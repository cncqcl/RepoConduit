import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { openCollaboration } from '../core/collaboration/identity.js';
import { createWorkingCopy, createWorkspace, parseWorkspaceId } from '../core/identity/index.js';
import { authorize, isDataPathPermitted, operationPolicy, PolicyError, validDataPaths, type Grant, type RequestContext, type ResourceScope } from '../core/policy/authorize.js';
import type { ArtifactApplication } from './artifacts.js';
import { LocalArtifactSource } from '../adapters/transfers/local-source.js';
import type { RepositoryApplication } from './repository.js';
import type { InvestigationApplication } from './investigations.js';
import type { InvestigationRecord, InvestigationResult } from '../core/investigation/request.js';
import type { ContextDecisionApplication } from './context-decisions.js';
import type { ContextContent } from '../core/collaboration/context.js';
import type { DecisionItem } from '../core/collaboration/decision.js';
import type { BindingApplication } from './bindings.js';
import type { ConversationApplication } from './conversation.js';
import { parseProfileConfiguration } from '../core/investigation/trusted-profile.js';
import { externalPermissions, localPermissions } from './daily-use.js';

export interface Command {
  operation: string;
  scope: ResourceScope;
  payload: unknown;
  idempotencyKey?: string;
}

/** Transport-created, non-serializable transfer. Untrusted command JSON cannot supply this value. */
export interface TrustedFileTransfer {
  referenceIdentity: string;
  mediaType: string | null;
  acquireBytes(maxBytes: number): Promise<Buffer>;
}

export class DispatchError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'UNSUPPORTED_CAPABILITY', message: string) { super(message); }
}

interface DispatchHandlers { artifact?: ArtifactApplication; repository?: RepositoryApplication; investigation?: InvestigationApplication; contextDecision?: ContextDecisionApplication; binding?: BindingApplication; conversation?: ConversationApplication }
const handlerOwned = new Set(['artifact.begin', 'artifact.put_text', 'artifact.import_reference', 'artifact.collect_local', 'artifact.collect_browser', 'artifact.export', 'artifact.finalize', 'artifact.abort', 'artifact.status', 'artifact.list', 'artifact.inspect',
  'conversation.bind', 'conversation.handoff', 'conversation.successor', 'conversation.send', 'conversation.sync', 'conversation.resume',
  'snapshot.capture', 'repo.inspect', 'repo.list', 'repo.read', 'repo.read_original', 'repo.search', 'repo.status', 'repo.diff',
  'investigate.submit', 'investigate.get', 'investigate.result', 'investigate.cancel',
  'context.propose', 'context.read', 'context.accept', 'decision.propose',
  'decision.review', 'decision.record',
  'decision.get', 'decision.list']);

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DispatchError('INVALID_ARGUMENT', `${name} required`);
  return value;
}
function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new DispatchError('INVALID_ARGUMENT', `${name} must be an integer`);
  return value as number;
}
function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name);
}
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new DispatchError('INVALID_ARGUMENT', `${name} must be a string array`);
  }
  return value as string[];
}
function contextContent(value: unknown): ContextContent {
  const fields = ['goal', 'constraints', 'acceptedDecisions', 'rejectedDecisions', 'currentQuestions',
    'evidenceRefs', 'expectedDeliverables', 'unknowns', 'recentChanges'] as const;
  const p = objectPayload(value, fields);
  if (typeof p.goal !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Context goal required');
  return { goal: p.goal, constraints: stringArray(p.constraints, 'constraints'),
    acceptedDecisions: stringArray(p.acceptedDecisions, 'acceptedDecisions'),
    rejectedDecisions: stringArray(p.rejectedDecisions, 'rejectedDecisions'),
    currentQuestions: stringArray(p.currentQuestions, 'currentQuestions'),
    evidenceRefs: stringArray(p.evidenceRefs, 'evidenceRefs'),
    expectedDeliverables: stringArray(p.expectedDeliverables, 'expectedDeliverables'),
    unknowns: stringArray(p.unknowns, 'unknowns'), recentChanges: stringArray(p.recentChanges, 'recentChanges') };
}

function decisionItems(value: unknown): DecisionItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new DispatchError('INVALID_ARGUMENT', 'Decision items required');
  }
  return value.map((entry) => {
    const item = objectPayload(entry, ['id', 'sourceRef', 'outcome', 'reason']);
    if (item.outcome !== 'accept' && item.outcome !== 'modify' && item.outcome !== 'reject') {
      throw new DispatchError('INVALID_ARGUMENT', 'Invalid decision item outcome');
    }
    return { id: requiredString(item.id, 'id'), sourceRef: requiredString(item.sourceRef, 'sourceRef'),
      outcome: item.outcome, reason: requiredString(item.reason, 'reason') };
  });
}

function decisionTarget(p: Record<string,unknown>):
  {bundleId:string;bundleManifestHash:string} | {proposalId:string} {
  const proposal=Object.hasOwn(p,'proposalId');
  const bundleId=Object.hasOwn(p,'bundleId');
  const bundleHash=Object.hasOwn(p,'bundleManifestHash');
  if (proposal === (bundleId || bundleHash) || bundleId!==bundleHash)
    throw new DispatchError('INVALID_ARGUMENT','Choose one decision target');
  return proposal ? {proposalId:requiredString(p.proposalId,'proposalId')} :
    {bundleId:requiredString(p.bundleId,'bundleId'),
      bundleManifestHash:requiredString(p.bundleManifestHash,'bundleManifestHash')};
}

function objectPayload(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new DispatchError('INVALID_ARGUMENT', 'Invalid payload');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new DispatchError('INVALID_ARGUMENT', 'Unknown payload field');
  }
  return record;
}

function adminGrantPayload(value: unknown): {principal:string;audience:string;workspaceId:string;
  recipient:string;permissions:string[];expiresAt:string|null;collaborationId?:string;dataPaths?:string[]} {
  const p=objectPayload(value,['principal','audience','workspaceId','collaborationId','recipient',
    'permissions','dataPaths','expiresAt']);
  const principal=p.principal,audience=p.audience,workspaceId=p.workspaceId,
    collaborationId=p.collaborationId,recipient=p.recipient,expiresAt=p.expiresAt;
  const permissions=Array.isArray(p.permissions) ? [...p.permissions] as unknown[] : null;
  const dataPaths=p.dataPaths===undefined ? undefined :
    Array.isArray(p.dataPaths) ? [...p.dataPaths] as unknown[] : null;
  if (typeof principal!=='string' || typeof audience!=='string' || typeof workspaceId!=='string' ||
      typeof recipient!=='string' || !principal.trim() || !audience.trim() ||
      !workspaceId.trim() || !recipient.trim() ||
      (collaborationId!==undefined && (typeof collaborationId!=='string' || !collaborationId.trim())) ||
      (expiresAt!==null && typeof expiresAt!=='string') || !permissions || permissions.length===0 ||
      !permissions.every(item=>typeof item==='string') ||
      (permissions.includes('data.read') && !validDataPaths(dataPaths)) ||
      (dataPaths!==undefined && !validDataPaths(dataPaths)))
    throw new DispatchError('INVALID_ARGUMENT','Invalid grant');
  return {principal,audience,workspaceId,recipient,permissions:permissions as string[],expiresAt,
    ...(collaborationId===undefined?{}:{collaborationId:collaborationId as string}),
    ...(dataPaths===undefined?{}:{dataPaths:dataPaths as string[]})};
}

type DailySharePayload = { workspaceId: string; external: { principal: string; audience: string; recipient: string };
  dataPaths: string[]; expectedLocalGrantId: string; expectedExternalGrantId: string };
type DailyShareReport = { workspaceId: string; localGrantId: string; externalGrantId: string; dataPaths: string[] };
function dailySharePayload(value: unknown): DailySharePayload {
  const p = objectPayload(value, ['workspaceId', 'external', 'dataPaths', 'expectedLocalGrantId', 'expectedExternalGrantId']);
  const external = objectPayload(p.external, ['principal', 'audience', 'recipient']);
  if (typeof p.workspaceId !== 'string' || !p.workspaceId ||
      typeof p.expectedLocalGrantId !== 'string' || !p.expectedLocalGrantId ||
      typeof p.expectedExternalGrantId !== 'string' || !p.expectedExternalGrantId ||
      typeof external.principal !== 'string' || !external.principal.trim() ||
      typeof external.audience !== 'string' || !external.audience.trim() ||
      typeof external.recipient !== 'string' || !external.recipient.trim() ||
      !validDataPaths(p.dataPaths)) throw new DispatchError('INVALID_ARGUMENT', 'Invalid daily share');
  const dataPaths = [...new Set(p.dataPaths)].sort();
  return { workspaceId: p.workspaceId, external: external as DailySharePayload['external'], dataPaths,
    expectedLocalGrantId: p.expectedLocalGrantId, expectedExternalGrantId: p.expectedExternalGrantId };
}

function samePermissions(grant: Grant, permissions: string[]): boolean {
  return grant.permissions.length === permissions.length && permissions.every(permission => grant.permissions.includes(permission));
}
function samePaths(paths: readonly string[] | undefined, wanted: string[]): boolean {
  return JSON.stringify([...paths ?? []].sort()) === JSON.stringify(wanted);
}

/** Every transport enters through this application boundary with its authenticated context. */
export class DispatchService {
  private closing = false;
  private inFlight = 0;
  private drained?: Promise<void>;
  private resolveDrained: (() => void) | undefined;

  constructor(private readonly store: SqliteStore,
    private readonly grants: (context: RequestContext) => readonly Grant[] = (context) => store.grantsFor(context.principal, context.audience),
    private readonly clock: () => Date = () => new Date(),
    private readonly handlers: DispatchHandlers = {},
    private readonly privateDataDirectory?: string) {}

  stopAccepting(): void { this.closing = true; }

  get hasInFlightRequests(): boolean { return this.inFlight > 0; }

  drain(): Promise<void> {
    if (this.drained) return this.drained;
    this.stopAccepting();
    this.drained = this.inFlight === 0 ? Promise.resolve() :
      new Promise<void>((resolve) => { this.resolveDrained = resolve; });
    return this.drained;
  }

  private assertRootOutsidePrivateData(candidate: string): void {
    if (!this.privateDataDirectory) return;
    const data = realpathSync(this.privateDataDirectory);
    const normalize = (path: string) => process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path;
    const within = (path: string, root: string) => {
      const child = relative(normalize(root), normalize(path));
      return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    };
    if (within(candidate, data) || within(data, candidate)) throw new PolicyError();
  }

  private assertDailyShare(context: RequestContext, payload: DailySharePayload,
    successors?: DailyShareReport): { local: Grant; external: Grant } {
    const workspace = this.store.getWorkspace(payload.workspaceId);
    if (!workspace || workspace.registeredBy !== context.principal ||
        (payload.external.principal === context.principal && payload.external.audience === context.audience)) throw new PolicyError();
    const now = this.clock().getTime();
    const check = (identity: { principal: string; audience: string; recipient: string },
      permissions: string[], id: string, allowRecipientless: boolean): Grant => {
      const all = this.store.grantsFor(identity.principal, identity.audience).filter(grant =>
        grant.workspaceId === payload.workspaceId &&
        (grant.recipient === identity.recipient || allowRecipientless && !grant.recipient));
      const active = all.filter(grant => grant.revokedAt === null &&
        (grant.expiresAt === null || Date.parse(grant.expiresAt) > now));
      const chosen = all.find(grant => grant.id === id);
      if (!chosen || chosen.recipient !== identity.recipient || chosen.collaborationId !== undefined ||
          !samePermissions(chosen, permissions) ||
          (successors ? !active.includes(chosen) || !samePaths(chosen.dataPaths, payload.dataPaths) :
            !active.includes(chosen))) throw new PolicyError();
      const daily = active.filter(grant => grant.recipient === identity.recipient &&
        grant.collaborationId === undefined && samePermissions(grant, permissions));
      if (daily.length !== 1 || daily[0]!.id !== id) throw new PolicyError();
      // Other effective data grants may coexist only when their entire scope is covered by the replacement.
      for (const grant of active) {
        if (grant.id === id || !grant.permissions.includes('data.read')) continue;
        if (!validDataPaths(grant.dataPaths) || grant.dataPaths.some(path => !payload.dataPaths.some(allowed =>
          allowed === path || allowed.endsWith('/') && path.startsWith(allowed)))) throw new PolicyError();
      }
      return chosen;
    };
    const local = check({ principal: context.principal, audience: context.audience, recipient: context.recipient },
      localPermissions, successors?.localGrantId ?? payload.expectedLocalGrantId, true);
    const external = check(payload.external, externalPermissions,
      successors?.externalGrantId ?? payload.expectedExternalGrantId, false);
    return { local, external };
  }

  async dispatch(context: RequestContext, command: Command, trustedFileTransfer?: TrustedFileTransfer,
    localSource?: LocalArtifactSource): Promise<unknown> {
    if (this.closing) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Dispatcher is closed');
    this.inFlight++;
    try {
    await context.assertFreshAuthority?.();
    const policy = operationPolicy(command.operation);
    const { scope, operation } = command;
    if ((operation === 'collab.open' || operation === 'collab.open_from_template') && scope.collaborationId) throw new PolicyError();
    if (scope.collaborationId && !this.store.getCollaboration(scope.collaborationId, scope.workspaceId)) throw new PolicyError();
    const entryContext = { ...context, now: this.clock() };
    const entryPermit = authorize(entryContext, operation, scope, this.grants(entryContext));
    if (policy.idempotencyRequired && !command.idempotencyKey) {
      throw new DispatchError('INVALID_ARGUMENT', 'Idempotency key required');
    }
    let result: unknown;
    if (handlerOwned.has(operation)) {
      result = await this.executeHandler(entryContext, command, trustedFileTransfer, localSource);
    } else {
      const effectiveCommand=operation==='admin.grant' ?
        {...command,payload:adminGrantPayload(command.payload)} : operation === 'admin.replace_project_share' ?
        { ...command, payload: dailySharePayload(command.payload) } : command;
      const execute = (): unknown => this.execute(entryContext, effectiveCommand);
      result = policy.idempotencyRequired ? this.store.runIdempotent({
        principal: context.principal, audience: context.audience, workspaceId: scope.workspaceId,
        operation, idempotencyKey: command.idempotencyKey!,
      }, { scope, payload: effectiveCommand.payload }, execute,
      (operation==='admin.configure_profile' || operation==='admin.publish_project_material' || operation==='collab.open_from_template' || operation==='admin.replace_project_share' || (operation==='admin.grant' &&
        (effectiveCommand.payload as {workspaceId:string}).workspaceId==='management')) ? () => {
        const current={...context,now:this.clock()};
        authorize(current,operation,scope,this.store.grantsFor(current.principal,current.audience));
        if (operation === 'admin.replace_project_share') {
          const payload = effectiveCommand.payload as DailySharePayload;
          const prior = this.store.lookupIdempotent<DailyShareReport>({ principal: context.principal,
            audience: context.audience, workspaceId: scope.workspaceId, operation,
            idempotencyKey: command.idempotencyKey! }, { scope, payload });
          this.assertDailyShare(current, payload, prior ?? undefined);
        }
        if (operation === 'collab.open_from_template') {
          const p = objectPayload(command.payload, ['materialId', 'title', 'question']);
          this.store.assertProjectMaterialAuthority(current, scope.workspaceId, requiredString(p.materialId, 'materialId'));
        }
      } : undefined) : execute();
    }
    let investigationPaths: string[] | undefined;
    if (operation === 'investigate.get' || operation === 'investigate.result') {
      const p = objectPayload(command.payload, ['workingCopyId', 'requestId']);
      if (!scope.collaborationId || !this.handlers.investigation) throw new PolicyError();
      investigationPaths = await this.handlers.investigation.disclosurePaths({ context,
        workspaceId: scope.workspaceId, collaborationId: scope.collaborationId,
        workingCopyId: requiredString(p.workingCopyId, 'workingCopyId'),
        requestId: requiredString(p.requestId, 'requestId') },
      result as InvestigationRecord | InvestigationResult | null);
    }
    await context.assertFreshAuthority?.();
    const disclosureContext = { ...context, now: this.clock() };
    const currentGrants = this.grants(disclosureContext);
    const disclosurePermit = authorize(disclosureContext, operation, scope, currentGrants);
    if (policy.requiredGrant === 'data.read' &&
        JSON.stringify([...entryPermit.dataPaths ?? []].sort()) !== JSON.stringify([...disclosurePermit.dataPaths ?? []].sort())) {
      throw new PolicyError();
    }
    if (investigationPaths) {
      const readPermit = authorize(disclosureContext, 'repo.read', scope, currentGrants);
      if (!readPermit.dataPaths?.length || investigationPaths.some(path => !isDataPathPermitted(path, readPermit.dataPaths!))) {
        throw new PolicyError();
      }
    }
    return result;
    } finally {
      this.inFlight--;
      if (this.closing && this.inFlight === 0) {
        this.resolveDrained?.();
        this.resolveDrained = undefined;
      }
    }
  }

  private async executeHandler(context: RequestContext, command: Command,
    trustedFileTransfer?: TrustedFileTransfer, localSource?: LocalArtifactSource): Promise<unknown> {
    const { workspaceId, collaborationId } = command.scope;
    if (!collaborationId) throw new DispatchError('INVALID_ARGUMENT', 'Collaboration required');
    const binding = { context, workspaceId, collaborationId };
    if (command.operation === 'conversation.bind' || command.operation === 'conversation.handoff' ||
        command.operation === 'conversation.successor') {
      const service = this.handlers.binding;
      if (!service) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Conversation binding handler is not installed');
      const p = objectPayload(command.payload, command.operation === 'conversation.bind' ? [] :
        command.operation === 'conversation.successor' ?
          ['predecessorBindingId', 'expectedEpoch', 'expectedRevision', 'contextRevisionId'] :
          ['bindingId', 'expectedEpoch']);
      if (command.operation === 'conversation.bind') return service.bind({ ...binding, idempotencyKey: command.idempotencyKey! });
      const expectedEpoch = optionalInteger(p.expectedEpoch, 'expectedEpoch');
      if (expectedEpoch === undefined || expectedEpoch < 0) throw new DispatchError('INVALID_ARGUMENT', 'Expected epoch required');
      if (command.operation === 'conversation.successor') {
        const expectedRevision = optionalInteger(p.expectedRevision, 'expectedRevision');
        if (expectedRevision === undefined || expectedRevision < 0) {
          throw new DispatchError('INVALID_ARGUMENT', 'Expected revision required');
        }
        return service.successor({ ...binding, idempotencyKey: command.idempotencyKey!,
          predecessorBindingId: requiredString(p.predecessorBindingId, 'predecessorBindingId'),
          expectedEpoch, expectedRevision,
          contextRevisionId: requiredString(p.contextRevisionId, 'contextRevisionId') });
      }
      return service.handoff({ ...binding, idempotencyKey: command.idempotencyKey!,
        bindingId: requiredString(p.bindingId, 'bindingId'), expectedEpoch });
    }
    if (command.operation === 'conversation.send' || command.operation === 'conversation.sync' ||
        command.operation === 'conversation.resume') {
      const service = this.handlers.conversation;
      if (!service) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Conversation handler is not installed');
      const p = objectPayload(command.payload, command.operation === 'conversation.send' ?
        ['bindingId', 'expectedEpoch', 'text'] : command.operation === 'conversation.resume' ?
          ['bindingId', 'expectedEpoch', 'acceptUnknownSendIntentId'] : ['bindingId', 'expectedEpoch']);
      const expectedEpoch = optionalInteger(p.expectedEpoch, 'expectedEpoch');
      if (expectedEpoch === undefined || expectedEpoch < 0) throw new DispatchError('INVALID_ARGUMENT', 'Expected epoch required');
      const request = { ...binding, idempotencyKey: command.idempotencyKey!,
        bindingId: requiredString(p.bindingId, 'bindingId'), expectedEpoch };
      if (command.operation === 'conversation.send') return service.send({ ...request, text: requiredString(p.text, 'text') });
      return command.operation === 'conversation.sync' ? service.sync(request) : service.resume({ ...request,
        ...(p.acceptUnknownSendIntentId !== undefined ? {
          acceptUnknownSendIntentId: requiredString(p.acceptUnknownSendIntentId, 'acceptUnknownSendIntentId'),
        } : {}) });
    }
    if (command.operation === 'context.propose' || command.operation === 'context.read' ||
        command.operation === 'context.accept' || command.operation === 'decision.propose' ||
        command.operation === 'decision.review' ||
        command.operation === 'decision.record' || command.operation === 'decision.get' ||
        command.operation === 'decision.list') {
      const service = this.handlers.contextDecision;
      if (!service) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Context and decision handler is not installed');
      if (command.operation === 'context.read') {
        const p = objectPayload(command.payload, ['proposalId', 'revisionId']);
        if (p.proposalId !== undefined && p.revisionId !== undefined) {
          throw new DispatchError('INVALID_ARGUMENT', 'Choose proposalId or revisionId');
        }
        if (p.proposalId !== undefined) {
          return service.readProposal({ ...binding, proposalId: requiredString(p.proposalId, 'proposalId') });
        }
        if (p.revisionId !== undefined) {
          return service.readRevision({ ...binding, revisionId: requiredString(p.revisionId, 'revisionId') });
        }
        return service.readCurrentContext(binding);
      }
      if (command.operation === 'decision.get') {
        const p = objectPayload(command.payload, ['decisionId', 'proposalId']);
        if ((p.decisionId === undefined) === (p.proposalId === undefined))
          throw new DispatchError('INVALID_ARGUMENT', 'Choose exactly one decision or proposal ID');
        return p.proposalId === undefined ?
          service.readDecision({ ...binding, decisionId: requiredString(p.decisionId, 'decisionId') }) :
          service.readDecisionProposal({ ...binding, proposalId: requiredString(p.proposalId, 'proposalId') });
      }
      if (command.operation === 'decision.list') {
        const p = objectPayload(command.payload, ['limit', 'cursor', 'kind']);
        const limit = optionalInteger(p.limit, 'limit');
        const request = { ...binding,
          ...(limit === undefined ? {} : { limit }),
          ...(p.cursor === undefined ? {} : { cursor: requiredString(p.cursor, 'cursor') }),
        };
        if (p.kind === 'proposal') return service.listDecisions({ ...request, kind: 'proposal' });
        if (p.kind !== undefined && p.kind !== 'record')
          throw new DispatchError('INVALID_ARGUMENT', 'Invalid decision list kind');
        return service.listDecisions(request);
      }
      if (command.operation === 'decision.propose') {
        const p = objectPayload(command.payload, ['proposalId', 'contextRevisionId', 'snapshotId',
          'recommendation', 'reason', 'bundleId', 'bundleManifestHash']);
        if (p.recommendation !== 'accept' && p.recommendation !== 'modify' &&
            p.recommendation !== 'reject')
          throw new DispatchError('INVALID_ARGUMENT', 'Invalid decision recommendation');
        return service.proposeDecision({ ...binding, idempotencyKey: command.idempotencyKey!,
          proposalId: requiredString(p.proposalId, 'proposalId'),
          contextRevisionId: requiredString(p.contextRevisionId, 'contextRevisionId'),
          snapshotId: requiredString(p.snapshotId, 'snapshotId'),
          recommendation: p.recommendation, reason: requiredString(p.reason, 'reason'),
          ...(p.bundleId === undefined ? {} : { bundleId: requiredString(p.bundleId, 'bundleId') }),
          ...(p.bundleManifestHash === undefined ? {} :
            { bundleManifestHash: requiredString(p.bundleManifestHash, 'bundleManifestHash') }) });
      }
      if (command.operation === 'context.propose') {
        const p = objectPayload(command.payload, ['proposalId', 'parentRevisionId', 'snapshotId', 'sourceRefs', 'content']);
        if (p.parentRevisionId !== null && typeof p.parentRevisionId !== 'string') {
          throw new DispatchError('INVALID_ARGUMENT', 'parentRevisionId must be string or null');
        }
        return service.propose({ ...binding, idempotencyKey: command.idempotencyKey!,
          proposalId: requiredString(p.proposalId, 'proposalId'), parentRevisionId: p.parentRevisionId,
          snapshotId: requiredString(p.snapshotId, 'snapshotId'),
          sourceRefs: stringArray(p.sourceRefs, 'sourceRefs'), content: contextContent(p.content) });
      }
      if (command.operation === 'context.accept') {
        const p = objectPayload(command.payload, ['proposalId', 'revisionId']);
        return service.accept({ ...binding, idempotencyKey: command.idempotencyKey!,
          proposalId: requiredString(p.proposalId, 'proposalId'), revisionId: requiredString(p.revisionId, 'revisionId') });
      }
      if (command.operation === 'decision.review') {
        const p = objectPayload(command.payload, ['reviewId', 'bundleId', 'bundleManifestHash',
          'proposalId', 'snapshotId', 'contextRevisionId']);
        return service.reviewBaseline({ ...binding, idempotencyKey: command.idempotencyKey!,
          reviewId: requiredString(p.reviewId, 'reviewId'), ...decisionTarget(p),
          snapshotId: requiredString(p.snapshotId, 'snapshotId'),
          contextRevisionId: requiredString(p.contextRevisionId, 'contextRevisionId') });
      }
      const p = objectPayload(command.payload, ['decisionId', 'bundleId', 'bundleManifestHash', 'proposalId', 'snapshotId',
        'contextRevisionId', 'reviewId', 'outcome', 'reason', 'items']);
      if (p.outcome !== 'accept' && p.outcome !== 'modify' && p.outcome !== 'reject') {
        throw new DispatchError('INVALID_ARGUMENT', 'Invalid decision outcome');
      }
      return service.decide({ ...binding, idempotencyKey: command.idempotencyKey!,
        decisionId: requiredString(p.decisionId, 'decisionId'), ...decisionTarget(p),
        snapshotId: requiredString(p.snapshotId, 'snapshotId'),
        contextRevisionId: requiredString(p.contextRevisionId, 'contextRevisionId'),
        ...(p.reviewId === undefined ? {} : { reviewId: requiredString(p.reviewId, 'reviewId') }),
        outcome: p.outcome, reason: requiredString(p.reason, 'reason'),
        ...(p.items === undefined ? {} : { items: decisionItems(p.items) }) });
    }
    if (command.operation === 'snapshot.capture' || command.operation.startsWith('repo.')) {
      const repository = this.handlers.repository;
      if (!repository) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Repository handler is not installed');
      const fields = command.operation === 'snapshot.capture' ? ['workingCopyId', 'commitRef'] :
        command.operation === 'repo.read_original' ? ['workingCopyId', 'snapshotId', 'path', 'maxBytes'] :
        command.operation === 'repo.read' ? ['workingCopyId', 'snapshotId', 'path', 'maxBytes', 'maxLines', 'cursor'] :
        command.operation === 'repo.search' ? ['workingCopyId', 'snapshotId', 'term', 'maxBytes', 'maxMatches', 'cursor'] :
        command.operation === 'repo.list' ? ['workingCopyId', 'snapshotId', 'maxEntries', 'cursor'] :
        command.operation === 'repo.diff' ? ['workingCopyId', 'snapshotId', 'beforeSnapshotId', 'maxEntries', 'cursor'] :
        ['workingCopyId', 'snapshotId'];
      const p = objectPayload(command.payload, fields);
      const workingCopyId = requiredString(p.workingCopyId, 'workingCopyId');
      if (command.operation === 'snapshot.capture') {
        return repository.capture({ ...binding, workingCopyId, idempotencyKey: command.idempotencyKey!,
          ...(optionalString(p.commitRef, 'commitRef') ? { commitRef: p.commitRef as string } : {}) });
      }
      const snapshotId = requiredString(p.snapshotId, 'snapshotId');
      const bound = { ...binding, workingCopyId, snapshotId };
      const maxEntries = optionalInteger(p.maxEntries, 'maxEntries');
      const maxBytes = optionalInteger(p.maxBytes, 'maxBytes');
      const maxLines = optionalInteger(p.maxLines, 'maxLines');
      const maxMatches = optionalInteger(p.maxMatches, 'maxMatches');
      const cursor = optionalString(p.cursor, 'cursor');
      switch (command.operation) {
        case 'repo.inspect': return repository.inspect(bound);
        case 'repo.status': return repository.status(bound);
        case 'repo.list': return repository.list({ ...bound, ...(maxEntries === undefined ? {} : { maxEntries }), cursor });
        case 'repo.read': return repository.read({ ...bound, path: requiredString(p.path, 'path'),
          ...(maxBytes === undefined ? {} : { maxBytes }), ...(maxLines === undefined ? {} : { maxLines }), cursor });
        case 'repo.read_original': return repository.readOriginal({ ...bound, path: requiredString(p.path, 'path'),
          ...(maxBytes === undefined ? {} : { maxBytes }) });
        case 'repo.search': return repository.search({ ...bound, term: requiredString(p.term, 'term'),
          ...(maxBytes === undefined ? {} : { maxBytes }), ...(maxMatches === undefined ? {} : { maxMatches }), cursor });
        case 'repo.diff': return repository.diff({ ...bound, beforeSnapshotId: requiredString(p.beforeSnapshotId, 'beforeSnapshotId'),
          ...(maxEntries === undefined ? {} : { maxEntries }), cursor });
      }
    }
    if (command.operation.startsWith('investigate.')) {
      const investigation = this.handlers.investigation;
      if (!investigation) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Investigation handler is not installed');
      const p = objectPayload(command.payload, command.operation === 'investigate.submit' ?
        ['workingCopyId', 'input'] : ['workingCopyId', 'requestId']);
      const workingCopyId = requiredString(p.workingCopyId, 'workingCopyId');
      if (command.operation === 'investigate.submit') {
        return investigation.submit({ ...binding, workingCopyId, idempotencyKey: command.idempotencyKey!, input: p.input });
      }
      const requestId = requiredString(p.requestId, 'requestId');
      const existing = { ...binding, workingCopyId, requestId };
      if (command.operation === 'investigate.get') return investigation.get(existing);
      if (command.operation === 'investigate.result') return investigation.result(existing);
      if (command.operation === 'investigate.cancel') return investigation.cancel({ ...existing, idempotencyKey: command.idempotencyKey! });
      throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Investigation operation is not implemented');
    }
    const artifact = this.handlers.artifact;
    if (!artifact) throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Artifact handler is not installed');
    switch (command.operation) {
      case 'artifact.begin': {
        const p = objectPayload(command.payload, ['bundleId', 'contextRevision', 'snapshotRefs', 'parentBundleId', 'expectedPaths']);
        if (typeof p.bundleId !== 'string' || typeof p.contextRevision !== 'string' ||
          !Array.isArray(p.snapshotRefs) || !p.snapshotRefs.every((x) => typeof x === 'string') ||
          (p.expectedPaths !== undefined && (!Array.isArray(p.expectedPaths) || !p.expectedPaths.every((x) => typeof x === 'string'))) ||
          (p.parentBundleId !== undefined && typeof p.parentBundleId !== 'string')) throw new DispatchError('INVALID_ARGUMENT', 'Invalid bundle input');
        return artifact.begin({ ...binding, bundleId: p.bundleId, contextRevision: p.contextRevision,
          snapshotRefs: p.snapshotRefs as string[],
          ...(p.parentBundleId ? { parentBundleId: p.parentBundleId } : {}),
          ...(p.expectedPaths ? { expectedPaths: p.expectedPaths as string[] } : {}),
          idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.put_text': {
        const p = objectPayload(command.payload, ['bundleId', 'path', 'text', 'mediaType']);
        if (typeof p.bundleId !== 'string' || typeof p.path !== 'string' ||
          typeof p.text !== 'string' || typeof p.mediaType !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Invalid text file input');
        return artifact.putText({ ...binding, bundleId: p.bundleId, path: p.path, text: p.text,
          mediaType: p.mediaType, sourceReceipt: context.surface === 'external_mcp' ? 'text_set_mcp' : 'local_text',
          idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.import_reference': {
        const p = objectPayload(command.payload, ['bundleId', 'path']);
        if (typeof p.bundleId !== 'string' || typeof p.path !== 'string') {
          throw new DispatchError('INVALID_ARGUMENT', 'Invalid file import input');
        }
        if (!trustedFileTransfer || typeof trustedFileTransfer.acquireBytes !== 'function' ||
            typeof trustedFileTransfer.referenceIdentity !== 'string' ||
            (trustedFileTransfer.mediaType !== null && typeof trustedFileTransfer.mediaType !== 'string') ||
            trustedFileTransfer.mediaType === '') {
          throw new DispatchError('UNSUPPORTED_CAPABILITY', 'File transfer unavailable');
        }
        return artifact.importReference({ ...binding, bundleId: p.bundleId, path: p.path,
          referenceIdentity: trustedFileTransfer.referenceIdentity,
          mediaType: trustedFileTransfer.mediaType,
          acquireBytes: trustedFileTransfer.acquireBytes,
          idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.collect_local': {
        const p = objectPayload(command.payload, ['bundleId', 'path', 'mediaType']);
        if (!(localSource instanceof LocalArtifactSource) || trustedFileTransfer ||
            (context.surface !== 'local_cli' && context.surface !== 'local_host')) {
          throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Local file selection unavailable');
        }
        return artifact.collectLocal({ ...binding, bundleId: requiredString(p.bundleId, 'bundleId'),
          path: requiredString(p.path, 'path'), mediaType: requiredString(p.mediaType, 'mediaType'),
          source: localSource, idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.collect_browser': {
        const p = objectPayload(command.payload, ['bundleId', 'path', 'nativeSessionId', 'nativeMessageId', 'filename', 'attachmentIndex', 'expectedSha256', 'expectedSize', 'retryOfCaptureId', 'reconcileOnly']);
        if (trustedFileTransfer || localSource || (context.surface !== 'local_cli' && context.surface !== 'local_host') ||
            !Number.isSafeInteger(p.expectedSize) || typeof p.expectedSize !== 'number') {
          throw new DispatchError('INVALID_ARGUMENT', 'Invalid browser collection');
        }
        return artifact.collectBrowser({ ...binding, bundleId: requiredString(p.bundleId, 'bundleId'),
          path: requiredString(p.path, 'path'), nativeSessionId: requiredString(p.nativeSessionId, 'nativeSessionId'),
          nativeMessageId: requiredString(p.nativeMessageId, 'nativeMessageId'), filename: requiredString(p.filename, 'filename'),
          ...(p.attachmentIndex === undefined ? {} : { attachmentIndex: optionalInteger(p.attachmentIndex, 'attachmentIndex')! }),
          expectedSha256: requiredString(p.expectedSha256, 'expectedSha256'), expectedSize: p.expectedSize,
          ...(p.retryOfCaptureId === undefined ? {} : { retryOfCaptureId: requiredString(p.retryOfCaptureId, 'retryOfCaptureId') }),
          ...(p.reconcileOnly === undefined ? {} : { reconcileOnly: {
            captureIntentId: requiredString(objectPayload(p.reconcileOnly, ['captureIntentId']).captureIntentId, 'captureIntentId') } }),
          idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.export': {
        const p = objectPayload(command.payload, ['bundleId', 'expectedManifestHash', 'exportName']);
        return artifact.export({ ...binding, bundleId: requiredString(p.bundleId, 'bundleId'),
          expectedManifestHash: requiredString(p.expectedManifestHash, 'expectedManifestHash'),
          exportName: requiredString(p.exportName, 'exportName'), idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.finalize': {
        const p = objectPayload(command.payload, ['bundleId']);
        if (typeof p.bundleId !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Bundle ID required');
        return artifact.finalize({ ...binding, bundleId: p.bundleId, idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.abort': {
        const p = objectPayload(command.payload, ['bundleId']);
        return artifact.abort({ ...binding, bundleId: requiredString(p.bundleId, 'bundleId'),
          idempotencyKey: command.idempotencyKey! });
      }
      case 'artifact.status': {
        const p = objectPayload(command.payload, ['bundleId']);
        if (typeof p.bundleId !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Bundle ID required');
        return artifact.status({ ...binding, bundleId: p.bundleId });
      }
      case 'artifact.list': {
        const p = objectPayload(command.payload, ['limit', 'cursor']);
        const limit = optionalInteger(p.limit, 'limit');
        const cursor = optionalString(p.cursor, 'cursor');
        return artifact.list({ ...binding, ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }) });
      }
      case 'artifact.inspect': {
        const p = objectPayload(command.payload, ['bundleId']);
        return artifact.inspect({ ...binding, bundleId: requiredString(p.bundleId, 'bundleId') });
      }
      default: throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Operation is not implemented');
    }
  }

  private execute(context: RequestContext, command: Command): unknown {
    switch (command.operation) {
      case 'admin.publish_project_material': {
        if (command.scope.workspaceId !== 'management' || command.scope.collaborationId || context.surface !== 'local_admin') throw new PolicyError();
        const p = objectPayload(command.payload, ['workspaceId', 'sourceCollaborationId', 'sourceContextRevisionId', 'external', 'dataPaths']);
        const target = objectPayload(p.external, ['principal', 'audience', 'recipient']);
        return this.store.publishProjectMaterial(context, { workspaceId: requiredString(p.workspaceId, 'workspaceId'),
          sourceCollaborationId: requiredString(p.sourceCollaborationId, 'sourceCollaborationId'),
          sourceContextRevisionId: requiredString(p.sourceContextRevisionId, 'sourceContextRevisionId'),
          dataPaths: stringArray(p.dataPaths, 'dataPaths'),
          external: { principal: requiredString(target.principal, 'principal'), audience: requiredString(target.audience, 'audience'),
            recipient: requiredString(target.recipient, 'recipient') } });
      }
      case 'collab.open_from_template': {
        const p = objectPayload(command.payload, ['materialId', 'title', 'question']);
        const title = requiredString(p.title, 'title'); const question = requiredString(p.question, 'question');
        if (title.length > 256 || Buffer.byteLength(question, 'utf8') > 16384 || command.scope.collaborationId) throw new PolicyError();
        return this.store.openCollaborationFromMaterial(context, command.scope.workspaceId,
          { materialId: requiredString(p.materialId, 'materialId'), title, question });
      }
      case 'admin.register_workspace': {
        if (command.scope.workspaceId !== 'management') throw new PolicyError();
        const payload = objectPayload(command.payload, ['name', 'root']);
        if (typeof payload.name !== 'string' || typeof payload.root !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Name and root required');
        const root = realpathSync(payload.root);
        if (!statSync(root).isDirectory()) throw new DispatchError('INVALID_ARGUMENT', 'Root must be a directory');
        this.assertRootOutsidePrivateData(root);
        const workspace = createWorkspace({ authenticatedPrincipal: context.principal, audience: 'local_admin' },
          { name: payload.name, canonicalRoot: root });
        this.store.insertWorkspace(workspace);
        return workspace;
      }
      case 'admin.register_working_copy': {
        if (command.scope.workspaceId !== 'management') throw new PolicyError();
        const payload = objectPayload(command.payload, ['workspaceId', 'root']);
        if (typeof payload.workspaceId !== 'string' || typeof payload.root !== 'string') {
          throw new DispatchError('INVALID_ARGUMENT', 'Workspace and root required');
        }
        const workspace = this.store.getWorkspace(payload.workspaceId);
        if (!workspace) throw new PolicyError();
        const root = realpathSync(payload.root);
        if (!statSync(root).isDirectory()) throw new DispatchError('INVALID_ARGUMENT', 'Root must be a directory');
        this.assertRootOutsidePrivateData(root);
        const copy = createWorkingCopy(parseWorkspaceId(workspace.id), root);
        this.store.insertWorkingCopy(copy);
        return copy;
      }
      case 'collab.open': {
        const payload = objectPayload(command.payload, ['purpose']);
        if (typeof payload.purpose !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Purpose required');
        if (!this.store.getWorkspace(command.scope.workspaceId)) throw new PolicyError();
        const workspaceId = parseWorkspaceId(command.scope.workspaceId);
        const collaboration = openCollaboration({ authenticatedPrincipal: context.principal,
          audience: context.surface === 'external_mcp' ? 'external_mcp' : context.surface === 'local_cli' ? 'local_cli' : 'local_host', workspaceId },
        { workspaceId, purpose: payload.purpose });
        this.store.insertCollaboration(collaboration);
        return collaboration;
      }
      case 'collab.get': {
        objectPayload(command.payload, []);
        if (!command.scope.collaborationId) throw new DispatchError('INVALID_ARGUMENT', 'Collaboration required');
        return this.store.getCollaboration(command.scope.collaborationId, command.scope.workspaceId) ?? (() => { throw new PolicyError(); })();
      }
      case 'collab.list': {
        objectPayload(command.payload, []);
        const all = this.store.listCollaborations(command.scope.workspaceId);
        return command.scope.collaborationId ? all.filter((item) => item.id === command.scope.collaborationId) : all;
      }
      case 'admin.grant': {
        if (command.scope.workspaceId !== 'management') throw new PolicyError();
        const payload=adminGrantPayload(command.payload);
        const managementProfileGrant=payload.workspaceId==='management' &&
          payload.permissions.length===1 && payload.permissions[0]==='admin.profile' &&
          payload.audience==='local-os' && payload.recipient===payload.principal &&
          payload.collaborationId===undefined && payload.dataPaths===undefined &&
          context.surface==='local_admin';
        if (payload.workspaceId==='management' ? !managementProfileGrant :
          !this.store.getWorkspace(payload.workspaceId)) throw new PolicyError();
        if (payload.collaborationId && !this.store.getCollaboration(payload.collaborationId, payload.workspaceId)) throw new PolicyError();
        const grant: Grant = {
          id: `gr_${randomUUID()}`, principal: payload.principal, audience: payload.audience,
          workspaceId: payload.workspaceId, ...(payload.collaborationId ? { collaborationId: payload.collaborationId } : {}),
          recipient: payload.recipient, permissions: payload.permissions as string[],
          ...(payload.dataPaths === undefined ? {} : { dataPaths: payload.dataPaths as string[] }),
          expiresAt: payload.expiresAt, revokedAt: null,
        };
        this.store.insertGrant(grant);
        return { id: grant.id, principal: grant.principal, audience: grant.audience, workspaceId: grant.workspaceId,
          collaborationId: grant.collaborationId ?? null, recipient: grant.recipient,
          permissions: grant.permissions, dataPaths: grant.dataPaths ?? null, expiresAt: grant.expiresAt };
      }
      case 'admin.revoke': {
        if (command.scope.workspaceId !== 'management') throw new PolicyError();
        const payload = objectPayload(command.payload, ['grantId']);
        if (typeof payload.grantId !== 'string') throw new DispatchError('INVALID_ARGUMENT', 'Grant ID required');
        this.store.revokeGrant(payload.grantId, context.now.toISOString());
        return { grantId: payload.grantId, revoked: true };
      }
      case 'admin.replace_project_share': {
        if (command.scope.workspaceId !== 'management' || command.scope.collaborationId) throw new PolicyError();
        const payload = dailySharePayload(command.payload);
        const previous = this.assertDailyShare(context, payload);
        this.store.revokeGrant(previous.local.id, context.now.toISOString());
        this.store.revokeGrant(previous.external.id, context.now.toISOString());
        const local: Grant = { ...previous.local, id: `gr_${randomUUID()}`, dataPaths: payload.dataPaths,
          revokedAt: null };
        const external: Grant = { ...previous.external, id: `gr_${randomUUID()}`, dataPaths: payload.dataPaths,
          revokedAt: null };
        this.store.insertGrant(local);
        this.store.insertGrant(external);
        return { workspaceId: payload.workspaceId, localGrantId: local.id,
          externalGrantId: external.id, dataPaths: payload.dataPaths } satisfies DailyShareReport;
      }
      case 'admin.configure_profile': {
        if (command.scope.workspaceId!=='management' || command.scope.collaborationId)
          throw new PolicyError();
        const input=parseProfileConfiguration(command.payload);
        return this.store.insertProfileRevision(input,context.principal,this.clock());
      }
      default:
        throw new DispatchError('UNSUPPORTED_CAPABILITY', 'Operation is not implemented');
    }
  }
}

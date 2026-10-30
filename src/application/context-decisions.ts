import { authorize, type Grant, type Permit, type RequestContext } from '../core/policy/authorize.js';
import { acceptContext, proposeContext, type ContextContent, type ContextProposal, type ContextRevision } from '../core/collaboration/context.js';
import { proposeDecision, recordDecision, type DecisionItem, type DecisionProposal,
  type DecisionRecord } from '../core/collaboration/decision.js';
import { ContextDecisionSqlite, type BaselineReview } from '../adapters/storage/context-decisions-sqlite.js';

type Operation = 'context.propose' | 'context.read' | 'context.accept' | 'decision.propose' |
  'decision.record' | 'decision.review' |
  'decision.get' | 'decision.list';
type Binding = { context: RequestContext; workspaceId: string; collaborationId: string };
type Mutation = Binding & { idempotencyKey: string };
export type ProposeContextRequest = Mutation & { proposalId: string; parentRevisionId: string | null;
  snapshotId: string; sourceRefs: string[]; content: ContextContent };
export type ReadProposalRequest = Binding & { proposalId: string };
export type ReadRevisionRequest = Binding & { revisionId: string };
export type AcceptContextRequest = Mutation & { proposalId: string; revisionId: string };
type DecisionTarget = { bundleId: string; bundleManifestHash: string; proposalId?: never } |
  { proposalId: string; bundleId?: never; bundleManifestHash?: never };
function requestFields(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key=>!fields.includes(key))) throw new Error('INVALID_ARGUMENT');
}
function decisionTarget(value: DecisionTarget): DecisionTarget {
  const proposal=Object.hasOwn(value,'proposalId');
  const bundle=Object.hasOwn(value,'bundleId') || Object.hasOwn(value,'bundleManifestHash');
  if (proposal===bundle || bundle !== (Object.hasOwn(value,'bundleId') &&
      Object.hasOwn(value,'bundleManifestHash'))) throw new Error('INVALID_ARGUMENT');
  if (proposal) {
    if (typeof value.proposalId!=='string' || !value.proposalId) throw new Error('INVALID_ARGUMENT');
    return {proposalId:value.proposalId};
  }
  if (typeof value.bundleId!=='string' || !value.bundleId ||
      typeof value.bundleManifestHash!=='string' || !value.bundleManifestHash)
    throw new Error('INVALID_ARGUMENT');
  return {bundleId:value.bundleId,bundleManifestHash:value.bundleManifestHash};
}
export type DecideRequest = Mutation & DecisionTarget & { decisionId: string;
  snapshotId: string; contextRevisionId: string; reviewId?: string; outcome: 'accept' | 'modify' | 'reject';
  reason: string; items?: DecisionItem[] };
export type ProposeDecisionRequest = Mutation & { proposalId: string; contextRevisionId: string;
  snapshotId: string; recommendation: DecisionProposal['recommendation']; reason: string;
  bundleId?: string; bundleManifestHash?: string };
export type ReviewBaselineRequest = Mutation & DecisionTarget & { reviewId: string;
  snapshotId: string; contextRevisionId: string };
export type ReadDecisionRequest = Binding & { decisionId: string };
export type ReadDecisionProposalRequest = Binding & { proposalId: string };
export type ListDecisionsRequest = Binding & { limit?: number; cursor?: string;
  kind?: 'record' | 'proposal' };
export type DecisionSummary = { decisionId: string; decisionSeq: number;
  outcome: DecisionRecord['outcome']; contextRevisionId: string; snapshotId: string;
  implementationAuthorized: false } & ({bundleId:string;proposalId?:never} |
  {proposalId:string;bundleId?:never});
export type DecisionPage = { decisions: DecisionSummary[]; nextCursor: string | null };
export type DecisionProposalPage = { proposals: { proposalId: string; proposalSeq: number;
  recommendation: DecisionProposal['recommendation']; contextRevisionId: string; snapshotId: string;
  implementationAuthorized: false }[]; nextCursor: string | null };
export type DecisionCursorSigner = { sign(body: string): string; verify(body: string, signature: string): boolean };

export class ContextDecisionApplication {
  constructor(private readonly store: ContextDecisionSqlite,
    private readonly grants: (context: RequestContext) => readonly Grant[],
    private readonly clock: () => Date = () => new Date(),
    private readonly cursorSigner?: DecisionCursorSigner) {}

  private permitted(request: Binding, operation: Operation): Permit {
    if (!request.collaborationId || !request.workspaceId) throw new Error('NOT_AVAILABLE');
    const current = { ...request.context, now: this.clock() };
    return authorize(current, operation, { workspaceId: request.workspaceId,
      collaborationId: request.collaborationId }, this.grants(current));
  }

  private mutate<T>(request: Mutation, operation: Operation, payload: unknown, action: (permit: Permit) => T): T {
    if (!request.idempotencyKey) throw new TypeError('Idempotency key required');
    this.permitted(request, operation);
    const current = { ...request.context, now: this.clock() };
    const result = this.store.runIdempotent({ principal: request.context.principal, audience: request.context.audience,
      workspaceId: request.workspaceId, operation, idempotencyKey: request.idempotencyKey },
      { collaborationId: request.collaborationId, payload }, current, request.collaborationId, action);
    this.permitted(request, operation);
    return result;
  }

  propose(request: ProposeContextRequest): ContextProposal {
    const proposal = proposeContext({ id: request.proposalId, workspaceId: request.workspaceId,
      collaborationId: request.collaborationId, parentRevisionId: request.parentRevisionId,
      snapshotId: request.snapshotId, proposedBy: request.context.principal,
      sourceRefs: request.sourceRefs, content: request.content });
    return this.mutate(request, 'context.propose', proposal, () => {
      this.store.insertProposal(proposal);
      return proposal;
    });
  }

  readProposal(request: ReadProposalRequest): ContextProposal | null {
    this.permitted(request, 'context.read');
    const proposal = this.store.getProposal(request.workspaceId, request.collaborationId, request.proposalId);
    this.permitted(request, 'context.read');
    return proposal;
  }

  readCurrentContext(request: Binding): ContextRevision | null {
    this.permitted(request, 'context.read');
    const revision = this.store.getCurrentRevision(request.workspaceId, request.collaborationId);
    this.permitted(request, 'context.read');
    return revision;
  }

  readRevision(request: ReadRevisionRequest): ContextRevision | null {
    this.permitted(request, 'context.read');
    const revision = this.store.getRevision(request.workspaceId, request.collaborationId, request.revisionId);
    this.permitted(request, 'context.read');
    return revision;
  }

  accept(request: AcceptContextRequest): ContextRevision {
    return this.mutate(request, 'context.accept', { proposalId: request.proposalId, revisionId: request.revisionId }, (permit) => {
      const proposal = this.store.getProposal(request.workspaceId, request.collaborationId, request.proposalId);
      if (!proposal) throw new Error('NOT_AVAILABLE');
      const revision = acceptContext(proposal, request.revisionId, permit, request.context.surface);
      this.store.insertRevision(revision, permit, request.context.surface);
      return revision;
    });
  }

  decide(request: DecideRequest): DecisionRecord {
    requestFields(request,['context','workspaceId','collaborationId','idempotencyKey','decisionId',
      'bundleId','bundleManifestHash','proposalId','snapshotId','contextRevisionId','reviewId',
      'outcome','reason','items']);
    const target=decisionTarget(request);
    const input = { id: request.decisionId, workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      ...target, snapshotId: request.snapshotId,
      contextRevisionId: request.contextRevisionId, ...(request.reviewId ? { reviewId: request.reviewId } : {}),
      outcome: request.outcome, reason: request.reason,
      ...(request.items === undefined ? {} : { items: request.items }),
      decidedBy: request.context.principal };
    return this.mutate(request, 'decision.record', input, (permit) => {
      const decision = recordDecision(input, permit, request.context.surface);
      return this.store.insertDecision(decision, permit, request.context.surface);
    });
  }

  proposeDecision(request: ProposeDecisionRequest): DecisionProposal {
    const fields=['context','workspaceId','collaborationId','idempotencyKey','proposalId',
      'contextRevisionId','snapshotId','recommendation','reason','bundleId','bundleManifestHash'];
    if (!request || typeof request!=='object' || Object.keys(request).some(key=>!fields.includes(key)))
      throw new Error('INVALID_ARGUMENT');
    const input = { id: request.proposalId, workspaceId: request.workspaceId,
      collaborationId: request.collaborationId, contextRevisionId: request.contextRevisionId,
      snapshotId: request.snapshotId, recommendation: request.recommendation, reason: request.reason,
      ...(request.bundleId === undefined ? {} : { bundleId: request.bundleId }),
      ...(request.bundleManifestHash === undefined ? {} : { bundleManifestHash: request.bundleManifestHash }),
      proposedBy: request.context.principal };
    return this.mutate(request, 'decision.propose', input, permit =>
      this.store.insertDecisionProposal(proposeDecision(input, permit), permit));
  }

  reviewBaseline(request: ReviewBaselineRequest): BaselineReview {
    requestFields(request,['context','workspaceId','collaborationId','idempotencyKey','reviewId',
      'bundleId','bundleManifestHash','proposalId','snapshotId','contextRevisionId']);
    const target=decisionTarget(request);
    const input = { id: request.reviewId, workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      ...target,
      snapshotId: request.snapshotId, contextRevisionId: request.contextRevisionId,
      reviewedBy: request.context.principal };
    return this.mutate(request, 'decision.review', input,
      (permit) => this.store.insertBaselineReview(input, permit, request.context.surface));
  }

  readDecision(request: ReadDecisionRequest): DecisionRecord | null {
    if (request.context.surface !== 'local_host' && request.context.surface !== 'local_cli') throw new Error('NOT_AVAILABLE');
    this.permitted(request, 'decision.get');
    const decision = this.store.getDecision(request.workspaceId, request.collaborationId, request.decisionId);
    this.permitted(request, 'decision.get');
    return decision;
  }

  readDecisionProposal(request: ReadDecisionProposalRequest): DecisionProposal | null {
    if (request.context.surface !== 'local_host' && request.context.surface !== 'local_cli')
      throw new Error('NOT_AVAILABLE');
    this.permitted(request, 'decision.get');
    const proposal = this.store.getDecisionProposal(request.workspaceId, request.collaborationId,
      request.proposalId);
    this.permitted(request, 'decision.get');
    return proposal;
  }

  listDecisions(request: ListDecisionsRequest & { kind: 'proposal' }): DecisionProposalPage;
  listDecisions(request: ListDecisionsRequest & { kind?: 'record' }): DecisionPage;
  listDecisions(request: ListDecisionsRequest): DecisionPage | DecisionProposalPage {
    if (request.kind === 'proposal') return this.listDecisionProposals(request);
    if (request.kind !== undefined && request.kind !== 'record')
      throw new Error('INVALID_ARGUMENT');
    if (request.context.surface !== 'local_host' && request.context.surface !== 'local_cli') throw new Error('NOT_AVAILABLE');
    this.permitted(request, 'decision.list');
    if (!this.cursorSigner) throw new Error('NOT_AVAILABLE');
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_ARGUMENT');
    let afterSeq = 0;
    let highWater = this.store.decisionHighWater(request.workspaceId, request.collaborationId);
    if (request.cursor !== undefined) {
      if (typeof request.cursor !== 'string' || request.cursor.length > 2048) throw new Error('INVALID_ARGUMENT');
      try {
        const envelope = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (!envelope || Object.keys(envelope).sort().join(',') !== 'body,signature' ||
            typeof envelope.signature !== 'string' || !envelope.body || typeof envelope.body !== 'object' ||
            Array.isArray(envelope.body)) throw new Error('INVALID_ARGUMENT');
        const body = envelope.body as Record<string, unknown>;
        if (!this.cursorSigner.verify(JSON.stringify(body), envelope.signature) ||
            Object.keys(body).sort().join(',') !==
              'afterSeq,audience,collaborationId,highWater,limit,principal,recipient,workspaceId' ||
            body.workspaceId !== request.workspaceId || body.collaborationId !== request.collaborationId ||
            body.principal !== request.context.principal || body.audience !== request.context.audience ||
            body.recipient !== request.context.recipient || body.limit !== limit ||
            !Number.isSafeInteger(body.afterSeq) || !Number.isSafeInteger(body.highWater) ||
            (body.afterSeq as number) < 0 || (body.highWater as number) < (body.afterSeq as number) ||
            Buffer.from(JSON.stringify(envelope)).toString('base64url') !== request.cursor) throw new Error('INVALID_ARGUMENT');
        afterSeq = body.afterSeq as number;
        highWater = body.highWater as number;
      } catch { throw new Error('INVALID_ARGUMENT'); }
    }
    const rows = this.store.listDecisions(request.workspaceId, request.collaborationId, afterSeq, highWater, limit + 1);
    const page = rows.slice(0, limit);
    const decisions = page.map(({ decisionSeq, decision }) => ({ decisionId: decision.id, decisionSeq,
      ...(decision.proposalId===undefined ? {bundleId:decision.bundleId} :
        {proposalId:decision.proposalId}),
      outcome: decision.outcome, contextRevisionId: decision.contextRevisionId,
      snapshotId: decision.snapshotId, implementationAuthorized: decision.implementationAuthorized }));
    this.permitted(request, 'decision.list');
    const body = { workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      principal: request.context.principal, audience: request.context.audience, recipient: request.context.recipient,
      limit, highWater, afterSeq: page.at(-1)?.decisionSeq };
    return { decisions, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ body,
      signature: this.cursorSigner.sign(JSON.stringify(body)) })).toString('base64url') : null };
  }

  private listDecisionProposals(request: ListDecisionsRequest): DecisionProposalPage {
    if (request.context.surface !== 'local_host' && request.context.surface !== 'local_cli')
      throw new Error('NOT_AVAILABLE');
    this.permitted(request, 'decision.list');
    if (!this.cursorSigner) throw new Error('NOT_AVAILABLE');
    const limit=request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>10) throw new Error('INVALID_ARGUMENT');
    let afterSeq=0;
    let highWater=this.store.decisionProposalHighWater(request.workspaceId,request.collaborationId);
    if (request.cursor!==undefined) {
      if (typeof request.cursor!=='string' || request.cursor.length>2048)
        throw new Error('INVALID_ARGUMENT');
      try {
        const envelope=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8')) as
          Record<string,unknown>;
        if (!envelope || Object.keys(envelope).sort().join(',')!=='body,signature' ||
            typeof envelope.signature!=='string' || !envelope.body ||
            typeof envelope.body!=='object' || Array.isArray(envelope.body))
          throw new Error('INVALID_ARGUMENT');
        const body=envelope.body as Record<string,unknown>;
        if (!this.cursorSigner.verify(JSON.stringify(body),envelope.signature) ||
            Object.keys(body).sort().join(',')!==
              'afterSeq,audience,collaborationId,highWater,kind,limit,principal,recipient,workspaceId' ||
            body.kind!=='proposal' || body.workspaceId!==request.workspaceId ||
            body.collaborationId!==request.collaborationId ||
            body.principal!==request.context.principal || body.audience!==request.context.audience ||
            body.recipient!==request.context.recipient || body.limit!==limit ||
            !Number.isSafeInteger(body.afterSeq) || !Number.isSafeInteger(body.highWater) ||
            (body.afterSeq as number)<0 || (body.highWater as number)<(body.afterSeq as number) ||
            Buffer.from(JSON.stringify(envelope)).toString('base64url')!==request.cursor)
          throw new Error('INVALID_ARGUMENT');
        afterSeq=body.afterSeq as number; highWater=body.highWater as number;
      } catch {throw new Error('INVALID_ARGUMENT');}
    }
    const rows=this.store.listDecisionProposals(request.workspaceId,request.collaborationId,
      afterSeq,highWater,limit+1);
    const page=rows.slice(0,limit);
    const proposals=page.map(({proposalSeq,proposal})=>({proposalId:proposal.id,proposalSeq,
      recommendation:proposal.recommendation,contextRevisionId:proposal.contextRevisionId,
      snapshotId:proposal.snapshotId,implementationAuthorized:false as const}));
    this.permitted(request,'decision.list');
    const body={kind:'proposal',workspaceId:request.workspaceId,collaborationId:request.collaborationId,
      principal:request.context.principal,audience:request.context.audience,
      recipient:request.context.recipient,limit,highWater,afterSeq:page.at(-1)?.proposalSeq};
    return {proposals,nextCursor:rows.length>limit?Buffer.from(JSON.stringify({body,
      signature:this.cursorSigner.sign(JSON.stringify(body))})).toString('base64url'):null};
  }
}

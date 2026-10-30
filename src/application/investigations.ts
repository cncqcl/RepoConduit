import { createHash } from 'node:crypto';
import { isDataPathPermitted, type Permit, type RequestContext } from '../core/policy/authorize.js';
import { newInvestigationRecord, parseInvestigationInput, type InvestigationBudget,
  type InvestigationInput, type InvestigationRecord, type InvestigationResult } from '../core/investigation/request.js';

type Operation = 'investigate.submit' | 'investigate.get' | 'investigate.result' | 'investigate.cancel' | 'repo.read';
type Binding = { workspaceId: string; collaborationId: string; workingCopyId: string };
type Bound = Binding & { context: RequestContext };
type Existing = Bound & { requestId: string };

export interface InvestigationDependencies {
  authorize(request: { context: RequestContext; operation: Operation; workspaceId: string; collaborationId: string }): Promise<Permit> | Permit;
  /** Must look up persisted, authorized objects; cannot infer them from native chat ids. */
  resolveBinding(request: Bound & { expected?: { snapshotRef: string; contextRevisionId: string } }): Promise<(Binding & { snapshotRef: string; contextRevisionId: string; recipient: string }) | null> |
    (Binding & { snapshotRef: string; contextRevisionId: string; recipient: string }) | null;
  /** Local trusted config only. An unverified isolation profile cannot schedule work. */
  selectProfile(request: Bound & { input: InvestigationInput; readPaths: readonly string[] }): Promise<{ profileRef: string; budgetRef: string; budget: InvestigationBudget; isolationVerified: boolean } | null> |
    { profileRef: string; budgetRef: string; budget: InvestigationBudget; isolationVerified: boolean } | null;
  /** Atomic durable request + outbox insert; same key/input replays, different input conflicts. */
  enqueue(record: InvestigationRecord, key: string, fingerprint: string): Promise<InvestigationRecord> | InvestigationRecord;
  get(id: string): Promise<InvestigationRecord | null> | InvestigationRecord | null;
  /** Compare-and-set expected state/revision in durable storage; never marks cancelled without worker confirmation. */
  requestCancel(record: InvestigationRecord, idempotencyKey: string, grantId: string): Promise<InvestigationRecord> | InvestigationRecord;
}

function unavailable(): never { throw new Error('NOT_AVAILABLE'); }
function validBudget(budget: InvestigationBudget): boolean {
  return Number.isSafeInteger(budget.maxWallSeconds) && budget.maxWallSeconds > 0 && budget.maxWallSeconds <= 600 &&
    Number.isSafeInteger(budget.maxTurns) && budget.maxTurns > 0 &&
    Number.isSafeInteger(budget.maxToolCalls) && budget.maxToolCalls > 0;
}

export class InvestigationApplication {
  constructor(private readonly dependencies: InvestigationDependencies, private readonly clock: () => Date = () => new Date()) {}

  private async permitted(request: Bound, operation: Operation): Promise<Permit> {
    const permit = await this.dependencies.authorize({ context: { ...request.context, now: this.clock() }, operation,
      workspaceId: request.workspaceId, collaborationId: request.collaborationId });
    const effect = operation === 'investigate.submit' ? 'agent_job' : operation === 'investigate.cancel' ? 'job_control' : 'read';
    if (!permit || permit.operation !== operation || permit.effect !== effect ||
      permit.principal !== request.context.principal || permit.recipient !== request.context.recipient ||
      permit.scope.workspaceId !== request.workspaceId || permit.scope.collaborationId !== request.collaborationId) unavailable();
    return permit;
  }

  private async bound(request: Bound & { expected?: { snapshotRef: string; contextRevisionId: string } }) {
    const bound = await this.dependencies.resolveBinding(request);
    if (!bound || bound.workspaceId !== request.workspaceId || bound.collaborationId !== request.collaborationId ||
      bound.workingCopyId !== request.workingCopyId || bound.recipient !== request.context.recipient) unavailable();
    return bound;
  }

  private async readScope(request: Bound, paths: readonly string[]): Promise<readonly string[]> {
    const permit = await this.permitted(request, 'repo.read');
    if (!Array.isArray(permit.dataPaths) || permit.dataPaths.length === 0 ||
      paths.some(path => !isDataPathPermitted(path, permit.dataPaths!))) unavailable();
    return permit.dataPaths;
  }

  private disclosedPaths(record: InvestigationRecord): string[] {
    return [...record.scope.paths, ...record.scope.relatedTests,
      ...(record.result?.coverage.searchedScope ?? []),
      ...(record.result?.evidence.map(entry => entry.path) ?? [])];
  }

  async submit(request: Bound & { idempotencyKey: string; input: unknown }): Promise<InvestigationRecord> {
    if (!request.idempotencyKey || request.idempotencyKey.length > 128) unavailable();
    const input = parseInvestigationInput(request.input);
    const permit = await this.permitted(request, 'investigate.submit');
    const bound = await this.bound(request);
    if (input.snapshotRef !== bound.snapshotRef || input.contextRevisionId !== bound.contextRevisionId) unavailable();
    const readPaths = await this.readScope(request, [...input.scope.paths, ...input.scope.relatedTests]);
    if (input.parentInvestigationId) {
      const parent = await this.dependencies.get(input.parentInvestigationId);
      if (!parent || parent.workspaceId !== request.workspaceId || parent.collaborationId !== request.collaborationId ||
        parent.workingCopyId !== request.workingCopyId || parent.recipient !== request.context.recipient ||
        parent.principal !== request.context.principal || parent.audience !== request.context.audience ||
        parent.snapshotRef !== input.snapshotRef || parent.contextRevisionId !== input.contextRevisionId) unavailable();
    }
    const profile = await this.dependencies.selectProfile({ ...request, input, readPaths });
    if (!profile || !profile.isolationVerified || !profile.profileRef || !profile.budgetRef || !validBudget(profile.budget)) unavailable();
    const record = newInvestigationRecord(input, { workspaceId: request.workspaceId,
      collaborationId: request.collaborationId, workingCopyId: request.workingCopyId,
      principal: request.context.principal, audience: request.context.audience, recipient: request.context.recipient,
      grantId: permit.grantId, profileRef: profile.profileRef, budgetRef: profile.budgetRef,
      budget: { ...profile.budget } }, this.clock());
    const fingerprint = createHash('sha256').update(JSON.stringify({ input, binding: request.workspaceId,
      collaborationId: request.collaborationId, workingCopyId: request.workingCopyId,
      principal: request.context.principal, audience: request.context.audience, recipient: request.context.recipient,
      profileRef: profile.profileRef, budgetRef: profile.budgetRef, budget: profile.budget })).digest('hex');
    await this.permitted(request, 'investigate.submit');
    await this.readScope(request, [...input.scope.paths, ...input.scope.relatedTests]);
    const saved = await this.dependencies.enqueue(record, request.idempotencyKey, fingerprint);
    await this.permitted(request, 'investigate.submit');
    await this.readScope(request, [...input.scope.paths, ...input.scope.relatedTests]);
    return { ...saved, result: null };
  }

  private async existing(request: Existing, operation: Operation) {
    await this.permitted(request, operation);
    const record = await this.dependencies.get(request.requestId);
    if (!record || record.workspaceId !== request.workspaceId || record.collaborationId !== request.collaborationId ||
      record.workingCopyId !== request.workingCopyId || record.recipient !== request.context.recipient ||
      record.principal !== request.context.principal || record.audience !== request.context.audience) unavailable();
    const bound = await this.bound({ ...request, expected: { snapshotRef: record.snapshotRef,
      contextRevisionId: record.contextRevisionId } });
    if (
      record.snapshotRef !== bound.snapshotRef || record.contextRevisionId !== bound.contextRevisionId) unavailable();
    return record;
  }

  async get(request: Existing): Promise<InvestigationRecord> {
    const record = await this.existing(request, 'investigate.get');
    const paths = this.disclosedPaths(record);
    await this.readScope(request, paths);
    await this.permitted(request, 'investigate.get');
    await this.readScope(request, paths);
    return record;
  }

  async result(request: Existing) {
    const record = await this.existing(request, 'investigate.result');
    const paths = this.disclosedPaths(record);
    await this.readScope(request, paths);
    await this.permitted(request, 'investigate.result');
    await this.readScope(request, paths);
    return record.result;
  }

  /** Validate the returned object and expose its complete declared read scope to the final transport guard. */
  async disclosurePaths(request: Existing, returned: InvestigationRecord | InvestigationResult | null): Promise<string[]> {
    const record = await this.existing(request, 'investigate.get');
    let observed: InvestigationResult | null = null;
    let paths = this.disclosedPaths(record);
    if (returned && 'id' in returned) {
      if (returned.id !== record.id || returned.snapshotRef !== record.snapshotRef ||
        returned.contextRevisionId !== record.contextRevisionId) unavailable();
      paths = [...paths, ...this.disclosedPaths(returned)];
      observed = returned.result;
    } else if (returned) {
      observed = returned;
    }
    if (observed) {
      if (observed.requestId !== record.id || observed.snapshotRef !== record.snapshotRef ||
        observed.contextRevisionId !== record.contextRevisionId) unavailable();
      paths = [...paths, ...observed.coverage.searchedScope, ...observed.evidence.map(entry => entry.path)];
    }
    await this.readScope(request, paths);
    return paths;
  }

  async cancel(request: Existing & { idempotencyKey: string }): Promise<{
    requestId: string; state: InvestigationRecord['state']; cancelRequested: boolean;
  }> {
    if (!request.idempotencyKey || request.idempotencyKey.length > 128) unavailable();
    const record = await this.existing(request, 'investigate.cancel');
    const permit = await this.permitted(request, 'investigate.cancel');
    const updated = await this.dependencies.requestCancel(record, request.idempotencyKey, permit.grantId);
    await this.permitted(request, 'investigate.cancel');
    return { requestId: updated.id, state: updated.state, cancelRequested: updated.cancelRequested };
  }
}

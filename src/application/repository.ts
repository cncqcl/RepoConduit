import type { Permit, RequestContext } from '../core/policy/authorize.js';
import { captureGitTree, RepositorySnapshot, type PersistedSnapshot } from '../adapters/repository/snapshots.js';
import { diffSnapshots, inspectSnapshot, listSnapshot, readSnapshot, readSnapshotOriginal, searchSnapshot } from '../adapters/repository/queries.js';

type Operation = 'snapshot.capture' | 'repo.inspect' | 'repo.list' | 'repo.read' | 'repo.read_original' | 'repo.search' | 'repo.status' | 'repo.diff';
type Binding = { workspaceId: string; collaborationId: string; workingCopyId: string };
type BoundRequest = Binding & { context: RequestContext };
type QueryRequest = BoundRequest & { snapshotId: string };

export type SnapshotRecord = Binding & { snapshot: PersistedSnapshot };
export type CaptureInput = Binding & { commitRef: string };
export type SnapshotReceipt = {
  snapshotId: string; workspaceId: string; collaborationId: string; workingCopyId: string;
  baseCommit: string; sourceConsistency: PersistedSnapshot['sourceConsistency']; excludedCategories: string[];
};

export interface RepositoryDependencies {
  /** Must derive grants and path scopes from trusted transport and current policy state. */
  authorize(request: { context: RequestContext; operation: Operation; workspaceId: string; collaborationId: string; snapshotId?: string }): Promise<Permit> | Permit;
  getWorkingCopy(workspaceId: string, workingCopyId: string): Promise<{ canonicalRoot: string } | null>;
  collaborationBelongsToWorkspace(workspaceId: string, collaborationId: string): Promise<boolean>;
  /** Save atomically and durably. The implementation must enforce idempotency key + input conflicts. */
  lookupCapture(input: CaptureInput, idempotencyKey: string, principal: string, audience: string): Promise<SnapshotReceipt | null> | SnapshotReceipt | null;
  saveSnapshot(record: SnapshotRecord, input: CaptureInput, idempotencyKey: string, principal: string, audience: string): Promise<SnapshotReceipt>;
  getSnapshot(snapshotId: string, workspaceId: string, collaborationId: string): Promise<SnapshotRecord | null>;
  captureTree?: typeof captureGitTree;
}

export class RepositoryApplication {
  constructor(private readonly dependencies: RepositoryDependencies, private readonly clock: () => Date = () => new Date()) {}

  private async permitted(request: BoundRequest, operation: Operation, snapshotId?: string) {
    const permit = await this.dependencies.authorize({ context: { ...request.context, now: this.clock() }, operation, workspaceId: request.workspaceId, collaborationId: request.collaborationId, ...(snapshotId ? { snapshotId } : {}) });
    if (!permit || permit.operation !== operation || permit.principal !== request.context.principal || permit.recipient !== request.context.recipient || permit.scope.workspaceId !== request.workspaceId || permit.scope.collaborationId !== request.collaborationId || permit.effect !== (operation === 'snapshot.capture' ? 'state_write' : 'read') ||
      (operation !== 'snapshot.capture' && (!Array.isArray(permit.dataPaths) || permit.dataPaths.length === 0))) {
      throw new Error('NOT_AVAILABLE');
    }
    return operation === 'snapshot.capture' ? [] : [...permit.dataPaths!];
  }

  private async boundSnapshot(request: QueryRequest, operation: Operation) {
    const scopePaths = await this.permitted(request, operation, request.snapshotId);
    const record = await this.dependencies.getSnapshot(request.snapshotId, request.workspaceId, request.collaborationId);
    if (!record || record.workspaceId !== request.workspaceId || record.collaborationId !== request.collaborationId || record.workingCopyId !== request.workingCopyId || record.snapshot.id !== request.snapshotId || record.snapshot.workingCopyId !== request.workingCopyId) throw new Error('NOT_AVAILABLE');
    const snapshot = RepositorySnapshot.fromPersisted(record.snapshot);
    return { snapshot, queryContext: { principal: request.context.principal, scopePaths } };
  }

  private async disclose<T>(request: QueryRequest, operation: Operation, originalScope: readonly string[], result: T): Promise<T> {
    const currentScope = await this.permitted(request, operation, request.snapshotId);
    if (JSON.stringify([...new Set(currentScope)].sort()) !== JSON.stringify([...new Set(originalScope)].sort())) throw new Error('NOT_AVAILABLE');
    return result;
  }

  async capture(request: BoundRequest & { idempotencyKey: string; commitRef?: string }) {
    if (!request.idempotencyKey || request.context.surface !== 'local_host' && request.context.surface !== 'local_cli') throw new Error('NOT_AVAILABLE');
    await this.permitted(request, 'snapshot.capture');
    const [workingCopy, collaborationBound] = await Promise.all([
      this.dependencies.getWorkingCopy(request.workspaceId, request.workingCopyId),
      this.dependencies.collaborationBelongsToWorkspace(request.workspaceId, request.collaborationId),
    ]);
    if (!workingCopy || !collaborationBound) throw new Error('NOT_AVAILABLE');
    const input: CaptureInput = { workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      workingCopyId: request.workingCopyId, commitRef: request.commitRef ?? 'HEAD' };
    const prior = await this.dependencies.lookupCapture(input, request.idempotencyKey, request.context.principal, request.context.audience);
    if (prior) {
      await this.permitted(request, 'snapshot.capture');
      return prior;
    }
    const snapshot = await (this.dependencies.captureTree ?? captureGitTree)(workingCopy.canonicalRoot, input.commitRef, { workingCopyId: request.workingCopyId });
    if (snapshot.workingCopyId !== request.workingCopyId) throw new Error('NOT_AVAILABLE');
    await this.permitted(request, 'snapshot.capture');
    const record: SnapshotRecord = { workspaceId: request.workspaceId, collaborationId: request.collaborationId, workingCopyId: request.workingCopyId, snapshot: snapshot.toPersisted() };
    const receipt = await this.dependencies.saveSnapshot(record, input, request.idempotencyKey, request.context.principal, request.context.audience);
    await this.permitted(request, 'snapshot.capture');
    return receipt;
  }

  async inspect(request: QueryRequest) {
    const { snapshot, queryContext } = await this.boundSnapshot(request, 'repo.inspect');
    return this.disclose(request, 'repo.inspect', queryContext.scopePaths, inspectSnapshot(snapshot, queryContext));
  }

  async list(request: QueryRequest & { maxEntries?: number; cursor?: string | undefined }) {
    const { snapshot, queryContext } = await this.boundSnapshot(request, 'repo.list');
    return this.disclose(request, 'repo.list', queryContext.scopePaths, listSnapshot(snapshot, queryContext, { ...(request.maxEntries !== undefined ? { maxEntries: request.maxEntries } : {}), cursor: request.cursor }));
  }

  async read(request: QueryRequest & { path: string; maxBytes?: number; maxLines?: number; cursor?: string | undefined }) {
    const { snapshot, queryContext } = await this.boundSnapshot(request, 'repo.read');
    const reservation = await request.context.reserveRepositoryRead?.({ workspaceId: request.workspaceId,
      collaborationId: request.collaborationId, workingCopyId: request.workingCopyId,
      snapshotId: request.snapshotId, path: request.path });
    const observed = readSnapshot(snapshot, queryContext, { path: request.path,
      ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
      ...(request.maxLines !== undefined ? { maxLines: request.maxLines } : {}), cursor: request.cursor });
    const disclosed = await this.disclose(request, 'repo.read', queryContext.scopePaths, observed);
    if (!reservation) return disclosed;
    const toolReceipt = await reservation.complete({ snapshotId: observed.snapshotId, path: observed.path,
      contentHash: observed.contentHash, byteRange: observed.byteRange,
      lineRange: observed.lineRange, content: observed.content,
      decoding: 'utf-8', completeness: observed.completeness });
    return { ...disclosed, toolReceipt };
  }

  async search(request: QueryRequest & { term: string; maxBytes?: number; maxMatches?: number; cursor?: string | undefined }) {
    const { snapshot, queryContext } = await this.boundSnapshot(request, 'repo.search');
    return this.disclose(request, 'repo.search', queryContext.scopePaths, searchSnapshot(snapshot, queryContext, { term: request.term, ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}), ...(request.maxMatches !== undefined ? { maxMatches: request.maxMatches } : {}), cursor: request.cursor }));
  }

  async readOriginal(request: QueryRequest & { path: string; maxBytes?: number }) {
    // Investigator receipt reservations are text-only; this route is not a worker tool.
    if (request.context.reserveRepositoryRead) throw new Error('UNSUPPORTED_CAPABILITY');
    const { snapshot, queryContext } = await this.boundSnapshot(request, 'repo.read_original');
    const original = readSnapshotOriginal(snapshot, queryContext, { path: request.path,
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }) });
    return this.disclose(request, 'repo.read_original', queryContext.scopePaths, original);
  }

  async status(request: QueryRequest) {
    const { snapshot, queryContext } = await this.boundSnapshot(request, 'repo.status');
    return this.disclose(request, 'repo.status', queryContext.scopePaths, inspectSnapshot(snapshot, queryContext));
  }

  async diff(request: QueryRequest & { beforeSnapshotId: string; maxEntries?: number; cursor?: string | undefined }) {
    const { snapshot: after, queryContext } = await this.boundSnapshot(request, 'repo.diff');
    const beforeScope = await this.permitted(request, 'repo.diff', request.beforeSnapshotId);
    if (JSON.stringify([...new Set(beforeScope)].sort()) !== JSON.stringify([...new Set(queryContext.scopePaths)].sort())) throw new Error('NOT_AVAILABLE');
    const beforeRecord = await this.dependencies.getSnapshot(request.beforeSnapshotId, request.workspaceId, request.collaborationId);
    if (!beforeRecord || beforeRecord.workspaceId !== request.workspaceId || beforeRecord.collaborationId !== request.collaborationId || beforeRecord.workingCopyId !== request.workingCopyId || beforeRecord.snapshot.id !== request.beforeSnapshotId) throw new Error('NOT_AVAILABLE');
    const before = RepositorySnapshot.fromPersisted(beforeRecord.snapshot);
    const result = diffSnapshots(before, after, queryContext, { ...(request.maxEntries !== undefined ? { maxEntries: request.maxEntries } : {}), cursor: request.cursor });
    const currentBeforeScope = await this.permitted(request, 'repo.diff', request.beforeSnapshotId);
    if (JSON.stringify([...new Set(currentBeforeScope)].sort()) !== JSON.stringify([...new Set(beforeScope)].sort())) throw new Error('NOT_AVAILABLE');
    return this.disclose(request, 'repo.diff', queryContext.scopePaths, result);
  }
}

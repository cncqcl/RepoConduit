import { join } from 'node:path';
import { materializeWindowsFrozenSource, type WindowsFrozenSourceView } from
  '../adapters/codex/investigator/windows-source-view.js';
import type { InvestigationClaim, SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';
import type { SnapshotRecord } from '../application/repository.js';
import { buildInvestigationSourcePlan, type InvestigationSourceBinding, type InvestigationSourcePlan } from
  '../application/investigation-source-plan.js';

type PreparationStore = Pick<SqliteInvestigationStore, 'get' | 'preflightSourceRead' |
  'reserveWindowsSourceView' | 'confirmWindowsSourcePrepared'>;
type SnapshotStore = { getSnapshot(snapshotId: string, workspaceId: string,
  collaborationId: string): Promise<SnapshotRecord | null> };

export interface WindowsInvestigationSourcePreparationInput {
  store: PreparationStore;
  snapshots: SnapshotStore;
  claim: InvestigationClaim;
  expected: InvestigationSourceBinding;
  privateRoot: string;
  now?: () => Date;
}

export interface WindowsInvestigationSourcePreparationOperations {
  materialize(plan: InvestigationSourcePlan, privateRoot: string): Promise<WindowsFrozenSourceView>;
}

const nativeOperations: WindowsInvestigationSourcePreparationOperations = {
  materialize: async (plan, root) => materializeWindowsFrozenSource(plan, root),
};

/** Host-owned frozen staging only. No profile, sandbox reader, model turn or launch gate is created. */
export async function prepareWindowsInvestigationSource(input: WindowsInvestigationSourcePreparationInput,
  operations: WindowsInvestigationSourcePreparationOperations = nativeOperations): Promise<{
    claim: InvestigationClaim; plan: InvestigationSourcePlan; view: WindowsFrozenSourceView;
  }> {
  const { store, claim, expected } = input;
  if (claim.phase !== 'start_intent' || claim.launchProtocol !== 'resource_reservation_v1' ||
    claim.nativeRef !== null || claim.wslResource || claim.sourceView || claim.containerName) {
    throw new Error('NOT_AVAILABLE');
  }
  const record = store.get(claim.requestId);
  if (!record) throw new Error('NOT_AVAILABLE');
  const now = input.now ?? (() => new Date());
  const selectedPaths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  store.preflightSourceRead(claim, selectedPaths, now());
  const saved = await input.snapshots.getSnapshot(record.snapshotRef, record.workspaceId, record.collaborationId);
  if (!saved || saved.workspaceId !== record.workspaceId || saved.collaborationId !== record.collaborationId ||
    saved.workingCopyId !== record.workingCopyId || saved.snapshot.id !== record.snapshotRef ||
    saved.snapshot.workingCopyId !== record.workingCopyId) throw new Error('NOT_AVAILABLE');
  const plan = buildInvestigationSourcePlan({ record, claim, snapshot: saved.snapshot, expected });
  const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    workerEpoch: claim.workerEpoch, sourceDigest: plan.digest };
  const reserved = store.reserveWindowsSourceView(claim, descriptor, input.privateRoot, selectedPaths, now());
  const view = await operations.materialize(plan, input.privateRoot);
  if (view.isolationVerified !== false || view.sourceDigest !== descriptor.sourceDigest ||
    view.viewPath !== join(input.privateRoot, `${claim.attemptId}.view`)) throw new Error('NOT_AVAILABLE');
  const current = store.confirmWindowsSourcePrepared(reserved, view, now());
  return { claim: current, plan, view };
}

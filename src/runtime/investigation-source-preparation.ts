import { runWslLaunchGate } from '../adapters/codex/investigator/launch-gate-runner.js';
import type { WslLaunchGateDescriptor, WslLaunchGateState } from '../adapters/codex/investigator/launch-gate.js';
import { runWslSourceView } from '../adapters/codex/investigator/source-view-runner.js';
import type { SourceViewDescriptor, SourceViewState } from '../adapters/codex/investigator/source-view.js';
import type { InvestigationClaim, SqliteInvestigationStore, WslLaunchGateBinding,
  WslResourceReservation } from '../adapters/storage/investigation-sqlite.js';
import type { SnapshotRecord } from '../application/repository.js';
import { buildInvestigationSourcePlan, type InvestigationSourceBinding,
  type InvestigationSourcePlan } from '../application/investigation-source-plan.js';

type PreparationStore = Pick<SqliteInvestigationStore, 'get' | 'preflightSourceRead' |
  'reserveWslResource' | 'reserveSourceView'>;
type SnapshotStore = { getSnapshot(snapshotId: string, workspaceId: string,
  collaborationId: string): Promise<SnapshotRecord | null> };

export interface InvestigationSourcePreparationInput {
  store: PreparationStore;
  snapshots: SnapshotStore;
  claim: InvestigationClaim;
  expected: InvestigationSourceBinding;
  reservation: WslResourceReservation & { gate: NonNullable<WslResourceReservation['gate']> };
  expectedPayloadKind?: WslLaunchGateBinding['payloadKind'];
  sourceRoot: string;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface InvestigationSourcePreparationOperations {
  materialize(descriptor: SourceViewDescriptor, root: string,
    plan: InvestigationSourcePlan, signal?: AbortSignal): Promise<SourceViewState | null>;
  prepareGate(descriptor: WslLaunchGateDescriptor, root: string,
    signal?: AbortSignal): Promise<WslLaunchGateState | null>;
}

const nativeOperations: InvestigationSourcePreparationOperations = {
  materialize: (descriptor, root, plan, signal) => runWslSourceView('materialize', descriptor, root, plan, signal),
  prepareGate: (descriptor, root, signal) => runWslLaunchGate('prepare', descriptor, root, signal),
};

function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('NOT_AVAILABLE');
}

/** Trusted source and gate preparation for one claimed attempt. It never launches an investigator. */
export async function prepareInvestigationSource(input: InvestigationSourcePreparationInput,
  operations: InvestigationSourcePreparationOperations = nativeOperations): Promise<{
    claim: InvestigationClaim; plan: InvestigationSourcePlan; source: SourceViewState; gate: WslLaunchGateState;
  }> {
  const { store, claim, expected, reservation } = input;
  const expectedPayloadKind = input.expectedPayloadKind ?? 'canary_v1';
  // Only the canary gate has a trusted prepare operation in this entry point.
  // Supervisor journals require their own preparation contract and receipt.
  if (expectedPayloadKind !== 'canary_v1') throw new Error('NOT_AVAILABLE');
  if (!reservation.gate || reservation.gate.protocol !== 'attempt_gate_v1' ||
    reservation.gate.payloadKind !== expectedPayloadKind || claim.phase !== 'start_intent' ||
    claim.launchProtocol !== 'resource_reservation_v1' || claim.nativeRef !== null) throw new Error('NOT_AVAILABLE');
  const record = store.get(claim.requestId);
  if (!record) throw new Error('NOT_AVAILABLE');
  const now = input.now ?? (() => new Date());
  requireNotAborted(input.signal);
  store.preflightSourceRead(claim,
    [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort(), now());
  const saved = await input.snapshots.getSnapshot(record.snapshotRef, record.workspaceId, record.collaborationId);
  requireNotAborted(input.signal);
  if (!saved || saved.workspaceId !== record.workspaceId ||
    saved.collaborationId !== record.collaborationId || saved.workingCopyId !== record.workingCopyId ||
    saved.snapshot.id !== record.snapshotRef || saved.snapshot.workingCopyId !== record.workingCopyId) {
    throw new Error('NOT_AVAILABLE');
  }
  const plan = buildInvestigationSourcePlan({ record, claim, snapshot: saved.snapshot, expected });
  const descriptor: SourceViewDescriptor = { distro: reservation.distro,
    linuxUser: reservation.gate.linuxUser, uid: reservation.uid, attemptId: claim.attemptId,
    workspaceId: claim.workspaceId, workerEpoch: claim.workerEpoch,
    sourceDigest: plan.digest, bootId: reservation.bootId };
  const gateDescriptor: WslLaunchGateDescriptor = { attemptId: claim.attemptId,
    workspaceId: claim.workspaceId, distro: reservation.distro,
    linuxUser: reservation.gate.linuxUser, uid: reservation.uid,
    bootId: reservation.bootId, unitName: reservation.unitName };
  requireNotAborted(input.signal);
  let current = store.reserveWslResource(claim, reservation, now());
  current = store.reserveSourceView(current, descriptor, input.sourceRoot,
    now(), plan.files.map(file => file.path));
  requireNotAborted(input.signal);
  const source = await operations.materialize(descriptor, input.sourceRoot, plan, input.signal);
  requireNotAborted(input.signal);
  if (!source || source.kind !== 'ready' || source.attemptId !== descriptor.attemptId ||
    source.workspaceId !== descriptor.workspaceId || source.uid !== descriptor.uid ||
    source.workerEpoch !== descriptor.workerEpoch || source.bootId !== descriptor.bootId ||
    source.digest !== descriptor.sourceDigest) throw new Error('NOT_AVAILABLE');
  // Reenter the SQLite write transaction after the external side effect. Grant, scope,
  // cancellation, permission epoch and lease must still authorize the exact paths.
  current = store.reserveSourceView(current, descriptor, input.sourceRoot,
    now(), plan.files.map(file => file.path));
  requireNotAborted(input.signal);
  const gate = await operations.prepareGate(gateDescriptor, reservation.gate.root, input.signal);
  requireNotAborted(input.signal);
  if (!gate || gate.kind !== 'open' || gate.attemptId !== gateDescriptor.attemptId ||
    gate.workspaceId !== gateDescriptor.workspaceId || gate.uid !== gateDescriptor.uid ||
    gate.bootId !== gateDescriptor.bootId || gate.unitName !== gateDescriptor.unitName) {
    throw new Error('NOT_AVAILABLE');
  }
  // Opening the gate is an external await; it cannot make a stale claim ready.
  // A future model launch must perform its own final authorization and fence check.
  current = store.reserveSourceView(current, descriptor, input.sourceRoot,
    now(), plan.files.map(file => file.path));
  return { claim: current, plan, source, gate };
}

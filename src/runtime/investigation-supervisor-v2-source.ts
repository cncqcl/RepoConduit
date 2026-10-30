import { runWslSourceView } from '../adapters/codex/investigator/source-view-runner.js';
import type { SourceViewDescriptor, SourceViewState } from '../adapters/codex/investigator/source-view.js';
import { runNativeSupervisorGate } from '../adapters/secondary-investigator/claude-native-supervisor-runner.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../adapters/secondary-investigator/fixed-zero-model-profile.js';
import type { NativeSupervisorGateDescriptor, NativeSupervisorGateState } from
  '../adapters/secondary-investigator/claude-native-supervisor.js';
import type { InvestigationClaim, SqliteInvestigationStore, WslResourceReservation } from
  '../adapters/storage/investigation-sqlite.js';
import type { SnapshotRecord } from '../application/repository.js';
import { buildInvestigationSourcePlan, type InvestigationSourceBinding,
  type InvestigationSourcePlan } from '../application/investigation-source-plan.js';

type PreparationStore = Pick<SqliteInvestigationStore, 'get' | 'preflightSourceRead' |
  'reserveWslResource' | 'reserveSourceView'>;
type SnapshotStore = { getSnapshot(snapshotId: string, workspaceId: string,
  collaborationId: string): Promise<SnapshotRecord | null> };

export { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../adapters/secondary-investigator/fixed-zero-model-profile.js';

export interface InvestigationSupervisorV2SourceInput {
  store: PreparationStore;
  snapshots: SnapshotStore;
  claim: InvestigationClaim;
  expected: InvestigationSourceBinding;
  reservation: WslResourceReservation & { gate: NonNullable<WslResourceReservation['gate']> };
  sourceRoot: string;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface InvestigationSupervisorV2SourceOperations {
  materialize(descriptor: SourceViewDescriptor, root: string,
    plan: InvestigationSourcePlan, signal?: AbortSignal): Promise<SourceViewState | null>;
  prepareGate(descriptor: NativeSupervisorGateDescriptor, root: string,
    signal?: AbortSignal): Promise<NativeSupervisorGateState | null>;
}

const nativeOperations: InvestigationSupervisorV2SourceOperations = {
  materialize: (descriptor, root, plan, signal) => runWslSourceView('materialize', descriptor, root, plan, signal),
  prepareGate: async (descriptor, root, signal) => {
    const state = await runNativeSupervisorGate('prepare', descriptor, root, undefined, signal);
    return state?.protocol === 'native_supervisor_v2' ? state : null;
  },
};

function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('NOT_AVAILABLE');
}

/** Prepare a persisted frozen source and fixed zero-model journal. This does not enter or launch a model. */
export async function prepareInvestigationSupervisorV2Source(input: InvestigationSupervisorV2SourceInput,
  operations: InvestigationSupervisorV2SourceOperations = nativeOperations): Promise<{
    claim: InvestigationClaim; plan: InvestigationSourcePlan;
    source: SourceViewState; gate: NativeSupervisorGateState;
  }> {
  const { store, claim, expected, reservation } = input;
  const launch = reservation.gate?.launch;
  if (claim.phase !== 'start_intent' || claim.launchProtocol !== 'resource_reservation_v1' ||
    claim.nativeRef !== null || claim.wslResource || claim.sourceView || claim.windowsSource ||
    claim.containerName || !reservation.gate || reservation.gate.protocol !== 'attempt_gate_v1' ||
    reservation.gate.payloadKind !== 'native_supervisor_v2' || !launch ||
    launch.action !== 'fixed_zero_model_v1' || launch.workerEpoch !== claim.workerEpoch ||
    launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST) throw new Error('NOT_AVAILABLE');
  const record = store.get(claim.requestId);
  if (!record) throw new Error('NOT_AVAILABLE');
  const now = input.now ?? (() => new Date());
  const selectedPaths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  requireNotAborted(input.signal);
  store.preflightSourceRead(claim, selectedPaths, now());
  const saved = await input.snapshots.getSnapshot(record.snapshotRef, record.workspaceId, record.collaborationId);
  requireNotAborted(input.signal);
  if (!saved || saved.workspaceId !== record.workspaceId ||
    saved.collaborationId !== record.collaborationId || saved.workingCopyId !== record.workingCopyId ||
    saved.snapshot.id !== record.snapshotRef || saved.snapshot.workingCopyId !== record.workingCopyId) {
    throw new Error('NOT_AVAILABLE');
  }
  // Snapshot acquisition is external; current authority must still permit these paths.
  store.preflightSourceRead(claim, selectedPaths, now());
  const plan = buildInvestigationSourcePlan({ record, claim, snapshot: saved.snapshot, expected });
  if (launch.sourceDigest !== plan.digest) throw new Error('NOT_AVAILABLE');
  const descriptor: SourceViewDescriptor = { distro: reservation.distro,
    linuxUser: reservation.gate.linuxUser, uid: reservation.uid, attemptId: claim.attemptId,
    workspaceId: claim.workspaceId, workerEpoch: claim.workerEpoch,
    sourceDigest: plan.digest, bootId: reservation.bootId };
  const gateDescriptor: NativeSupervisorGateDescriptor = { attemptId: claim.attemptId,
    workspaceId: claim.workspaceId, distro: reservation.distro, linuxUser: reservation.gate.linuxUser,
    uid: reservation.uid, bootId: reservation.bootId, unitName: reservation.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest };
  requireNotAborted(input.signal);
  let current = store.reserveWslResource(claim, reservation, now());
  current = store.reserveSourceView(current, descriptor, input.sourceRoot, now(), selectedPaths);
  requireNotAborted(input.signal);
  const source = await operations.materialize(descriptor, input.sourceRoot, plan, input.signal);
  requireNotAborted(input.signal);
  if (!source || source.kind !== 'ready' || source.attemptId !== descriptor.attemptId ||
    source.workspaceId !== descriptor.workspaceId || source.uid !== descriptor.uid ||
    source.workerEpoch !== descriptor.workerEpoch || source.bootId !== descriptor.bootId ||
    source.digest !== descriptor.sourceDigest) throw new Error('NOT_AVAILABLE');
  current = store.reserveSourceView(current, descriptor, input.sourceRoot, now(), selectedPaths);
  requireNotAborted(input.signal);
  const gate = await operations.prepareGate(gateDescriptor, reservation.gate.root, input.signal);
  requireNotAborted(input.signal);
  if (!gate || gate.protocol !== 'native_supervisor_v2' || gate.phase !== 'prepared' || gate.closed ||
    gate.attemptId !== gateDescriptor.attemptId || gate.workspaceId !== gateDescriptor.workspaceId ||
    gate.uid !== gateDescriptor.uid || gate.bootId !== gateDescriptor.bootId ||
    gate.unitName !== gateDescriptor.unitName || gate.launchWorkerEpoch !== gateDescriptor.launchWorkerEpoch ||
    gate.sourceDigest !== gateDescriptor.sourceDigest || gate.profileDigest !== gateDescriptor.profileDigest) {
    throw new Error('NOT_AVAILABLE');
  }
  current = store.reserveSourceView(current, descriptor, input.sourceRoot, now(), selectedPaths);
  return { claim: current, plan, source, gate };
}

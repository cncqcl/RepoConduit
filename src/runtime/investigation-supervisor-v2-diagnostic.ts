import { spawn } from 'node:child_process';
import { runWslSourceView } from '../adapters/codex/investigator/source-view-runner.js';
import { nativeSupervisorGateSpec, type NativeSupervisorGateDescriptor,
  type NativeSupervisorGateState, type NativeSupervisorUnitIdentity } from
  '../adapters/secondary-investigator/claude-native-supervisor.js';
import { runNativeSupervisorGate } from
  '../adapters/secondary-investigator/claude-native-supervisor-runner.js';
import { observeSupervisorV2Running, type SupervisorV2ExpectedIdentity,
  type SupervisorV2RunningObservation } from
  '../adapters/secondary-investigator/supervisor-v2-running-observer.js';
import type { InvestigationClaim, ClaimInput, SqliteInvestigationStore, WslResource,
  WslResourceReservation } from '../adapters/storage/investigation-sqlite.js';
import type { SnapshotRecord } from '../application/repository.js';
import { buildInvestigationSourcePlan, type InvestigationSourceBinding,
  type InvestigationSourcePlan } from '../application/investigation-source-plan.js';
import { readWslCanaryBridge } from './investigation-canary-supervisor.js';
import { prepareInvestigationSupervisorV2Source,
  type InvestigationSupervisorV2SourceOperations } from './investigation-supervisor-v2-source.js';

type DiagnosticStore = Pick<SqliteInvestigationStore, 'claimRequest' | 'get' | 'preflightSourceRead' |
  'reserveWslResource' | 'reserveSourceView' | 'preflightNativeLaunch' |
  'observeWslResource' | 'recordSupervisorV2RunningFact' |
  'preflightSupervisorRelease' | 'markRecoveryRequired' |
  'renewLease' | 'listUnsettled'>;
type SnapshotStore = { getSnapshot(snapshotId: string, workspaceId: string,
  collaborationId: string): Promise<SnapshotRecord | null> };
type ExpectedBinding = Omit<InvestigationSourceBinding, 'attemptId' | 'workerEpoch'>;
type V2Reservation = WslResourceReservation & { gate: NonNullable<WslResourceReservation['gate']> };

export interface ClaimedSupervisorV2DiagnosticInput {
  requestId: string;
  store: DiagnosticStore;
  snapshots: SnapshotStore;
  expected: ExpectedBinding;
  claim: Omit<ClaimInput, 'launchProtocol'>;
  /** Trusted local configuration. Called only with a current, snapshot-verified plan. */
  reservationForPlan(claim: InvestigationClaim, plan: InvestigationSourcePlan): {
    reservation: V2Reservation; sourceRoot: string;
  };
  now?: () => Date;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
}

export interface SupervisorV2DiagnosticOperations {
  source: InvestigationSupervisorV2SourceOperations;
  launchUnit(descriptor: NativeSupervisorGateDescriptor, root: string,
    signal?: AbortSignal): Promise<'exited' | 'unknown'>;
  status(descriptor: NativeSupervisorGateDescriptor, root: string,
    signal?: AbortSignal): Promise<NativeSupervisorGateState | null>;
  observeRunning(resource: WslResource, journal: NativeSupervisorGateState,
    expected: SupervisorV2ExpectedIdentity): Promise<SupervisorV2RunningObservation>;
  release(descriptor: NativeSupervisorGateDescriptor, root: string,
    observed: NativeSupervisorUnitIdentity, signal?: AbortSignal): Promise<NativeSupervisorGateState | null>;
  close(descriptor: NativeSupervisorGateDescriptor, root: string): Promise<NativeSupervisorGateState | null>;
}

/** Only a fixed journal enter is allowed inside the original systemd unit. */
export async function runFixedSupervisorV2Unit(descriptor: NativeSupervisorGateDescriptor,
  root: string, signal?: AbortSignal): Promise<'exited' | 'unknown'> {
  const enter = nativeSupervisorGateSpec('enter', descriptor, root);
  if (signal?.aborted) return 'unknown';
  try {
    const child = spawn(enter.executable, ['-d', descriptor.distro, '--user', descriptor.linuxUser,
      '--cd', '/', '--exec', '/usr/bin/systemd-run', '--user', '--quiet',
      '--remain-after-exit', '--unit', descriptor.unitName, '--property=RuntimeMaxSec=12s', '--',
      '/usr/bin/python3', ...enter.args.slice(8)],
    { env: enter.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return readWslCanaryBridge(child, signal, 4000);
  } catch { return 'unknown'; }
}

const nativeOperations: SupervisorV2DiagnosticOperations = {
  source: {
    materialize: (descriptor, root, plan, signal) =>
      runWslSourceView('materialize', descriptor, root, plan, signal),
    prepareGate: async (descriptor, root, signal) => {
      const state = await runNativeSupervisorGate('prepare', descriptor, root, undefined, signal);
      return state?.protocol === 'native_supervisor_v2' ? state : null;
    },
  },
  launchUnit: runFixedSupervisorV2Unit,
  status: async (descriptor, root, signal) => {
    const state = await runNativeSupervisorGate('status', descriptor, root, undefined, signal);
    return state?.protocol === 'native_supervisor_v2' ? state : null;
  },
  observeRunning: observeSupervisorV2Running,
  release: async (descriptor, root, observed, signal) => {
    const state = await runNativeSupervisorGate('release', descriptor, root, observed, signal);
    return state?.protocol === 'native_supervisor_v2' ? state : null;
  },
  close: async (descriptor, root) => {
    const state = await runNativeSupervisorGate('close', descriptor, root);
    return state?.protocol === 'native_supervisor_v2' ? state : null;
  },
};

function requireCurrent(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('NOT_AVAILABLE');
}

function exactJournal(state: NativeSupervisorGateState | null,
  descriptor: NativeSupervisorGateDescriptor, phase: NativeSupervisorGateState['phase']): boolean {
  return !!state && state.protocol === 'native_supervisor_v2' && state.phase === phase &&
    !state.closed && state.attemptId === descriptor.attemptId &&
    state.workspaceId === descriptor.workspaceId && state.uid === descriptor.uid &&
    state.bootId === descriptor.bootId && state.unitName === descriptor.unitName &&
    state.launchWorkerEpoch === descriptor.launchWorkerEpoch &&
    state.sourceDigest === descriptor.sourceDigest && state.profileDigest === descriptor.profileDigest;
}

async function awaitJournalPhase(operations: SupervisorV2DiagnosticOperations,
  descriptor: NativeSupervisorGateDescriptor, root: string,
  phase: 'entered' | 'consumed', checkpoint: () => void,
  signal?: AbortSignal): Promise<NativeSupervisorGateState> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    requireCurrent(signal);
    const state = await operations.status(descriptor, root, signal);
    requireCurrent(signal);
    checkpoint();
    if (state && exactJournal(state, descriptor, phase)) return state;
    if (!state || state.closed || (phase === 'entered' && state.phase !== 'prepared') ||
      (phase === 'consumed' && state.phase !== 'released')) throw new Error('NOT_AVAILABLE');
    await new Promise(resolve => setTimeout(resolve, 50));
    checkpoint();
  }
  throw new Error('NOT_AVAILABLE');
}

/** Zero-model diagnostic only. Even confirmed consumption retains recovery_required and the slot. */
export async function runClaimedSupervisorV2Diagnostic(input: ClaimedSupervisorV2DiagnosticInput,
  operations: SupervisorV2DiagnosticOperations = nativeOperations): Promise<{
    claim: InvestigationClaim; sourceDigest: string;
    observedUnit: NativeSupervisorUnitIdentity; consumed: true; closed: true;
  }> {
  if (!input.requestId || input.expected.requestId !== input.requestId) throw new Error('NOT_AVAILABLE');
  requireCurrent(input.signal);
  const now = input.now ?? (() => new Date());
  const heartbeatMs = input.heartbeatIntervalMs ?? 10_000;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 10_000) {
    throw new Error('INVALID_ARGUMENT');
  }
  const claimed = input.store.claimRequest(input.requestId,
    { ...input.claim, launchProtocol: 'resource_reservation_v1' });
  if (!claimed) throw new Error('NOT_AVAILABLE');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  let closeTarget: { descriptor: NativeSupervisorGateDescriptor; root: string } | undefined;
  let result: { claim: InvestigationClaim; sourceDigest: string;
    observedUnit: NativeSupervisorUnitIdentity; consumed: true; closed: true } | undefined;
  let failure: unknown;
  const record = input.store.get(input.requestId);
  const selected = record ? [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort() : [];
  const deadline = setTimeout(() => controller.abort(),
    record && Number.isSafeInteger(record.budget.maxWallSeconds) &&
    record.budget.maxWallSeconds >= 1 && record.budget.maxWallSeconds <= 600 ?
      record.budget.maxWallSeconds * 1000 : 1);
  const heartbeat = setInterval(() => {
    if (controller.signal.aborted) return;
    try {
      input.store.preflightSourceRead(claimed, selected, now());
      input.store.renewLease(claimed, now());
    } catch { controller.abort(); }
  }, heartbeatMs);
  try {
    if (!record || !Number.isSafeInteger(record.budget.maxWallSeconds) ||
      record.budget.maxWallSeconds < 1 || record.budget.maxWallSeconds > 600) throw new Error('NOT_AVAILABLE');
    requireCurrent(controller.signal);
    input.store.preflightSourceRead(claimed, selected, now());
    const saved = await input.snapshots.getSnapshot(record.snapshotRef, record.workspaceId, record.collaborationId);
    requireCurrent(controller.signal);
    input.store.preflightSourceRead(claimed, selected, now());
    if (!saved || saved.workspaceId !== record.workspaceId ||
      saved.collaborationId !== record.collaborationId || saved.workingCopyId !== record.workingCopyId ||
      saved.snapshot.id !== record.snapshotRef || saved.snapshot.workingCopyId !== record.workingCopyId)
      throw new Error('NOT_AVAILABLE');
    const expected = { ...input.expected, attemptId: claimed.attemptId, workerEpoch: claimed.workerEpoch };
    const initialPlan = buildInvestigationSourcePlan({ record, claim: claimed,
      snapshot: saved.snapshot, expected });
    const { reservation, sourceRoot } = input.reservationForPlan(claimed, initialPlan);
    requireCurrent(controller.signal);
    const launch = reservation.gate?.launch;
    if (!launch || launch.workerEpoch !== claimed.workerEpoch ||
      launch.sourceDigest !== initialPlan.digest) throw new Error('NOT_AVAILABLE');
    const descriptor: NativeSupervisorGateDescriptor = { attemptId: claimed.attemptId,
      workspaceId: claimed.workspaceId, distro: reservation.distro,
      linuxUser: reservation.gate.linuxUser, uid: reservation.uid,
      bootId: reservation.bootId, unitName: reservation.unitName,
      launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
      profileDigest: launch.profileDigest };
    nativeSupervisorGateSpec('close', descriptor, reservation.gate.root);
    // Source preparation may have opened the journal before its final authority
    // recheck fails. Keep an exact close target before any native gate effect.
    closeTarget = { descriptor, root: reservation.gate.root };
    const prepared = await prepareInvestigationSupervisorV2Source({ store: input.store,
      snapshots: input.snapshots, claim: claimed, expected, reservation, sourceRoot,
      now, signal: controller.signal }, operations.source);
    const paths = prepared.plan.files.map(file => file.path).sort();
    requireCurrent(controller.signal);
    input.store.preflightNativeLaunch(prepared.claim, paths, input.claim.profileRevision,
      prepared.plan.digest, now());
    const bridge = await operations.launchUnit(descriptor, reservation.gate.root, controller.signal);
    requireCurrent(controller.signal);
    input.store.preflightSourceRead(prepared.claim, paths, now());
    if (bridge !== 'exited') throw new Error('NOT_AVAILABLE');
    const entered = await awaitJournalPhase(operations, descriptor, reservation.gate.root,
      'entered', () => input.store.preflightSourceRead(prepared.claim, paths, now()), controller.signal);
    if (!entered.invocationId || !entered.controlGroup) throw new Error('NOT_AVAILABLE');
    const observedUnit = { invocationId: entered.invocationId, controlGroup: entered.controlGroup };
    const observedClaim = input.store.observeWslResource(prepared.claim, observedUnit, now());
    if (!observedClaim.wslResource) throw new Error('NOT_AVAILABLE');
    const running = await operations.observeRunning(observedClaim.wslResource, entered,
      { attemptId: claimed.attemptId, workspaceId: claimed.workspaceId });
    requireCurrent(controller.signal);
    if (running.kind !== 'original_unit_running' ||
      running.native.invocationId !== observedUnit.invocationId ||
      running.native.controlGroup !== observedUnit.controlGroup ||
      running.native.bootId !== descriptor.bootId || running.native.uid !== descriptor.uid ||
      running.native.unitName !== descriptor.unitName ||
      running.native.mainPid !== entered.enterPid ||
      running.native.startTicks !== entered.enterStartTicks ||
      running.native.procControlGroup !== entered.controlGroup)
      throw new Error('NOT_AVAILABLE');
    input.store.recordSupervisorV2RunningFact(observedClaim, running, paths, now());
    input.store.preflightSupervisorRelease(observedClaim, observedUnit, launch, paths, now());
    const released = await operations.release(descriptor, reservation.gate.root,
      observedUnit, controller.signal);
    requireCurrent(controller.signal);
    input.store.preflightSourceRead(observedClaim, paths, now());
    if (!released || (released.phase !== 'released' && released.phase !== 'consumed') ||
      !exactJournal(released, descriptor, released.phase) ||
      released.invocationId !== observedUnit.invocationId ||
      released.controlGroup !== observedUnit.controlGroup) throw new Error('NOT_AVAILABLE');
    const consumed = released.phase === 'consumed' ? released :
      await awaitJournalPhase(operations, descriptor, reservation.gate.root, 'consumed',
        () => input.store.preflightSourceRead(observedClaim, paths, now()), controller.signal);
    input.store.preflightSourceRead(observedClaim, paths, now());
    if (!exactJournal(consumed, descriptor, 'consumed') ||
      consumed.invocationId !== observedUnit.invocationId ||
      consumed.controlGroup !== observedUnit.controlGroup) throw new Error('NOT_AVAILABLE');
    result = { claim: observedClaim, sourceDigest: prepared.plan.digest,
      observedUnit, consumed: true, closed: true };
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    input.signal?.removeEventListener('abort', onAbort);
    if (closeTarget) {
      try {
        // Cleanup is independent of the aborted diagnostic signal.
        const closed = await operations.close(closeTarget.descriptor, closeTarget.root);
        if (!closed || closed.protocol !== 'native_supervisor_v2' || !closed.closed ||
          closed.attemptId !== closeTarget.descriptor.attemptId ||
          closed.workspaceId !== closeTarget.descriptor.workspaceId ||
          closed.bootId !== closeTarget.descriptor.bootId ||
          closed.uid !== closeTarget.descriptor.uid ||
          closed.unitName !== closeTarget.descriptor.unitName ||
          closed.launchWorkerEpoch !== closeTarget.descriptor.launchWorkerEpoch ||
          closed.sourceDigest !== closeTarget.descriptor.sourceDigest ||
          closed.profileDigest !== closeTarget.descriptor.profileDigest ||
          (result && closed.phase !== 'consumed')) {
          failure ??= new Error('NOT_AVAILABLE');
          result = undefined;
        }
      } catch (error) { failure ??= error; result = undefined; }
    }
    try { input.store.markRecoveryRequired(claimed, now()); }
    catch (error) { failure ??= error; result = undefined; }
  }
  if (failure) throw failure;
  if (!result) throw new Error('NOT_AVAILABLE');
  return result;
}

import { randomUUID } from 'node:crypto';
import { cleanupInvestigationScratch, cleanupPersistedContainer, docker } from '../adapters/investigator/docker-worker.js';
import { cleanupDockerVolume, type DockerCommandRunner } from '../adapters/investigator/docker-volume-cleanup.js';
import { runWslLaunchGate } from '../adapters/codex/investigator/launch-gate-runner.js';
import { observeFixedCanaryTerminal, type FixedCanaryTerminalObservation } from
  '../adapters/codex/investigator/fixed-canary-terminal-observer.js';
import { runWslSourceView } from '../adapters/codex/investigator/source-view-runner.js';
import { runNativeSupervisorGate } from
  '../adapters/secondary-investigator/claude-native-supervisor-runner.js';
import { parseNativeSupervisorGateOutput, type NativeSupervisorGateDescriptor,
  type NativeSupervisorGateState } from
  '../adapters/secondary-investigator/claude-native-supervisor.js';
import { observeSupervisorV2Terminal, type SupervisorV2TerminalObservation } from
  '../adapters/secondary-investigator/supervisor-v2-terminal-observer.js';
import type { SupervisorV2RunningObservation } from
  '../adapters/secondary-investigator/supervisor-v2-running-observer.js';
import { runWslTerminalProbe } from '../adapters/codex/investigator/terminal-observer.js';
import { closeWindowsFrozenSource, type WindowsFrozenSourceClosedObservation } from
  '../adapters/codex/investigator/windows-source-view.js';
import type { WslLaunchGateDescriptor, WslLaunchGateState } from '../adapters/codex/investigator/launch-gate.js';
import type { SourceViewDescriptor, SourceViewState } from '../adapters/codex/investigator/source-view.js';
import type { InvestigationClaim, SqliteInvestigationStore, WindowsSourceDescriptor, WslResource } from
  '../adapters/storage/investigation-sqlite.js';
import type { DockerVolumeCleanupTickets } from './docker-volume-cleanup-tickets.js';
import type { ReturnTypeFixedCanaryTickets } from './fixed-canary-termination-tickets.js';
import type { createSupervisorV2TerminationTickets } from './supervisor-v2-termination-tickets.js';
import { recoverClaudeModelAttempt } from './claude-model-recovery.js';
import type { createClaudeModelPreventionTickets } from './claude-model-prevention-tickets.js';
import type { createClaudeModelTreeTickets } from './claude-model-tree-tickets.js';
import type { ClaudeModelRecoveryOperations } from './claude-model-recovery.js';

type RecoveryStore = Pick<SqliteInvestigationStore, 'listUnsettled' | 'acquireCleanupLease' |
  'recordObservedContainer' | 'settleExpiredUnreservedAttempt' | 'acquireWslCleanupLease' |
  'settleClosedUnconsumedWslAttempt' | 'observeWslResource' | 'confirmSourceViewClosed'> &
  Partial<Pick<SqliteInvestigationStore, 'acquireWindowsSourceCleanupLease' |
    'recoverCodexOwnedSessions' | 'recoverStartupAttempts' |
    'recoverExpiredGenericAttempts' |
    'settleClosedWindowsSourceAttempt' | 'getWindowsLaunch' |
    'acquireClosedWindowsLaunchCleanupLease' | 'settleClosedWindowsLaunchAttempt' |
    'getWindowsLaunchNotStarted' | 'acquireNotStartedWindowsLaunchCleanupLease' |
    'settleNotStartedWindowsLaunchAttempt' |
    'finishWslCleanup' |
    'settleClosedPreparedSupervisorV2Attempt' | 'settleSupervisorV2Diagnostic' |
    'getSupervisorV2RunningFact' | 'acquireDockerVolumeCleanupLease' |
    'observeDockerVolumeOwner' | 'observeDockerVolumeReader' | 'finishDockerVolumeCleanup' |
    'preflightClaudeModelCleanup' | 'getModelRunningObservation' | 'settleClaudeModelExecutionPrevented' |
    'getModelOuterFact' | 'settleClaudeModelTreeTerminated'>> &
  { finishCleanup(claim: InvestigationClaim, now: Date): void };

interface CleanupOperations {
  removeContainer(name: string, id: string | null, persist: (id: string) => void | Promise<void>): Promise<string>;
  removeScratch(name: string, root: string): Promise<void>;
}

const dockerCleanup: CleanupOperations = {
  removeContainer: cleanupPersistedContainer,
  removeScratch: cleanupInvestigationScratch,
};

export function fixedDockerVolumeInvocation(args: string[], inherited: NodeJS.ProcessEnv):
  { args: string[]; environment: NodeJS.ProcessEnv } {
  // Every subprocess targets the same local socket, even if the user's default
  // Docker context changes between calls. A daemon ID check alone is insufficient.
  const endpoint = process.platform === 'win32' ?
    'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
  const environment = { ...inherited };
  delete environment.DOCKER_CONTEXT;
  delete environment.DOCKER_HOST;
  delete environment.DOCKER_TLS_VERIFY;
  delete environment.DOCKER_CERT_PATH;
  return { args: ['--host', endpoint, ...args], environment };
}

const dockerVolumeRunner: DockerCommandRunner = async args => {
  const fixed = fixedDockerVolumeInvocation(args, process.env);
  const result = await docker(fixed.args, 1_000_000, 5000, fixed.environment);
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr,
    timedOut: false, truncated: false };
};

interface GateOperations {
  close(descriptor: WslLaunchGateDescriptor, root: string): Promise<WslLaunchGateState | null>;
}

const gateCleanup: GateOperations = {
  close: (descriptor, root) => runWslLaunchGate('close', descriptor, root),
};

export interface SupervisorV2RecoveryOperations {
  /** Cleanup of the persisted fixed journal; never release or enter. */
  close(descriptor: NativeSupervisorGateDescriptor, root: string): Promise<NativeSupervisorGateState | null>;
  observeTerminal(resource: WslResource,
    journal: NativeSupervisorGateState,
    runningFact?: SupervisorV2RunningObservation): Promise<SupervisorV2TerminalObservation>;
  /** Caller must wire this same instance's verify callback into store authority. */
  tickets: ReturnType<typeof createSupervisorV2TerminationTickets>;
}

function nativeV2Recovery(tickets: ReturnType<typeof createSupervisorV2TerminationTickets>):
  SupervisorV2RecoveryOperations {
  return { close: async (descriptor, root) => {
    const state = await runNativeSupervisorGate('close', descriptor, root);
    return state?.protocol === 'native_supervisor_v2' ? state : null;
  }, observeTerminal: (resource, journal, runningFact) =>
    observeSupervisorV2Terminal(resource, journal, runWslTerminalProbe, runningFact), tickets };
}

function exactClosedV2(state: NativeSupervisorGateState | null,
  descriptor: NativeSupervisorGateDescriptor): state is NativeSupervisorGateState {
  return !!state && state.protocol === 'native_supervisor_v2' && state.closed &&
    state.attemptId === descriptor.attemptId && state.workspaceId === descriptor.workspaceId &&
    state.bootId === descriptor.bootId && state.uid === descriptor.uid &&
    state.unitName === descriptor.unitName &&
    state.launchWorkerEpoch === descriptor.launchWorkerEpoch &&
    state.sourceDigest === descriptor.sourceDigest &&
    state.profileDigest === descriptor.profileDigest &&
    parseNativeSupervisorGateOutput(JSON.stringify(state) + '\n', descriptor)?.protocol ===
      'native_supervisor_v2';
}

async function recoverSupervisorV2(store: RecoveryStore, unsettled: InvestigationClaim,
  workerId: string, sources: SourceOperations,
  operations: SupervisorV2RecoveryOperations): Promise<void> {
  if (!store.settleClosedPreparedSupervisorV2Attempt || !store.settleSupervisorV2Diagnostic) return;
  const claim = store.acquireWslCleanupLease(unsettled, workerId, new Date());
  const resource = claim?.wslResource;
  const gate = resource?.gate;
  const launch = gate?.launch;
  if (!claim || !resource || !gate || gate.payloadKind !== 'native_supervisor_v2' ||
    !launch || launch.action !== 'fixed_zero_model_v1' ||
    claim.workerEpoch <= launch.workerEpoch || !claim.sourceView ||
    claim.sourceView.descriptor.workerEpoch !== launch.workerEpoch ||
    claim.sourceView.descriptor.sourceDigest !== launch.sourceDigest) return;
  const descriptor: NativeSupervisorGateDescriptor = { attemptId: claim.attemptId,
    workspaceId: claim.workspaceId, distro: resource.distro, linuxUser: gate.linuxUser,
    uid: resource.uid, bootId: resource.bootId, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest };
  // The original launch epoch is durable; cleanup's new epoch is only a storage fence.
  const closed = await operations.close(descriptor, gate.root);
  if (!exactClosedV2(closed, descriptor)) return;
  if (closed.phase !== 'prepared' && closed.phase !== 'consumed') {
    // Entered/released stays occupied; recovery never releases or relaunches it.
    return;
  }
  let current = claim;
  if (closed.phase === 'consumed') {
    if (!closed.invocationId || !closed.controlGroup) return;
    current = store.observeWslResource(claim, { invocationId: closed.invocationId,
      controlGroup: closed.controlGroup }, new Date());
  }
  const sourceClosed = await sources.close(current.sourceView!.descriptor,
    current.sourceView!.privateRoot);
  if (sourceClosed?.kind !== 'closed') return;
  current = store.confirmSourceViewClosed(current, sourceClosed, new Date());
  if (closed.phase === 'prepared') {
    store.settleClosedPreparedSupervisorV2Attempt(current, launch, closed, new Date());
    return;
  }
  const runningFact = store.getSupervisorV2RunningFact?.(current) ?? undefined;
  const terminal = await operations.observeTerminal(current.wslResource!, closed, runningFact);
  if (terminal.kind !== 'fixed_zero_model_terminal') return;
  const receipt = operations.tickets.issue(current, terminal);
  try { store.settleSupervisorV2Diagnostic(current, launch, closed, receipt, new Date()); }
  finally { operations.tickets.revoke(receipt); }
}

export interface SourceOperations {
  close(descriptor: SourceViewDescriptor, root: string): Promise<SourceViewState | null>;
}

const sourceCleanup: SourceOperations = {
  close: (descriptor, root) => runWslSourceView('close', descriptor, root),
};

interface WindowsSourceOperations {
  close(descriptor: WindowsSourceDescriptor, root: string): Promise<WindowsFrozenSourceClosedObservation>;
}

const windowsSourceCleanup: WindowsSourceOperations = {
  close: async (descriptor, root) => closeWindowsFrozenSource(descriptor, root),
};

export interface CanaryTerminationOperations {
  observe(resource: WslResource): Promise<FixedCanaryTerminalObservation>;
  issue(claim: InvestigationClaim, observation: FixedCanaryTerminalObservation): string;
  revoke(receipt: string): void;
}

export type FixedCanarySettlementStore = Pick<SqliteInvestigationStore, 'confirmSourceViewClosed'> &
  Partial<Pick<SqliteInvestigationStore, 'finishWslCleanup'>>;

/** The store performs the final lease, epoch, source, and ticket checks atomically. */
export async function settleFixedCanaryClaim(store: FixedCanarySettlementStore,
  currentClaim: InvestigationClaim, canaryOps: CanaryTerminationOperations,
  sourceOps: SourceOperations = sourceCleanup, now: () => Date = () => new Date()): Promise<boolean> {
  if (!store.finishWslCleanup || currentClaim.nativeRef !== null ||
    !currentClaim.wslResource?.gate || currentClaim.wslResource.gate.payloadKind !== 'canary_v1')
    return false;
  const terminal = await canaryOps.observe(currentClaim.wslResource);
  if (terminal.kind !== 'fixed_canary_terminal') return false;
  let current = currentClaim;
  if (current.sourceView) {
    const sourceClosed = await sourceOps.close(current.sourceView.descriptor,
      current.sourceView.privateRoot);
    if (sourceClosed?.kind !== 'closed') return false;
    current = store.confirmSourceViewClosed(current, sourceClosed, now());
  }
  const receipt = canaryOps.issue(current, terminal);
  try {
    store.finishWslCleanup(current, receipt, now());
    return true;
  } finally {
    canaryOps.revoke(receipt);
  }
}

/** An attempt is never relaunched; recovery touches only its persisted resource identity. */
export async function runInvestigationCleanupTick(store: RecoveryStore, workerId: string,
  operations: CleanupOperations = dockerCleanup, claims = store.listUnsettled(),
  gates: GateOperations = gateCleanup, sources: SourceOperations = sourceCleanup,
  windowsSources: WindowsSourceOperations = windowsSourceCleanup,
  canaries?: CanaryTerminationOperations,
  supervisorV2?: SupervisorV2RecoveryOperations,
  volumeTickets?: DockerVolumeCleanupTickets,
  volumeRunner: DockerCommandRunner = dockerVolumeRunner,
  modelTickets?: ReturnType<typeof createClaudeModelPreventionTickets>,
  modelTreeTickets?: ReturnType<typeof createClaudeModelTreeTickets>,
  modelOps?: Partial<ClaudeModelRecoveryOperations>,
  reconciliation: 'required' | 'startup-completed' = 'required'): Promise<void> {
  // Internal startup phase only; transports never choose whether reconciliation ran.
  if (reconciliation !== 'startup-completed') {
    store.recoverCodexOwnedSessions?.(new Date());
    store.recoverExpiredGenericAttempts?.(new Date());
  }
  for (const unsettled of claims) {
    try {
      if (store.settleExpiredUnreservedAttempt(unsettled, new Date())) continue;
    } catch { continue; } // A changed claim must be re-read on the next tick.
    if (unsettled.windowsSource) {
      try {
        if (!store.getWindowsLaunch) continue;
        if (store.getWindowsLaunch(unsettled)) {
          if (store.getWindowsLaunchNotStarted?.(unsettled)) {
            if (!store.acquireNotStartedWindowsLaunchCleanupLease ||
              !store.settleNotStartedWindowsLaunchAttempt) continue;
            const claim=store.acquireNotStartedWindowsLaunchCleanupLease(unsettled,workerId,new Date());
            if (!claim?.windowsSource) continue;
            const closed=await windowsSources.close(claim.windowsSource.descriptor,
              claim.windowsSource.privateRoot);
            store.settleNotStartedWindowsLaunchAttempt(claim,closed,new Date());
            continue;
          }
          if (!store.acquireClosedWindowsLaunchCleanupLease ||
            !store.settleClosedWindowsLaunchAttempt) continue;
          const claim=store.acquireClosedWindowsLaunchCleanupLease(unsettled,workerId,new Date());
          if (!claim?.windowsSource) continue;
          const closed=await windowsSources.close(claim.windowsSource.descriptor,
            claim.windowsSource.privateRoot);
          store.settleClosedWindowsLaunchAttempt(claim,closed,new Date());
          continue;
        }
        const claim = store.acquireWindowsSourceCleanupLease?.(unsettled, workerId, new Date());
        if (!claim?.windowsSource) continue;
        const closed = await windowsSources.close(claim.windowsSource.descriptor,
          claim.windowsSource.privateRoot);
        store.settleClosedWindowsSourceAttempt?.(claim, closed, new Date());
      } catch { /* Unknown source close or changed lease keeps the attempt and slot occupied. */ }
      continue;
    }
    if (unsettled.dockerVolume) {
      if (!volumeTickets || !store.acquireDockerVolumeCleanupLease ||
        !store.observeDockerVolumeOwner || !store.observeDockerVolumeReader ||
        !store.finishDockerVolumeCleanup) continue;
      try {
        let claim = store.acquireDockerVolumeCleanupLease(unsettled, workerId, new Date());
        if (!claim?.dockerVolume) continue;
        const result = await cleanupDockerVolume(claim.dockerVolume, volumeRunner);
        if (result.kind === 'observed') {
          if (claim.dockerVolume.ownerId === null) {
            claim = store.observeDockerVolumeOwner(claim, result.ownerId, result.volumeName, new Date());
          }
          if (result.readerId !== null && claim.dockerVolume?.readerId === null) {
            store.observeDockerVolumeReader(claim, result.readerId, new Date());
          }
        } else if (result.kind === 'cleaned') {
          const receipt = volumeTickets.issue(claim, result);
          try { store.finishDockerVolumeCleanup(claim, receipt, new Date()); }
          finally { volumeTickets.revoke(receipt); }
        }
      } catch { /* Unknown daemon state or changed lease keeps the slot occupied. */ }
      continue;
    }
    if (unsettled.wslResource?.gate) {
      if (unsettled.wslResource.gate.payloadKind === 'claude_model_v1') {
        if (modelTickets && store.preflightClaudeModelCleanup && store.getModelRunningObservation &&
            store.settleClaudeModelExecutionPrevented) {
          await recoverClaudeModelAttempt({
            acquireWslCleanupLease: store.acquireWslCleanupLease.bind(store),
            observeWslResource: store.observeWslResource.bind(store),
            preflightClaudeModelCleanup: store.preflightClaudeModelCleanup.bind(store),
            getModelRunningObservation: store.getModelRunningObservation.bind(store),
            ...(store.getModelOuterFact ?
              {getModelOuterFact: store.getModelOuterFact.bind(store)} : {}),
            settleClaudeModelExecutionPrevented: store.settleClaudeModelExecutionPrevented.bind(store),
            ...(store.settleClaudeModelTreeTerminated ?
              {settleClaudeModelTreeTerminated: store.settleClaudeModelTreeTerminated.bind(store)} : {}),
          }, unsettled, workerId, modelTickets, modelOps, modelTreeTickets);
        }
        continue;
      }
      if (unsettled.wslResource.gate.payloadKind === 'native_supervisor_v2') {
        if (supervisorV2) {
          try { await recoverSupervisorV2(store, unsettled, workerId, sources, supervisorV2); }
          catch { /* Unknown journal, source or terminal state retains the occupied slot. */ }
        }
        continue;
      }
      // A model supervisor needs its own exact terminal and source cleanup proof.
      // The fixed canary path must not touch its gate, lease or slot.
      if (unsettled.wslResource.gate.payloadKind !== 'canary_v1') continue;
      try {
        const claim = store.acquireWslCleanupLease(unsettled, workerId, new Date());
        const resource = claim?.wslResource;
        if (!claim || !resource?.gate || resource.gate.payloadKind !== 'canary_v1') continue;
        const descriptor: WslLaunchGateDescriptor = { attemptId: claim.attemptId,
          workspaceId: claim.workspaceId, distro: resource.distro, linuxUser: resource.gate.linuxUser,
          uid: resource.uid, bootId: resource.bootId, unitName: resource.unitName };
        const closed = await gates.close(descriptor, resource.gate.root);
        if (closed?.kind === 'closed_unconsumed') {
          let current = claim;
          if (claim.sourceView) {
            const sourceClosed = await sources.close(claim.sourceView.descriptor,
              claim.sourceView.privateRoot);
            if (sourceClosed?.kind !== 'closed') continue;
            current = store.confirmSourceViewClosed(claim, sourceClosed, new Date());
          }
          store.settleClosedUnconsumedWslAttempt(current, closed, new Date());
        }
        else if (closed?.kind === 'closed_consumed' &&
          closed.attemptId === descriptor.attemptId &&
          closed.workspaceId === descriptor.workspaceId && closed.bootId === descriptor.bootId &&
          closed.uid === descriptor.uid && closed.unitName === descriptor.unitName &&
          closed.invocationId && closed.controlGroup) {
          const current = store.observeWslResource(claim, { invocationId: closed.invocationId,
            controlGroup: closed.controlGroup }, new Date());
          if (canaries) await settleFixedCanaryClaim(store, current, canaries, sources);
        }
      } catch { /* Unknown close or changed lease keeps the attempt and slot occupied. */ }
      continue;
    }
    let claim: InvestigationClaim | null;
    try { claim = store.acquireCleanupLease(unsettled, workerId, new Date()); }
    catch { continue; } // Another process may have fenced or settled it.
    if (!claim?.containerName || !claim.scratchRoot) continue;
    try {
      let current = claim;
      const id = await operations.removeContainer(claim.containerName, claim.containerId ?? null, (observed) => {
        current = store.recordObservedContainer(current, observed, new Date());
      });
      if (current.containerId !== id) continue;
      await operations.removeScratch(claim.containerName, claim.scratchRoot);
      store.finishCleanup(current, new Date());
    } catch {
      // Keep the slot occupied. A later tick may retry after the cleanup lease expires.
    }
  }
}

/** Startup pass plus bounded, nonreentrant retries for an installed process. */
export function startInvestigationRecovery(store: RecoveryStore,
  tickets?: ReturnTypeFixedCanaryTickets,
  supervisorV2Tickets?: ReturnType<typeof createSupervisorV2TerminationTickets>,
  volumeTickets?: DockerVolumeCleanupTickets,
  modelTickets?: ReturnType<typeof createClaudeModelPreventionTickets>,
  modelTreeTickets?: ReturnType<typeof createClaudeModelTreeTickets>):
  { ready: Promise<void>; close(): Promise<void> | void } {
  const startupReconciled = !!store.recoverStartupAttempts;
  store.recoverStartupAttempts?.(new Date());
  const workerId = `cleanup-${randomUUID()}`;
  let closing = false;
  let running: Promise<void> | null = null;
  const tick = (reconciliation: 'required' | 'startup-completed' = 'required'): Promise<void> => {
    if (closing) return Promise.resolve();
    if (running) return running;
    const claims = store.listUnsettled();
    if (claims.length === 0) return Promise.resolve();
    const canaries: CanaryTerminationOperations | undefined = tickets ? {
      observe: observeFixedCanaryTerminal, issue: tickets.issue, revoke: tickets.revoke,
    } : undefined;
    running = runInvestigationCleanupTick(store, workerId, dockerCleanup, claims,
      gateCleanup, sourceCleanup, windowsSourceCleanup, canaries,
      supervisorV2Tickets ? nativeV2Recovery(supervisorV2Tickets) : undefined,
      volumeTickets, dockerVolumeRunner, modelTickets, modelTreeTickets, undefined, reconciliation)
      .finally(() => { running = null; });
    return running;
  };
  const ready = tick(startupReconciled ? 'startup-completed' : 'required');
  const timer = setInterval(() => {
    try { void tick().catch(() => undefined); }
    catch { /* Durable attempt remains occupied; next tick retries. */ }
  }, 10_000);
  timer.unref();
  return { ready, close: () => {
    closing = true;
    clearInterval(timer);
    return running?.then(() => undefined);
  } };
}

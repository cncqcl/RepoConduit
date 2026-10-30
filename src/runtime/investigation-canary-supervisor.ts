import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { runWslLaunchGate } from '../adapters/codex/investigator/launch-gate-runner.js';
import { wslLaunchGateSpec, type WslLaunchGateDescriptor,
  type WslLaunchGateState } from '../adapters/codex/investigator/launch-gate.js';
import { runWslSourceView } from '../adapters/codex/investigator/source-view-runner.js';
import type { InvestigationClaim, ClaimInput, SqliteInvestigationStore,
  WslResourceReservation } from '../adapters/storage/investigation-sqlite.js';
import type { SnapshotRecord } from '../application/repository.js';
import type { InvestigationSourceBinding } from '../application/investigation-source-plan.js';
import { prepareInvestigationSource, type InvestigationSourcePreparationOperations } from
  './investigation-source-preparation.js';
import { settleFixedCanaryClaim, type CanaryTerminationOperations,
  type SourceOperations } from './investigation-recovery.js';

type CanaryStore = Pick<SqliteInvestigationStore, 'claimRequest' | 'get' | 'preflightSourceRead' |
  'reserveWslResource' | 'reserveSourceView' | 'preflightNativeLaunch' | 'observeWslResource' |
  'markRecoveryRequired' | 'renewLease' | 'listUnsettled' | 'confirmSourceViewClosed' |
  'finishWslCleanup'>;
type SnapshotStore = { getSnapshot(snapshotId: string, workspaceId: string,
  collaborationId: string): Promise<SnapshotRecord | null> };
type ExpectedBinding = Omit<InvestigationSourceBinding, 'attemptId' | 'workerEpoch'>;
type CanaryReservation = WslResourceReservation & { gate: NonNullable<WslResourceReservation['gate']> };

export interface ClaimedCanaryInput {
  requestId: string;
  store: CanaryStore;
  snapshots: SnapshotStore;
  expected: ExpectedBinding;
  claim: Omit<ClaimInput, 'launchProtocol'>;
  /** Trusted local configuration; called only after the durable claim. */
  reservationForClaim(claim: InvestigationClaim): { reservation: CanaryReservation; sourceRoot: string };
  /** Trusted native proof and source close; a failed proof keeps the slot occupied. */
  termination: { canaries: CanaryTerminationOperations; sources?: SourceOperations };
  now?: () => Date;
  signal?: AbortSignal;
  /** Trusted diagnostic timing override for deterministic fault tests. */
  heartbeatIntervalMs?: number;
}

export interface CanaryLaunchObservation {
  bridge: 'exited' | 'unknown' | 'not_started';
  gate: WslLaunchGateState | null;
}

export interface CanaryOperations extends InvestigationSourcePreparationOperations {
  /** A missing gate identity is an unknown launch; bridge exit is separate evidence. */
  launchAndClose(descriptor: WslLaunchGateDescriptor, root: string,
    signal?: AbortSignal): Promise<CanaryLaunchObservation>;
}

type CanaryBridge = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean };

/** Bridge exit is never process-tree termination evidence. */
export function readWslCanaryBridge(child: CanaryBridge, signal?: AbortSignal,
  timeoutMs = 20_000): Promise<'exited' | 'unknown'> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let bytes = 0;
    let uncertain = false;
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const onAbort = () => fail();
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      resolve(!uncertain && code === 0 ? 'exited' : 'unknown');
    };
    const fail = () => {
      if (uncertain || finished) return;
      uncertain = true;
      try { child.kill(); } catch { /* The WSL unit remains unconfirmed. */ }
      grace = setTimeout(() => finish(null), 1000);
    };
    const timer = setTimeout(fail, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > 4096) fail();
      });
      stream.on('error', fail);
    }
    child.on('error', fail);
    child.on('close', finish);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) fail();
  });
}

/** Fixed zero-model systemd unit. This diagnostic never executes an AI worker. */
export async function runWslCanaryUnit(descriptor: WslLaunchGateDescriptor,
  root: string, signal?: AbortSignal): Promise<CanaryLaunchObservation> {
  const enter = wslLaunchGateSpec('enter', descriptor, root);
  let bridge: CanaryLaunchObservation['bridge'] = 'not_started';
  if (!signal?.aborted) {
    try {
      const child = spawn(enter.executable, ['-d', descriptor.distro,
        '--user', descriptor.linuxUser, '--cd', '/', '--exec', '/usr/bin/systemd-run',
        '--user', '--remain-after-exit', '--unit', descriptor.unitName,
        '--property=RuntimeMaxSec=90s',
        '--', '/usr/bin/python3', ...enter.args.slice(8)],
      { env: enter.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      bridge = await readWslCanaryBridge(child, signal);
    } catch { bridge = 'unknown'; }
  }
  // systemd-run returns after queuing the unit, before the fixed payload must
  // have consumed its durable gate. Poll only the exact gate for a short bound.
  // Failure stays unknown and recovery will close the gate after lease expiry.
  const pollUntil = Date.now() + 5_000;
  while (!signal?.aborted && Date.now() < pollUntil) {
    const state = await runWslLaunchGate('status', descriptor, root, signal);
    if (state?.kind === 'consumed' || state?.kind === 'closed_consumed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Closing the gate is an independent bounded cleanup action. An aborted
  // bridge signal cannot suppress it or erase a consumed unit identity.
  const gate = await runWslLaunchGate('close', descriptor, root);
  return { bridge, gate };
}

const nativeOperations: CanaryOperations = {
  materialize: (descriptor, root, plan, signal) => runWslSourceView('materialize', descriptor, root, plan, signal),
  prepareGate: (descriptor, root, signal) => runWslLaunchGate('prepare', descriptor, root, signal),
  launchAndClose: runWslCanaryUnit,
};

/**
 * One real queued request through durable claim, frozen source, OS gate, and
 * exact unit observation, and fixed-canary termination settlement. No model
 * result is published; failed proof keeps the attempt occupied for recovery.
 */
export async function runClaimedCanaryInvestigation(input: ClaimedCanaryInput,
  operations: CanaryOperations = nativeOperations): Promise<{
    claim: InvestigationClaim; sourceDigest: string;
    observedUnit: { invocationId: string; controlGroup: string };
    settled: boolean;
  }> {
  if (!input.requestId || input.expected.requestId !== input.requestId) throw new Error('NOT_AVAILABLE');
  if (input.signal?.aborted) throw new Error('NOT_AVAILABLE');
  const now = input.now ?? (() => new Date());
  const heartbeatMs = input.heartbeatIntervalMs ?? 10_000;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 10_000) {
    throw new Error('INVALID_ARGUMENT');
  }
  const claimed = input.store.claimRequest(input.requestId,
    { ...input.claim, launchProtocol: 'resource_reservation_v1' });
  if (!claimed) throw new Error('NOT_AVAILABLE');
  const record = input.store.get(input.requestId);
  if (!record || !Number.isSafeInteger(record.budget.maxWallSeconds) ||
    record.budget.maxWallSeconds < 1 || record.budget.maxWallSeconds > 600) {
    throw new Error('NOT_AVAILABLE');
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const selectedScope = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  const deadline = setTimeout(() => controller.abort(), record.budget.maxWallSeconds * 1000);
  const heartbeat = setInterval(() => {
    if (controller.signal.aborted) return;
    try {
      input.store.preflightSourceRead(claimed, selectedScope, now());
      input.store.renewLease(claimed, now());
    } catch { controller.abort(); }
  }, heartbeatMs);
  try {
    const { reservation, sourceRoot } = input.reservationForClaim(claimed);
    if (reservation.gate?.payloadKind !== 'canary_v1') throw new Error('NOT_AVAILABLE');
    const prepared = await prepareInvestigationSource({ store: input.store,
      snapshots: input.snapshots, claim: claimed,
      expected: { ...input.expected, attemptId: claimed.attemptId, workerEpoch: claimed.workerEpoch },
      reservation, sourceRoot, expectedPayloadKind: 'canary_v1', now,
      signal: controller.signal }, operations);
    const selected = prepared.plan.files.map(file => file.path).sort();
    if (controller.signal.aborted) throw new Error('NOT_AVAILABLE');
    input.store.preflightNativeLaunch(prepared.claim, selected,
      input.claim.profileRevision, prepared.plan.digest, now());
    const descriptor: WslLaunchGateDescriptor = { attemptId: claimed.attemptId,
      workspaceId: claimed.workspaceId, distro: reservation.distro,
      linuxUser: reservation.gate.linuxUser, uid: reservation.uid,
      bootId: reservation.bootId, unitName: reservation.unitName };
    const observation = await operations.launchAndClose(descriptor, reservation.gate.root, controller.signal);
    const closed = observation.gate;
    if (!closed || closed.kind !== 'closed_consumed' ||
      closed.attemptId !== descriptor.attemptId || closed.workspaceId !== descriptor.workspaceId ||
      closed.uid !== descriptor.uid || closed.bootId !== descriptor.bootId ||
      closed.unitName !== descriptor.unitName || !closed.invocationId || !closed.controlGroup) {
      throw new Error('NOT_AVAILABLE');
    }
    const observedUnit = { invocationId: closed.invocationId, controlGroup: closed.controlGroup };
    const current = input.store.observeWslResource(prepared.claim, observedUnit, now());
    if (observation.bridge !== 'exited' || controller.signal.aborted) throw new Error('NOT_AVAILABLE');
    // Revocation after the native side effect does not erase the unit identity;
    // it prevents this diagnostic from reporting a current authorized run.
    input.store.preflightSourceRead(current, selected, now());
    // The source-read heartbeat is invalid after the reconcile transition.
    // Keep only the exact worker lease alive while native cleanup is pending.
    clearInterval(heartbeat);
    const retained = input.store.markRecoveryRequired(current, now());
    const cleanupHeartbeat = setInterval(() => {
      try { input.store.renewLease(retained, now()); }
      catch { clearInterval(cleanupHeartbeat); }
    }, heartbeatMs);
    try {
      const settled = await settleFixedCanaryClaim(input.store, retained,
        input.termination.canaries, input.termination.sources, now);
      return { claim: retained, sourceDigest: prepared.plan.digest, observedUnit, settled };
    } finally { clearInterval(cleanupHeartbeat); }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    input.signal?.removeEventListener('abort', onExternalAbort);
    // An unreserved prelaunch failure remains eligible for safe lease-expiry
    // settlement. Any reserved resource/source remains occupied for recovery.
    try {
      const active = input.store.listUnsettled().find(item =>
        item.requestId === claimed.requestId && item.attemptId === claimed.attemptId &&
        item.workerEpoch === claimed.workerEpoch);
      if (active?.wslResource || active?.sourceView || active?.windowsSource ||
        active?.containerName || active?.containerId || active?.scratchRoot || active?.nativeRef) {
        input.store.markRecoveryRequired(claimed, now());
      }
    }
    catch { /* An expired or fenced worker leaves takeover to installed recovery. */ }
  }
}

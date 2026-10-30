import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, RunningReadBinding, SqliteInvestigationStore, WslResource } from
  '../adapters/storage/investigation-sqlite.js';
import type { PersistedInvestigatorMcpOptions } from
  '../adapters/secondary-investigator/persisted-mcp.js';
import { startPersistedInvestigatorStdioBridge } from
  '../adapters/secondary-investigator/persisted-stdio-bridge.js';
import { runPrivateFifoPrepare, runPrivateFifoRelay } from
  '../adapters/secondary-investigator/wsl-private-fifo-runner.js';
import type { PrivateFifoBinding } from '../adapters/secondary-investigator/wsl-private-fifo.js';

type FifoStore = Pick<SqliteInvestigationStore, 'listUnsettled' | 'get' |
  'assertRunningReadAuthority' | 'reserveRunningRead' | 'preflightSourceRead'> &
  Partial<Pick<SqliteInvestigationStore, 'getModelRunningFact'>>;

function sameResource(a: WslResource | undefined, b: WslResource | undefined): boolean {
  return Boolean(a && b && isDeepStrictEqual(a, b));
}

function durableBinding(store: FifoStore, supplied: InvestigationClaim,
  phase: 'prepare' | 'attach'): { current: InvestigationClaim; binding: PrivateFifoBinding } {
  const current = store.listUnsettled().find(item => item.requestId === supplied.requestId &&
    item.attemptId === supplied.attemptId);
  const resource = current?.wslResource;
  const gate = resource?.gate;
  const record = current && store.get(current.requestId);
  const attempt = record?.attempts.find(item => item.id === current?.attemptId);
  const started = attempt?.startedAt ? Date.parse(attempt.startedAt) : NaN;
  const deadlineEpochMs = phase === 'attach' && record && Number.isSafeInteger(record.budget.maxWallSeconds) &&
    Number.isFinite(started) ? started + record.budget.maxWallSeconds * 1000 : 0;
  if (!current || !resource || !gate || !gate.launch ||
    current.workerEpoch !== supplied.workerEpoch || current.workerId !== supplied.workerId ||
    current.workspaceId !== supplied.workspaceId || current.nativeRef !== supplied.nativeRef ||
    !sameResource(resource, supplied.wslResource) ||
    gate.protocol !== 'attempt_gate_v1' ||
    !((gate.payloadKind === 'native_supervisor_v2' && gate.launch.action === 'fixed_zero_model_v1') ||
      (gate.payloadKind === 'claude_model_v1' && gate.launch.action === 'claude_model_v1' &&
        typeof gate.launch.commandDigest === 'string' && /^[0-9a-f]{64}$/.test(gate.launch.commandDigest))) ||
    gate.launch.workerEpoch !== current.workerEpoch ||
    (phase === 'prepare' && (current.phase !== 'start_intent' || current.nativeRef !== null ||
      resource.invocationId !== null || resource.controlGroup !== null)) ||
    (phase === 'attach' && (current.phase !== 'started' || !current.nativeRef ||
      !resource.invocationId || !resource.controlGroup || !Number.isSafeInteger(deadlineEpochMs) ||
      deadlineEpochMs <= Date.now() || deadlineEpochMs > Date.now() + 600_000))) throw new Error('NOT_AVAILABLE');
  if (phase === 'attach' && gate.payloadKind === 'claude_model_v1') {
    const fact = store.getModelRunningFact?.(current);
    if (!fact || fact.phase !== 'entered' || fact.closed ||
        fact.commandDigest !== gate.launch.commandDigest) throw new Error('NOT_AVAILABLE');
  }
  return { current, binding: { attemptId: current.attemptId, workspaceId: current.workspaceId,
    workerEpoch: current.workerEpoch, root: gate.root, distro: resource.distro,
    linuxUser: gate.linuxUser, uid: resource.uid, bootId: resource.bootId,
    unitName: resource.unitName, invocationId: resource.invocationId,
    controlGroup: resource.controlGroup, deadlineEpochMs } };
}

/** Called only after the WSL reservation is durable and before native start. */
export async function preparePrivateFifo(input: { store: FifoStore; claim: InvestigationClaim;
  signal?: AbortSignal }): Promise<{ directory: string }> {
  const { binding } = durableBinding(input.store, input.claim, 'prepare');
  const record = input.store.get(input.claim.requestId);
  if (!record) throw new Error('NOT_AVAILABLE');
  const selected = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  input.store.preflightSourceRead(input.claim, selected, new Date());
  await runPrivateFifoPrepare(binding, input.signal);
  durableBinding(input.store, input.claim, 'prepare');
  input.store.preflightSourceRead(input.claim, selected, new Date());
  // The path is a reservation detail, never authority to attach or settle an attempt.
  return { directory: `${binding.root}/${binding.attemptId}-${binding.workerEpoch}.mcp` };
}

/** Attach only an already started native worker; the transport cannot settle its attempt. */
export async function attachPrivateFifo(input: PersistedInvestigatorMcpOptions & {
  store: FifoStore; signal?: AbortSignal;
}): Promise<{ closed: Promise<void>; closeTransport(): Promise<void> }> {
  const { binding } = durableBinding(input.store, input.claim, 'attach');
  const record = input.store.get(input.claim.requestId);
  if (!record) throw new Error('NOT_AVAILABLE');
  const readBinding: RunningReadBinding = {
    collaborationId: record.collaborationId, workingCopyId: record.workingCopyId,
    snapshotId: record.snapshotRef,
    paths: [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort(),
    workerGrantId: input.workerGrantId, workerAudience: input.workerAudience,
    workerRecipient: input.workerRecipient,
  };
  input.store.assertRunningReadAuthority(input.claim, readBinding, new Date());
  const relay = await runPrivateFifoRelay(binding, input.signal);
  try {
    // Read authority is rechecked after the asynchronous native readiness wait.
    durableBinding(input.store, input.claim, 'attach');
    input.store.assertRunningReadAuthority(input.claim, readBinding, new Date());
    const guardedStore: PersistedInvestigatorMcpOptions['store'] = {
      get: input.store.get.bind(input.store),
      assertRunningReadAuthority: (claim, selected, now) => {
        if (Date.now() >= binding.deadlineEpochMs) throw new Error('NOT_AVAILABLE');
        return input.store.assertRunningReadAuthority(claim, selected, now);
      },
      reserveRunningRead: (claim, selected, read, now) => {
        if (Date.now() >= binding.deadlineEpochMs) throw new Error('NOT_AVAILABLE');
        const reservation = input.store.reserveRunningRead(claim, selected, read, now);
        if (!reservation) throw new Error('NOT_AVAILABLE');
        return {complete: (observed) => {
          if (Date.now() >= binding.deadlineEpochMs) throw new Error('NOT_AVAILABLE');
          return reservation.complete(observed);
        }};
      },
    };
    const bridge = startPersistedInvestigatorStdioBridge({ claim: input.claim,
      store: guardedStore, workerGrantId: input.workerGrantId,
      workerAudience: input.workerAudience, workerRecipient: input.workerRecipient,
      dispatcher: input.dispatcher, input: relay.child.stdout, output: relay.child.stdin });
    const authorityWatch = setInterval(() => {
      try {
        durableBinding(input.store, input.claim, 'attach');
        input.store.assertRunningReadAuthority(input.claim, readBinding, new Date());
      } catch { void closeTransport().catch(() => undefined); }
    }, 250);
    const deadlineTimer = setTimeout(() => { void closeTransport().catch(() => undefined); },
      Math.max(1, binding.deadlineEpochMs - Date.now()));
    const closeTransport = async () => {
      clearInterval(authorityWatch);
      clearTimeout(deadlineTimer);
      try { await bridge.close(); }
      finally { await relay.closeTransport(); }
    };
    void relay.closed.then(() => bridge.close()).catch(() => undefined);
    void bridge.closed.then(() => relay.closeTransport()).catch(() => undefined);
    const closed = Promise.all([relay.closed, bridge.closed]).then(() => undefined);
    void closed.then(() => { clearInterval(authorityWatch); clearTimeout(deadlineTimer); });
    return { closed, closeTransport };
  } catch (error) { await relay.closeTransport(); throw error; }
}

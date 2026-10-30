import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { DispatchService } from '../application/dispatch.js';
import type { InvestigationClaim, RunningReadBinding, SqliteInvestigationStore } from
  '../adapters/storage/investigation-sqlite.js';
import type { ClaudeMcpSandboxPaths } from '../adapters/secondary-investigator/claude-mcp-sandbox-spec.js';
import type { ClaudeModelLaunchProfile } from '../adapters/secondary-investigator/claude-model-launch-config.js';
import { boundedClaudeModelPrompt, runClaudeModelSupervisorOperation, startClaudeModelUnit,
  type ClaudeModelUnitHandle } from '../adapters/secondary-investigator/claude-model-supervisor-runner.js';
import { claudeModelCommandDigest, parseClaudeModelSupervisorOutput, validClaudeModelLaunchLimits,
  type ClaudeModelLaunchLimits,
  type ClaudeModelSupervisorDescriptor, type ClaudeModelSupervisorState } from
  '../adapters/secondary-investigator/claude-model-supervisor.js';
import { observeClaudeModelOuter } from '../adapters/secondary-investigator/claude-model-outer-observer.js';
import { parseClaudeModelStartup } from '../adapters/secondary-investigator/claude-model-startup.js';
import { parseClaudeModelOutcomeCandidate, type ClaudeModelOutcomeCandidate } from
  '../adapters/secondary-investigator/claude-model-outcome.js';
import { validateCurrentClaudeModelOuterFact, type ModelOuterConfinedFact } from
  '../adapters/secondary-investigator/claude-model-outer-fact.js';
import { preparePrivateFifo, attachPrivateFifo } from './investigation-private-fifo.js';
import { persistClaudeModelRunning } from './claude-model-start-observation.js';
import type { createClaudeModelRunningTickets } from './claude-model-running-tickets.js';
import type { createClaudeModelOuterTickets } from './claude-model-outer-tickets.js';

type Store = SqliteInvestigationStore;
type OuterTickets = ReturnType<typeof createClaudeModelOuterTickets>;
type OwnerWindow = ReturnType<OuterTickets['beginOwner']>;
type Transport = Awaited<ReturnType<typeof attachPrivateFifo>>;

export interface ClaudeModelOriginalOwnerCandidate extends Omit<ClaudeModelOutcomeCandidate, 'kind'> {
  kind: 'claude_model_original_owner_candidate_v1';
  requestId: string; attemptId: string; workspaceId: string; workerEpoch: number;
  nativeRef: string; promptHash: string; commandDigest: string;
}

export interface ClaudeModelOriginalOwnerInput {
  /** Only a currently persisted resource reservation from the trusted scheduler. */
  claim: InvestigationClaim;
  store: Store;
  binding: RunningReadBinding;
  descriptor: ClaudeModelSupervisorDescriptor;
  paths: ClaudeMcpSandboxPaths;
  profile: ClaudeModelLaunchProfile;
  profileRevision: string;
  limits: ClaudeModelLaunchLimits;
  runningTickets: ReturnType<typeof createClaudeModelRunningTickets>;
  outerTickets: OuterTickets;
  dispatcher: Pick<DispatchService, 'dispatch'>;
  signal?: AbortSignal;
}

export interface ClaudeModelOriginalOwnerPorts {
  prepare: typeof preparePrivateFifo;
  operation: typeof runClaudeModelSupervisorOperation;
  start: typeof startClaudeModelUnit;
  persist: typeof persistClaudeModelRunning;
  attach: typeof attachPrivateFifo;
  observe: typeof observeClaudeModelOuter;
}

const nativePorts: ClaudeModelOriginalOwnerPorts = {
  prepare: preparePrivateFifo, operation: runClaudeModelSupervisorOperation,
  start: startClaudeModelUnit, persist: persistClaudeModelRunning,
  attach: attachPrivateFifo, observe: observeClaudeModelOuter,
};

export type ClaudeModelOriginalOwnerStage = 'validation' | 'fifo_prepare' | 'gate_prepare' |
  'native_start' | 'entered' | 'running' | 'fifo_attach' | 'before_release' |
  'release' | 'ready' | 'outer_observation' | 'outer_validation' | 'outer_persistence';

/** Fixed diagnostic label only. It carries no raw native error, paths or credentials. */
export class ClaudeModelOriginalOwnerError extends Error {
  readonly stage: ClaudeModelOriginalOwnerStage;
  constructor(stage: ClaudeModelOriginalOwnerStage) {
    super('MODEL_ORIGINAL_OWNER_UNAVAILABLE');
    this.name = 'ClaudeModelOriginalOwnerError';
    this.stage = stage;
  }
}

function selectedPaths(store: Store, claim: InvestigationClaim): string[] {
  const record = store.get(claim.requestId);
  if (!record || record.workspaceId !== claim.workspaceId) throw new Error('NOT_AVAILABLE');
  return [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
}

function originalDescriptor(claim: InvestigationClaim): ClaudeModelSupervisorDescriptor {
  const resource = claim.wslResource; const gate = resource?.gate; const launch = gate?.launch;
  if (!resource || !gate || !launch || gate.protocol !== 'attempt_gate_v1' ||
    gate.payloadKind !== 'claude_model_v1' || launch.action !== 'claude_model_v1' ||
    launch.workerEpoch !== claim.workerEpoch || !launch.commandDigest ||
    claim.launchProtocol !== 'resource_reservation_v1' ||
    claim.sourceView || claim.windowsSource || claim.dockerVolume || claim.containerId ||
    claim.containerName || claim.scratchRoot) throw new Error('NOT_AVAILABLE');
  return {attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    distro: resource.distro, linuxUser: gate.linuxUser, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest, commandDigest: launch.commandDigest};
}

function entered(state: ClaudeModelSupervisorState | null): state is ClaudeModelSupervisorState {
  return !!state && state.phase === 'entered' && !state.closed &&
    !!state.invocationId && !!state.controlGroup && !!state.enterPid && !!state.enterStartTicks;
}

function exactState(state: ClaudeModelSupervisorState | null,
  descriptor: ClaudeModelSupervisorDescriptor): ClaudeModelSupervisorState | null {
  return state ? parseClaudeModelSupervisorOutput(JSON.stringify(state) + '\n', descriptor) : null;
}

function cloneTrusted<T>(value: T): T {
  try {return structuredClone(value);}
  catch {throw new ClaudeModelOriginalOwnerError('validation');}
}

/** Bounds an asynchronous native result. Late resolution is ignored and never advances the state. */
async function before<T>(work: Promise<T>, deadline: number, signal?: AbortSignal,
  closed: readonly Promise<unknown>[] = [], cancel?: () => void): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0 || signal?.aborted) {
    cancel?.();
    // The native operation was already invoked while evaluating this argument.
    void work.catch(() => undefined);
    throw new Error('NOT_AVAILABLE');
  }
  let rejectTimeout!: (error: Error) => void;
  const stop = new Promise<never>((_, reject) => {rejectTimeout = reject;});
  const abort = () => {cancel?.(); rejectTimeout(new Error('NOT_AVAILABLE'));};
  const timer = setTimeout(abort, remaining);
  signal?.addEventListener('abort', abort, {once: true});
  try {
    const result = await Promise.race([work, stop,
      ...closed.map(p => p.then((): never => {throw new Error('NOT_AVAILABLE');},
        (): never => {throw new Error('NOT_AVAILABLE');}))]);
    if (performance.now() >= deadline || signal?.aborted) {cancel?.(); throw new Error('NOT_AVAILABLE');}
    return result;
  } catch (error) {cancel?.(); throw error;}
  finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
}

/** Trusted original-owner coordinator. This does not grant a recovery or historical send window. */
export async function runClaudeModelOriginalOwner(input: ClaudeModelOriginalOwnerInput,
  ports: ClaudeModelOriginalOwnerPorts = nativePorts) {
  const claim = cloneTrusted(input.claim);
  const descriptor = cloneTrusted(input.descriptor);
  const paths = cloneTrusted(input.paths);
  const profile = cloneTrusted(input.profile);
  const limits = cloneTrusted(input.limits);
  const binding = cloneTrusted(input.binding);
  const profileRevision = input.profileRevision;
  const dispatcher = input.dispatcher;
  const {store, runningTickets, outerTickets, signal} = input;
  let current = claim;
  let handle: ClaudeModelUnitHandle | undefined;
  let transport: Transport | undefined;
  let owner: OwnerWindow | undefined;
  let recoveryNeeded = false;
  let disposed = false;
  let closePromise: Promise<void> | undefined;
  let stage: ClaudeModelOriginalOwnerStage = 'validation';
  let handleClosed = false;
  let transportClosed = false;
  let resolveDisposed!: () => void;
  const whenDisposed = new Promise<void>(resolve => {resolveDisposed = resolve;});
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    disposed = true;
    resolveDisposed();
    if (!recoveryNeeded) {
      recoveryNeeded = true;
      try {store.markRecoveryRequired(current, new Date());} catch {
        // Stale owner cannot overwrite a new lease; retain the occupied slot.
      }
    }
    owner?.close();
    closePromise = Promise.allSettled([
      Promise.resolve().then(() => transport?.closeTransport()),
      Promise.resolve().then(() => handle?.closeBridge()),
    ]).then(() => undefined);
    return closePromise;
  };
  const fail = close;
  try {
    const record = store.get(claim.requestId);
    if (claim.phase !== 'start_intent' || claim.nativeRef !== null || signal?.aborted ||
      !isDeepStrictEqual(descriptor, originalDescriptor(claim)) ||
      !record || record.budget.maxWallSeconds !== limits.maxWallSeconds ||
      record.budget.maxTurns !== limits.maxTurns ||
      !validClaudeModelLaunchLimits(limits) ||
      claudeModelCommandDigest(paths, profile, limits.maxTurns) !== descriptor.commandDigest ||
      paths.privateFifoDirectory !==
        `${claim.wslResource!.gate!.root}/${claim.attemptId}-${claim.workerEpoch}.mcp`)
      throw new Error('NOT_AVAILABLE');
    const selected = selectedPaths(store, claim);
    store.preflightClaudeModelLaunch(claim, selected, profileRevision,
      claim.wslResource!.gate!.launch!, new Date());
    stage = 'fifo_prepare';
    const fifo = await ports.prepare({store, claim, ...(signal ? {signal} : {})});
    if (signal?.aborted || fifo.directory !== paths.privateFifoDirectory) throw new Error('NOT_AVAILABLE');
    stage = 'gate_prepare';
    const prepared = exactState(await ports.operation('prepare', descriptor,
      claim.wslResource!.gate!.root, undefined, signal), descriptor);
    if (!prepared || prepared.phase !== 'prepared' || prepared.closed) throw new Error('NOT_AVAILABLE');
    store.preflightClaudeModelLaunch(claim, selected, profileRevision,
      claim.wslResource!.gate!.launch!, new Date());
    stage = 'native_start';
    handle = ports.start(descriptor, claim.wslResource!.gate!.root, paths, limits, profile, signal);
    void handle.closed.then(() => {handleClosed = true;}, () => {handleClosed = true;});
    stage = 'entered';
    const enteredDeadline = performance.now() + 5000;
    let journal: ClaudeModelSupervisorState | null = null;
    while (performance.now() < enteredDeadline) {
      journal = exactState(await before(ports.operation('status', descriptor, claim.wslResource!.gate!.root,
        undefined, signal), enteredDeadline, signal, [handle.closed]), descriptor);
      if (entered(journal)) break;
      await before(new Promise(resolve => setTimeout(resolve, 50)), enteredDeadline, signal, [handle.closed]);
    }
    if (!entered(journal) || handleClosed) throw new Error('NOT_AVAILABLE');
    stage = 'running';
    current = await ports.persist({claim, journal, descriptor, store, tickets: runningTickets,
      nativeRef: randomUUID(), profileRevision});
    if (current.phase !== 'started' || !current.nativeRef || handleClosed ||
      current.requestId !== claim.requestId || current.attemptId !== claim.attemptId ||
      current.workspaceId !== claim.workspaceId || current.workerId !== claim.workerId ||
      current.workerEpoch !== claim.workerEpoch ||
      !isDeepStrictEqual(current.wslResource?.gate, claim.wslResource?.gate))
      throw new Error('NOT_AVAILABLE');
    stage = 'fifo_attach';
    transport = await ports.attach({claim: current, store, workerGrantId: binding.workerGrantId,
      workerAudience: binding.workerAudience, workerRecipient: binding.workerRecipient,
      dispatcher, ...(signal ? {signal} : {})});
    void transport.closed.then(() => {transportClosed = true;}, () => {transportClosed = true;});
    stage = 'before_release';
    store.assertRunningReadAuthority(current, binding, new Date());
    const originalRunning = store.getModelRunningObservation(current);
    if (!originalRunning || !isDeepStrictEqual(originalRunning.journal, journal) ||
      !isDeepStrictEqual(originalRunning.resource, current.wslResource)) throw new Error('NOT_AVAILABLE');
    const rechecked = exactState(await ports.operation('status', descriptor,
      claim.wslResource!.gate!.root, undefined, signal), descriptor);
    if (!entered(rechecked) || !isDeepStrictEqual(rechecked, journal) ||
      handleClosed || transportClosed || signal?.aborted) throw new Error('NOT_AVAILABLE');
    store.assertRunningReadAuthority(current, binding, new Date());
    const active = store.get(current.requestId);
    const startedAt = active?.attempts.find(attempt => attempt.id === current.attemptId)?.startedAt;
    if (!startedAt) throw new Error('NOT_AVAILABLE');
    owner = outerTickets.beginOwner(current, handle, new Date(startedAt), limits, signal);
    if (handleClosed || transportClosed || signal?.aborted ||
      performance.now() >= owner.deadline) throw new Error('NOT_AVAILABLE');
    const releaseController = new AbortController();
    const releaseSignal = signal ? AbortSignal.any([signal, releaseController.signal]) :
      releaseController.signal;
    // First release of this exact original handle; no retry after an unknown result.
    stage = 'release';
    const release = exactState(await before(ports.operation('release', descriptor,
      claim.wslResource!.gate!.root, {invocationId: journal.invocationId!,
        controlGroup: journal.controlGroup!}, releaseSignal), owner.deadline, releaseSignal,
    [handle.closed, transport.closed], () => releaseController.abort()), descriptor);
    if (!release || !['released','consumed'].includes(release.phase) || release.closed ||
      release.invocationId !== journal.invocationId ||
      release.controlGroup !== journal.controlGroup ||
      release.enterPid !== journal.enterPid ||
      release.enterStartTicks !== journal.enterStartTicks)
      throw new Error('NOT_AVAILABLE');
    stage = 'ready';
    const startup = await before(handle.ready, owner.deadline, signal, [handle.closed, transport.closed]);
    const checkedStartup = startup && parseClaudeModelStartup(JSON.stringify(startup) + '\n', descriptor);
    if (!checkedStartup || checkedStartup.journal.phase !== 'consumed' || checkedStartup.journal.closed ||
      checkedStartup.journal.invocationId !== journal.invocationId ||
      checkedStartup.journal.controlGroup !== journal.controlGroup ||
      checkedStartup.journal.enterPid !== journal.enterPid ||
      checkedStartup.journal.enterStartTicks !== journal.enterStartTicks)
      throw new Error('NOT_AVAILABLE');
    stage = 'outer_observation';
    const observation = await before(ports.observe({running: originalRunning, startup: checkedStartup,
      descriptor, paths, profile, limits}, {deadline: owner.deadline, closed: handle.closed,
        ...(signal ? {signal} : {})}),
    owner.deadline, signal, [handle.closed, transport.closed]);
    if (observation.kind !== 'outer_journal_candidate') throw new Error('NOT_AVAILABLE');
    const fact: ModelOuterConfinedFact = {kind: 'model_outer_confined_v1',
      networkMode: 'host_shared_pre_srt', srtState: 'not_started',
      expectation: {descriptor, paths, profile, profileRevision, limits},
      observation};
    stage = 'outer_validation';
    if (!validateCurrentClaudeModelOuterFact(fact) || handleClosed || transportClosed)
      throw new Error('NOT_AVAILABLE');
    stage = 'outer_persistence';
    store.assertRunningReadAuthority(current, binding, new Date());
    const outerReceipt = owner.issueFact(fact);
    try {store.recordModelOuterFact(current, binding, fact, outerReceipt, new Date());}
    finally {outerTickets.revoke(outerReceipt);}
    const savedFact = structuredClone(fact);
    let sendEntered = false;
    let successfulPromptHash: string | null = null;
    let outcomeRead = false;
    let gateCloseEntered = false;
    return {
      get fact(): ModelOuterConfinedFact { return structuredClone(savedFact); },
      sendPrompt(bytes: Buffer, hash: string): Promise<void> {
        if (sendEntered || disposed) return Promise.reject(new Error('MODEL_PROMPT_UNAVAILABLE'));
        sendEntered = true;
        try {
          const copied = boundedClaudeModelPrompt(bytes, hash);
          if (signal?.aborted || handleClosed || transportClosed ||
            performance.now() >= owner!.deadline) throw new Error('NOT_AVAILABLE');
          const launch = current.wslResource!.gate!.launch!;
          const intentReceipt = owner!.issuePrompt(savedFact, 'intent');
          try {store.recordModelPromptIntent(current, binding, launch, hash, new Date(), intentReceipt);}
          finally {outerTickets.revoke(intentReceipt);}
          if (signal?.aborted || handleClosed || transportClosed ||
            performance.now() >= owner!.deadline) throw new Error('NOT_AVAILABLE');
          const sendReceipt = owner!.issuePrompt(savedFact, 'send');
          try {store.assertModelPromptSendAuthority(current, binding, launch, hash, new Date(), sendReceipt);}
          finally {outerTickets.revoke(sendReceipt);}
          if (disposed || signal?.aborted || handleClosed || transportClosed ||
            performance.now() >= owner!.deadline) throw new Error('NOT_AVAILABLE');
          // No await or mutable-input read between the durable final fence and original-handle write.
          return handle!.writePrompt(copied, hash).then(() => {successfulPromptHash = hash;},
            async () => {await fail(); throw new Error('MODEL_PROMPT_UNAVAILABLE');});
        } catch {
          return fail().then(() => {throw new Error('MODEL_PROMPT_UNAVAILABLE');});
        }
      },
      async readNativeOutcomeCandidate(): Promise<ClaudeModelOriginalOwnerCandidate | null> {
        if (outcomeRead || !successfulPromptHash || disposed || signal?.aborted ||
          transportClosed) return null;
        outcomeRead = true;
        const promptHash = successfulPromptHash;
        try {
          const record = store.get(current.requestId);
          const attempt = record?.attempts.find(item => item.id === current.attemptId);
          const started = attempt?.startedAt ? Date.parse(attempt.startedAt) : NaN;
          const wall = record?.budget.maxWallSeconds;
          const maxTurns = record?.budget.maxTurns;
          if (!record || record.workspaceId !== current.workspaceId ||
            !Number.isSafeInteger(wall) || wall! < 1 || wall! > 600 ||
            wall !== limits.maxWallSeconds || !Number.isSafeInteger(maxTurns) ||
            maxTurns! < 1 || maxTurns! > 8 || maxTurns !== limits.maxTurns ||
            !Number.isFinite(started) ||
            started > Date.now()) return null;
          const remaining = started + wall! * 1000 - Date.now();
          if (remaining <= 0) return null;
          const monotonicDeadline = performance.now() + remaining;
          let timer!: NodeJS.Timeout;
          const timeout = new Promise<null>(resolve => {
            timer = setTimeout(() => resolve(null), remaining);
          });
          let abortListener: (() => void) | undefined;
          const aborted = new Promise<null>(resolve => {
            if (signal?.aborted) {resolve(null); return;}
            abortListener = () => resolve(null);
            signal?.addEventListener('abort', abortListener, {once: true});
          });
          let native;
          try {
            native = await Promise.race([handle!.closed.then(value => value, () => null),
              whenDisposed.then(() => null), transport!.closed.then(() => null, () => null),
              timeout, aborted]);
          } finally {
            clearTimeout(timer);
            if (abortListener) signal?.removeEventListener('abort', abortListener);
          }
          if (!native || disposed || signal?.aborted || transportClosed ||
            native.uncertain !== false || native.bridgeExitCode !== 0 ||
            !Buffer.isBuffer(native.stdout)) return null;
          const raw = Buffer.from(native.stdout);
          const parsed = parseClaudeModelOutcomeCandidate(raw, maxTurns!);
          if (!parsed) return null;
          // Parse before the final running-authority check, while the caller still owns the unit.
          store.assertRunningReadAuthority(current, binding, new Date());
          if (disposed || signal?.aborted || transportClosed ||
            performance.now() >= monotonicDeadline || Date.now() >= started + wall! * 1000)
            return null;
          const {kind: _kind, ...projected} = parsed;
          void _kind;
          return {kind: 'claude_model_original_owner_candidate_v1',
            requestId: current.requestId, attemptId: current.attemptId,
            workspaceId: current.workspaceId, workerEpoch: current.workerEpoch,
            nativeRef: current.nativeRef!, promptHash,
            commandDigest: current.wslResource!.gate!.launch!.commandDigest!, ...projected};
        } catch {return null;}
      },
      /** Stop the original consumed gate without changing its durable claim or epoch. */
      async closeOriginalGate(): Promise<ClaudeModelSupervisorState | null> {
        if (gateCloseEntered || !successfulPromptHash || disposed) return null;
        gateCloseEntered = true;
        try {
          const closed = exactState(await ports.operation('close', descriptor,
            claim.wslResource!.gate!.root), descriptor);
          if (!closed || closed.phase !== 'consumed' || closed.closed !== true ||
            !isDeepStrictEqual(closed, {...savedFact.observation.journalAfter, closed: true})) return null;
          return closed;
        } catch { return null; }
      },
      close,
    };
  } catch {
    try {await fail();} catch { /* Preserve the fixed diagnostic even if local cleanup fails. */ }
    throw new ClaudeModelOriginalOwnerError(stage);
  }
}

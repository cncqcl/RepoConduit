import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SqliteInvestigationStore, InvestigationClaim, RunningReadBinding,
  WslResourceReservation } from '../adapters/storage/investigation-sqlite.js';
import type { SqliteStore } from '../adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../core/investigation/request.js';
import { buildClaudeModelSealedLaunch } from '../adapters/secondary-investigator/claude-model-sealed-launch.js';
import type { ClaudeModelInvestigationInput, ClaudeModelInvestigationPorts } from './claude-model-investigation.js';
import { deriveClaudeInvestigationRuntimePaths, parseClaudeInvestigationRuntimeConfiguration,
  type ClaudeInvestigationRuntimeConfiguration } from './claude-investigation-runtime-config.js';

export interface PreparedInvestigationAuthority {
  profileRevision: string;
  budgetRef: string;
  permissionEpoch: number;
  isolationEvidence: string;
  identity: { uid: number; bootId: string };
  runtime: ClaudeInvestigationRuntimeConfiguration;
}

type ModelRunInput = Omit<ClaudeModelInvestigationInput,
  'store' | 'completionTickets' | 'getSnapshot' | 'contextRevision' | 'dispatcher' |
  'runningTickets' | 'outerTickets'>;

export interface InvestigationSchedulerDependencies {
  store: Pick<SqliteInvestigationStore, 'listPending' | 'get' | 'claimRequest' |
    'reserveWslResource' | 'markRecoveryRequired' | 'listUnsettled'>;
  grants: Pick<SqliteStore, 'insertGrant' | 'revokeGrant'>;
  /** Only the trusted application owner may return a verified, current local profile. */
  authority: { prepareForRequest(record: InvestigationRecord, signal: AbortSignal):
    Promise<PreparedInvestigationAuthority | null> | PreparedInvestigationAuthority | null };
  preflightPrompt(requestId: string): Promise<{actualBytes:number;maxBytes:16384}>;
  /** Hash actual persisted snapshot content after checking its exact binding. */
  getSourceDigest(record: InvestigationRecord): Promise<string>;
  runModelInvestigation(input: ModelRunInput,
    ports?: ClaudeModelInvestigationPorts): Promise<InvestigationRecord | null>;
  now?: () => Date;
  onError?: (requestId: string, error: unknown) => void;
  /** Bounds each trusted pre-claim observation; tests may use a shorter interval. */
  observationTimeoutMs?: number;
}

const SHA = /^[0-9a-f]{64}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stillQueued(record: InvestigationRecord | null, expected: InvestigationRecord): boolean {
  return !!record && isDeepStrictEqual(record, expected) && record.state === 'queued' &&
    !record.cancelRequested && record.attempts.length === 0;
}

/** Abort or bound a pending pre-claim observation. A late result has no dispatch path. */
function beforeClaim<T>(work: (signal: AbortSignal) => Promise<T> | T,
  parent: AbortSignal, timeoutMs: number): Promise<T> {
  if (parent.aborted) return Promise.reject(new Error('NOT_AVAILABLE'));
  return new Promise<T>((resolve, reject) => {
    const observation = new AbortController();
    let settled = false;
    const cleanup = () => {clearTimeout(timeout);parent.removeEventListener('abort', abort);};
    const abort = () => {
      if (settled) return;
      settled = true;observation.abort();cleanup();reject(new Error('NOT_AVAILABLE'));
    };
    const timeout = setTimeout(abort, timeoutMs);
    parent.addEventListener('abort', abort, {once:true});
    if (parent.aborted) abort();
    void Promise.resolve().then(() => {
      if (settled) throw new Error('NOT_AVAILABLE');
      return work(observation.signal);
    }).then(value => {
      if (settled) return;
      settled=true;cleanup();resolve(value);
    }, error => {
      if (settled) return;
      settled=true;cleanup();reject(error);
    });
  });
}

/** One trusted local coordinator. SQLite remains the cross-process slot authority. */
export function createInvestigationScheduler(deps: InvestigationSchedulerDependencies) {
  const abort = new AbortController();
  let accepting = true;
  let ticking: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const activeRuns = new Set<Promise<void>>();
  const runFailures: unknown[] = [];
  const fatalErrors: unknown[] = [];
  const now = deps.now ?? (() => new Date());
  const observationTimeoutMs = deps.observationTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(observationTimeoutMs) || observationTimeoutMs < 1 || observationTimeoutMs > 10_000)
    throw new TypeError('INVALID_OBSERVATION_TIMEOUT');
  const report = (requestId: string, error: unknown) => {
    try {deps.onError?.(requestId, error);} catch { /* The durable attempt remains authoritative. */ }
  };

  async function finalize(record: InvestigationRecord, claim: InvestigationClaim,
    grantId: string | null): Promise<void> {
    const errors: unknown[] = [];
    if (grantId) {
      try {deps.grants.revokeGrant(grantId,now().toISOString());}
      catch (error) {report(record.id,error);errors.push(error);}
    }
    try {
      if (deps.store.listUnsettled().some(item =>
        item.requestId===claim.requestId && item.attemptId===claim.attemptId)) {
        deps.store.markRecoveryRequired(claim,now());
      }
    } catch (error) {report(record.id,error);errors.push(error);}
    if (errors.length) throw new AggregateError(errors,
      `Investigation ${record.id} finalization unconfirmed`);
  }

  async function process(record: InvestigationRecord): Promise<void> {
    let claim: InvestigationClaim | null = null;
    let grantId: string | null = null;
    let launched = false;
    try {
      const raw = await beforeClaim(signal => deps.authority.prepareForRequest(record, signal),
        abort.signal, observationTimeoutMs);
      const prepared = raw && structuredClone(raw);
      if (!accepting || !prepared || prepared.profileRevision !== record.profileRef ||
        prepared.budgetRef !== record.budgetRef || !prepared.isolationEvidence ||
        !Number.isSafeInteger(prepared.permissionEpoch) || prepared.permissionEpoch < 0 ||
        !Number.isSafeInteger(prepared.identity?.uid) || prepared.identity.uid < 1 ||
        !BOOT.test(prepared.identity.bootId)) return;
      const runtime = parseClaudeInvestigationRuntimeConfiguration(prepared.runtime);
      if (!Number.isSafeInteger(record.budget.maxTurns) || record.budget.maxTurns < 1 ||
        record.budget.maxTurns > 8 || !Number.isSafeInteger(record.budget.maxWallSeconds) ||
        record.budget.maxWallSeconds < 1 || record.budget.maxWallSeconds > 600) return;
      const sized = await beforeClaim(() => deps.preflightPrompt(record.id),abort.signal,observationTimeoutMs);
      if (!accepting || !Number.isSafeInteger(sized.actualBytes) || sized.actualBytes < 1 ||
        sized.actualBytes > sized.maxBytes || sized.maxBytes !== 16384) return;
      const sourceDigest = await beforeClaim(() => deps.getSourceDigest(record),abort.signal,observationTimeoutMs);
      if (!accepting || !SHA.test(sourceDigest) || !stillQueued(deps.store.get(record.id), record)) return;
      const workerId = `worker_${randomUUID()}`;
      claim = deps.store.claimRequest(record.id, {workerId, isolationEvidence:prepared.isolationEvidence,
        profileRevision:prepared.profileRevision,permissionEpoch:prepared.permissionEpoch,
        launchProtocol:'resource_reservation_v1',now:now()});
      if (!claim) return;
      const paths = deriveClaudeInvestigationRuntimePaths(runtime, claim.attemptId, claim.workerEpoch);
      const selected = [...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
      const profileDigest = createHash('sha256').update(JSON.stringify({profileRevision:prepared.profileRevision,
        budgetRef:prepared.budgetRef,budget:record.budget,runtime})).digest('hex');
      const commandDigest = buildClaudeModelSealedLaunch(paths,runtime.profile,record.budget.maxTurns).commandDigest;
      const reservation: WslResourceReservation = {unitName:`rcac-investigator-${randomUUID()}.service`,
        distro:runtime.distro,uid:prepared.identity.uid,bootId:prepared.identity.bootId,
        gate:{protocol:'attempt_gate_v1',linuxUser:runtime.linuxUser,root:runtime.relayRoot,
          payloadKind:'claude_model_v1',launch:{workerEpoch:claim.workerEpoch,sourceDigest,profileDigest,
            commandDigest,action:'claude_model_v1'}}};
      claim = deps.store.reserveWslResource(claim,reservation,now());
      if (!accepting || abort.signal.aborted) throw new Error('NOT_AVAILABLE');
      grantId = `worker-read-${randomUUID()}`;
      const workerAudience = 'investigator';
      const workerRecipient = 'local';
      deps.grants.insertGrant({id:grantId,principal:workerId,audience:workerAudience,
        recipient:workerRecipient,workspaceId:record.workspaceId,collaborationId:record.collaborationId,
        permissions:['data.read'],dataPaths:selected,
        expiresAt:new Date(now().getTime()+record.budget.maxWallSeconds*1000+30_000).toISOString(),
        revokedAt:null});
      const binding: RunningReadBinding = {collaborationId:record.collaborationId,
        workingCopyId:record.workingCopyId,snapshotId:record.snapshotRef,paths:selected,
        workerGrantId:grantId,workerAudience,workerRecipient};
      const descriptor = {attemptId:claim.attemptId,workspaceId:claim.workspaceId,
        distro:reservation.distro,linuxUser:runtime.linuxUser,uid:reservation.uid,
        bootId:reservation.bootId,unitName:reservation.unitName,launchWorkerEpoch:claim.workerEpoch,
        sourceDigest,profileDigest,commandDigest};
      if (!accepting || abort.signal.aborted) throw new Error('NOT_AVAILABLE');
      const currentClaim = claim;
      const currentGrantId = grantId;
      const run = (async () => {
        try {await deps.runModelInvestigation({claim:currentClaim,binding,descriptor,paths,profile:runtime.profile,
        profileRevision:prepared.profileRevision,
        limits:{maxWallSeconds:record.budget.maxWallSeconds,maxTurns:record.budget.maxTurns},
        signal:abort.signal});}
        catch (error) {report(record.id,error);}
        finally {await finalize(record,currentClaim,currentGrantId);}
      })();
      launched = true;
      activeRuns.add(run);
      void run.then(() => activeRuns.delete(run), error => {
        activeRuns.delete(run);runFailures.push(error);fatalErrors.push(error);accepting=false;
      });
    } catch (error) {report(record.id,error);}
    finally {
      if (!launched && claim) await finalize(record,claim,grantId);
    }
  }

  const tick = (): Promise<void> => {
    if (fatalErrors.length) return Promise.reject(new AggregateError(fatalErrors,
      'Investigation scheduler finalization unconfirmed'));
    if (!accepting) return Promise.resolve();
    if (ticking) return ticking;
    let pending: ReturnType<typeof deps.store.listPending>;
    try {pending=deps.store.listPending();}
    catch(error) {return Promise.reject(error);}
    if (pending.length===0) return Promise.resolve();
    ticking = (async () => {
      const errors: unknown[] = [];
      for (const item of pending) {
        if (!accepting) break;
        const record = deps.store.get(item.requestId);
        if (!record || record.workspaceId!==item.workspaceId ||
          record.collaborationId!==item.collaborationId || record.state!=='queued') continue;
        try {await process(record);} catch (error) {errors.push(error);fatalErrors.push(error);accepting=false;}
      }
      errors.push(...runFailures.splice(0));
      if (errors.length) throw new AggregateError(errors,'Investigation scheduler finalization unconfirmed');
    })().finally(() => {ticking=undefined;});
    return ticking;
  };
  const stopAdmission = (): void => {accepting=false;};
  const close = (): Promise<void> | undefined => {
    if (closing) return closing;
    if (closed) {
      if (fatalErrors.length) throw new AggregateError(fatalErrors,'Investigation scheduler shutdown unconfirmed');
      return;
    }
    stopAdmission();
    abort.abort();
    if (!ticking && activeRuns.size===0) {
      closed=true;
      const errors=fatalErrors;
      if(errors.length) throw new AggregateError(errors,'Investigation scheduler shutdown unconfirmed');
      return;
    }
    closing=Promise.allSettled([ticking]).then(async settled => {
      await Promise.allSettled([...activeRuns]);
      const admissionErrors=settled.filter((item): item is PromiseRejectedResult => item.status==='rejected')
        .map(item => item.reason as unknown);
      const errors=fatalErrors;
      if(errors.length || admissionErrors.length) throw new AggregateError([...errors,...admissionErrors],
        'Investigation scheduler shutdown unconfirmed');
    });
    void closing.then(() => {closed=true;}, () => {closed=true;});
    return closing;
  };
  return {tick,stopAdmission,close};
}

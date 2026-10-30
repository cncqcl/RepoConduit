import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { StdioConnection, CodexControlSend, CodexSynchronousSend } from '../adapters/codex/protocol/stdio.js';
import { CodexJsonlTransport } from '../adapters/codex/protocol/stdio.js';
import { WINDOWS_APP_SERVER_PROTOCOL_TARGET } from '../adapters/codex/investigator/windows-launch-record.js';
import type { WindowsAppServerLaunchRecord } from '../adapters/codex/investigator/windows-launch-record.js';
import type { InvestigationClaim, SqliteInvestigationStore, RunningReadBinding } from '../adapters/storage/investigation-sqlite.js';
import type {DispatchService} from '../application/dispatch.js';
import { StoreConflict } from '../adapters/storage/sqlite.js';
import type { RepositorySnapshot } from '../adapters/repository/snapshots.js';
import type { ContextRevision } from '../core/collaboration/context.js';
import { parseInvestigationResult, type ParsedInvestigationResult } from '../core/investigation/result.js';
import { buildInvestigationPrompt, InvestigationPromptLimitExceeded } from './investigation-prompt.js';
import {createCodexInvestigatorReadCapability,type CodexInvestigatorReadStore} from './codex-investigator-read.js';
import {validateInvestigationResultEvidence} from './investigation-result-evidence.js';
import { interruptJournaledRestrictedTurn, startJournaledRestrictedThread,
  startJournaledRestrictedTurn } from './codex-investigation-lifecycle.js';

export const WINDOWS_CODEX_PROTOCOL_TARGET = WINDOWS_APP_SERVER_PROTOCOL_TARGET;

export type CodexInvestigationFailureStage = 'prepare' | 'initialize' | 'thread_start' |
  'turn_start' | 'wait_turn' | 'result_parse' | 'evidence_validate' | 'cleanup';
export type CodexInvestigationFailureCode = 'PROTOCOL_REJECTED' | 'PROTOCOL_REMOTE_ERROR' |
  'PROTOCOL_CLOSED' | 'PROTOCOL_LIMIT' | 'PROTOCOL_LIMIT_FRAME' | 'PROTOCOL_LIMIT_TOTAL' |
  'PROTOCOL_LIMIT_NOTIFICATIONS' | 'PROTOCOL_TIMEOUT' | 'PROTOCOL_ABORTED' |
  'PROTOCOL_NO_FINAL_ITEM' | 'PROTOCOL_NO_FINAL_INCOMPLETE_VIEW' | 'PROTOCOL_NO_FINAL_NONFINAL_ONLY' |
  'PROTOCOL_REJECTED_THREAD_CWD' | 'PROTOCOL_REJECTED_THREAD_MODEL' |
  'PROTOCOL_REJECTED_THREAD_POLICY' | 'PROTOCOL_REJECTED_THREAD_ROOTS' |
  'PROTOCOL_REJECTED_THREAD_PROVIDER' | 'PROTOCOL_REJECTED_THREAD_REVIEWER' |
  'PROTOCOL_REJECTED_THREAD_SANDBOX' | 'PROTOCOL_REJECTED_THREAD_PROFILE' |
  'PROTOCOL_REJECTED_THREAD_DUPLICATE' | 'PROTOCOL_REJECTED_TURN_STRUCTURE' |
  'PROTOCOL_REJECTED_TURN_ID' | 'PROTOCOL_REJECTED_TURN_STATUS' |
  'PROTOCOL_REJECTED_TURN_ITEMS' | 'PROTOCOL_REJECTED_TURN_DUPLICATE' |
  'PROTOCOL_REJECTED_TURN_OUTCOME' | 'PROTOCOL_REJECTED_INGEST_JSON' |
  'PROTOCOL_REJECTED_INGEST_ENVELOPE' | 'PROTOCOL_REJECTED_INGEST_NOTIFICATION' |
  'PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID' |
  'PROTOCOL_REJECTED_INGEST_NOTIFICATION_UNKNOWN' | 'PROTOCOL_NATIVE_ERROR' |
  'PROTOCOL_NATIVE_UNAUTHORIZED' | 'PROTOCOL_NATIVE_FORBIDDEN' |
  'PROTOCOL_NATIVE_BAD_REQUEST' | 'PROTOCOL_NATIVE_RATE_LIMIT' |
  'PROTOCOL_NATIVE_USAGE_LIMIT' | 'PROTOCOL_NATIVE_CONTEXT_LIMIT' |
  'PROTOCOL_NATIVE_BUDGET_LIMIT' | 'PROTOCOL_NATIVE_SERVER' |
  'PROTOCOL_NATIVE_POLICY' | 'PROTOCOL_NATIVE_INTERNAL' | 'PROTOCOL_NATIVE_SANDBOX' |
  'PROTOCOL_NATIVE_TURN_NOT_STEERABLE' | 'PROTOCOL_NATIVE_CONNECTION' |
  'PROTOCOL_NATIVE_STREAM_CONNECTION' | 'PROTOCOL_NATIVE_STREAM_DISCONNECTED' |
  'PROTOCOL_NATIVE_STREAM_RETRY_LIMIT' |
  'PROTOCOL_REJECTED_INGEST_SERVER_REQUEST' | 'NOT_AVAILABLE' | 'INVALID_ARGUMENT' |
  'INVALID_INVESTIGATION_RESULT' | 'INTERNAL_ERROR';
export interface CodexInvestigationFailure {
  stage: CodexInvestigationFailureStage;
  code: CodexInvestigationFailureCode;
}

const codexFailureCodes = new Set<CodexInvestigationFailureCode>([
  'PROTOCOL_REJECTED','PROTOCOL_REMOTE_ERROR','PROTOCOL_CLOSED','PROTOCOL_LIMIT',
  'PROTOCOL_LIMIT_FRAME','PROTOCOL_LIMIT_TOTAL','PROTOCOL_LIMIT_NOTIFICATIONS',
  'PROTOCOL_NO_FINAL_ITEM','PROTOCOL_NO_FINAL_INCOMPLETE_VIEW','PROTOCOL_NO_FINAL_NONFINAL_ONLY',
  'PROTOCOL_TIMEOUT','PROTOCOL_ABORTED','PROTOCOL_REJECTED_THREAD_CWD','PROTOCOL_REJECTED_THREAD_MODEL',
  'PROTOCOL_REJECTED_THREAD_POLICY','PROTOCOL_REJECTED_THREAD_ROOTS',
  'PROTOCOL_REJECTED_THREAD_PROVIDER','PROTOCOL_REJECTED_THREAD_REVIEWER',
  'PROTOCOL_REJECTED_THREAD_SANDBOX','PROTOCOL_REJECTED_THREAD_PROFILE',
  'PROTOCOL_REJECTED_THREAD_DUPLICATE','NOT_AVAILABLE','INVALID_ARGUMENT',
  'PROTOCOL_REJECTED_TURN_STRUCTURE','PROTOCOL_REJECTED_TURN_ID',
  'PROTOCOL_REJECTED_TURN_STATUS','PROTOCOL_REJECTED_TURN_ITEMS',
  'PROTOCOL_REJECTED_TURN_DUPLICATE','PROTOCOL_REJECTED_TURN_OUTCOME',
  'PROTOCOL_REJECTED_INGEST_JSON','PROTOCOL_REJECTED_INGEST_ENVELOPE',
  'PROTOCOL_REJECTED_INGEST_NOTIFICATION','PROTOCOL_REJECTED_INGEST_SERVER_REQUEST',
  'PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID',
  'PROTOCOL_REJECTED_INGEST_NOTIFICATION_UNKNOWN','PROTOCOL_NATIVE_ERROR',
  'PROTOCOL_NATIVE_UNAUTHORIZED','PROTOCOL_NATIVE_FORBIDDEN','PROTOCOL_NATIVE_BAD_REQUEST',
  'PROTOCOL_NATIVE_RATE_LIMIT','PROTOCOL_NATIVE_USAGE_LIMIT','PROTOCOL_NATIVE_CONTEXT_LIMIT',
  'PROTOCOL_NATIVE_BUDGET_LIMIT','PROTOCOL_NATIVE_SERVER','PROTOCOL_NATIVE_POLICY',
  'PROTOCOL_NATIVE_INTERNAL','PROTOCOL_NATIVE_SANDBOX','PROTOCOL_NATIVE_TURN_NOT_STEERABLE',
  'PROTOCOL_NATIVE_CONNECTION','PROTOCOL_NATIVE_STREAM_CONNECTION',
  'PROTOCOL_NATIVE_STREAM_DISCONNECTED','PROTOCOL_NATIVE_STREAM_RETRY_LIMIT',
  'INVALID_INVESTIGATION_RESULT','INTERNAL_ERROR',
]);

/** Never persist a native/provider error message unless it is one of these exact codes. */
export function normalizeCodexFailureCode(error: unknown): CodexInvestigationFailureCode {
  if (!(error instanceof Error)) return 'INTERNAL_ERROR';
  return codexFailureCodes.has(error.message as CodexInvestigationFailureCode) ?
    error.message as CodexInvestigationFailureCode : 'INTERNAL_ERROR';
}

type Store = Pick<SqliteInvestigationStore, 'get' | 'getNativeJournal' | 'preflightSourceRead' |
  'renewLease' | 'beginNativeThreadIntent' | 'observeNativeThread' | 'beginNativeTurnIntent' |
  'observeNativeTurn' | 'assertNativeTurnBinding' | 'acknowledgeNativeTurnInterrupt' |
 'observeNativeTurnTerminal' | 'markRecoveryRequired' | 'getWindowsLaunch' |
 'markWindowsLaunchRecoveryRequired'> &
 Partial<CodexInvestigatorReadStore & Pick<SqliteInvestigationStore,'prepareCodexReadSession'>>;

export interface CodexModelInvestigationInput {
  store: Store;
  claim: InvestigationClaim;
  contextRevision: ContextRevision;
  snapshot: RepositorySnapshot;
  connection: StdioConnection;
  runtime: { protocolTarget: typeof WINDOWS_CODEX_PROTOCOL_TARGET; cwd: string;
    profileId: string; model: string };
  signal?: AbortSignal;
  now?: () => Date;
  /** Internal scoped worker grant and application handler. Absent means no tools are registered. */
  read?: {binding:RunningReadBinding;dispatcher:Pick<DispatchService,'dispatch'>};
  /** Trusted original owner only. Drain actual output before disposing the parser. */
  owned?: {send:CodexSynchronousSend;remainingWallMs?():number;stopAndDrain():Promise<void>};
}

export interface CodexInvestigationProtocolObservation {
  kind: 'codex_investigation_protocol_observation';
  threadId: string | null;
  turnId: string | null;
  terminalStatus: 'completed' | 'interrupted' | 'failed' | null;
  candidate: {itemId:string;rawBytesSha256:string;result:ParsedInvestigationResult;
    evidenceStatus:'syntax_only'|'receipt_verified'} | null;
  processTermination: 'unconfirmed';
  failure?: CodexInvestigationFailure;
  cleanupFailure?: CodexInvestigationFailure;
}

/** Stop waiting for a native response at the original deadline. A late ID stays unknown. */
async function awaitBoundedRpc<T>(pending: Promise<T>, transport: CodexJsonlTransport,
  remaining: () => number, signal: AbortSignal): Promise<T> {
  // The native call may already have written before an abort fired synchronously.
  // Attach rejection handling before closing its pending transport request.
  void pending.catch(() => undefined);
  const timeoutMs = Math.ceil(remaining());
  if (timeoutMs <= 0 || signal.aborted) {
    transport.close({terminate:false});
    throw new Error('NOT_AVAILABLE');
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve,reject) => {
      const stop = () => {
        transport.close({terminate:false});
        reject(new Error('NOT_AVAILABLE'));
      };
      onAbort = stop;
      timer = setTimeout(stop,timeoutMs);
      signal.addEventListener('abort',stop,{once:true});
      if (signal.aborted) stop();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort',onAbort);
  }
}

/** One journaled native attempt. The candidate is syntax only: model-authored receipts are unverified. */
export async function runCodexModelInvestigation(input: CodexModelInvestigationInput):
  Promise<CodexInvestigationProtocolObservation> {
  const now = input.now ?? (() => new Date());
  const {store, claim, contextRevision, snapshot} = input;
  const runtime = Object.freeze({...input.runtime});
  const readSettings=input.read?{binding:structuredClone(input.read.binding),dispatcher:input.read.dispatcher}:undefined;
  const observation: CodexInvestigationProtocolObservation = {
    kind:'codex_investigation_protocol_observation', threadId:null, turnId:null,
    terminalStatus:null, candidate:null, processTermination:'unconfirmed',
  };
  if (runtime.protocolTarget !== WINDOWS_CODEX_PROTOCOL_TARGET) throw new Error('NOT_AVAILABLE');
  const record = store.get(claim.requestId);
  if (!record || record.workspaceId !== claim.workspaceId ||
    record.collaborationId !== contextRevision.collaborationId ||
    record.contextRevisionId !== contextRevision.id || record.snapshotRef !== snapshot.id ||
    record.workingCopyId !== snapshot.workingCopyId || claim.nativeRef !== null ||
    claim.phase !== 'start_intent' || !Number.isSafeInteger(record.budget.maxWallSeconds) ||
    record.budget.maxWallSeconds < 1 || record.budget.maxWallSeconds > 600 ||
    !Number.isSafeInteger(record.budget.maxTurns) ||
    record.budget.maxTurns < 1 || !Number.isSafeInteger(record.budget.maxToolCalls) ||
    record.budget.maxToolCalls < 1) throw new Error('NOT_AVAILABLE');
  const selectedPaths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  const startedMono = performance.now();
  const budgetMs = record.budget.maxWallSeconds * 1000;
  let workBudgetMs=budgetMs,deadline=now().getTime()+budgetMs;
  let lastOwnerRemaining=Number.POSITIVE_INFINITY;
  const ownerRemaining=()=>{
    if(!input.owned?.remainingWallMs)return undefined;
    const value=input.owned.remainingWallMs();
    if(!Number.isFinite(value)||value<0||value>budgetMs||value>lastOwnerRemaining)
      throw new Error('NOT_AVAILABLE');
    lastOwnerRemaining=value;return value;
  };
  const remaining = () => {
    const owner=ownerRemaining();
    return Math.max(0,Math.min(deadline-now().getTime(),
      workBudgetMs-(performance.now()-startedMono),owner===undefined?Infinity:owner-10_000));
  };
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  let transport: CodexJsonlTransport | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let heartbeatFailure = false;
  let intentId: string | null = null;
  let failed = false;
  let completionError: unknown;
  let stage: CodexInvestigationFailureStage = 'prepare';
  const recordCleanupFailure = (error: unknown) => {
    observation.cleanupFailure ??= {stage:'cleanup',code:normalizeCodexFailureCode(error)};
  };
  let recoveryReason: 'model_prompt_limit_exceeded' | undefined;
  let encounteredLaunch: WindowsAppServerLaunchRecord | null = null;
  const runtimeUnchanged = () => input.runtime.protocolTarget === runtime.protocolTarget &&
    input.runtime.cwd === runtime.cwd && input.runtime.profileId === runtime.profileId &&
    input.runtime.model === runtime.model;
  const workFresh = () => {
    if (!runtimeUnchanged() || remaining() <= 0 || signal.aborted || !runtimeUnchanged())
      throw new Error('NOT_AVAILABLE');
  };
  const current = () => {
    if (!runtimeUnchanged()) throw new Error('NOT_AVAILABLE');
    encounteredLaunch = store.getWindowsLaunch(claim);
    // This protocol coordinator accepts a supplied connection, not a connection
    // bound to an actual launcher-owned process handle. Never admit that path
    // for a durable Windows process launch, even with a recorded identity.
    if (encounteredLaunch) throw new Error('NOT_AVAILABLE');
    store.preflightSourceRead(claim, selectedPaths, now());
    workFresh();
  };
  const tick = () => {
    if (heartbeatFailure) return;
    try { current(); store.renewLease(claim, now()); }
    catch (error) {
      heartbeatFailure = true;
      observation.failure ??= {stage,code:normalizeCodexFailureCode(error)};
      controller.abort();
    }
  };
  const owned = () => {
    try { store.getNativeJournal(claim, record.collaborationId); return true; }
    catch (error) { if (error instanceof StoreConflict) return false; throw error; }
  };
  let cleanupRemaining: (()=>number)|undefined;
  const cleanupInterruptAllowed = (frame: CodexControlSend) => {
    if (!(signal.aborted || remaining() <= 0) || !observation.threadId ||
      !observation.turnId || !intentId || store.getWindowsLaunch(claim)) return false;
    if(frame.kind!=='rpc'||frame.method!=='turn/interrupt') return false;
    const params = frame.params as Record<string,unknown>;
    if (Object.keys(params).sort().join(',') !== 'threadId,turnId' ||
      params.threadId !== observation.threadId || params.turnId !== observation.turnId) return false;
    store.preflightSourceRead(claim, selectedPaths, now());
    if (!owned()) return false;
    store.assertNativeTurnBinding(claim,record.collaborationId,intentId,
      observation.threadId,observation.turnId);
    return cleanupRemaining!==undefined && cleanupRemaining()>0;
  };
  try {
    const initialOwner=ownerRemaining();
    if(initialOwner!==undefined){
      workBudgetMs=Math.min(budgetMs,Math.floor(initialOwner)-10_000);
      if(workBudgetMs<=0)throw new Error('NOT_AVAILABLE');
      deadline=now().getTime()+workBudgetMs;
    }
    current();
    let prompt: Buffer;
    try { prompt = buildInvestigationPrompt(record, contextRevision, snapshot, claim.attemptId); }
    catch (error) {
      if (error instanceof InvestigationPromptLimitExceeded) recoveryReason = 'model_prompt_limit_exceeded';
      throw error;
    }
    current();
    tick();
    if (heartbeatFailure) throw new Error('NOT_AVAILABLE');
    heartbeat = setInterval(tick, 5000);
    const guardedConnection: StdioConnection = {...input.connection,
      terminate: () => { if (owned()) input.connection.terminate(); }};
    transport = new CodexJsonlTransport(guardedConnection,
      {maxFrameBytes: 64 * 1024, maxTotalBytes: 1024 * 1024,
        maxNotifications: 4096, requestTimeoutMs: 30_000}, WINDOWS_CODEX_PROTOCOL_TARGET,
      frame=>{
        try {current();}
        catch(error){if(!cleanupInterruptAllowed(frame))throw error;}
        if(frame.kind==='repo-read-failure') {
          const journal=store.getNativeJournal(claim,record.collaborationId);
          const turn=journal?.turns.find(item=>item.turnId===frame.turnId&&item.state==='observed');
          if(!readSettings||journal?.thread.threadId!==frame.threadId||!turn)
            throw new Error('NOT_AVAILABLE');
          store.assertCodexReadAuthority!(claim,readSettings.binding,
            {intentId:turn.intentId,threadId:frame.threadId,turnId:frame.turnId},now());
        }
      },input.owned?.send);
    if(readSettings) {
      for(const name of ['prepareCodexReadSession','assertCodexReadAuthority','reserveCodexRead',
        'discloseCodexRead','getSucceededCodexReadReceipts'] as const)
        if(typeof store[name]!=='function') throw new Error('NOT_AVAILABLE');
      store.prepareCodexReadSession!(claim,readSettings.binding,new Date(deadline),now());
      transport.installRepoReadCapability(createCodexInvestigatorReadCapability({
        store:store as CodexInvestigatorReadStore,claim,binding:readSettings.binding,
        dispatcher:readSettings.dispatcher,signal,now,assertWorkFresh:workFresh}));
    }
    stage = 'initialize';
    await awaitBoundedRpc(transport.initialize(),transport,remaining,signal);
    current();
    stage = 'thread_start';
    observation.threadId = await awaitBoundedRpc(startJournaledRestrictedThread(store, claim,
      record.collaborationId, transport, runtime, now),transport,remaining,signal);
    current();
    intentId = randomUUID();
    stage = 'turn_start';
    observation.turnId = await awaitBoundedRpc(startJournaledRestrictedTurn(store, claim,
      record.collaborationId, intentId, transport,
      {threadId:observation.threadId, profileId:runtime.profileId,
        text:prompt.toString('utf8')}, now),transport,remaining,signal);
    current();
    stage = 'wait_turn';
    const waitMs=Math.min(600_000,Math.ceil(remaining()));
    if(waitMs<=0)throw new Error('PROTOCOL_TIMEOUT');
    const terminal = await transport.waitForBoundTurn({threadId:observation.threadId,
      turnId:observation.turnId, timeoutMs:waitMs, signal});
    if (terminal.threadId !== observation.threadId || terminal.turnId !== observation.turnId)
      throw new Error('PROTOCOL_REJECTED');
    current();
    store.assertNativeTurnBinding(claim,record.collaborationId,intentId,
      observation.threadId,observation.turnId);
    store.observeNativeTurnTerminal(claim,record.collaborationId,intentId,observation.turnId);
    observation.terminalStatus = terminal.status;
    if (terminal.status === 'completed' && !terminal.candidate)
      observation.failure = {stage:'result_parse',code:transport.missingBoundFinalCode(observation.threadId,observation.turnId)};
    if (terminal.status === 'completed' && terminal.candidate) {
      stage = 'result_parse';
      try {
        const result = parseInvestigationResult(terminal.candidate.text);
        if (result.requestId === record.id && result.attemptId === claim.attemptId &&
          result.snapshotRef === record.snapshotRef &&
          result.contextRevisionId === record.contextRevisionId &&
          new Set(result.evidence.map(item => item.toolReceipt)).size <= record.budget.maxToolCalls) {
          current();
          if(readSettings) {
            stage = 'evidence_validate';
            const nativeTurn={intentId,threadId:observation.threadId,turnId:observation.turnId};
            const receipts=store.getSucceededCodexReadReceipts!(claim,nativeTurn);
            validateInvestigationResultEvidence(result,receipts,snapshot,{
              requestId:record.id,attemptId:claim.attemptId,workspaceId:record.workspaceId,
              collaborationId:record.collaborationId,workingCopyId:record.workingCopyId,
              snapshotId:record.snapshotRef,contextRevisionId:record.contextRevisionId,
              launchEpoch:claim.workerEpoch,...nativeTurn,workerPrincipal:claim.workerId,
              workerAudience:readSettings.binding.workerAudience,workerRecipient:readSettings.binding.workerRecipient,
              workerGrantId:readSettings.binding.workerGrantId});
          }
          current();
          observation.candidate = {itemId:terminal.candidate.itemId,
            rawBytesSha256:createHash('sha256').update(Buffer.from(terminal.candidate.text,'utf8')).digest('hex'),
            result,evidenceStatus:readSettings?'receipt_verified':'syntax_only'};
        } else {
          observation.failure ??= {stage:'result_parse',code:'INVALID_INVESTIGATION_RESULT'};
        }
      } catch (error) {
        observation.failure ??= {stage,code:normalizeCodexFailureCode(error)};
      }
    }
  } catch (error) {
    failed = true;
    observation.failure ??= {stage,code:normalizeCodexFailureCode(error)};
    if (transport && observation.threadId && observation.turnId && intentId && owned()) {
      try {
        const owner=ownerRemaining();
        const cleanupMs=owner===undefined?5000:Math.min(5000,Math.floor(owner)-5000);
        if(cleanupMs>0){
          const cleanupWallDeadline=Date.now()+cleanupMs;
          const cleanupMonoStart=performance.now();
          cleanupRemaining=()=>Math.max(0,Math.floor(Math.min(
            cleanupWallDeadline-Date.now(),cleanupMs-(performance.now()-cleanupMonoStart),
            (ownerRemaining()??Infinity)-5000)));
          try{
            await awaitBoundedRpc(interruptJournaledRestrictedTurn(store,claim,record.collaborationId,
              intentId,transport,observation.threadId,observation.turnId),transport,
              cleanupRemaining,new AbortController().signal);
          }finally{cleanupRemaining=undefined;}
        }
      }
      catch (cleanupError) {
        recordCleanupFailure(cleanupError);
        /* Unknown interrupt remains in the native journal for reconciliation. */
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if(input.owned){
      try{await input.owned.stopAndDrain();transport?.assertDrainedProtocol();}
      catch(error){failed=true;recordCleanupFailure(error);}
    }
    if (encounteredLaunch) {
      try { store.markWindowsLaunchRecoveryRequired(encounteredLaunch, now()); }
      catch (error) { completionError = error; recordCleanupFailure(error); }
    }
    let currentOwner = false;
    try { currentOwner = owned(); }
    catch (error) { completionError = error; recordCleanupFailure(error); }
    if (currentOwner) {
      try {
        const journal = store.getNativeJournal(claim,record.collaborationId);
        observation.threadId ??= journal?.thread.threadId ?? null;
        observation.turnId ??= journal?.turns.find(item=>item.intentId===intentId)?.turnId ?? null;
      } catch (error) { completionError ??= error; recordCleanupFailure(error); }
      try { store.markRecoveryRequired(claim, now(), recoveryReason); }
      catch (error) { completionError = error; recordCleanupFailure(error); }
    }
    try { transport?.close({terminate:false}); }
    catch (error) { completionError ??= error; recordCleanupFailure(error); }
  }
  if (completionError) throw completionError;
  if (failed || heartbeatFailure) observation.candidate = null;
  return observation;
}

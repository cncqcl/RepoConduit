import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {SqliteStore} from '../adapters/storage/sqlite.js';
import type {CodexSessionClosure,InvestigationClaim,SqliteInvestigationStore} from '../adapters/storage/investigation-sqlite.js';
import type {InvestigationRecord} from '../core/investigation/request.js';
import type {ContextRevision} from '../core/collaboration/context.js';
import type {RepositorySnapshot} from '../adapters/repository/snapshots.js';
import type {DispatchService} from '../application/dispatch.js';
import {openOwnedWindowsAppServer,PreparedWindowsFixtureSession,getPreparedWindowsFailure,verifyPreparedWindowsNotStarted,
 type PreparedWindowsFailureDiagnostic} from '../adapters/codex/investigator/windows-prepared-session.js';
import {loadWindowsInvestigatorModelRuntime,loadAuthorizedWindowsRuntimeSource} from './windows-investigation-runtime-config.js';
import {runCodexModelInvestigation,WINDOWS_CODEX_PROTOCOL_TARGET,normalizeCodexFailureCode,
 type CodexInvestigationProtocolObservation} from './codex-model-investigation.js';

export interface PersonalCodexRuntimeSource {dataDirectory:string;workspaceId:string;profileRevision:string}
export interface PersonalCodexInvestigatorConfiguration {
 workspaceId:string;profileRevision:string;runtimeSource?:PersonalCodexRuntimeSource;
}
export interface PersonalCodexDiagnostic {
 requestId:string;
 failure?:{stage:string;code:string};
 cleanupFailure?:{stage:string;code:string};
 preparedFailure?:PreparedWindowsFailureDiagnostic;
}

/** A configured personal runtime, the fixed native Job owner and the product request are bound here. */
export function createPersonalCodexInvestigator(root:string,configuration:PersonalCodexInvestigatorConfiguration,
 onDiagnostic?:(diagnostic:PersonalCodexDiagnostic)=>void) {
 const keys=configuration&&Object.keys(configuration).sort().join(',');
 if(keys!=='profileRevision,workspaceId'&&keys!=='profileRevision,runtimeSource,workspaceId')throw new Error('NOT_AVAILABLE');
 if(configuration.runtimeSource&&(typeof configuration.runtimeSource!=='object'||Array.isArray(configuration.runtimeSource)||
  Object.keys(configuration.runtimeSource).sort().join(',')!=='dataDirectory,profileRevision,workspaceId'||
  Object.values(configuration.runtimeSource).some(value=>typeof value!=='string'||!value)))throw new Error('NOT_AVAILABLE');
 if(keys==='profileRevision,runtimeSource,workspaceId'&&!configuration.runtimeSource)throw new Error('NOT_AVAILABLE');
 const configured=Object.freeze({...configuration,...(configuration.runtimeSource?
  {runtimeSource:Object.freeze({...configuration.runtimeSource})}:{})});
 const proofs=new Map<string,{claim:InvestigationClaim;closure:CodexSessionClosure}>();
 const consumedNotStartedProofs=new WeakSet<object>();
 const load=(record:Pick<InvestigationRecord,'workspaceId'|'profileRef'|'budgetRef'>)=>{
  if(record.workspaceId!==configured.workspaceId||record.profileRef!==configured.profileRevision||
   record.budgetRef!==configured.profileRevision)throw new Error('NOT_AVAILABLE');
  const source=configured.runtimeSource;
  return source?loadAuthorizedWindowsRuntimeSource(root,configured,source):
   loadWindowsInvestigatorModelRuntime(root,configured.workspaceId,configured.profileRevision);
 };
 const verifyIsolation=(evidence:string,record:InvestigationRecord,revision:string)=>{
  try{return revision===configured.profileRevision&&evidence===`codex-native:${load(record).runtimeId}`;}
  catch{return false;}
 };
 const verifyClosure=(claim:InvestigationClaim,closure:CodexSessionClosure)=>{
  const proof=proofs.get(closure?.sessionId);
  return !!proof&&proof.closure===closure&&proof.claim.requestId===claim.requestId&&
   proof.claim.attemptId===claim.attemptId&&proof.claim.workerId===claim.workerId&&
   proof.claim.workerEpoch===claim.workerEpoch&&proof.claim.workspaceId===claim.workspaceId;
 };
 const run=async(input:{store:SqliteInvestigationStore;grants:SqliteStore;dispatcher:DispatchService;
  record:InvestigationRecord;contextRevision:ContextRevision;snapshot:RepositorySnapshot;signal:AbortSignal;
 }):Promise<InvestigationRecord|null>=>{
  const {store,grants,record}=input,runtime=load(record);
  const desktopTarget=PreparedWindowsFixtureSession.assertAppServerAvailable();
  const claim=store.claimRequest(record.id,{workerId:`codex-worker-${randomUUID()}`,
   isolationEvidence:`codex-native:${runtime.runtimeId}`,profileRevision:configured.profileRevision,
   permissionEpoch:grants.permissionEpoch(record.principal,record.audience,record.workspaceId),
   launchProtocol:'resource_reservation_v1',now:new Date()});
  if(!claim)return store.get(record.id);
  const abort=new AbortController(),signal=AbortSignal.any([input.signal,abort.signal]);
  const selected=[...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
  const nativeBinding=Object.freeze({runtimeRoot:runtime.root,configSha256:runtime.configSha256,
   sourceCwd:join(runtime.root,'check')});
  const grantId=`codex-read-${randomUUID()}`,sessionId=randomUUID();
  let closure:CodexSessionClosure|null=null;
  let original:Awaited<ReturnType<typeof openOwnedWindowsAppServer>>|undefined;
  let nativeStartAttempted=false;
  let closeWork:Promise<void>|undefined;
  let monitor:NodeJS.Timeout|undefined;
  let lastLeaseRenewedAt=0;
  let stage='prepare';
  const diagnostic:PersonalCodexDiagnostic={requestId:record.id};
  const stop=()=>closeWork??=Promise.resolve().then(async()=>{
   if(!original)throw new Error('NOT_AVAILABLE');
   const observed=await original.stop();
   if(observed.kind==='prepared_closed'&&nativeStartAttempted)throw new Error('NOT_AVAILABLE');
   // A closed prepared helper has no native process; it cannot prove process termination.
   closure=Object.freeze({kind:observed.kind==='prepared_closed'?'not_started':'job_closed',
    sessionId,requestId:claim.requestId,attemptId:claim.attemptId,workerEpoch:claim.workerEpoch});
   proofs.set(sessionId,{claim:structuredClone(claim),closure});
  });
  try{
   if(signal.aborted)throw new Error('NOT_AVAILABLE');
   grants.insertGrant({id:grantId,principal:claim.workerId,audience:'codex-investigator',recipient:'codex-local',
    workspaceId:record.workspaceId,collaborationId:record.collaborationId,permissions:['data.read'],dataPaths:selected,
    expiresAt:new Date(Date.now()+record.budget.maxWallSeconds*1000).toISOString(),revokedAt:null});
   store.beginCodexOwnedSession(claim,sessionId,new Date());
   store.preflightSourceRead(claim,selected,new Date());
   const current=()=>{try{
    if(signal.aborted)throw new Error('NOT_AVAILABLE');
    store.preflightSourceRead(claim,selected,new Date());
    const clock=performance.now();
    // Native preparation can outlive the initial 30-second claim lease. Keep the
    // same claim current until its original Job closes and the outcome settles.
    if(clock-lastLeaseRenewedAt>=5000){store.renewLease(claim,new Date());lastLeaseRenewedAt=clock;}
   }
    catch{abort.abort();}};
   monitor=setInterval(current,50);monitor.unref();current();
   stage='native_open';
   original=await openOwnedWindowsAppServer({...nativeBinding,desktopTarget,maxWallSeconds:record.budget.maxWallSeconds,signal});
   if(signal.aborted)throw new Error('NOT_AVAILABLE');
   store.preflightSourceRead(claim,selected,new Date());
   stage='native_start';
   if(configured.runtimeSource&&!isDeepStrictEqual(load(record),runtime))throw new Error('NOT_AVAILABLE');
   const ownerRemaining=original.remainingWallMs();
   if(!Number.isFinite(ownerRemaining)||ownerRemaining<=10_000||
    ownerRemaining>record.budget.maxWallSeconds*1000)throw new Error('NOT_AVAILABLE');
   nativeStartAttempted=true;await original.start();
   current();
   const inputStream=new PassThrough(),exited=new EventEmitter();
   stage='protocol';
   const observation:CodexInvestigationProtocolObservation=await runCodexModelInvestigation({store,claim,contextRevision:input.contextRevision,
    snapshot:input.snapshot,connection:{input:inputStream,output:original.output,errors:original.errors,
     exited,terminate(){void stop().catch(()=>{});}},
    runtime:{protocolTarget:WINDOWS_CODEX_PROTOCOL_TARGET,cwd:join(runtime.root,'check'),profileId:'rcac_static',model:runtime.modelRef},
    signal,read:{binding:{collaborationId:record.collaborationId,workingCopyId:record.workingCopyId,
     snapshotId:record.snapshotRef,paths:selected,workerGrantId:grantId,workerAudience:'codex-investigator',
     workerRecipient:'codex-local'},dispatcher:input.dispatcher},
    owned:{send:line=>original!.send(line),remainingWallMs:()=>original!.remainingWallMs(),
     stopAndDrain:stop}});
   if(observation.failure)diagnostic.failure=observation.failure;
   if(observation.cleanupFailure)diagnostic.cleanupFailure=observation.cleanupFailure;
   stage='settle';
   if(!closure)throw new Error('NOT_AVAILABLE');
   const journal=store.getNativeJournal(claim,record.collaborationId);
   const native=journal?.turns.find(t=>t.turnId===observation.turnId&&t.state==='terminal');
   const candidate=observation.terminalStatus==='completed'&&observation.candidate?.evidenceStatus==='receipt_verified'&&
    native&&observation.threadId&&observation.turnId?{turn:{intentId:native.intentId,
     threadId:observation.threadId,turnId:observation.turnId},result:observation.candidate.result,snapshot:input.snapshot}:null;
   return store.settleCodexSession(claim,closure,candidate,new Date());
  }catch(error){
   diagnostic.failure??={stage,code:normalizeCodexFailureCode(error)};
   if(stage==='native_open'&&!original){
    const fact=getPreparedWindowsFailure(error);
    if(fact){
     diagnostic.preparedFailure=fact.diagnostic;
     if(fact.notStarted&&!consumedNotStartedProofs.has(fact.notStarted)&&
      verifyPreparedWindowsNotStarted(fact.notStarted,nativeBinding)){
      consumedNotStartedProofs.add(fact.notStarted);
      closure=Object.freeze({kind:'not_started',sessionId,requestId:claim.requestId,
       attemptId:claim.attemptId,workerEpoch:claim.workerEpoch});
      proofs.set(sessionId,{claim:structuredClone(claim),closure});
     }
    }
   }
   try{if(original)await stop();}catch(error){
    diagnostic.cleanupFailure??={stage:'native_stop',code:normalizeCodexFailureCode(error)};}
   if(closure){try{return store.settleCodexSession(claim,closure,null,new Date());}catch{/* Preserve fencing failure. */}}
   try{store.markRecoveryRequired(claim,new Date());}catch{/* A newer epoch owns recovery. */}
   return store.get(record.id);
  }finally{
   if(monitor)clearInterval(monitor);
   grants.revokeGrant(grantId,new Date().toISOString());
   proofs.delete(sessionId);
   // Local diagnostics cannot change cleanup, state, or external result disclosure.
   try{if(diagnostic.failure||diagnostic.cleanupFailure)onDiagnostic?.(structuredClone(diagnostic));}catch{/* Best effort only. */}
  }
 };
 return {load,verifyIsolation,verifyClosure,run};
}

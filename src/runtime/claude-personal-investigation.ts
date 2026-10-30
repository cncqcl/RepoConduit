import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Readable} from 'node:stream';
import {homedir} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import type {SqliteStore} from '../adapters/storage/sqlite.js';
import type {InvestigationClaim,RunningReadBinding,SqliteInvestigationStore} from '../adapters/storage/investigation-sqlite.js';
import type {DispatchService} from '../application/dispatch.js';
import {startExternalHttp} from '../adapters/mcp/http.js';
import {buildClaudeWindowsLaunchSpec,buildClaudeWindowsUserFrame,parseClaudeWindowsStreamOutcome} from
 '../adapters/secondary-investigator/claude-windows-protocol.js';
import {openOwnedWindowsClaude,PreparedWindowsFixtureSession} from '../adapters/codex/investigator/windows-prepared-session.js';
import {loadExistingClaudeGlmEnvironment} from '../adapters/secondary-investigator/claude-windows-model-environment.js';
import type {InvestigationRecord,InvestigationResult} from '../core/investigation/request.js';
import type {ContextRevision} from '../core/collaboration/context.js';
import type {RepositorySnapshot} from '../adapters/repository/snapshots.js';
import {parseInvestigationResult} from '../core/investigation/result.js';
import {buildInvestigationPrompt,preflightInvestigationPrompt} from './investigation-prompt.js';
import {validateInvestigationResultEvidence} from './investigation-result-evidence.js';

export interface PersonalClaudeConfiguration {workspaceId:string;profileRevision:string}
export interface PersonalClaudeDiagnostic {requestId:string;stage:string;code:string;
 nativeSessionId?:string;outputSha256?:string;jobClosed?:boolean;
 outputBytes?:number;stderrBytes?:number;httpClose?:'pending'|'closed'|'failed'|'not_started';
 cleanupFailures?:string[]}
/** Original owner only. Test ports do not exist in CLI/MCP request envelopes. */
export interface PersonalClaudeOwner {
 readonly output:Readable;readonly errors:Readable;readonly root:{pid:number;creationFiletime:string}|null;
 remainingWallMs():number;
 start():Promise<{pid:number;creationFiletime:string}>;
 send(line:string):true;
 stop():Promise<{kind:'job_closed'|'prepared_closed'}>;
}
interface OwnerOptions {runtimeRoot:string;configSha256:string;sourceCwd:string;maxWallSeconds:number;maxTurns:number;signal:AbortSignal}
interface Ports {assertAvailable():void;open(options:OwnerOptions):Promise<PersonalClaudeOwner>;
 readModelEnvironment?:()=>Readonly<NodeJS.ProcessEnv>}
const nativePorts:Ports={assertAvailable:()=>PreparedWindowsFixtureSession.assertClaudeAvailable(),
 open:openOwnedWindowsClaude,readModelEnvironment:loadExistingClaudeGlmEnvironment};
const TOOL='mcp__repo-conduit__repo_read';
const unavailable=()=>new Error('CLAUDE_INVESTIGATION_UNAVAILABLE');
const sameClaim=(a:InvestigationClaim,b:InvestigationClaim)=>a.requestId===b.requestId&&a.attemptId===b.attemptId&&
 a.workerId===b.workerId&&a.workerEpoch===b.workerEpoch&&a.workspaceId===b.workspaceId;

/** A second native adapter using the existing request, grant, snapshot and durable read ledger. */
export function createPersonalClaudeInvestigator(root:string,configuration:PersonalClaudeConfiguration,
 onDiagnostic?:(value:PersonalClaudeDiagnostic)=>void,ports:Ports=nativePorts){
 if(!configuration||Object.keys(configuration).sort().join(',')!=='profileRevision,workspaceId'||
  !Object.values(configuration).every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)))throw unavailable();
 const selected=Object.freeze({...configuration});
 const starts=new Map<string,{claim:InvestigationClaim;nativeRef:string}>();
 const outcomes=new Map<string,{claim:InvestigationClaim;nativeRef:string;result:InvestigationResult}>();
 const matches=(record:Pick<InvestigationRecord,'workspaceId'|'profileRef'|'budgetRef'>)=>
  record.workspaceId===selected.workspaceId&&record.profileRef===selected.profileRevision&&record.budgetRef===selected.profileRevision;
 const verifyIsolation=(evidence:string,record:InvestigationRecord,revision:string)=>matches(record)&&
  revision===selected.profileRevision&&evidence===`claude-windows-2.1.287:${revision}`;
 const verifyNativeReceipt=(claim:InvestigationClaim,nativeRef:string,receipt:string)=>{
  const fact=starts.get(receipt);return !!fact&&sameClaim(fact.claim,claim)&&fact.nativeRef===nativeRef;
 };
 const verifyOutcomeReceipt=(claim:InvestigationClaim,result:InvestigationResult,nativeRef:string,receipt:string)=>{
  const fact=outcomes.get(receipt);return !!fact&&sameClaim(fact.claim,claim)&&fact.nativeRef===nativeRef&&isDeepStrictEqual(fact.result,result);
 };
 const run=async(input:{store:SqliteInvestigationStore;grants:SqliteStore;dispatcher:DispatchService;
  record:InvestigationRecord;contextRevision:ContextRevision;snapshot:RepositorySnapshot;signal:AbortSignal;
 }):Promise<InvestigationRecord|null>=>{
  const {store,grants,record}=input;
  if(!matches(record)||input.signal.aborted)throw unavailable();
  ports.assertAvailable();
  preflightInvestigationPrompt(record,input.contextRevision,input.snapshot);
  let claim=store.claimRequest(record.id,{workerId:`claude-worker-${randomUUID()}`,
   isolationEvidence:`claude-windows-2.1.287:${selected.profileRevision}`,profileRevision:selected.profileRevision,
   permissionEpoch:grants.permissionEpoch(record.principal,record.audience,record.workspaceId),now:new Date()});
  if(!claim)return store.get(record.id);
  const attemptRoot=join(root,'claude-runs',claim.attemptId);
  const paths=[...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
  const grantId=`claude-read-${randomUUID()}`,startReceipt=randomUUID(),outcomeReceipt=randomUUID();
  const binding:RunningReadBinding={collaborationId:record.collaborationId,workingCopyId:record.workingCopyId,
   snapshotId:record.snapshotRef,paths,workerGrantId:grantId,workerAudience:'claude-investigator',workerRecipient:'claude-local'};
  const controller=new AbortController();
  const signal=AbortSignal.any([input.signal,controller.signal]);
  let owner:PersonalClaudeOwner|undefined,http:Awaited<ReturnType<typeof startExternalHttp>>|undefined;
  let stopWork:Promise<boolean>|undefined;
  let interval:NodeJS.Timeout|undefined,deadline:NodeJS.Timeout|undefined;
  let readyResolve!:(value:boolean)=>void;
  const started=new Promise<boolean>(resolve=>{readyResolve=resolve;});
  let modelBytes=Buffer.alloc(0),stderr=Buffer.alloc(0),stage='prepare',nativeToolName:string|undefined;
  let diagnostic:PersonalClaudeDiagnostic={requestId:record.id,stage,code:'FAILED'};
  let httpVerifications=0,toolDispatches=0;
  const stop=()=>stopWork??=Promise.resolve().then(async()=>{
   if(!owner)return false;
   const closure=await owner.stop();return closure.kind==='job_closed';
  });
  const check=()=>{
   if(signal.aborted)throw unavailable();
   store.assertRunningReadAuthority(claim!,binding,new Date());
  };
  let observed:InvestigationRecord|null=null;
  let cleanupFailed:boolean;
  try{
   mkdirSync(attemptRoot,{recursive:true});mkdirSync(join(attemptRoot,'work'));
   grants.insertGrant({id:grantId,principal:claim.workerId,audience:binding.workerAudience,recipient:binding.workerRecipient,
    workspaceId:record.workspaceId,collaborationId:record.collaborationId,permissions:['data.read'],dataPaths:paths,
    expiresAt:new Date(Date.now()+record.budget.maxWallSeconds*1000).toISOString(),revokedAt:null});
   store.preflightSourceRead(claim,paths,new Date());
   const bearer=randomUUID()+randomUUID();
   http=await startExternalHttp({expectedAudience:binding.workerAudience,
    async verifyBearer(token){
     if(token!==bearer||!await started)return undefined;
     httpVerifications++;
     try{check();return {principal:claim!.workerId,audience:binding.workerAudience,recipient:binding.workerRecipient,
      expiresAt:Date.now()+1000,delegatedPermissions:['data.read'],visibleOperations:['repo.read'],
      allowedWorkspaceId:record.workspaceId,allowedCollaborationId:record.collaborationId};}catch{return undefined;}
    },
    dispatcher:{async dispatch(context,command){
     toolDispatches++;
     check();const payload=command.payload as Record<string,unknown>;
     if(command.operation!=='repo.read'||command.scope.workspaceId!==record.workspaceId||
      command.scope.collaborationId!==record.collaborationId||payload.workingCopyId!==record.workingCopyId||
      payload.snapshotId!==record.snapshotRef||typeof payload.path!=='string'||!paths.includes(payload.path))throw unavailable();
     const result=await input.dispatcher.dispatch({...context,
      assertFreshAuthority:async()=>{await context.assertFreshAuthority?.();check();},
      reserveRepositoryRead:read=>{check();return store.reserveRunningRead(claim!,binding,read,new Date());}},command);
     check();return result;
    }},
   });
   const executablePath=join(homedir(),'.local','bin','claude.exe');
   const spec=buildClaudeWindowsLaunchSpec({executablePath,root:attemptRoot,mcpEndpoint:http.url,bearerToken:bearer,
    inheritedEnv:process.env,maxTurns:record.budget.maxTurns,
    ...(ports.readModelEnvironment?{modelEnvironment:ports.readModelEnvironment()}:{})});
   writeFileSync(spec.mcpConfigPath,spec.mcpConfigBytes,{flag:'wx',mode:0o600});
   stage='native_open';
   owner=await ports.open({runtimeRoot:attemptRoot,configSha256:spec.mcpConfigSha256,sourceCwd:spec.cwd,
    maxWallSeconds:record.budget.maxWallSeconds,maxTurns:record.budget.maxTurns,signal});
   let finalResolve!:()=>void,finalReject!:(error:Error)=>void;
   const final=new Promise<void>((resolve,reject)=>{finalResolve=resolve;finalReject=reject;});
   let lineBuffer='';
   const fail=(error:Error)=>{controller.abort();finalReject(error);};
   owner.output.on('error',fail);
   owner.errors.on('error',fail);
   owner.errors.on('data',(part:Buffer)=>{
    stderr=Buffer.concat([stderr,part.subarray(0,Math.max(0,64*1024-stderr.length))]);
    if(stderr.length>=64*1024)fail(unavailable());
   });
   owner.output.on('data',(part:Buffer)=>{
    modelBytes=Buffer.concat([modelBytes,part]);
    if(modelBytes.length>1024*1024){fail(unavailable());return;}
    lineBuffer+=part.toString('utf8');
    let at:number;
    while((at=lineBuffer.indexOf('\n'))>=0){
     const line=lineBuffer.slice(0,at);lineBuffer=lineBuffer.slice(at+1);
     try{const event=JSON.parse(line) as {type:string;subtype?:string;tools?:unknown};
      if(event.type==='system'&&event.subtype==='init'){
       if(nativeToolName||!Array.isArray(event.tools)||event.tools.length!==1||
        ![TOOL,'mcp__repo-conduit__repo.read'].includes(event.tools[0] as string))throw unavailable();
       nativeToolName=event.tools[0] as string;
      }
      if(event.type==='result')finalResolve();
     }catch(error){fail(error instanceof Error?error:unavailable());}
    }
   });
   owner.output.once('end',finalResolve);
   signal.addEventListener('abort',()=>finalReject(unavailable()),{once:true});
   // Attach rejection handling before any native callback can emit an early error.
   void final.catch(()=>{});
   stage='native_start';
   const native=await owner.start();
   const nativeRef=`claude-windows:${native.pid}:${native.creationFiletime}:${claim.attemptId}`;
   starts.set(startReceipt,{claim:structuredClone(claim),nativeRef});
   claim=store.recordNativeStart(claim,nativeRef,startReceipt,new Date());
   readyResolve(true);check();
   const ownerRemaining=owner.remainingWallMs();
   if(!Number.isFinite(ownerRemaining)||ownerRemaining<=5_000||
    ownerRemaining>record.budget.maxWallSeconds*1000)throw unavailable();
   const tick=()=>{try{check();store.renewLease(claim!,new Date());}catch{controller.abort();}};
   interval=setInterval(tick,250);interval.unref();
   // The native owner's hard deadline starts before model startup. Stop the
   // model within that same budget and keep its existing five-second close window.
   deadline=setTimeout(()=>controller.abort(),Math.max(1,ownerRemaining-5_000));
   const prompt=buildInvestigationPrompt(store.get(record.id)!,input.contextRevision,input.snapshot,claim.attemptId).toString('utf8')+
    `\nCall repo.read with scope=${JSON.stringify({workspaceId:record.workspaceId,collaborationId:record.collaborationId})}`+
    ` and payload workingCopyId=${JSON.stringify(record.workingCopyId)}, snapshotId=${JSON.stringify(record.snapshotRef)}.\n`;
   if(Buffer.byteLength(prompt)>16*1024)throw unavailable();
   stage='model';
   owner.send(JSON.stringify(buildClaudeWindowsUserFrame(prompt))+'\n');
   await final;
   stage='native_close';
   if(!await stop())throw unavailable();
   diagnostic.jobClosed=true;
   const current=store.get(record.id)!;
   let result:InvestigationResult;
   if(current.cancelRequested){
    result={requestId:record.id,attemptId:claim.attemptId,resultState:'cancelled',snapshotRef:record.snapshotRef,
     contextRevisionId:record.contextRevisionId,findings:[],evidence:[],coverage:{searchedScope:[],excludedCategories:[],
      truncated:false,missingDependencies:[]},openQuestions:[],limitsAndWarnings:['Original Windows Job closed after cancellation.']};
   }else{
    check();stage='result';
    const candidate=parseClaudeWindowsStreamOutcome(modelBytes,{maxTurns:record.budget.maxTurns,
     maxToolCalls:record.budget.maxToolCalls,expectedToolName:nativeToolName??TOOL});
    if(!candidate)throw unavailable();
    diagnostic.nativeSessionId=candidate.sessionId;diagnostic.outputSha256=candidate.rawBytesSha256;
    const parsed=parseInvestigationResult(candidate.result);
    validateInvestigationResultEvidence(parsed,store.getSucceededReadReceipts(claim),input.snapshot,{
     requestId:record.id,attemptId:claim.attemptId,workspaceId:record.workspaceId,collaborationId:record.collaborationId,
     workingCopyId:record.workingCopyId,snapshotId:record.snapshotRef,contextRevisionId:record.contextRevisionId,
     launchEpoch:claim.workerEpoch,nativeRef:claim.nativeRef!,workerPrincipal:claim.workerId,
     workerAudience:binding.workerAudience,workerRecipient:binding.workerRecipient,workerGrantId:grantId});
    result={...parsed,evidence:parsed.evidence.map(item=>({path:item.path,symbol:item.symbol,
     lineRange:item.lineRange,contentHash:item.contentHash,excerpt:item.excerpt,toolReceipt:item.toolReceipt}))};
   }
   outcomes.set(outcomeReceipt,{claim:structuredClone(claim),nativeRef:claim.nativeRef!,result:structuredClone(result)});
   diagnostic={...diagnostic,stage:'complete',code:result.resultState};
   observed=store.completeAttempt(claim,result,outcomeReceipt,new Date());
  }catch{
   readyResolve(false);
   let closed=false;try{closed=await stop();}catch{/* Unknown owner retains its slot. */}
   diagnostic={...diagnostic,stage,code:closed?'CLOSED_WITHOUT_RESULT':'OWNER_UNKNOWN',jobClosed:closed};
   if(closed&&claim.nativeRef){
    const cancelled=store.get(record.id)?.cancelRequested===true;
    const result:InvestigationResult={requestId:record.id,attemptId:claim.attemptId,
     resultState:cancelled?'cancelled':'failed',snapshotRef:record.snapshotRef,contextRevisionId:record.contextRevisionId,
     findings:[],evidence:[],coverage:{searchedScope:[],excludedCategories:[],truncated:false,missingDependencies:[]},
     openQuestions:[],limitsAndWarnings:['Original Windows Job closed without a verified model result.']};
    outcomes.set(outcomeReceipt,{claim:structuredClone(claim),nativeRef:claim.nativeRef,result});
    try{observed=store.completeAttempt(claim,result,outcomeReceipt,new Date());}catch{/* Preserve fencing failure. */}
   }
   if(!observed){
    try{store.markRecoveryRequired(claim,new Date());}catch{/* A newer epoch owns recovery. */}
    observed=store.get(record.id);
   }
  }finally{
   readyResolve(false);if(interval)clearInterval(interval);if(deadline)clearTimeout(deadline);
   const cleanupFailures=new Set<string>();
   const capture=(label:string,action:()=>void)=>{try{action();}catch{cleanupFailures.add(label);}};
   capture('grant_revoke',()=>{grants.revokeGrant(grantId,new Date().toISOString());});
   diagnostic.httpClose=http?'pending':'not_started';
   const preserve=()=>{
    diagnostic={...diagnostic,outputBytes:modelBytes.length,stderrBytes:stderr.length,
     outputSha256:createHash('sha256').update(modelBytes).digest('hex')};
    // Save even zero bytes before awaiting a possibly unresolved transport drain.
    // The local bearer itself must never be retained as an evidence artifact.
    capture('native_output_write',()=>writeFileSync(join(attemptRoot,'native.jsonl'),modelBytes,{mode:0o600}));
    capture('native_stderr_write',()=>writeFileSync(join(attemptRoot,'native.stderr'),stderr,{mode:0o600}));
    capture('mcp_scrub',()=>writeFileSync(join(attemptRoot,'mcp.json'),'{"mcpServers":{}}\n',{mode:0o600}));
    diagnostic.cleanupFailures=[...cleanupFailures];
    capture('diagnostic_write',()=>writeFileSync(join(attemptRoot,'native-diagnostic.json'),
     JSON.stringify({...diagnostic,httpVerifications,toolDispatches},null,2)+'\n',{mode:0o600}));
    try{onDiagnostic?.(structuredClone(diagnostic));}catch{/* Observers cannot change settlement. */}
   };
   preserve();
   try{await http?.close();diagnostic.httpClose=http?'closed':'not_started';}
   catch{diagnostic.httpClose='failed';cleanupFailures.add('http_close');}
   finally{starts.delete(startReceipt);outcomes.delete(outcomeReceipt);preserve();}
   cleanupFailed=cleanupFailures.size>0;
  }
  if(cleanupFailed)throw new Error('CLAUDE_INVESTIGATION_CLEANUP_UNCONFIRMED');
  return observed;
 };
 return {matches,verifyIsolation,verifyNativeReceipt,verifyOutcomeReceipt,run};
}

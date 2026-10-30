import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {assertPrivateInstallationDirectory} from '../../../runtime/local-security.js';
import {SqliteInvestigationStore,type InvestigationClaim} from '../../storage/investigation-sqlite.js';
import {windowsJobHelperPath} from './windows-job-host.js';
import {resolveWindowsDesktopTarget} from './windows-desktop-target.js';
import {verifyWindowsFrozenSourceView} from './windows-source-view.js';
import {parsePreparedWindowsEvent,type PreparedWindowsBinding,type PreparedWindowsEvent} from
  './windows-prepared-session.js';
import {WINDOWS_APP_SERVER_PROTOCOL_TARGET,WINDOWS_APP_SERVER_RECIPE,
  sameWindowsAppServerLaunchOrigin,validActiveWindowsAppServerLaunchBinding,
  type ActiveWindowsAppServerLaunchBinding,type CurrentWindowsAppServerLaunchRecord,
  type WindowsAppServerLaunchRecord,type WindowsAppServerNotStartedObservation,
  type WindowsAppServerNotStartedRecord} from './windows-launch-record.js';

type BindingInput=Omit<ActiveWindowsAppServerLaunchBinding,'hostScopeId'|'executionInstanceId'>;
interface PrepareInput {runtimeRoot:string;sourcePath:string;claim:InvestigationClaim;
  binding:BindingInput;maxWallSeconds:number;signal?:AbortSignal}
type Closed={readonly kind:'prepared_closed';readonly childPresent:false;readonly helperExitCode:0;
  readonly helper:{readonly pid:number;readonly creationFiletime:string};
  readonly members:{readonly complete:true;readonly assigned:0;readonly listed:0;readonly pids:readonly []}};
interface Proof {launch:CurrentWindowsAppServerLaunchRecord;
  observation:WindowsAppServerNotStartedObservation}
type FailureOrigin='stop-write-callback'|'stop-sync-throw'|'stdin-error'|'stdout-error'|
  'stderr-error'|'child-error'|'timer'|'abort'|'parser'|'output-limit'|'utf8'|'partial-limit';
interface FirstFailure {readonly origin:FailureOrigin;readonly code:string|null;
  readonly syscall:string|null;readonly elapsedMs:number}
const unknown=()=>new Error('WINDOWS_ORIGINAL_OWNER_UNKNOWN');
const unavailable=()=>new Error('WINDOWS_ORIGINAL_OWNER_UNAVAILABLE');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(a,b);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
const strict=(path:string)=>{
  if(path!==resolve(path))throw unavailable();
  for(let p=path;;p=dirname(p)){
    const stat=lstatSync(p);
    if(!stat.isDirectory()||stat.isSymbolicLink()||
      realpathSync.native(p).toLowerCase()!==p.toLowerCase())throw unavailable();
    if(dirname(p)===p)break;
  }
  assertPrivateInstallationDirectory(path);
};
const strictFile=(path:string,max:number)=>{
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max||
    realpathSync.native(path).toLowerCase()!==path.toLowerCase())throw unavailable();
  assertPrivateInstallationDirectory(dirname(path),path);
  return readFileSync(path);
};

function freezeInput(input:PrepareInput):PrepareInput{
  if(process.platform!=='win32'||!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(k=>!['runtimeRoot','sourcePath','claim','binding','maxWallSeconds','signal'].includes(k))||
    !Number.isSafeInteger(input.maxWallSeconds)||input.maxWallSeconds<1||input.maxWallSeconds>600||
    (input.signal!==undefined&&!(input.signal instanceof AbortSignal))||input.signal?.aborted||
    typeof input.runtimeRoot!=='string'||typeof input.sourcePath!=='string'||
    !input.claim||typeof input.claim!=='object'||Array.isArray(input.claim)||
    !input.binding||typeof input.binding!=='object'||Array.isArray(input.binding)||
    Object.keys(input.binding).sort().join(',')!==
      'collaborationId,configSha256,permissionEpoch,profileRevision,protocolTarget,recipe,runtimeId,sourceDigest')
    throw unavailable();
  const claim=structuredClone(input.claim),binding=structuredClone(input.binding);
  if(!claim.windowsSource||claim.windowsSource.preparedAt===null||claim.phase!=='start_intent'||
    claim.launchProtocol!=='resource_reservation_v1'||claim.nativeRef!==null||
    claim.windowsSource.descriptor.attemptId!==claim.attemptId||
    claim.windowsSource.descriptor.workspaceId!==claim.workspaceId||
    claim.windowsSource.descriptor.workerEpoch!==claim.workerEpoch||
    claim.windowsSource.descriptor.sourceDigest!==binding.sourceDigest||
    binding.protocolTarget!==WINDOWS_APP_SERVER_PROTOCOL_TARGET||
    binding.recipe!==WINDOWS_APP_SERVER_RECIPE||!uuid.test(binding.runtimeId)||
    !hex.test(binding.configSha256)||!hex.test(binding.sourceDigest)||
    typeof binding.profileRevision!=='string'||!binding.profileRevision||
    typeof binding.collaborationId!=='string'||!binding.collaborationId||
    !Number.isSafeInteger(binding.permissionEpoch)||binding.permissionEpoch<0||
    input.sourcePath!==join(claim.windowsSource.privateRoot,`${claim.attemptId}.view`))
    throw unavailable();
  return Object.freeze({...input,claim:Object.freeze(claim),binding:Object.freeze(binding)});
}

function verifyPaths(input:PrepareInput):string{
  strict(input.runtimeRoot);
  const home=join(input.runtimeRoot,'home'),codex=join(home,'.codex');
  for(const p of [home,codex,join(input.runtimeRoot,'AppDataLocal'),
    join(input.runtimeRoot,'AppDataRoaming'),join(input.runtimeRoot,'temp'),
    join(input.runtimeRoot,'check')])strict(p);
  const savedRaw=strictFile(join(input.runtimeRoot,'runtime.json'),8192);
  let saved:unknown;
  try{saved=JSON.parse(savedRaw.toString('utf8'));}catch{throw unavailable();}
  if(!saved||typeof saved!=='object'||Array.isArray(saved))throw unavailable();
  const rec=saved as Record<string,unknown>;
  if(Object.keys(rec).sort().join(',')!==
      'configSha256,kind,modelRef,profileRevision,protocolTarget,recipe,runtimeId,workspaceId'||
    rec.kind!=='windows_investigation_runtime_v1'||rec.runtimeId!==input.binding.runtimeId||
    rec.workspaceId!==input.claim.workspaceId||rec.profileRevision!==input.binding.profileRevision||
    rec.protocolTarget!==input.binding.protocolTarget||rec.recipe!==WINDOWS_APP_SERVER_RECIPE||
    rec.configSha256!==input.binding.configSha256)throw unavailable();
  const config=strictFile(join(codex,'config.toml'),16384);
  if(sha(config)!==input.binding.configSha256)throw unavailable();
  const view=verifyWindowsFrozenSourceView(input.claim.windowsSource!.descriptor,
    input.claim.windowsSource!.privateRoot);
  if(view.viewPath!==input.sourcePath||view.sourceDigest!==input.binding.sourceDigest||
    view.binding.requestId!==input.claim.requestId||
    view.binding.attemptId!==input.claim.attemptId||
    view.binding.workspaceId!==input.claim.workspaceId||
    view.binding.workerEpoch!==input.claim.workerEpoch||
    view.binding.collaborationId!==input.binding.collaborationId)
    throw unavailable();
  return sha(config);
}

/** The registry is created without native side effects so application construction remains portable. */
export function createWindowsOriginalOwnerFactory(){
  const proofs=new Map<string,Proof>();
  const verifyNotStarted=(launch:WindowsAppServerLaunchRecord,
    observation:WindowsAppServerNotStartedObservation):boolean=>{
    const proof=proofs.get(launch?.launchId);
    return !!proof&&sameWindowsAppServerLaunchOrigin(proof.launch,launch)&&
      same(proof.observation,observation);
  };
  const prepare=async(raw:PrepareInput)=>{
    const input=freezeInput(raw);
    let hash:string,binary:string,desktopTarget:string;
    try{hash=verifyPaths(input);binary=windowsJobHelperPath();desktopTarget=resolveWindowsDesktopTarget();}catch{throw unavailable();}
    const budget=input.maxWallSeconds*1000,mono=performance.now(),deadline=Date.now()+budget;
    const remaining=()=>Math.min(deadline-Date.now(),budget-(performance.now()-mono));
    if(remaining()<=0||input.signal?.aborted)throw unavailable();
    const binding=Object.freeze({recipe:WINDOWS_APP_SERVER_RECIPE,
      hostScopeId:randomUUID(),executionInstanceId:randomUUID()}) satisfies PreparedWindowsBinding;
    const fullBinding:ActiveWindowsAppServerLaunchBinding=Object.freeze({...input.binding,...binding});
    if(!validActiveWindowsAppServerLaunchBinding(fullBinding))throw unavailable();
    const child:ChildProcessWithoutNullStreams=spawn(binary,[WINDOWS_APP_SERVER_RECIPE,
      binding.hostScopeId,binding.executionInstanceId,input.runtimeRoot,hash,input.sourcePath,
      String(Math.max(1,Math.ceil(remaining()/1000))),desktopTarget],
      {shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
       env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
    let partial=Buffer.alloc(0),total=0,prepared:Extract<PreparedWindowsEvent,{kind:'prepared'}>|null=null;
    let closed:Extract<PreparedWindowsEvent,{kind:'prepared_closed'}>|null=null;
    let stdoutEnded=false,stderrEnded=false,stderrEmpty=true,exitCode:number|null=null;
    let failed=false,stopSent=false,settled=false,stopWriteSucceeded=false;
    let firstFailure:FirstFailure|null=null;
    let prepareResolve!:()=>void,prepareReject!:(error:Error)=>void;
    let closeResolve!:(value:Closed)=>void,closeReject!:(error:Error)=>void;
    const preparedPromise=new Promise<void>((r,j)=>{prepareResolve=r;prepareReject=j;});
    const closedPromise=new Promise<Closed>((r,j)=>{closeResolve=r;closeReject=j;});
    void preparedPromise.catch(()=>{});void closedPromise.catch(()=>{});
    let cleanupTimer:NodeJS.Timeout|undefined;
    const first=(origin:FailureOrigin,error?:unknown)=>{
      if(firstFailure)return;
      const item=error&&typeof error==='object'?error as {code?:unknown;syscall?:unknown}:{};
      const codes=['EPIPE','ECONNRESET','ERR_STREAM_DESTROYED',
        'ERR_STREAM_WRITE_AFTER_END','ERR_STREAM_PREMATURE_CLOSE','ETIMEDOUT'];
      const calls=['write','shutdown','read'];
      firstFailure=Object.freeze({origin,
        code:item.code===undefined?null:typeof item.code==='string'&&codes.includes(item.code)?
          item.code:'other',
        syscall:item.syscall===undefined?null:typeof item.syscall==='string'&&
          calls.includes(item.syscall)?item.syscall:'other',
        elapsedMs:Math.max(0,Math.round(performance.now()-mono))});
    };
    const stop=()=>{
      if(stopSent)return;stopSent=true;
      try{child.stdin.write('stop\n',(error?:Error|null)=>{
        if(error){fail('stop-write-callback',error);return;}stopWriteSucceeded=true;
      });}catch(error){fail('stop-sync-throw',error);}
    };
    const fail=(origin:FailureOrigin,error?:unknown)=>{
      if(settled)return;first(origin,error);failed=true;prepareReject(unknown());stop();
      if(!cleanupTimer)cleanupTimer=setTimeout(()=>{
        if(settled)return;settled=true;clearTimeout(timer);
        input.signal?.removeEventListener('abort',onAbort);
        try{child.kill();}catch{/* Not a termination proof. */}
        for(const stream of [child.stdin,child.stdout,child.stderr])
          try{stream.destroy();}catch{/* Unknown. */}
        try{child.unref();}catch{/* Unknown. */}
        closeReject(new Error('WINDOWS_ORIGINAL_OWNER_UNKNOWN',
          {cause:Object.freeze({firstFailure})}));
      },5000);
    };
    const onAbort=()=>fail('abort');
    const timer=setTimeout(()=>fail('timer'),Math.max(1,Math.ceil(remaining())));
    child.on('error',error=>fail('child-error',error));
    child.stdin.on('error',error=>fail('stdin-error',error));
    child.stdout.on('error',error=>fail('stdout-error',error));
    child.stderr.on('error',error=>fail('stderr-error',error));
    child.stderr.on('data',()=>{stderrEmpty=false;fail('stderr-error');});
    child.stdout.on('end',()=>{stdoutEnded=true;});
    child.stderr.on('end',()=>{stderrEnded=true;});
    child.stdout.on('data',(bytes:Buffer)=>{
      if(failed||settled)return;
      total+=bytes.length;if(total>32768){fail('output-limit');return;}
      partial=Buffer.concat([partial,bytes]);
      for(let end;(end=partial.indexOf(10))>=0;){
        let line:string;
        try{line=new TextDecoder('utf-8',{fatal:true}).decode(partial.subarray(0,end));}
        catch{fail('utf8');return;}
        partial=partial.subarray(end+1);
        const event=parsePreparedWindowsEvent(line,binding,prepared?2:1);
        if(!event||(prepared===null&&
          (event.kind!=='prepared'||event.writer.helperPid!==child.pid))||
          (prepared!==null&&(!stopSent||closed!==null||event.kind!=='prepared_closed'))){
          fail('parser');return;
        }
        if(event.kind==='prepared'){prepared=event;prepareResolve();}
        else if(event.kind==='prepared_closed')closed=event;
      }
      if(partial.length>16384)fail('partial-limit');
    });
    child.on('close',(code:number|null)=>{
      clearTimeout(timer);if(cleanupTimer)clearTimeout(cleanupTimer);
      input.signal?.removeEventListener('abort',onAbort);
      if(settled)return;settled=true;exitCode=code;prepareReject(unknown());
      const closure=Object.freeze({failed,prepared:prepared!==null,closed:closed!==null,
        stopSent,stopWriteSucceeded,stdoutEnded,stderrEnded,stderrEmpty,
        exitCode,partialEmpty:partial.length===0,withinBudget:remaining()>0,
        aborted:input.signal?.aborted===true,pidPresent:child.pid!==undefined,firstFailure});
      if(prepared&&closed&&child.pid!==undefined&&
        !closure.failed&&closure.prepared&&closure.closed&&closure.stopSent&&
        closure.stopWriteSucceeded&&closure.stdoutEnded&&closure.stderrEnded&&
        closure.stderrEmpty&&closure.exitCode===0&&closure.partialEmpty&&
        closure.withinBudget&&!closure.aborted&&closure.pidPresent){
        closeResolve(Object.freeze({kind:'prepared_closed',childPresent:false,helperExitCode:0,
          helper:Object.freeze({pid:child.pid,creationFiletime:prepared.writer.helperCreationFiletime}),
          members:closed.members}));
      }else closeReject(new Error('WINDOWS_ORIGINAL_OWNER_UNKNOWN',{cause:closure}));
    });
    input.signal?.addEventListener('abort',onAbort,{once:true});
    if(input.signal?.aborted)onAbort();
    try{await preparedPromise;if(failed||remaining()<=0)throw unknown();}
    catch{stop();await closedPromise.catch(()=>{});throw unknown();}

    let store:SqliteInvestigationStore|null=null;
    let launch:CurrentWindowsAppServerLaunchRecord|null=null;
    let reserveUsed=false,recorded:WindowsAppServerNotStartedRecord|null=null;
    let stopRecordPending:Promise<WindowsAppServerNotStartedRecord>|null=null;
    const close=async():Promise<Closed>=>{stop();return closedPromise;};
    const reserveLaunch=(next:SqliteInvestigationStore,now:Date):CurrentWindowsAppServerLaunchRecord=>{
      if(reserveUsed||stopSent||failed||settled||remaining()<=0||
        !(next instanceof SqliteInvestigationStore)||
        !(now instanceof Date)||!Number.isFinite(now.getTime()))throw unavailable();
      reserveUsed=true;
      try{
        if(!same(next.listUnsettled().find(item=>item.requestId===input.claim.requestId),input.claim)||
          verifyPaths(input)!==hash)throw unavailable();
        const saved=next.beginWindowsAppServerLaunch(input.claim,fullBinding,now);
        if(!same(saved.binding,fullBinding)||saved.requestId!==input.claim.requestId||
          saved.attemptId!==input.claim.attemptId||saved.workspaceId!==input.claim.workspaceId||
          saved.collaborationId!==input.binding.collaborationId||
          saved.launchWorkerId!==input.claim.workerId||saved.launchEpoch!==input.claim.workerEpoch||
          saved.state!=='intent'||saved.identity!==null||saved.observedAt!==null||
          verifyPaths(input)!==hash)throw unavailable();
        store=next;launch=structuredClone(saved);return structuredClone(saved);
      }catch(error){void close().catch(()=>{});throw error;}
    };
    const stopAndRecord=async(next:SqliteInvestigationStore,now:Date):
      Promise<WindowsAppServerNotStartedRecord>=>{
      if(next!==store||!launch||!(now instanceof Date)||!Number.isFinite(now.getTime()))
        throw unavailable();
      if(recorded)return structuredClone(recorded);
      if(stopRecordPending)return stopRecordPending;
      stopRecordPending=(async()=>{
        const completed=await close();
        if(proofs.size>=64&&!proofs.has(launch!.launchId))throw unavailable();
        const observation:WindowsAppServerNotStartedObservation=Object.freeze({
          kind:'windows_app_server_not_started_v1',protocol:'windows_job_stdio_v1',
          helperVersion:'3',recipe:WINDOWS_APP_SERVER_RECIPE,launchId:launch!.launchId,
          hostScopeId:fullBinding.hostScopeId,executionInstanceId:fullBinding.executionInstanceId,
          helper:completed.helper,
          prepared:Object.freeze({kind:'prepared',sequence:1,childPresent:false}),
          preparedClosed:Object.freeze({kind:'prepared_closed',sequence:2,childPresent:false,
            members:completed.members}),helperExitCode:0});
        proofs.set(launch!.launchId,{launch:launch!,observation});
        const result=next.recordWindowsLaunchNotStarted(launch!,observation,now);
        proofs.delete(launch!.launchId);recorded=result;return result;
      })();
      try{return await stopRecordPending;}
      finally{stopRecordPending=null;}
    };
    return Object.freeze({reserveLaunch,close,stopAndRecord});
  };
  return Object.freeze({prepare,verifyNotStarted});
}

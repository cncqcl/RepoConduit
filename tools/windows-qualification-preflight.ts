/** Source-only D236 P2 fixed synthetic preflight/login/model/setup modes. No production admission. */
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {assertPrivateInstallationDirectory} from '../src/runtime/local-security.js';
import {windowsJobHelperPath} from '../src/adapters/codex/investigator/windows-job-host.js';
import {WINDOWS_APP_SERVER_PROTOCOL_TARGET} from '../src/adapters/codex/investigator/windows-launch-record.js';
import {parsePreparedWindowsEvent,type PreparedWindowsBinding,type PreparedWindowsEvent} from '../src/adapters/codex/investigator/windows-prepared-session.js';
import {parseWindowsConfigInitialize,parseWindowsConfigRead} from '../src/adapters/codex/protocol/windows-config-check.js';
import {ManagedChatgptLoginProtocol,type ManagedLoginOwner} from './windows-qualification-login-protocol.js';
import {FixedQualificationTurn,FixedQualificationThreadStartOnly,qualificationModelReadinessAllowsLogin,type QualificationToolCall} from './windows-qualification-turn-protocol.js';
import {createSyntheticQualificationRead} from './windows-qualification-synthetic-read.js';
import {FixedSandboxSetup} from './windows-qualification-setup-protocol.js';

/** Stop state is checked immediately before the only raw URL handoff. */
export function acceptManagedLoginStartWhenRunning(login:ManagedChatgptLoginProtocol,reply:unknown,
 owner:ManagedLoginOwner,presentAuthUrl:(url:string)=>void,
 gate:{readonly stopSent:boolean;readonly firstFailure:string|null;readonly interrupted:boolean}):void{
 if(gate.stopSent||gate.firstFailure||gate.interrupted)throw new Error('QUALIFICATION_LOGIN_STOPPED');
 login.acceptStart(reply,owner,presentAuthUrl);
}

interface Expected {home:string;configPath:string;modelRef:string;checkCwd:string}
interface EndState {firstFailure:string|null;drainError?:string|null;exitCode:number|null;stdoutEnded:boolean;stderrEnded:boolean;
 helperStderr:string;partialBytes:number;rpcPartialBytes:number;startWriteSucceeded:boolean;
 stopWriteSucceeded:boolean;stopSent:boolean;phase:number;readiness:string|null;
 root:unknown;terminal:{kind:string;root?:unknown}|undefined;kinds:string[]}
export function ownedNativeClosureObserved(s:EndState):boolean{
 return !s.drainError&&s.exitCode===0&&s.stdoutEnded&&s.stderrEnded&&s.helperStderr===''&&
  s.partialBytes===0&&s.rpcPartialBytes===0&&s.startWriteSucceeded&&s.stopWriteSucceeded&&s.stopSent&&
  s.terminal?.kind==='job_closed'&&s.root!==null&&isDeepStrictEqual(s.root,s.terminal.root)&&
  ['prepared','started','stdout_eof','stderr_eof','root_exit','job_closed'].every(kind=>s.kinds.filter(k=>k===kind).length===1);
}
export function qualificationClosureComplete(s:EndState):boolean{
 return !s.firstFailure&&ownedNativeClosureObserved(s)&&s.phase===3&&
  ['ready','notConfigured','updateRequired'].includes(String(s.readiness));
}
interface LoginEndState extends EndState {loginStatus:string;ephemeralConfigVerified:boolean;authJsonAbsent:boolean}
export function managedLoginClosureComplete(s:LoginEndState):boolean{
 return !s.firstFailure&&ownedNativeClosureObserved(s)&&s.phase===4&&
  s.loginStatus==='success'&&s.ephemeralConfigVerified&&s.authJsonAbsent;
}
/** Returns unknown at a finite deadline even if a child cannot be killed or drained. */
export function waitQualificationHelperClose(close:Promise<number|null>,detachUnknown:()=>void,timeoutMs=28_000):Promise<number|null>{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>28_000)throw new Error('INVALID_ARGUMENT');
 return new Promise(resolveEnd=>{
  const timer=setTimeout(()=>{try{detachUnknown();}finally{resolveEnd(null);}},timeoutMs);
  void close.then(code=>{clearTimeout(timer);resolveEnd(code);},()=>{clearTimeout(timer);try{detachUnknown();}finally{resolveEnd(null);}});
 });
}
function waitManagedLoginHelperClose(close:Promise<number|null>,detachUnknown:()=>void,timeoutMs=370_000):Promise<number|null>{
 return new Promise(resolveEnd=>{
  const timer=setTimeout(()=>{try{detachUnknown();}finally{resolveEnd(null);}},timeoutMs);
  void close.then(code=>{clearTimeout(timer);resolveEnd(code);},()=>{clearTimeout(timer);try{detachUnknown();}finally{resolveEnd(null);}});
 });
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Historical candidate files are retained, never rebound to a newer fixed executable. */
export function qualificationMarkerMatches(marker:unknown):boolean{
 return record(marker)&&marker.kind==='windows_qualification_candidate_v1'&&marker.modelRef==='gpt-6-sol'&&
  marker.protocolTarget===WINDOWS_APP_SERVER_PROTOCOL_TARGET;
}
export function qualificationRequests(expected:Expected){
 return [
  {id:1,method:'initialize',params:{clientInfo:{name:'repo-conduit-synthetic-preflight',version:'0.1.0'},capabilities:{experimentalApi:true,requestAttestation:false}}},
  {method:'initialized'},
  {id:2,method:'config/read',params:{cwd:expected.checkCwd,includeLayers:false}},
  {id:3,method:'windowsSandbox/readiness',params:null},
 ];
}
export function parseQualificationReply(id:number,result:unknown,expected:Expected):boolean|string{
 if(id===1)return parseWindowsConfigInitialize(result,expected.home);
 // This schema projection verifies only model/approval/web and their origins.
 // It cannot admit login/model execution or verify effective tools/permissions/auth storage.
 if(id===2)return parseWindowsConfigRead(result,{codexHome:expected.home,configPath:expected.configPath,modelRef:expected.modelRef});
 if(id===3&&record(result)&&Object.keys(result).join(',')==='status'&&
  ['ready','notConfigured','updateRequired'].includes(String(result.status)))return String(result.status);
 return false;
}

type TrialMode='preflight'|'managed_login'|'managed_model'|'sandbox_setup'|'thread_start_only';
/** Executed by the native writer path; the count is advanced before each one-way write. */
export function advanceThreadOnlyOutbound(value:unknown,count:number,stopped:boolean):number{
 const expected=[['initialize',1],['initialized',undefined],['config/read',2],
  ['windowsSandbox/readiness',3],['thread/start',6]] as const;
 const next=expected[count];
 if(stopped||!next||!record(value)||value.method!==next[0]||
  (next[1]===undefined?'id'in value:value.id!==next[1]))
  throw new Error('QUALIFICATION_THREAD_START_PROTOCOL');
 return count+1;
}
export function threadStartCaptureOrStop(capture:()=>void,stopWith:(code:string)=>void):boolean{
 try{capture();return true;}catch{stopWith('thread_error_capture_failed');return false;}
}
export function writeThreadStartPrivateError(fixtureRoot:string,binding:PreparedWindowsBinding,
 message:string,verify:(directory:string,file?:string)=>void=assertPrivateInstallationDirectory):void{
 if(typeof message!=='string'||Buffer.byteLength(message,'utf8')>4096)
  throw new Error('QUALIFICATION_THREAD_START_PROTOCOL');
 const file=join(fixtureRoot,'thread-start-error.private.json');
 verify(fixtureRoot);
 writeFileSync(file,JSON.stringify({kind:'private_thread_start_error_v1',binding,message})+'\n',
  {flag:'wx',mode:0o600});
 verify(fixtureRoot,file);
}
type ThreadFailureReason='wrong_owner'|'state'|'unexpected_method'|'replyid'|
 'error_envelope'|'lifecycle'|'result_projection'|'warning'|'utf8'|'json'|'frame_limit'|
 'unexpected_after_stop'|'other';
interface ThreadFailureFrame{
 readonly frame:Buffer;readonly complete:boolean;readonly observedBytes?:number;
 readonly nativeSequence:number;readonly rpcOrdinal:number;readonly outboundCount:number;
 readonly preFailureState:string;readonly stopSent:boolean;readonly reason:ThreadFailureReason;
}
/** One payload at a time; a coalesced JSONL buffer has no aggregate payload limit. */
export function nextThreadStartFrame(buffer:Buffer):
 {kind:'partial';remaining:Buffer;frame?:never;observedBytes?:never;complete?:never}|
 {kind:'frame';remaining:Buffer;frame:Buffer;observedBytes:number;complete:true}|
 {kind:'overflow';remaining:Buffer;frame:Buffer;observedBytes:number;complete:false}{
 const newline=buffer.indexOf(10),observedBytes=newline<0?buffer.length:newline;
 if(observedBytes>128*1024)return {kind:'overflow',remaining:Buffer.alloc(0),
  frame:Buffer.from(buffer.subarray(0,128*1024)),observedBytes,complete:false};
 if(newline<0)return {kind:'partial',remaining:buffer};
 return {kind:'frame',remaining:buffer.subarray(newline+1),
  frame:Buffer.from(buffer.subarray(0,newline)),observedBytes,complete:true};
}
/** Only the current thread RPC may be associated with a subsequent failure. */
export class ThreadStartFrameAssociation<T>{
 private current:T|null=null;
 beginData(){this.current=null;}
 beginNativeLine(){this.current=null;}
 set(value:T){this.current=value;}
 get():T|null{return this.current;}
}
/** Cleanup consumes bounded frames, without decoding or accepting late business replies. */
export function drainStoppedThreadRpc(buffer:Buffer):{remaining:Buffer;frames:number}{
 let remaining=buffer,frames=0;
 for(;;){const next=nextThreadStartFrame(remaining);
  if(next.kind==='partial')return {remaining,frames};
  if(next.kind==='overflow')throw new Error('rpc_limit');
  remaining=next.remaining;frames++;
 }
}
export function nextThreadStartBusinessFrame(buffer:Buffer,businessFailed:boolean){
 if(businessFailed)return {kind:'drained' as const,...drainStoppedThreadRpc(buffer)};
 return nextThreadStartFrame(buffer);
}
/** Only the zero-model diagnostic uses this native cleanup stream, not production admission. */
export class ThreadOnlyCleanupStream{
 private partial:Buffer=Buffer.alloc(0);
 private total=0;private sequence=1;private failedBusiness=false;
 private drainError:string|null=null;
 private prepared=false;private root:Extract<PreparedWindowsEvent,{kind:'started'}>['root']|null=null;
 private stdoutEof=false;private stderrEof=false;private rootExited=false;private closed=false;
 constructor(private readonly binding:PreparedWindowsBinding,private readonly helperPid:number,
  private readonly stopped:()=>boolean,private readonly beginLine:()=>void,
  private readonly onEvent:(event:PreparedWindowsEvent)=>void,
  private readonly onFailure:(error:unknown)=>void,private readonly drainRpc:()=>void){}
 summary(){return {partialBytes:this.partial.length,drainError:this.drainError};}
 private poison(code:string){this.drainError??=code;this.onFailure(new Error(code));}
 private validLifecycle(event:PreparedWindowsEvent):boolean{
  if(this.closed)return false;
  if(event.kind==='prepared'){
   if(this.prepared||event.sequence!==1||event.writer.helperPid!==this.helperPid)return false;
   this.prepared=true;return true;
  }
  if(event.kind==='started'){
   if(!this.prepared||this.root)return false;this.root=event.root;return true;
  }
  if(event.kind==='prepared_closed'){
   if(!this.prepared||this.root||event.sequence!==2||!this.stopped())return false;
   this.closed=true;return true;
  }
  if(!this.root)return false;
  if(event.kind==='stdout')return !this.stdoutEof;
  if(event.kind==='stderr')return !this.stderrEof;
  if(event.kind==='stdout_eof'){if(this.stdoutEof)return false;this.stdoutEof=true;return true;}
  if(event.kind==='stderr_eof'){if(this.stderrEof)return false;this.stderrEof=true;return true;}
  if(event.kind==='root_exit'){if(this.rootExited)return false;this.rootExited=true;return true;}
  if(event.kind!=='job_closed'||!this.stopped()||!this.stdoutEof||!this.stderrEof||!this.rootExited||
   !isDeepStrictEqual(event.root,this.root))return false;
  this.closed=true;return true;
 }
 consume(chunk:Buffer):void{
  if(this.drainError!==null)return; // No resynchronization after a malformed native stream.
  this.total+=chunk.length;
  if(this.total>256*1024||this.partial.length+chunk.length>32768){this.beginLine();this.poison('output_limit');return;}
  this.partial=Buffer.concat([this.partial,chunk]);
  for(let end;(end=this.partial.indexOf(10))>=0;){
   this.beginLine();
   let line:string;
   try{line=new TextDecoder('utf-8',{fatal:true}).decode(this.partial.subarray(0,end));}
   catch{this.poison('native_utf8');return;}
   this.partial=this.partial.subarray(end+1);
   const event=parsePreparedWindowsEvent(line,this.binding,this.sequence++);
   if(!event){this.poison('native_envelope');return;}
   if(!this.validLifecycle(event)){this.poison('native_lifecycle');return;}
   try{this.onEvent(event);}
   catch(error){
    if(event.kind!=='stdout'){this.poison('native_handler');return;}
    if(!this.failedBusiness){this.failedBusiness=true;this.onFailure(error);}
    try{this.drainRpc();}catch{this.poison('rpc_limit');return;}
   }
  }
  if(this.partial.length>16384){this.beginLine();this.poison('output_limit');}
 }
}
/** Decodes only an already bounded original JSONL frame; never embeds source bytes in errors. */
export function decodeThreadOnlyRpcFrame(frame:Buffer):unknown{
 let decoded:string;
 try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(frame);}
 catch{throw new Error('thread_frame_utf8');}
 try{return JSON.parse(decoded) as unknown;}
 catch{throw new Error('thread_frame_json');}
}
/** After stop, only already scoped observational notifications may reach the protocol. */
export function dispatchStoppedThreadStartFrame(reply:unknown,
 trial:FixedQualificationThreadStartOnly,owner:ManagedLoginOwner):void{
 if(!record(reply)||!['pending','accepted'].includes(trial.summary().status)||
  !['thread/started','thread/status/changed','warning'].includes(String(reply.method)))
  throw new Error('thread_only_rpc_after_stop');
 trial.accept(reply,owner);
}
/** Private single-frame evidence. Hashes describe inspected/captured bytes, never an unseen suffix. */
export function writeThreadStartFailureFrame(fixtureRoot:string,binding:PreparedWindowsBinding,
 observation:ThreadFailureFrame,
 verify:(directory:string,file?:string)=>void=assertPrivateInstallationDirectory){
 const {frame}=observation;
 const observedBytes=observation.observedBytes??frame.length;
 if(!Buffer.isBuffer(frame)||frame.length>128*1024||!Number.isSafeInteger(observedBytes)||
  observedBytes<frame.length||!Number.isSafeInteger(observation.nativeSequence)||
  !Number.isSafeInteger(observation.rpcOrdinal)||!Number.isSafeInteger(observation.outboundCount))
  throw new Error('QUALIFICATION_THREAD_FRAME_CAPTURE');
 const retained=frame,file=join(fixtureRoot,'thread-start-failure-frame.private.json');
 const projection={captured:true,complete:observation.complete,
  truncated:retained.length<observedBytes,observedBytes,
  inspectedBytes:frame.length,inspectedSha256:createHash('sha256').update(frame).digest('hex'),
  capturedBytes:retained.length,capturedSha256:createHash('sha256').update(retained).digest('hex')};
 verify(fixtureRoot);
 writeFileSync(file,JSON.stringify({kind:'private_thread_start_failure_frame_v1',binding,
  nativeSequence:observation.nativeSequence,rpcOrdinal:observation.rpcOrdinal,
  outboundCount:observation.outboundCount,preFailureState:observation.preFailureState,
  stopSent:observation.stopSent,reason:observation.reason,...projection,
  frameBase64:retained.toString('base64')})+'\n',{flag:'wx',mode:0o600});
 verify(fixtureRoot,file);
 return projection;
}
export function captureThreadStartFailureFrame(fixtureRoot:string,binding:PreparedWindowsBinding,
 observation:ThreadFailureFrame,
 verify:(directory:string,file?:string)=>void=assertPrivateInstallationDirectory){
 try{return {projection:writeThreadStartFailureFrame(fixtureRoot,binding,observation,verify),
  captureFailed:false} as const;}
 catch{return {projection:null,captureFailed:true} as const;}
}
const TRIAL_MARKERS=['managed-login-attempt.json','managed-model-attempt.json',
 'managed-login.json','managed-model.json','sandbox-setup-attempt.json','sandbox-setup.json',
 'thread-start-only-attempt.json','thread-start-only.json'] as const;
export function qualificationTrialPreviouslyUsed(present:ReadonlySet<string>):boolean{
 return TRIAL_MARKERS.some(name=>present.has(name));
}
async function runQualification(fixtureRoot:string,mode:TrialMode,presentAuthUrl?: (url:string)=>void){
 const setupEnd=mode==='sandbox_setup'?performance.now()+300_000:null;
 const setupRemaining=()=>setupEnd===null?300_000:Math.max(0,setupEnd-performance.now());
 const managed=mode==='managed_login'||mode==='managed_model';
 // @ts-expect-error source-only JS preparation is deliberately outside product exports.
 const {renderWindowsQualificationConfig,qualificationFixtureParent}=await import('./windows-qualification-config.mjs');
 if(process.platform!=='win32')throw new Error('QUALIFICATION_FIXTURE_SCOPE');
 qualificationFixtureParent(fixtureRoot);
 const runtimeRoot=join(fixtureRoot,'runtime'),sourcePath=join(fixtureRoot,'source');
 const configPath=join(runtimeRoot,'home','.codex','config.toml');
 for(const path of [fixtureRoot,runtimeRoot,sourcePath,join(runtimeRoot,'home'),join(runtimeRoot,'home','.codex'),
  ...['AppDataLocal','AppDataRoaming','temp','check'].map(p=>join(runtimeRoot,p))]){
  if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()||realpathSync.native(path).toLowerCase()!==path.toLowerCase())throw new Error('QUALIFICATION_FIXTURE_PATH');
  assertPrivateInstallationDirectory(path);
 }
 assertPrivateInstallationDirectory(fixtureRoot,join(fixtureRoot,'qualification.json'));
 assertPrivateInstallationDirectory(join(runtimeRoot,'home','.codex'),configPath);
 const marker=JSON.parse(readFileSync(join(fixtureRoot,'qualification.json'),'utf8')) as Record<string,unknown>;
 if(!qualificationMarkerMatches(marker))throw new Error('QUALIFICATION_MARKER');
 // Render from fixed local implementation; never accept config/auth/argv from the marker.
 const config=readFileSync(configPath),expectedBytes=Buffer.from(renderWindowsQualificationConfig('gpt-6-sol'));
 if(!config.equals(expectedBytes)||existsSync(join(runtimeRoot,'home','.codex','auth.json'))||
  readFileSync(join(sourcePath,'README.md'),'utf8')!=='# RepoConduit synthetic qualification source\nNo repository data.\n')throw new Error('QUALIFICATION_CONFIG');
 const configSha256=createHash('sha256').update(config).digest('hex');
 if(marker.configSha256!==configSha256)throw new Error('QUALIFICATION_CONFIG');
 if(mode!=='preflight'){
  if(managed&&typeof presentAuthUrl!=='function')throw new Error('QUALIFICATION_LOGIN_HANDOFF');
  if(qualificationTrialPreviouslyUsed(new Set(TRIAL_MARKERS.filter(name=>
   existsSync(join(fixtureRoot,name))))))throw new Error('QUALIFICATION_TRIAL_USED');
  // Historical filename; this one-way journal now reserves any active trial.
  // All three modes compete for the same wx marker before a child exists. It is not an authorization carrier.
  writeFileSync(join(fixtureRoot,'managed-login-attempt.json'),
   JSON.stringify({kind:mode==='sandbox_setup'?'sandbox_setup_attempt_v1':
     mode==='managed_model'?'managed_model_attempt_v1':
      mode==='thread_start_only'?'thread_start_only_attempt_v1':'managed_login_attempt_v1',
   configSha256,protocolTarget:WINDOWS_APP_SERVER_PROTOCOL_TARGET})+'\n',{flag:'wx',mode:0o600});
  if(mode==='managed_model')writeFileSync(join(fixtureRoot,'managed-model-attempt.json'),
   JSON.stringify({kind:'managed_model_attempt_v1',configSha256,
    protocolTarget:WINDOWS_APP_SERVER_PROTOCOL_TARGET})+'\n',{flag:'wx',mode:0o600});
  if(mode==='thread_start_only')writeFileSync(join(fixtureRoot,'thread-start-only-attempt.json'),
   JSON.stringify({kind:'thread_start_only_attempt_v1',configSha256,
    protocolTarget:WINDOWS_APP_SERVER_PROTOCOL_TARGET})+'\n',{flag:'wx',mode:0o600});
 }
 if(mode==='sandbox_setup'){
  if(existsSync(join(fixtureRoot,'preflight.json')))
   throw new Error('QUALIFICATION_TRIAL_USED');
  writeFileSync(join(fixtureRoot,'sandbox-setup-attempt.json'),JSON.stringify({kind:'sandbox_setup_attempt_v1',
   configSha256,protocolTarget:WINDOWS_APP_SERVER_PROTOCOL_TARGET})+'\n',{flag:'wx',mode:0o600});
  if(setupRemaining()<20_000)throw new Error('QUALIFICATION_SETUP_DEADLINE');
 }
 const expected={home:join(runtimeRoot,'home','.codex'),configPath,modelRef:'gpt-6-sol',checkCwd:join(runtimeRoot,'check')};
 const requests=qualificationRequests(expected),binary=windowsJobHelperPath();
 const binding:PreparedWindowsBinding={recipe:'windows_app_server_readonly_v1',hostScopeId:randomUUID(),executionInstanceId:randomUUID()};
 const native:PreparedWindowsEvent[]=[],replies:unknown[]=[],startedAt=new Date().toISOString();
 const child=spawn(binary,[binding.recipe,binding.hostScopeId,binding.executionInstanceId,runtimeRoot,configSha256,sourcePath,
  mode==='sandbox_setup'?String(Math.floor((setupRemaining()-10_000)/1000)):
   mode==='managed_model'?'540':mode==='managed_login'?'360':
    mode==='thread_start_only'?'60':'45'],
  {shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
 let partial:Buffer=Buffer.alloc(0),rpcPartial:Buffer=Buffer.alloc(0),sequence=1,total=0,phase=0;
 let writer:Extract<PreparedWindowsEvent,{kind:'prepared'}>['writer']|null=null;
 let root:Extract<PreparedWindowsEvent,{kind:'started'}>['root']|null=null;
 let readiness:string|null=null,firstFailure:string|null=null,stopSent=false,finished=false;
 let startWriteSucceeded=false,stopWriteSucceeded=false;
 let helperStderr='',nativeStderr='',stdoutEnded=false,stderrEnded=false;
 let cleanupTimer:NodeJS.Timeout|undefined;
 let interrupted=false;
 let login:ManagedChatgptLoginProtocol|null=null;
 let loginOwner:ManagedLoginOwner|null=null;
 let loginDeadline:NodeJS.Timeout|undefined;
 let loginStartAttempted=false;
 let cancelReason:'login_deadline'|'login_interrupted'='login_deadline';
 let turn:FixedQualificationTurn|null=null;
 let synthetic:Awaited<ReturnType<typeof createSyntheticQualificationRead>>|null=null;
 let modelDeadline:NodeJS.Timeout|undefined;
 let modelPhase=0;
 let modelInterruptIntent=false;
 let setup:FixedSandboxSetup|null=null;
 let setupOwner:ManagedLoginOwner|null=null;
 let setupNotNeeded=false;
 let setupErrorCaptured=false;
 let threadOnly:FixedQualificationThreadStartOnly|null=null;
 let threadOwner:ManagedLoginOwner|null=null;
 let threadErrorCaptured=false;
 let threadOutboundCount=0;
 let rpcOrdinal=0;
 const threadFrames=new ThreadStartFrameAssociation<ThreadFailureFrame>();
 let threadFrameProjection:ReturnType<typeof writeThreadStartFailureFrame>|null=null;
 let threadFrameCaptureFailed=false;
 let threadFailureReason:ThreadFailureReason|null=null;
 const setupHeartbeat=mode==='sandbox_setup'?setInterval(()=>console.log(
  `Sandbox setup observation: ${Math.ceil(setupRemaining()/1000)}s remaining; account/model not requested.`),30_000):undefined;
 const close=new Promise<number|null>(done=>child.once('close',done));
 const stop=()=>{
  if(stopSent||finished)return;stopSent=true;
  try{child.stdin.write('stop\n',error=>{if(error)firstFailure??='stop_write';else stopWriteSucceeded=true;});}catch{firstFailure??='stop_write';}
  cleanupTimer=setTimeout(()=>{firstFailure??='helper_close_timeout';try{child.kill();}catch{/* Not closure. */}},6000);
 };
 const fail=(code:string)=>{firstFailure??=code;stop();};
 const timer=mode==='sandbox_setup'?setTimeout(()=>fail('setup_observation_deadline'),Math.max(1,setupRemaining()-10_000)):
  mode==='preflight'?setTimeout(()=>fail('preflight_deadline'),20_000):
   mode==='thread_start_only'?setTimeout(()=>{
    if(threadOnly?.summary().status==='pending')threadOnly.markUnknown();
    fail('thread_start_deadline');
   },50_000):
  mode==='managed_model'?setTimeout(()=>fail('model_overall_deadline'),530_000):undefined;
 const cancelLogin=(reason:'login_deadline'|'login_interrupted')=>{
   if(!managed||stopSent||finished)return;
  cancelReason=reason;
  if(loginDeadline){clearTimeout(loginDeadline);loginDeadline=undefined;}
  if(login&&loginOwner&&login.summary().status==='pending'){
   try{send(login.cancelRequest());}catch{firstFailure??='login_cancel_send';stop();return;}
   loginDeadline=setTimeout(()=>{firstFailure??=reason;stop();},5_000);
  }else{firstFailure??=reason;stop();}
 };
 const cancelAtDeadline=()=>cancelLogin('login_deadline');
 const interruptModel=(reason:string)=>{
  if(stopSent||finished)return;
  modelInterruptIntent=true;
  if(modelDeadline){clearTimeout(modelDeadline);modelDeadline=undefined;}
  if(turn&&turn.summary().status==='turn_bound'){
   try{send(turn.interruptRequest());modelDeadline=setTimeout(()=>{firstFailure??=reason;stop();},5_000);}
   catch{firstFailure??='model_interrupt_send';stop();}
  }else{firstFailure??=reason;stop();}
 };
 const onSigInt=()=>{if(interrupted)return;interrupted=true;
  if(mode==='sandbox_setup')fail('setup_observation_interrupted');
   else if(mode==='thread_start_only')fail('thread_start_interrupted');
  else if(mode==='managed_model'&&turn)interruptModel('model_interrupted');
  else cancelLogin('login_interrupted');};
 if(mode!=='preflight')process.on('SIGINT',onSigInt);
 const send=(value:object)=>{
  if(!writer||!root||stopSent||firstFailure)throw new Error('QUALIFICATION_NOT_RUNNING');
  if(mode==='thread_start_only')threadOutboundCount=advanceThreadOnlyOutbound(value,threadOutboundCount,stopSent);
  if(setupEnd!==null&&setupRemaining()<1000)throw new Error('QUALIFICATION_SETUP_DEADLINE');
  const w=writer;
  const sent=spawnSync(binary,['__write_owned_frame',binding.hostScopeId,binding.executionInstanceId,
   String(w.helperPid),w.helperCreationFiletime,w.pipeName,w.handle,w.deadlineUtcTicks,w.deadlineUptimeMs],
   {shell:false,windowsHide:true,input:JSON.stringify(value)+'\n',encoding:'utf8',timeout:500,maxBuffer:2048,
    env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
  if(sent.error||sent.status!==0||sent.stdout!=='{"accepted":true}'||sent.stderr!=='')throw new Error('QUALIFICATION_SEND_UNKNOWN');
 };
 const runTool=async(call:QualificationToolCall)=>{
   if(!turn||!synthetic||stopSent||finished||firstFailure)return;
  try{
   const result=await synthetic.read(call.arguments);
    if(!stopSent&&!finished&&!firstFailure&&turn.summary().status==='turn_bound')
     send(turn.completeToolCall(call,result));
  }catch{
    try{if(!stopSent&&!finished&&!firstFailure&&turn&&turn.summary().status==='turn_bound')
     send(turn.failToolCall(call));}
   catch{fail('model_tool_response');}
  }
 };
 child.stdin.on('error',()=>fail('stdin_error'));child.stdout.on('error',()=>fail('stdout_error'));
 child.stderr.on('error',()=>fail('stderr_error'));child.on('error',()=>fail('helper_error'));
 child.stdout.on('end',()=>{stdoutEnded=true;});child.stderr.on('end',()=>{stderrEnded=true;});
 child.stderr.on('data',(chunk:Buffer)=>{helperStderr+=chunk.toString('utf8');if(helperStderr.length>4096)helperStderr=helperStderr.slice(0,4096);fail('helper_stderr');});
 const recordProtocolFailure=(error:unknown)=>{
   const codes=['output_limit','native_envelope','native_utf8','native_lifecycle','native_handler','helper_identity','root_identity','stderr_limit','rpc_limit',
    'rpc_shape','rpc_order_or_error','rpc_contract','rpc_duplicate','QUALIFICATION_SEND_UNKNOWN','QUALIFICATION_NOT_RUNNING',
    'QUALIFICATION_LOGIN_PROTOCOL','QUALIFICATION_LOGIN_STOPPED','QUALIFICATION_TURN_PROTOCOL',
    'login_order','model_owner','model_stopped','model_rpc_order','QUALIFICATION_SETUP_PROTOCOL',
    'QUALIFICATION_SETUP_DEADLINE','QUALIFICATION_THREAD_START_PROTOCOL','thread_only_rpc_after_stop',
    'thread_frame_utf8','thread_frame_json'];
   const code=error instanceof Error&&codes.includes(error.message)?error.message:'parse_failure';
   if(mode==='thread_start_only'&&threadOnly&&firstFailure===null){
    // Lock the original failure and stop this owner before attempting private evidence I/O.
    fail(code);
    const threadFrame=threadFrames.get();
    threadFailureReason=threadFrame?.reason&&threadFrame.reason!=='other'?threadFrame.reason:
     threadOnly.summary().failureReason??
     (code==='thread_only_rpc_after_stop'?'unexpected_after_stop':
      code==='rpc_limit'?'frame_limit':'other');
    if(threadFrame){
     const capture=captureThreadStartFailureFrame(fixtureRoot,binding,
      {...threadFrame,stopSent,reason:threadFailureReason});
     threadFrameProjection=capture.projection;threadFrameCaptureFailed=capture.captureFailed;
    }
   }else fail(code);
 };
 const acceptNativeEvent=(event:PreparedWindowsEvent)=>{
  native.push(event);
    if(event.kind==='prepared'){
     if(writer||event.writer.helperPid!==child.pid)throw new Error('helper_identity');writer=event.writer;
     if(stopSent)return;child.stdin.write('start\n',error=>{if(error)fail('start_write');else startWriteSucceeded=true;});
    }else if(event.kind==='started'){
     if(root||!writer)throw new Error('root_identity');root=event.root;if(mode==='thread_start_only'&&stopSent)return;send(requests[0]!);
    }else if(event.kind==='stderr'){
     nativeStderr+=Buffer.from(event.dataBase64,'base64').toString('utf8');if(nativeStderr.length>65536)throw new Error('stderr_limit');
    }else if(event.kind==='stdout'){
     rpcPartial=Buffer.concat([rpcPartial,Buffer.from(event.dataBase64,'base64')]);
     if(mode!=='thread_start_only'&&rpcPartial.length>128*1024)throw new Error('rpc_limit');
     for(;;){
       let frame:Buffer;
       if(mode==='thread_start_only'){
        const next=nextThreadStartBusinessFrame(rpcPartial,firstFailure!==null||
         threadOnly?.summary().status==='rejected'||threadOnly?.summary().status==='unknown');
        if(next.kind==='drained'){rpcPartial=next.remaining;return;}
        if(next.kind==='partial')break;
        if(next.kind==='overflow'){
         if(threadOnly)threadFrames.set({frame:next.frame,complete:false,
          observedBytes:next.observedBytes,nativeSequence:event.sequence,rpcOrdinal:rpcOrdinal+1,
          outboundCount:threadOutboundCount,preFailureState:threadOnly.summary().status,
          stopSent,reason:'frame_limit'});
         throw new Error('rpc_limit');
        }
        frame=next.frame;rpcPartial=next.remaining;
       }else{
        const nl=rpcPartial.indexOf(10);if(nl<0)break;
        frame=Buffer.from(rpcPartial.subarray(0,nl));rpcPartial=rpcPartial.subarray(nl+1);
       }
       rpcOrdinal++;
       if(mode==='thread_start_only'&&threadOnly)threadFrames.set({frame,complete:true,
        nativeSequence:event.sequence,rpcOrdinal,outboundCount:threadOutboundCount,
        preFailureState:threadOnly.summary().status,stopSent,reason:'other'});
       let reply:unknown;
       try{reply=mode==='thread_start_only'?decodeThreadOnlyRpcFrame(frame):
        JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame)) as unknown;}
       catch(error){const reason=error instanceof Error&&error.message==='thread_frame_utf8'?'utf8':'json';
        const current=threadFrames.get();if(current)threadFrames.set({...current,reason});
        throw error;}
      if(!record(reply))throw new Error('rpc_shape');
       if(mode==='thread_start_only'&&stopSent){
        if(!threadOnly||!threadOwner)throw new Error('helper_identity');
        dispatchStoppedThreadStartFrame(reply,threadOnly,threadOwner);continue;
       }
       if(mode==='thread_start_only'&&threadOnly){
        if(!threadOwner)throw new Error('helper_identity');
        const outcome=threadOnly.accept(reply,threadOwner);
        if(outcome==='accepted'||outcome==='rejected'){
         replies.push({id:6,status:outcome,projectionMatched:outcome==='accepted'});
         phase=4;
         if(outcome==='rejected'){
          const error=threadOnly.privateErrorMessage();
          if(error===null)throw new Error('QUALIFICATION_THREAD_START_PROTOCOL');
          if(!threadStartCaptureOrStop(()=>{
           writeThreadStartPrivateError(fixtureRoot,binding,error);threadErrorCaptured=true;
          },fail))continue;
         }
         stop();
        }
        continue;
       }
      if(reply.method==='remoteControl/status/changed'&&!('id'in reply)&&record(reply.params))continue;
      if(mode==='sandbox_setup'&&(reply.method==='windowsSandbox/setupCompleted'||reply.id===4||reply.id===5)){
       if(!setup||!setupOwner||stopSent||firstFailure)throw new Error('QUALIFICATION_SETUP_PROTOCOL');
       if(reply.method==='windowsSandbox/setupCompleted'){
        const privateError=setup.acceptCompletion(reply,setupOwner);
        if(privateError!==null){
         // Candidate privacy was checked before launch. No raw error enters the public result/collector.
         try{writeFileSync(join(fixtureRoot,'sandbox-setup-error.private.json'),JSON.stringify({
          kind:'private_sandbox_setup_error_v1',binding,owner:setupOwner,error:privateError})+'\n',
          {flag:'wx',mode:0o600});setupErrorCaptured=true;}
         catch{fail('setup_error_capture_failed');continue;}
        }
       }
       else if(reply.id===4)setup.acceptStart(reply,setupOwner);
       else{setup.acceptReadiness(reply,setupOwner);readiness=setup.summary().readiness;phase=5;stop();continue;}
       if(setup.failed()){fail('setup_not_success');continue;}
       if(setup.canReadiness()){send(setup.readinessRequest());phase=4;}
       continue;
      }
      if(managed&&reply.method==='account/login/completed'&&!('id'in reply)){
       if(!login||!loginOwner)throw new Error('login_order');
       login.acceptCompletion(reply,loginOwner);
       if(login.summary().status!=='success'){firstFailure??='login_not_success';stop();continue;}
       if(mode==='managed_model'){
        if(loginDeadline){clearTimeout(loginDeadline);loginDeadline=undefined;}
        turn=new FixedQualificationTurn(loginOwner,expected.checkCwd);
        send(turn.threadStartRequest());modelPhase=1;
       }else stop();
       continue;
      }
      if(managed&&reply.method==='account/updated'&&!('id'in reply)&&
       login?.summary().status==='success')continue;
      if(mode==='managed_model'&&turn){
       if(!loginOwner)throw new Error('model_owner');
       if(['thread/status/changed','thread/tokenUsage/updated'].includes(String(reply.method))){
        turn.observeStatus(reply,loginOwner);continue;
       }
        if(['thread/started','turn/started'].includes(String(reply.method))){
         turn.observeLifecycle(reply,loginOwner);continue;
        }
       if(['item/started','item/completed','item/agentMessage/delta',
        'item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded',
        'item/reasoning/textDelta'].includes(String(reply.method))){
         turn.observeItem(reply,loginOwner);continue;
        }
       if(reply.method==='item/tool/call'){
        if(stopSent||firstFailure)throw new Error('model_stopped');
        const accepted=turn.acceptToolCall(reply,loginOwner);
        if(!accepted.queued)void runTool(accepted.call);
        continue;
       }
       if(reply.method==='turn/completed'){
        turn.acceptTurnCompleted(reply,loginOwner);stop();continue;
       }
       if(reply.id===6&&modelPhase===1){
        turn.acceptThreadStart(reply,loginOwner);replies.push({id:6,projectionMatched:true});
        send(turn.turnStartRequest());modelPhase=2;continue;
       }
       if(reply.id===7&&modelPhase===2){
        turn.acceptTurnStart(reply,loginOwner);replies.push({id:7,projectionMatched:true});
        modelPhase=3;
        for(const call of turn.queuedToolCalls())void runTool(call);
        modelDeadline=setTimeout(()=>interruptModel('model_deadline'),240_000);
        continue;
       }
       if(reply.id===8&&modelPhase===3){
        turn.acceptInterrupt(reply,loginOwner);replies.push({id:8,projectionMatched:true});
        // ACK is not a terminal turn notification; the existing finite deadline drains it.
        continue;
       }
       throw new Error('model_rpc_order');
      }
      if(reply.id!==phase+1||'error'in reply||'method'in reply)throw new Error('rpc_order_or_error');
      const parsed=phase<3?parseQualificationReply(Number(reply.id),reply.result,expected):true;
      replies.push({id:reply.id,projectionMatched:parsed!==false,...(reply.id===3&&typeof parsed==='string'?{readiness:parsed}:{})});
      if(parsed===false)throw new Error('rpc_contract');phase++;
      if(phase===1){send(requests[1]!);send(requests[2]!);}
      else if(phase===2){
        if(managed){
        if(!writer)throw new Error('helper_identity');
        loginOwner={hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId,
         helperPid:writer.helperPid,helperCreationFiletime:writer.helperCreationFiletime};
        login=new ManagedChatgptLoginProtocol(loginOwner);
        login.confirmEphemeral(reply.result,configPath);
       }
       send(requests[3]!);
      }
      else if(phase===3){readiness=String(parsed);
       if(mode==='sandbox_setup'){
        if(readiness==='ready'){setupNotNeeded=true;stop();}
        else{
         if(!writer)throw new Error('helper_identity');
         setupOwner={hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId,
          helperPid:writer.helperPid,helperCreationFiletime:writer.helperCreationFiletime};
         setup=new FixedSandboxSetup(setupOwner,expected.checkCwd);
         console.log('Sandbox setup request: elevated; UAC must be confirmed by the user. No account/model request.');
         send(setup.startRequest());
        }
       }
       else if(mode==='preflight')stop();
       else if(mode==='thread_start_only'){
        if(!writer)throw new Error('helper_identity');
        threadOwner={hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId,
         helperPid:writer.helperPid,helperCreationFiletime:writer.helperCreationFiletime};
        threadOnly=new FixedQualificationThreadStartOnly(threadOwner,expected.checkCwd);
        send(threadOnly.start());
       }
       else if(mode==='managed_model'&&!qualificationModelReadinessAllowsLogin(readiness)){
        firstFailure??='model_readiness';stop();
       }
       else if(mode==='managed_model'){
        void createSyntheticQualificationRead(fixtureRoot).then(created=>{
         synthetic=created;
         if(stopSent||firstFailure)return;
         if(!login)throw new Error('login_order');
         const start=login.startRequest();loginStartAttempted=true;send(start);
         loginDeadline=setTimeout(cancelAtDeadline,240_000);
        }).catch(()=>fail('synthetic_read_setup'));
       }
       else if(login){const start=login.startRequest();loginStartAttempted=true;send(start);
        loginDeadline=setTimeout(cancelAtDeadline,300_000);}
       else throw new Error('login_order');
      }
       else if(phase===4&&managed){
       if(!login||!loginOwner)throw new Error('login_order');
       acceptManagedLoginStartWhenRunning(login,reply,loginOwner,presentAuthUrl!,{stopSent,firstFailure,interrupted});
      }
       else if(phase===5&&managed){
       if(!login||!loginOwner)throw new Error('login_order');
       login.acceptCancel(reply,loginOwner);
       firstFailure??=cancelReason;stop();
      }
      else throw new Error('rpc_duplicate');
     }
    }
 };
 const threadDrain=mode==='thread_start_only'?new ThreadOnlyCleanupStream(binding,child.pid??-1,
  ()=>stopSent,()=>threadFrames.beginNativeLine(),acceptNativeEvent,recordProtocolFailure,
  ()=>{rpcPartial=drainStoppedThreadRpc(rpcPartial).remaining;}):null;
 child.stdout.on('data',(chunk:Buffer)=>{
  if(finished)return;
  threadFrames.beginData();
  if(threadDrain){threadDrain.consume(chunk);return;}
  try{
   total+=chunk.length;if(total>256*1024||partial.length+chunk.length>32768)throw new Error('output_limit');
   partial=Buffer.concat([partial,chunk]);
   for(let end;(end=partial.indexOf(10))>=0;){
    threadFrames.beginNativeLine();
    const line=new TextDecoder('utf-8',{fatal:true}).decode(partial.subarray(0,end));partial=partial.subarray(end+1);
    const event=parsePreparedWindowsEvent(line,binding,sequence++);if(!event)throw new Error('native_envelope');
    acceptNativeEvent(event);
   }
  }catch(error){recordProtocolFailure(error);}
 });
 const detachUnknown=()=>{
  firstFailure??='helper_close_unknown';finished=true;
  for(const stream of [child.stdin,child.stdout,child.stderr])try{stream.destroy();}catch{/* No closure proof. */}
  try{child.unref();}catch{/* No closure proof. */}
 };
 const exitCode=await (mode==='sandbox_setup'?waitManagedLoginHelperClose(close,detachUnknown,Math.max(1,Math.floor(setupRemaining()))):
  mode==='preflight'?waitQualificationHelperClose(close,detachUnknown):
  waitManagedLoginHelperClose(close,detachUnknown,mode==='thread_start_only'?70_000:
   mode==='managed_model'?560_000:370_000));
 finished=true;if(mode!=='preflight')process.removeListener('SIGINT',onSigInt);
 if(timer)clearTimeout(timer);if(loginDeadline)clearTimeout(loginDeadline);
 if(modelDeadline)clearTimeout(modelDeadline);if(cleanupTimer)clearTimeout(cleanupTimer);
 if(setupHeartbeat)clearInterval(setupHeartbeat);
 const currentSynthetic=():Awaited<ReturnType<typeof createSyntheticQualificationRead>>|null=>synthetic;
 currentSynthetic()?.close();
 const terminal=native.at(-1),kinds=native.map(e=>e.kind);
 const closureState={firstFailure,exitCode,stdoutEnded,stderrEnded,helperStderr,
  partialBytes:threadDrain?.summary().partialBytes??partial.length,
  drainError:threadDrain?.summary().drainError??null,rpcPartialBytes:rpcPartial.length,startWriteSucceeded,stopWriteSucceeded,stopSent,
  phase,readiness,terminal,root,kinds};
 const authJsonAbsent=!existsSync(join(runtimeRoot,'home','.codex','auth.json'));
 if(!authJsonAbsent)firstFailure??='auth_json_present';
 const currentLogin=():ManagedChatgptLoginProtocol|null=>login;
 const loginSummary=currentLogin()?.summary();
 const currentTurn=():FixedQualificationTurn|null=>turn;
 const turnSummary=currentTurn()?.summary();
 const currentSetup=():FixedSandboxSetup|null=>setup;
 const setupSummary=currentSetup()?.summary();
 const currentThreadOnly=():FixedQualificationThreadStartOnly|null=>threadOnly;
 const threadStartSummary=currentThreadOnly()?.summary();
 const nativeClosureObserved=ownedNativeClosureObserved(closureState);
 const setupObserved=mode==='sandbox_setup'&&firstFailure===null&&authJsonAbsent&&nativeClosureObserved&&
  (setupNotNeeded?phase===3&&readiness==='ready':phase===5&&setupSummary?.status==='ready');
 const closureVerified=mode==='preflight'?qualificationClosureComplete({...closureState,firstFailure}):
  mode==='sandbox_setup'?setupObserved:
  mode==='thread_start_only'?nativeClosureObserved&&authJsonAbsent&&firstFailure===null:
  mode==='managed_model'?nativeClosureObserved:
  managedLoginClosureComplete({...closureState,firstFailure,loginStatus:loginSummary?.status??'not_started',
   ephemeralConfigVerified:loginSummary?.ephemeralConfigVerified??false,authJsonAbsent});
 const authObserved=loginSummary?.status==='success'&&loginSummary.ephemeralConfigVerified&&
  nativeClosureObserved&&authJsonAbsent;
 const inquiryObserved=mode==='managed_model'&&authObserved&&!modelInterruptIntent&&firstFailure===null&&
  turnSummary?.terminalStatus==='completed'&&turnSummary.successfulReads>=1&&turnSummary.findingStatus==='valid';
 const streamProjection=(text:string)=>({bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
 const projectedNative=native.map(event=>{
  if(mode!=='preflight'){
   if(event.kind==='prepared')return {kind:event.kind,sequence:event.sequence,
    helperPid:event.writer.helperPid,helperCreationFiletime:event.writer.helperCreationFiletime};
   if(event.kind==='started'||event.kind==='job_closed')return {kind:event.kind,sequence:event.sequence,
    root:{pid:event.root.pid,creationFiletime:event.root.creationFiletime}};
   if(event.kind==='stdout'||event.kind==='stderr'){
    const bytes=Buffer.from(event.dataBase64,'base64');
    return {kind:event.kind,sequence:event.sequence,bytes:bytes.length,
     sha256:createHash('sha256').update(bytes).digest('hex')};
   }
   return {kind:event.kind,sequence:event.sequence};
  }
  if(event.kind!=='stdout'&&event.kind!=='stderr')return event;
  const {dataBase64,...envelope}=event,bytes=Buffer.from(dataBase64,'base64');
  return {...envelope,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 });
 const result={kind:mode==='sandbox_setup'?'windows_qualification_sandbox_setup_v1':
  mode==='thread_start_only'?'windows_qualification_thread_start_only_v1':
  mode==='preflight'?'windows_qualification_preflight_v1':
  mode==='managed_model'?'windows_qualification_managed_model_v1':'windows_qualification_managed_login_v1',
  startedAt,endedAt:new Date().toISOString(),binding,configSha256,
  readiness,configProjectionVerified:phase>=2,
  configEffectiveBoundary:loginSummary?.ephemeralConfigVerified?'ephemeral_user_origin_verified':'not_verified',
  closureVerified,exitCode,firstFailure,
  nativeClosureObserved,
  cleanupDrainError:threadDrain?.summary().drainError??null,
  startWriteSucceeded,stopWriteSucceeded,native:projectedNative,replies,
  helperStderr:streamProjection(helperStderr),nativeStderr:streamProjection(nativeStderr),
  authentication:mode==='preflight'||!loginStartAttempted?'not_run':
   (authObserved?'managed_login_observed':'not_verified'),
  login:managed?loginSummary:undefined,authJsonAbsent,
  setup:mode==='sandbox_setup'?{...setupSummary,notNeeded:setupNotNeeded,
   privateErrorCaptured:setupErrorCaptured,
   observationComplete:setupObserved,installerTerminationVerified:false,systemRollbackVerified:false}:undefined,
  threadStart:mode==='thread_start_only'?{...threadStartSummary,
   status:threadStartSummary?.status==='accepted'?'accepted':
    threadStartSummary?.status==='rejected'?'rejected':'unknown',
   privateErrorCaptured:threadErrorCaptured}:undefined,
  threadFailureFrame:mode==='thread_start_only'?{
   stage:threadFailureReason===null?'none':'thread_start',reason:threadFailureReason,
   captured:threadFrameProjection!==null,captureFailed:threadFrameCaptureFailed,
   ...(threadFrameProjection??{})}:undefined,
  turn:mode==='managed_model'?turnSummary:undefined,
  modelTurn:mode==='managed_model'?(inquiryObserved?'read_and_finding_observed':
   !turnSummary?'not_run':turnSummary.terminalStatus==='failed'?'failed':
   turnSummary.terminalStatus==='interrupted'?'interrupted':
   turnSummary.terminalStatus==='completed'?(modelInterruptIntent?'interrupted':
    turnSummary.successfulReads===0?'not_exercised':'invalid'):
   'unknown'):'not_run',
  isolationVerified:false,productionAvailable:false};
 writeFileSync(join(fixtureRoot,mode==='sandbox_setup'?'sandbox-setup.json':
  mode==='thread_start_only'?'thread-start-only.json':mode==='preflight'?'preflight.json':
  mode==='managed_model'?'managed-model.json':'managed-login.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 if(mode==='managed_model'&&!inquiryObserved)throw new Error('QUALIFICATION_MODEL_UNKNOWN');
 if(mode==='thread_start_only'&&(!closureVerified||threadStartSummary?.status==='unknown'||
  threadStartSummary===undefined))throw new Error('QUALIFICATION_THREAD_START_UNKNOWN');
 if(mode!=='managed_model'&&!closureVerified)throw new Error(mode==='sandbox_setup'?'QUALIFICATION_SETUP_UNKNOWN':
  mode==='preflight'?'QUALIFICATION_PREFLIGHT_UNKNOWN':'QUALIFICATION_LOGIN_UNKNOWN');
 return result;
}
export async function runQualificationPreflight(fixtureRoot:string){return runQualification(fixtureRoot,'preflight');}
/** Explicit single-use native setup observation; never starts login or a model. */
export async function runQualificationSandboxSetup(fixtureRoot:string){return runQualification(fixtureRoot,'sandbox_setup');}
/** Explicit zero-model thread/start diagnostic; no login, turn/start, tool or setup request. */
export async function runQualificationThreadStartOnly(fixtureRoot:string){return runQualification(fixtureRoot,'thread_start_only');}
/** Explicit local human flow; this never starts a model turn or grants production admission. */
export async function runQualificationManagedLogin(fixtureRoot:string,presentAuthUrl:(url:string)=>void){
 return runQualification(fixtureRoot,'managed_login',presentAuthUrl);
}
/** Separate explicit one-turn synthetic mode; never entered from the default preflight or login-only command. */
export async function runQualificationManagedModel(fixtureRoot:string,presentAuthUrl:(url:string)=>void){
 return runQualification(fixtureRoot,'managed_model',presentAuthUrl);
}
function openOfficialLoginForHuman(url:string):void{
 // The protocol has already validated an exact documented HTTPS OpenAI origin.
 const opened=spawnSync('C:\\Windows\\System32\\rundll32.exe',['url.dll,FileProtocolHandler',url],
  {shell:false,windowsHide:true,stdio:'ignore',timeout:10_000,
   env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
 if(opened.error||opened.status!==0)throw new Error('QUALIFICATION_LOGIN_HANDOFF');
 console.log('等待用户在官方页面完成登录；已请求系统打开登录页，请确认是否可见。');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const managed=process.argv.length===4&&process.argv[2]==='--managed-login';
 const model=process.argv.length===4&&process.argv[2]==='--managed-model';
 const setup=process.argv.length===4&&process.argv[2]==='--sandbox-setup';
 const threadOnly=process.argv.length===4&&process.argv[2]==='--thread-start-only';
 if(!managed&&!model&&!setup&&!threadOnly&&process.argv.length!==3)throw new Error('Expected one fresh synthetic fixture path');
 const result=threadOnly?await runQualificationThreadStartOnly(process.argv[3]!):
  setup?await runQualificationSandboxSetup(process.argv[3]!):
  model?await runQualificationManagedModel(process.argv[3]!,openOfficialLoginForHuman):
  managed?await runQualificationManagedLogin(process.argv[3]!,openOfficialLoginForHuman):
  await runQualificationPreflight(process.argv[2]!);
 console.log(JSON.stringify({readiness:result.readiness,configProjectionVerified:result.configProjectionVerified,configEffectiveBoundary:result.configEffectiveBoundary,closureVerified:result.closureVerified,
  authentication:result.authentication,modelTurn:result.modelTurn,
  threadStart:result.threadStart,isolationVerified:false,productionAvailable:false}));
}

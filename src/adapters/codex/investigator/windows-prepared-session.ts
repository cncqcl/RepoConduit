import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {PassThrough,type Readable} from 'node:stream';
import {isAbsolute,resolve} from 'node:path';
import {windowsJobHelperPath,type WindowsJobRoot} from './windows-job-host.js';
import {resolveWindowsDesktopTarget} from './windows-desktop-target.js';
import {loadExistingClaudeGlmEnvironment} from '../../secondary-investigator/claude-windows-model-environment.js';

export interface PreparedWindowsBinding {
 readonly recipe:'prepared_owned_fixture_v1'|'windows_app_server_readonly_v1'|'windows_claude_readonly_v1';
 readonly hostScopeId:string;readonly executionInstanceId:string;
}
interface WriterOrigin {readonly helperPid:number;readonly helperCreationFiletime:string;
 readonly pipeName:string;readonly handle:string;readonly deadlineUtcTicks:string;
 readonly deadlineUptimeMs:string}
type Members={readonly complete:true;readonly assigned:0;readonly listed:0;readonly pids:readonly []};
type Common=PreparedWindowsBinding & {readonly protocol:'windows_job_stdio_v1';
 readonly helperVersion:'3';readonly sequence:number};
export type PreparedWindowsEvent=Common & (
 {readonly kind:'prepared';readonly childPresent:false;readonly writer:WriterOrigin}|
 {readonly kind:'prepared_closed';readonly childPresent:false;readonly members:Members}|
 {readonly kind:'started';readonly root:WindowsJobRoot;readonly createdSuspended:true;
  readonly jobMemberBeforeResume:true}|
 {readonly kind:'stdout'|'stderr';readonly dataBase64:string}|
 {readonly kind:'stdout_eof'|'stderr_eof'|'root_exit'}|
 {readonly kind:'job_closed';readonly root:WindowsJobRoot;readonly rootExited:true;
  readonly members:Members});
type Closure=Extract<PreparedWindowsEvent,{kind:'job_closed'|'prepared_closed'}>;
const unknown=()=>new Error('WINDOWS_PREPARED_UNKNOWN');
export interface PreparedWindowsFailureDiagnostic {
 readonly helperStage:string;readonly helperCloseObserved:boolean;readonly exitCode:number|null;
 readonly signal:string|null;readonly forcedKill:boolean;readonly startWriteAttempted:boolean;
 readonly protocolFault:boolean;readonly spawnError:string|null;
}
export interface PreparedWindowsNotStartedProof {readonly kind:'prepared_windows_not_started_v1'}
const failureFacts=new WeakMap<object,Readonly<{diagnostic:PreparedWindowsFailureDiagnostic;
 notStarted?:PreparedWindowsNotStartedProof}>>();
const notStartedFacts=new WeakMap<object,{production:Production;
 child:ChildProcessWithoutNullStreams}>();
const helperCodes=new Set(('ARGUMENTS ATTRIBUTE_HANDLES ATTRIBUTE_INIT ATTRIBUTE_JOB ATTRIBUTE_SIZE '+
 'CHILD_START CONFIG_FILE CONFIG_HASH CONFIG_PATH MODEL_CONFIG CONTROL_EOF CONTROL_INVALID CONTROL_LIMIT '+
 'CONTROL_ORDER CONTROL_TIMEOUT FIXTURE_FRAME HELPER_IDENTITY INPUT_TIMEOUT JOB_ACCOUNTING '+
 'JOB_CREATE JOB_LIMIT JOB_LIST_BOUNDS JOB_LIST_DUPLICATE JOB_LIST_INCOMPLETE JOB_LIST_PID '+
 'JOB_LIST_TRUNCATED JOB_NOT_EMPTY JOB_TERMINATE PIPE_CONNECT PIPE_CREATE PIPE_DACL '+
 'PIPE_INHERIT PIPE_LIMIT PRE_RESUME_MEMBERSHIP PREPARED_DEADLINE PROCESS_CREATE '+
 'PROCESS_IDENTITY PROCESS_RESUME ROOT_WAIT STDIN_WRITE TREE_NOT_STABLE WRITER_DEADLINE '+
 'WRITER_FRAME_LIMIT WRITER_FRAME WRITER_HANDLE WRITER_IMAGE WRITER_ORIGIN '+
 'WRITER_PIPE_MODE WRITER_PIPE_SERVER WRITER_PIPE_TYPE WRITER_PROCESS WRITER_UNKNOWN '+
 'HOST_UNKNOWN STDIO_UNKNOWN CHILD_UNKNOWN DESKTOP_TARGET').split(' '));
// WindowsJobHost.StdioHost reaches these stages before its first AwaitControl("start").
// Ambiguous control/cleanup codes and all later process stages remain diagnostic only.
const preStartHelperCodes=new Set(('CONFIG_FILE CONFIG_HASH CONFIG_PATH JOB_CREATE JOB_LIMIT '+
 'PIPE_CREATE PIPE_CONNECT PIPE_DACL PIPE_INHERIT ATTRIBUTE_SIZE ATTRIBUTE_INIT '+
 'ATTRIBUTE_JOB ATTRIBUTE_HANDLES HELPER_IDENTITY').split(' '));
const postStartHelperCodes=new Set(('PROCESS_CREATE PROCESS_IDENTITY PROCESS_RESUME '+
 'PRE_RESUME_MEMBERSHIP').split(' '));
const spawnErrorCodes=new Set(['EPERM','EACCES','ENOENT','EINVAL','EAGAIN','ENOMEM']);
/** Only original failures registered by this adapter expose bounded observations. */
export function getPreparedWindowsFailure(error:unknown){
 return error&&typeof error==='object'?failureFacts.get(error):undefined;
}
/** An immutable, privately registered proof must match the original production launch options. */
export function verifyPreparedWindowsNotStarted(proof:unknown,expected:{runtimeRoot:string;
 configSha256:string;sourceCwd:string}):boolean{
 if(!proof||typeof proof!=='object'||!record(expected))return false;
 const fact=notStartedFacts.get(proof);
 return !!fact&&fact.production.recipe==='windows_app_server_readonly_v1'&&
  fact.production.runtimeRoot===expected.runtimeRoot&&
  fact.production.configSha256===expected.configSha256&&fact.production.sourceCwd===expected.sourceCwd;
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal=(v:unknown,max:bigint):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)&&BigInt(v)<=max;
const uint64=0xffff_ffff_ffff_ffffn;
const validRoot=(v:unknown):v is WindowsJobRoot=>record(v)&&keys(v,['pid','creationFiletime'])&&
 Number.isInteger(v.pid)&&Number(v.pid)>0&&Number(v.pid)<=0xffff_ffff&&decimal(v.creationFiletime,uint64);
const validMembers=(v:unknown):v is Members=>record(v)&&keys(v,['complete','assigned','listed','pids'])&&
 v.complete===true&&v.assigned===0&&v.listed===0&&Array.isArray(v.pids)&&v.pids.length===0;

/** Envelope parsing is transport evidence only, never a production qualification. */
export function parsePreparedWindowsEvent(line:string,binding:PreparedWindowsBinding,sequence:number):PreparedWindowsEvent|null{
 if(!record(binding)||!keys(binding,['recipe','hostScopeId','executionInstanceId'])||
  !['prepared_owned_fixture_v1','windows_app_server_readonly_v1','windows_claude_readonly_v1'].includes(binding.recipe)||
  typeof binding.hostScopeId!=='string'||!uuid.test(binding.hostScopeId)||
  typeof binding.executionInstanceId!=='string'||!uuid.test(binding.executionInstanceId)||
  typeof line!=='string'||Buffer.byteLength(line)>16384||!Number.isSafeInteger(sequence)||sequence<1)return null;
 let v:unknown;try{v=JSON.parse(line);}catch{return null;}
 if(!record(v)||v.protocol!=='windows_job_stdio_v1'||v.helperVersion!=='3'||v.recipe!==binding.recipe||
  v.hostScopeId!==binding.hostScopeId||v.executionInstanceId!==binding.executionInstanceId||v.sequence!==sequence)return null;
 const base=['protocol','helperVersion','recipe','hostScopeId','executionInstanceId','sequence','kind'];
 if(v.kind==='prepared'){
  if(!keys(v,[...base,'childPresent','writer'])||v.childPresent!==false||!record(v.writer))return null;
  const w=v.writer;
  if(!keys(w,['helperPid','helperCreationFiletime','pipeName','handle','deadlineUtcTicks','deadlineUptimeMs'])||
   !Number.isInteger(w.helperPid)||Number(w.helperPid)<1||Number(w.helperPid)>0xffff_ffff||
   !decimal(w.helperCreationFiletime,uint64)||!decimal(w.handle,uint64)||
   !decimal(w.deadlineUtcTicks,3155378975999999999n)||!decimal(w.deadlineUptimeMs,0x7fff_ffff_ffff_ffffn)||
   w.pipeName!==`\\\\.\\pipe\\RepoConduit-prepared-${binding.hostScopeId}-${binding.executionInstanceId}`)return null;
  Object.freeze(w);
 }else if(v.kind==='started'){
  if(!keys(v,[...base,'root','createdSuspended','jobMemberBeforeResume'])||!validRoot(v.root)||
   v.createdSuspended!==true||v.jobMemberBeforeResume!==true)return null;
  Object.freeze(v.root);
 }else if(v.kind==='job_closed'||v.kind==='prepared_closed'){
  if(!validMembers(v.members))return null;
  if(v.kind==='job_closed'){
   if(!keys(v,[...base,'root','rootExited','members'])||!validRoot(v.root)||v.rootExited!==true)return null;
   Object.freeze(v.root);
  }else if(!keys(v,[...base,'childPresent','members'])||v.childPresent!==false)return null;
  Object.freeze(v.members.pids);Object.freeze(v.members);
 }else if(v.kind==='stdout'||v.kind==='stderr'){
  if(!keys(v,[...base,'dataBase64'])||typeof v.dataBase64!=='string'||!v.dataBase64||v.dataBase64.length>5464)return null;
  const bytes=Buffer.from(v.dataBase64,'base64');
  if(bytes.length>4096||bytes.toString('base64')!==v.dataBase64)return null;
 }else if(!['stdout_eof','stderr_eof','root_exit'].includes(String(v.kind))||!keys(v,base))return null;
 return Object.freeze(v) as unknown as PreparedWindowsEvent;
}

interface FixtureOptions {maxWallSeconds:number;signal?:AbortSignal}
interface AppServerOptions extends FixtureOptions {runtimeRoot:string;configSha256:string;sourceCwd:string;desktopTarget?:string}
interface ClaudeOptions extends FixtureOptions {runtimeRoot:string;configSha256:string;sourceCwd:string;maxTurns:number}
type Production=Readonly<{runtimeRoot:string;configSha256:string;sourceCwd:string;
 recipe:'windows_app_server_readonly_v1'|'windows_claude_readonly_v1';maxTurns?:number;desktopTarget?:string}>;
interface OwnedState {
 child:ChildProcessWithoutNullStreams;binary:string;binding:PreparedWindowsBinding;
 writer:WriterOrigin|null;root:WindowsJobRoot|null;phase:'preparing'|'prepared'|'starting'|'running'|'stopping'|'closed';
 deadline:number;mono:number;budgetMs:number;failed:boolean;
 start:()=>Promise<WindowsJobRoot>;send:(line:string)=>true;stop:()=>Promise<Closure>;
}
const sessions=new WeakMap<PreparedWindowsFixtureSession,OwnedState>();
const claudeEnvironment=()=>{
 const profile=homedir();
 const proxy=process.env.HTTPS_PROXY??process.env.https_proxy;
 const allowedProxy=typeof proxy==='string'&&/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/?$/u.test(proxy)?proxy:undefined;
 return {SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
  USERPROFILE:profile,APPDATA:`${profile}\\AppData\\Roaming`,
  LOCALAPPDATA:`${profile}\\AppData\\Local`,
  TEMP:`${profile}\\AppData\\Local\\Temp`,
  TMP:`${profile}\\AppData\\Local\\Temp`,
  CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',NO_PROXY:'127.0.0.1,localhost',
  ...loadExistingClaudeGlmEnvironment(),
  ...(allowedProxy?{HTTPS_PROXY:allowedProxy,HTTP_PROXY:allowedProxy}:{})};
};

/** Original native Job session. open() selects the synthetic recipe; openAppServer() selects the fixed production recipe.
 * Transport ownership alone does not establish live investigator acceptance. */
export class PreparedWindowsFixtureSession {
 private constructor(readonly output:Readable,readonly errors:Readable){}
 /** Fixed production inputs must exist before a durable investigation claim. */
 static assertAppServerAvailable():string{
  try{
   windowsJobHelperPath(); // Validates installed binary, manifest and reviewed source hashes.
   return resolveWindowsDesktopTarget();
  }catch{throw new Error('NOT_AVAILABLE');}
 }
 static assertClaudeAvailable():void{
  try{
   const path=resolve(homedir(),'.local','bin','claude.exe');
   const executable=lstatSync(path);
   if(!executable.isFile()||executable.isSymbolicLink())throw unknown();
   const version=spawnSync(path,['--version'],{shell:false,windowsHide:true,encoding:'utf8',
    timeout:5000,maxBuffer:4096,env:claudeEnvironment()});
   if(version.error||version.status!==0||version.stderr!==''||
    version.stdout.trim()!=='2.1.287 (Claude Code)')throw unknown();
   windowsJobHelperPath();
  }catch{throw new Error('NOT_AVAILABLE');}
 }
 get root():WindowsJobRoot|null{return sessions.get(this)?.root??null;}
 remainingWallMs():number{
  const s=sessions.get(this);if(!s)throw unknown();
  return Math.max(0,Math.min(s.deadline-Date.now(),s.budgetMs-(performance.now()-s.mono)));
 }
 start():Promise<WindowsJobRoot>{const s=sessions.get(this);if(!s)throw unknown();return s.start();}
 send(line:string):true{const s=sessions.get(this);if(!s)throw unknown();return s.send(line);}
 stop():Promise<Closure>{const s=sessions.get(this);if(!s)throw unknown();return s.stop();}

 static async open(options:FixtureOptions):Promise<PreparedWindowsFixtureSession>{
  return this.openSession(options);
 }

 /** Fixed production recipe, never a caller-selected executable or supplied channel. */
 static async openAppServer(options:AppServerOptions):Promise<PreparedWindowsFixtureSession>{
  if(!record(options)||!isAbsolute(options.runtimeRoot)||resolve(options.runtimeRoot)!==options.runtimeRoot||
   !isAbsolute(options.sourceCwd)||resolve(options.sourceCwd)!==options.sourceCwd||
   !/^[0-9a-f]{64}$/.test(options.configSha256)||
   (options.desktopTarget!==undefined&&typeof options.desktopTarget!=='string')||
   Object.keys(options).some(k=>!['runtimeRoot','sourceCwd','configSha256','maxWallSeconds','signal','desktopTarget'].includes(k)))throw unknown();
  return this.openSession({maxWallSeconds:options.maxWallSeconds,...(options.signal?{signal:options.signal}:{})},
   Object.freeze({runtimeRoot:options.runtimeRoot,sourceCwd:options.sourceCwd,
    configSha256:options.configSha256,recipe:'windows_app_server_readonly_v1',
    desktopTarget:options.desktopTarget??resolveWindowsDesktopTarget()}));
 }

 /** Fixed current-user Claude recipe; the caller supplies only the locked MCP config root. */
 static async openClaude(options:ClaudeOptions):Promise<PreparedWindowsFixtureSession>{
  if(!record(options)||!isAbsolute(options.runtimeRoot)||resolve(options.runtimeRoot)!==options.runtimeRoot||
   !isAbsolute(options.sourceCwd)||resolve(options.sourceCwd)!==options.sourceCwd||
   options.sourceCwd!==resolve(options.runtimeRoot,'work')||
   !/^[0-9a-f]{64}$/.test(options.configSha256)||
   !Number.isInteger(options.maxTurns)||options.maxTurns<1||options.maxTurns>8||
   Object.keys(options).some(k=>!['runtimeRoot','sourceCwd','configSha256','maxWallSeconds','maxTurns','signal'].includes(k)))throw unknown();
  return this.openSession({maxWallSeconds:options.maxWallSeconds,...(options.signal?{signal:options.signal}:{})},
   Object.freeze({runtimeRoot:options.runtimeRoot,sourceCwd:options.sourceCwd,
    configSha256:options.configSha256,recipe:'windows_claude_readonly_v1',maxTurns:options.maxTurns}));
 }

 private static async openSession(options:FixtureOptions,production?:Production):Promise<PreparedWindowsFixtureSession>{
  if(process.platform!=='win32'||!record(options)||typeof options.maxWallSeconds!=='number'||
   !Number.isSafeInteger(options.maxWallSeconds)||options.maxWallSeconds<1||options.maxWallSeconds>600||
   Object.keys(options).some(k=>!['maxWallSeconds','signal'].includes(k))||
   (options.signal!==undefined&&!(options.signal instanceof AbortSignal))||options.signal?.aborted)throw unknown();
  options=Object.freeze({...options});
  const budgetMs=options.maxWallSeconds*1000;
  const mono=performance.now(),deadline=Date.now()+budgetMs;
  const binary=windowsJobHelperPath();
  const binding:PreparedWindowsBinding=Object.freeze({recipe:production?.recipe??'prepared_owned_fixture_v1',
   hostScopeId:randomUUID(),executionInstanceId:randomUUID()});
  const claude=production?.recipe==='windows_claude_readonly_v1';
  const claudeEnv=claude?claudeEnvironment():undefined;
  const child=spawn(binary,[binding.recipe,binding.hostScopeId,binding.executionInstanceId,
   ...(production?[production.runtimeRoot,production.configSha256,production.sourceCwd]:[]),
   String(options.maxWallSeconds),...(claude?[String(production!.maxTurns)]:[]),
   ...(production?.recipe==='windows_app_server_readonly_v1'?[production.desktopTarget!]:[])],{
   shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
   env:claude?claudeEnv:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
  const output=new PassThrough(),errors=new PassThrough();
  const session=new PreparedWindowsFixtureSession(output,errors);
  let sequence=1,partial=Buffer.alloc(0),total=0,nativeTotal=0;
  let stdoutEof=false,stderrEof=false,rootExited=false,closure:Closure|null=null;
  let helperCloseObserved=false,helperExitCode:number|null=null,helperSignal:string|null=null;
  let spawnError:string|null=null;
  let closeSignalled=false;
  let stdoutEnded=false,stderrEnded=false,forcedKill=false,startWriteAttempted=false;
  let protocolFault=false,aborted=false,timedOut=false,handedOff=false,claudeInputSent=false;
  let helperStderr=Buffer.alloc(0),helperStderrOverflow=false;
  let prepareResolve:()=>void,prepareReject:(e:Error)=>void,startResolve:(root:WindowsJobRoot)=>void,startReject:(e:Error)=>void;
  let closeResolve:(c:Closure)=>void,closeReject:(e:Error)=>void;
  const prepared=new Promise<void>((r,j)=>{prepareResolve=r;prepareReject=j;});
  const started=new Promise<WindowsJobRoot>((r,j)=>{startResolve=r;startReject=j;});
  const closed=new Promise<Closure>((r,j)=>{closeResolve=r;closeReject=j;});
  void prepared.catch(()=>{});void started.catch(()=>{});void closed.catch(()=>{});
  let cleanupTimer:NodeJS.Timeout|undefined;
  const remaining=()=>Math.max(0,Math.min(deadline-Date.now(),budgetMs-(performance.now()-mono)));
  const state:OwnedState={child,binary,binding,writer:null,root:null,phase:'preparing',deadline,mono,budgetMs,failed:false,
   start:()=>{throw unknown();},send:()=>{throw unknown();},stop:()=>closed};
  sessions.set(session,state);
  const stop=()=>{
   if(state.phase==='closed'||state.phase==='stopping')return closed;
   state.phase='stopping';state.writer=null;
   try{child.stdin.write('stop\n');}catch{state.failed=true;}
   cleanupTimer=setTimeout(()=>{state.failed=true;forcedKill=true;try{child.kill();}catch{/* Not closure proof. */}
    closeReject(unknown());},5000);
   return closed;
  };
  const fail=(protocol=false)=>{if(protocol)protocolFault=true;state.failed=true;
   prepareReject(unknown());startReject(unknown());void stop().catch(()=>{});};
  // Cancellation stops new sends but an intact original Job can still prove closure.
  const abort=()=>{aborted=true;prepareReject(unknown());startReject(unknown());void stop().catch(()=>{});};
  const timer=setTimeout(()=>{timedOut=true;fail();},Math.ceil(remaining()));
  state.stop=stop;
  state.start=()=>{
   if(state.phase!=='prepared'||state.failed||remaining()<=0||options.signal?.aborted)throw unknown();
   state.phase='starting'; // Irreversible local opportunity, including an unknown send.
   startWriteAttempted=true;
   if(child.stdin.writableLength||child.stdin.writableNeedDrain){fail();throw unknown();}
   try{if(!child.stdin.write('start\n')){fail();throw unknown();}}catch{fail();throw unknown();}
   return started;
  };
  state.send=(line)=>{
   if(state.phase!=='running'||state.failed||remaining()<=0||options.signal?.aborted||!state.writer)throw unknown();
   if(typeof line!=='string'||!line.endsWith('\n')||line.slice(0,-1).includes('\n')||line.includes('\r')){fail();throw unknown();}
   const bytes=Buffer.from(line,'utf8');
   if(bytes.length>65536||bytes.length<3||new TextDecoder('utf-8',{fatal:true}).decode(bytes)!==line){fail();throw unknown();}
   let parsed:unknown;try{parsed=JSON.parse(line);}catch{fail();throw unknown();}
   if(!record(parsed)){fail();throw unknown();}
   if(claude){
    if(claudeInputSent||parsed.type!=='user'||!record(parsed.message)||
     parsed.message.role!=='user'||typeof parsed.message.content!=='string'||
     !parsed.message.content){fail();throw unknown();}
    claudeInputSent=true;
   }
   const w=state.writer;
   const writeStarted=performance.now();
   const result=spawnSync(binary,['__write_owned_frame',binding.hostScopeId,binding.executionInstanceId,
    String(w.helperPid),w.helperCreationFiletime,w.pipeName,w.handle,w.deadlineUtcTicks,w.deadlineUptimeMs],{
    shell:false,windowsHide:true,input:bytes,encoding:'utf8',timeout:Math.max(1,Math.min(500,Math.ceil(remaining()))),maxBuffer:2048,
    env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
   if(result.error||result.status!==0||result.stdout!=='{"accepted":true}'||result.stderr!==''||
    state.phase!=='running'||state.failed||options.signal?.aborted||remaining()<=0){
    const withinBudget=remaining()>0;
    const code=(result.error as NodeJS.ErrnoException|undefined)?.code;
    const helperStage=typeof result.stderr==='string'&&result.stderr.length<=128?
     result.stderr.replace(/\r?\n$/u,''):'unknown';
    const diagnostic=Object.freeze({stage:'frame_write',
     reason:result.error?'spawn_error':result.status!==0?'native_exit':
      result.stdout!=='{"accepted":true}'?'receipt_mismatch':result.stderr!==''?'native_stderr':
       options.signal?.aborted?'cancelled':!withinBudget?'budget_exhausted':'authority_changed',
     spawnError:result.error?(typeof code==='string'&&
      [...spawnErrorCodes,'ETIMEDOUT','ENOBUFS'].includes(code)?code:'unknown'):null,
     exitCode:Number.isSafeInteger(result.status)?result.status:null,
     signal:typeof result.signal==='string'&&['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGBREAK'].includes(result.signal)?result.signal:null,
     helperStage:helperCodes.has(helperStage)?helperStage:'unknown',
     receiptMatched:result.stdout==='{"accepted":true}',stderrEmpty:result.stderr==='',
     phaseRunning:state.phase==='running',failed:state.failed,aborted:options.signal?.aborted===true,
     withinBudget,elapsedMs:Math.min(600_000,Math.max(0,Math.ceil(performance.now()-writeStarted)))});
    fail();throw new Error('WINDOWS_PREPARED_UNKNOWN',{cause:diagnostic});
   }
   return true;
  };
  child.stdin.on('error',()=>fail(true));child.stdout.on('error',()=>fail(true));
  child.stderr.on('error',()=>fail(true));child.on('error',(error:Error)=>{
   const code=(error as NodeJS.ErrnoException).code;
   spawnError=typeof code==='string'&&spawnErrorCodes.has(code)?code:'unknown';
   fail(true);
  });
  child.stdout.on('end',()=>{stdoutEnded=true;});child.stderr.on('end',()=>{stderrEnded=true;});
  child.stderr.on('data',(chunk:Buffer)=>{
   if(helperStderr.length+chunk.length>128)helperStderrOverflow=true;
   else helperStderr=Buffer.concat([helperStderr,chunk]);
   fail();
  });
  child.stdout.on('data',(chunk:Buffer)=>{
   if(state.phase==='closed')return;
   total+=chunk.length;
   if(total>2*1024*1024||partial.length+chunk.length>32768){fail(true);return;}
   partial=Buffer.concat([partial,chunk]);
   for(let end;(end=partial.indexOf(10))>=0;){
    let line:string;try{line=new TextDecoder('utf-8',{fatal:true}).decode(partial.subarray(0,end));}catch{fail(true);return;}
    partial=partial.subarray(end+1);
    const e=parsePreparedWindowsEvent(line,binding,sequence++);
    if(!e||closure){fail(true);return;}
    if(e.kind==='prepared'){
     if(state.phase!=='preparing'||state.writer||e.writer.helperPid!==child.pid){fail(true);return;}
     state.writer=e.writer;state.phase='prepared';prepareResolve();
    }else if(e.kind==='started'){
     // Retain a late real identity even after revocation, without restoring send authority.
     if(state.root||!['starting','stopping'].includes(state.phase)){fail(true);return;}
     state.root=e.root;
     if(state.phase==='starting'&&!state.failed){state.phase='running';startResolve(e.root);}
    }else if(e.kind==='stdout'||e.kind==='stderr'){
     if(!state.root||(e.kind==='stdout'&&stdoutEof)||(e.kind==='stderr'&&stderrEof)){fail(true);return;}
     const bytes=Buffer.from(e.dataBase64,'base64');nativeTotal+=bytes.length;
     if(nativeTotal>1024*1024){fail(true);return;}
     if(e.kind==='stdout')output.write(bytes);else errors.write(bytes);
    }else if(e.kind==='stdout_eof'||e.kind==='stderr_eof'||e.kind==='root_exit'){
     if(!state.root){fail(true);return;}
     if(e.kind==='stdout_eof'){if(stdoutEof){fail(true);return;}stdoutEof=true;output.end();}
     if(e.kind==='stderr_eof'){if(stderrEof){fail(true);return;}stderrEof=true;errors.end();}
     if(e.kind==='root_exit'){if(rootExited){fail(true);return;}rootExited=true;}
    }else if(e.kind==='prepared_closed'){
     if(state.phase!=='stopping'||state.root||sequence!==3){fail(true);return;}closure=e;
    }else if(e.kind==='job_closed'){
     if(state.phase!=='stopping'||!state.root||!stdoutEof||!stderrEof||!rootExited||
      e.root.pid!==state.root.pid||e.root.creationFiletime!==state.root.creationFiletime){fail(true);return;}closure=e;
    }
   }
   if(partial.length>16384)fail(true);
  });
  child.on('close',(code:number|null,signal:string|null)=>{
   helperCloseObserved=true;helperExitCode=code;closeSignalled=signal!==null;
   helperSignal=typeof signal==='string'&&/^[A-Z0-9]{1,16}$/.test(signal)?signal:null;
   clearTimeout(timer);if(cleanupTimer)clearTimeout(cleanupTimer);
   options.signal?.removeEventListener('abort',abort);
   state.writer=null;state.phase='closed';output.end();errors.end();
   prepareReject(unknown());startReject(unknown());
   if(code===0&&closure&&!partial.length&&!state.failed)closeResolve(closure);else closeReject(unknown());
  });
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)fail();
  try{await prepared;if(state.failed||remaining()<=0||options.signal?.aborted)throw unknown();
   handedOff=true;return session;}
  catch{void stop().catch(()=>{});await closed.catch(()=>{});
   const failure=unknown();
   const stderrText=helperStderrOverflow?'':helperStderr.toString('utf8');
   const helperStage=helperCodes.has(stderrText.replace(/\r?\n$/u,''))&&
    /^[-A-Z_]+\r?\n$/u.test(stderrText)?stderrText.replace(/\r?\n$/u,''):'unknown';
   const stageContradiction=!startWriteAttempted&&
    (postStartHelperCodes.has(helperStage)||helperStage.startsWith('WRITER_')||
     (preStartHelperCodes.has(helperStage)&&(total>0||helperExitCode===0)));
   const diagnostic:PreparedWindowsFailureDiagnostic=Object.freeze({helperStage,helperCloseObserved,
    exitCode:helperExitCode,signal:helperSignal,forcedKill,startWriteAttempted,spawnError,
    protocolFault:protocolFault||partial.length>0||stageContradiction});
   const canProve=!!production&&!handedOff&&!startWriteAttempted&&!state.root&&
    helperCloseObserved&&stdoutEnded&&stderrEnded&&!partial.length&&!protocolFault&&
    !aborted&&!timedOut&&!forcedKill&&!closeSignalled&&!spawnError&&helperExitCode===1&&
    preStartHelperCodes.has(helperStage)&&sequence===1&&total===0;
   let notStarted:PreparedWindowsNotStartedProof|undefined;
   if(canProve){notStarted=Object.freeze({kind:'prepared_windows_not_started_v1'});
    notStartedFacts.set(notStarted,{production:production!,child});}
   failureFacts.set(failure,Object.freeze({diagnostic,...(notStarted?{notStarted}:{})}));
   throw failure;}
 }
}

/** Does not accept caller channels, executables, production recipes or qualification callbacks. */
export const openPreparedWindowsFixture=(options:FixtureOptions)=>PreparedWindowsFixtureSession.open(options);

/** Reuses the native suspended-start Job owner; full closure comes from the original helper. */
export const openOwnedWindowsAppServer=(options:AppServerOptions)=>PreparedWindowsFixtureSession.openAppServer(options);

/** One fixed Claude Job owner; inputs cannot select executable, argv or child environment. */
export const openOwnedWindowsClaude=(options:ClaudeOptions)=>PreparedWindowsFixtureSession.openClaude(options);

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runWindowsReadinessProtocol, type WindowsReadinessResult } from '../protocol/windows-readiness.js';
import {runWindowsConfigProtocol} from '../protocol/windows-config-check.js';
import { windowsJobHelperPath, type WindowsJobHelperChannel, type WindowsJobRoot } from './windows-job-host.js';
import {resolveWindowsDesktopTarget} from './windows-desktop-target.js';

export type OwnedReadinessRecipe = 'stdio_fixture_v1' | 'desktop_readiness_v1' | 'owned_pipe_fixture_v1';
export interface OwnedStdioBinding { recipe: OwnedReadinessRecipe | 'desktop_config_check_v1'; hostScopeId: string; executionInstanceId: string }
type Common = OwnedStdioBinding & { protocol: 'windows_job_stdio_v1'; helperVersion: '3'; sequence: number };
export type OwnedStdioEvent = Common & (
  { kind: 'started'; root: WindowsJobRoot; createdSuspended: true; jobMemberBeforeResume: true;
    writer?: OwnedWriterOrigin } |
  { kind: 'stdout' | 'stderr'; dataBase64: string } |
  { kind: 'stdout_eof' | 'stderr_eof' | 'root_exit' } |
  { kind: 'job_closed'; root: WindowsJobRoot; rootExited: true;
    members: { complete: true; assigned: 0; listed: 0; pids: [] } });
type Closure = Extract<OwnedStdioEvent, { kind: 'job_closed' }>;
interface OwnedWriterOrigin {helperPid:number;helperCreationFiletime:string;pipeName:string;
  handle:string;deadlineUtcTicks:string;deadlineUptimeMs:string}
export interface OwnedReadinessResult extends WindowsReadinessResult {
  recipe: OwnedReadinessRecipe; root: WindowsJobRoot; closure: Closure;
}
interface Options { signal?: AbortSignal; assertDiagnosticAuthority: () => boolean }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^[1-9][0-9]{0,19}$/;
const ownedChannels = new WeakMap<WindowsJobHelperChannel,
  {binding:OwnedStdioBinding;helperPid:number;writer:OwnedWriterOrigin|null}>();
const validBinding = (b: OwnedStdioBinding) => record(b) && sameKeys(b, ['recipe', 'hostScopeId', 'executionInstanceId']) &&
  ['stdio_fixture_v1', 'desktop_readiness_v1', 'desktop_config_check_v1', 'owned_pipe_fixture_v1'].includes(b.recipe) &&
  typeof b.hostScopeId === 'string' && uuid.test(b.hostScopeId) &&
  typeof b.executionInstanceId === 'string' && uuid.test(b.executionInstanceId);
const validRoot = (v: unknown): v is WindowsJobRoot => record(v) && sameKeys(v, ['pid', 'creationFiletime']) &&
  Number.isInteger(v.pid) && (v.pid as number) > 0 && (v.pid as number) <= 0xffff_ffff &&
  typeof v.creationFiletime === 'string' && /^[1-9][0-9]{0,19}$/.test(v.creationFiletime) &&
  BigInt(v.creationFiletime) <= 0xffff_ffff_ffff_ffffn;
const validWriter=(v:unknown,binding:OwnedStdioBinding):v is OwnedWriterOrigin=>record(v)&&
  sameKeys(v,['helperPid','helperCreationFiletime','pipeName','handle','deadlineUtcTicks','deadlineUptimeMs'])&&
  Number.isInteger(v.helperPid)&&Number(v.helperPid)>0&&Number(v.helperPid)<=0xffff_ffff&&
  typeof v.helperCreationFiletime==='string'&&decimal.test(v.helperCreationFiletime)&&
  BigInt(v.helperCreationFiletime)<=0xffff_ffff_ffff_ffffn&&
  v.pipeName===`\\\\.\\pipe\\RepoConduit-owned-${binding.hostScopeId}-${binding.executionInstanceId}`&&
  typeof v.handle==='string'&&decimal.test(v.handle)&&
  typeof v.deadlineUtcTicks==='string'&&decimal.test(v.deadlineUtcTicks)&&
  BigInt(v.deadlineUtcTicks)<=BigInt(Number.MAX_SAFE_INTEGER)*1000n&&
  typeof v.deadlineUptimeMs==='string'&&decimal.test(v.deadlineUptimeMs);

/** Transport integrity only: never an isolation or investigator qualification. */
export function parseOwnedStdioEvent(line: string, binding: OwnedStdioBinding, sequence: number): OwnedStdioEvent | null {
  if (!validBinding(binding) || typeof line !== 'string' || Buffer.byteLength(line) > 16384 ||
      !Number.isSafeInteger(sequence) || sequence < 1) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!record(value) || value.protocol !== 'windows_job_stdio_v1' || value.helperVersion !== '3' ||
      value.recipe !== binding.recipe || value.hostScopeId !== binding.hostScopeId ||
      value.executionInstanceId !== binding.executionInstanceId || value.sequence !== sequence) return null;
  const base = ['protocol', 'helperVersion', 'recipe', 'hostScopeId', 'executionInstanceId', 'sequence', 'kind'];
  if (value.kind === 'started') {
    const owned=binding.recipe==='owned_pipe_fixture_v1';
    if (!sameKeys(value, [...base, 'root', 'createdSuspended', 'jobMemberBeforeResume',
        ...(owned?['writer']:[])]) || !validRoot(value.root) ||
        value.createdSuspended !== true || value.jobMemberBeforeResume !== true) return null;
    if(owned){if(!validWriter(value.writer,binding))return null;Object.freeze(value.writer);}
    Object.freeze(value.root);
  } else if (value.kind === 'stdout' || value.kind === 'stderr') {
    if (!sameKeys(value, [...base, 'dataBase64']) || typeof value.dataBase64 !== 'string' ||
        !value.dataBase64 || value.dataBase64.length > 5464) return null;
    const bytes = Buffer.from(value.dataBase64, 'base64');
    if (bytes.length > 4096 || bytes.toString('base64') !== value.dataBase64) return null;
  } else if (value.kind === 'job_closed') {
    if (!sameKeys(value, [...base, 'root', 'rootExited', 'members']) || !validRoot(value.root) ||
        value.rootExited !== true || !record(value.members) ||
        !sameKeys(value.members, ['complete', 'assigned', 'listed', 'pids']) || value.members.complete !== true ||
        value.members.assigned !== 0 || value.members.listed !== 0 ||
        !Array.isArray(value.members.pids) || value.members.pids.length !== 0) return null;
    Object.freeze(value.root); Object.freeze(value.members.pids); Object.freeze(value.members);
  } else if (!['stdout_eof', 'stderr_eof', 'root_exit'].includes(value.kind as string) || !sameKeys(value, base)) return null;
  return Object.freeze(value) as unknown as OwnedStdioEvent;
}

const initialize = JSON.stringify({ id: 1, method: 'initialize', params: {
  clientInfo: { name: 'repo-conduit-readiness', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false },
} }) + '\n';
const fixedWrites = [initialize, '{"method":"initialized"}\n', '{"id":2,"method":"windowsSandbox/readiness","params":null}\n'];
const fixedCommands = ['readiness-initialize\n', 'readiness-initialized\n', 'readiness-query\n'];
const ownedCommands = ['owned-initialize\n','owned-initialized\n','owned-query\n'];
const configInitialize=JSON.stringify({id:1,method:'initialize',params:{
 clientInfo:{name:'repo-conduit-config-check',version:'0.1.0'},capabilities:{experimentalApi:true,requestAttestation:false}}})+'\n';
const configWrites=(checkCwd:string)=>[configInitialize,'{"method":"initialized"}\n',
 JSON.stringify({id:2,method:'config/read',params:{cwd:checkCwd,includeLayers:false}})+'\n'];
const configCommands=['config-initialize\n','config-initialized\n','config-read\n'];
const unknown = () => new Error('WINDOWS_OWNED_STDIO_UNKNOWN');

function writeOwnedFixtureFrame(child:WindowsJobHelperChannel,binding:OwnedStdioBinding,
 writer:OwnedWriterOrigin,frame:string):void {
  const owned=ownedChannels.get(child);
  if(!owned||owned.binding!==binding||owned.helperPid!==writer.helperPid||
    owned.writer!==writer||
    !ownedCommands.includes(frame))throw unknown();
  const result=spawnSync(windowsJobHelperPath(),['__write_owned_pipe',binding.hostScopeId,
    binding.executionInstanceId,String(writer.helperPid),writer.helperCreationFiletime,
    writer.pipeName,writer.handle,writer.deadlineUtcTicks,writer.deadlineUptimeMs],{
      shell:false,windowsHide:true,encoding:'utf8',input:frame,timeout:500,maxBuffer:2048,
      env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'},
    });
  if(result.error||result.status!==0||result.stdout!=='{"accepted":true}'||
    result.stderr!=='')throw unknown();
}

interface ConfigExpected {codexHome:string;configPath:string;modelRef:string;checkCwd:string}
/** Protocol test seam only; supplied channels never grant native launch authority. */
async function diagnoseOwnedChannel(child: WindowsJobHelperChannel, binding: OwnedStdioBinding,
  options: Options, configExpected?:ConfigExpected): Promise<{result:WindowsReadinessResult|boolean;
    root:WindowsJobRoot;closure:Closure}> {
  if (!validBinding(binding) || !record(options) || typeof options.assertDiagnosticAuthority !== 'function' ||
      Object.keys(options).some(k => !['signal', 'assertDiagnosticAuthority'].includes(k)) ||
      (binding.recipe==='desktop_config_check_v1')!==Boolean(configExpected)) throw unknown();
  const configMode=Boolean(configExpected);
  const ownedFixture=binding.recipe==='owned_pipe_fixture_v1';
  if(ownedFixture&&ownedChannels.get(child)?.binding!==binding)throw unknown();
  const writes=configMode?configWrites(configExpected!.checkCwd):fixedWrites;
  const commands=configMode?configCommands:ownedFixture?ownedCommands:fixedCommands;
  let started: Extract<OwnedStdioEvent, { kind: 'started' }> | undefined;
  let closure: Closure | undefined;
  let sequence = 1, commandPhase = 0, rawTotal = 0, nativeTotal = 0;
  let buffer = Buffer.alloc(0);
  let failed = false, closing = false, invalidAuthority = false, finished = false;
  let stdoutEof = false, stderrEof = false, rootExited = false;
  let queuedInitialize = false;
  const output = new PassThrough(), errors = new PassThrough(), exited = new EventEmitter();
  let doneResolve: () => void, doneReject: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  void done.catch(() => {});
  const authority = () => { try { return !options.signal?.aborted && options.assertDiagnosticAuthority() === true; } catch { return false; } };
  const stop = () => {
    if(ownedFixture)ownedChannels.delete(child);
    if (closing || failed || finished) return;
    closing = true; queuedInitialize = false;
    try { child.stdin.write('stop\n'); } catch { fail(); }
  };
  const deny = () => { invalidAuthority = true; stop(); exited.emit('error', unknown()); };
  const fail = () => {
    if(ownedFixture)ownedChannels.delete(child);
    if (failed || finished) return;
    failed = true; clearTimeout(deadline);
    doneReject(unknown()); exited.emit('error', unknown());
    try { child.kill(); } catch { /* Kill is not closure proof. */ }
    child.stdin.destroy();
  };
  const abort = () => { if (!finished && !failed) deny(); };
  const deadline = setTimeout(fail, 20_000);
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) {
    if (failed || closing || finished || chunk.toString('utf8') !== writes[commandPhase]) { callback(unknown()); return; }
    if (!started) {
      if (commandPhase !== 0 || queuedInitialize) { callback(unknown()); return; }
      queuedInitialize = true; callback(); return;
    }
    if (!authority()) { deny(); callback(unknown()); return; }
    try {
      if(ownedFixture){
        if(!started.writer)throw unknown();
        writeOwnedFixtureFrame(child,binding,started.writer,commands[commandPhase++]!);
        callback();return;
      }
      if(configMode && (child.stdin.writableNeedDrain || child.stdin.writableLength)){
        deny();callback(unknown());return;
      }
      const command=commands[commandPhase++]!;
      if(configMode){
        let completed=false;
        const complete=(error?:Error|null)=>{if(!completed){completed=true;callback(error??undefined);}};
        const accepted=child.stdin.write(command,complete);
        if(!accepted){deny();complete(unknown());}
      }else{child.stdin.write(command);callback();}
    } catch { fail(); callback(unknown()); }
  } });
  const protocol = configExpected
    ? runWindowsConfigProtocol({input,output,errors,exited,terminate:stop},configExpected,10_000)
    : runWindowsReadinessProtocol({ input, output, errors, exited, terminate: stop }, 10_000);
  void protocol.catch(() => {});
  child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail); child.on('error', fail);
  child.stderr.on('data', fail); // Helper stage details are not retained.
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed || finished) return;
    rawTotal += chunk.length;
    if (rawTotal > 1024 * 1024 || buffer.length + chunk.length > 32768) { fail(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    let newline: number;
    while (!failed && (newline = buffer.indexOf(10)) >= 0) {
      let line: string;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)); } catch { fail(); return; }
      buffer = buffer.subarray(newline + 1);
      const event = parseOwnedStdioEvent(line, binding, sequence++);
      if (!event || closure || (!started && event.kind !== 'started')) { fail(); return; }
      if (event.kind === 'started') {
        if (started) { fail(); return; }
        started = event;
        if(ownedFixture){
          const owned=ownedChannels.get(child);
          if(!owned||!event.writer||owned.writer){fail();return;}
          owned.writer=event.writer;
        }
        if (queuedInitialize) {
          if (closing || failed || finished || invalidAuthority) { queuedInitialize = false; continue; }
          if (!authority()) { deny(); continue; }
          queuedInitialize = false;
          if(configMode && (child.stdin.writableNeedDrain || child.stdin.writableLength)){
            deny();continue;
          }
          try{
            if(ownedFixture){
              if(!started.writer)throw unknown();
              writeOwnedFixtureFrame(child,binding,started.writer,commands[commandPhase++]!);
            }else if(!child.stdin.write(commands[commandPhase++]!) && configMode){deny();continue;}
          }catch{fail();continue;}
        }
      } else if (event.kind === 'stdout' || event.kind === 'stderr') {
        if ((event.kind === 'stdout' && stdoutEof) || (event.kind === 'stderr' && stderrEof)) { fail(); return; }
        const bytes = Buffer.from(event.dataBase64, 'base64'); nativeTotal += bytes.length;
        if (nativeTotal > 128 * 1024) { fail(); return; }
        (event.kind === 'stdout' ? output : errors).write(bytes);
      } else if (event.kind === 'stdout_eof') {
        if (stdoutEof) { fail(); return; } stdoutEof = true; output.end();
      } else if (event.kind === 'stderr_eof') {
        if (stderrEof) { fail(); return; } stderrEof = true; errors.end();
      } else if (event.kind === 'root_exit') {
        if (rootExited) { fail(); return; } rootExited = true;
      } else if (event.kind === 'job_closed') {
        if (!closing || !stdoutEof || !stderrEof || !rootExited || !started ||
            event.root.pid !== started.root.pid || event.root.creationFiletime !== started.root.creationFiletime) { fail(); return; }
        closure = event;
      }
    }
    if (buffer.length > 16384) fail();
  });
  child.on('close', (code: number | null) => {
    if(ownedFixture)ownedChannels.delete(child);
    if (failed || finished) return;
    if (code !== 0 || !closure || buffer.length) { fail(); return; }
    finished = true; clearTimeout(deadline); doneResolve(); exited.emit('close');
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const result = await protocol;
    await done;
    if (failed || invalidAuthority || !authority() || !started || !closure) throw unknown();
    return Object.freeze({result,root:started.root,closure});
  } catch {
    // Protocol rejection still awaits bounded cleanup of the owned Job; never publishes a candidate.
    stop(); await done.catch(() => {}); throw unknown();
  } finally {
    clearTimeout(deadline); options.signal?.removeEventListener('abort', abort);
    if(ownedFixture)ownedChannels.delete(child);
  }
}

export async function diagnoseOwnedReadinessChannel(child:WindowsJobHelperChannel,binding:OwnedStdioBinding,
 options:Options):Promise<OwnedReadinessResult>{
 if(binding.recipe==='desktop_config_check_v1'||binding.recipe==='owned_pipe_fixture_v1')throw unknown();
 const observed=await diagnoseOwnedChannel(child,binding,options);
 return Object.freeze({...observed.result as WindowsReadinessResult,recipe:binding.recipe,
  root:observed.root,closure:observed.closure});
}

/** A supplied helper channel only checks protocol shape; it cannot prove owned launch. */
export async function diagnoseOwnedConfigChannel(child:WindowsJobHelperChannel,binding:OwnedStdioBinding,
 expected:ConfigExpected,options:Options):Promise<{strictConfigVerified:boolean;root:WindowsJobRoot;closure:Closure}>{
 if(binding.recipe!=='desktop_config_check_v1')throw unknown();
 const observed=await diagnoseOwnedChannel(child,binding,options,expected);
 return Object.freeze({strictConfigVerified:observed.result===true,
  root:observed.root,closure:observed.closure});
}

/** Fixed owned native entry. No executable, PID, arbitrary RPC, cwd, env or connection injection. */
export async function runOwnedWindowsReadiness(recipe: OwnedReadinessRecipe, options: Options,desktopTarget?:string): Promise<OwnedReadinessResult> {
  if (process.platform !== 'win32' || !['stdio_fixture_v1', 'desktop_readiness_v1', 'owned_pipe_fixture_v1'].includes(recipe) ||
      !record(options) || typeof options.assertDiagnosticAuthority !== 'function' ||
      Object.keys(options).some(k => !['signal', 'assertDiagnosticAuthority'].includes(k))) throw unknown();
  if (options.signal?.aborted) throw unknown();
  if (options.assertDiagnosticAuthority() !== true || options.signal?.aborted) throw unknown();
  const binding: OwnedStdioBinding = Object.freeze({ recipe, hostScopeId: randomUUID(),
    executionInstanceId: randomUUID() });
  const child = spawn(windowsJobHelperPath(), [recipe, binding.hostScopeId, binding.executionInstanceId,
    ...(recipe==='desktop_readiness_v1'?[desktopTarget??resolveWindowsDesktopTarget()]:[])], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' },
  });
  if(recipe==='owned_pipe_fixture_v1'){
    if(!Number.isInteger(child.pid)||!child.pid||child.pid<1){
      child.once('error',()=>{});
      throw unknown();
    }
    ownedChannels.set(child,{binding,helperPid:child.pid,writer:null});
    const observed=await diagnoseOwnedChannel(child,binding,options);
    return Object.freeze({...observed.result as WindowsReadinessResult,recipe,
      root:observed.root,closure:observed.closure});
  }
  return diagnoseOwnedReadinessChannel(child, binding, options);
}

/** Fixed Desktop strict-config diagnostic. No model turn, login, arbitrary binary or RPC. */
export async function runOwnedWindowsConfigCheck(runtime:{root:string;home:string;
  modelRef:string;configSha256:string},options:Options,desktopTarget?:string):Promise<boolean>{
 if(process.platform!=='win32'||!record(runtime)||!record(options)||
  typeof options.assertDiagnosticAuthority!=='function'||
  Object.keys(options).some(k=>!['signal','assertDiagnosticAuthority'].includes(k))||
  options.signal?.aborted||options.assertDiagnosticAuthority()!==true)throw unknown();
 const binding:OwnedStdioBinding={recipe:'desktop_config_check_v1',hostScopeId:randomUUID(),
  executionInstanceId:randomUUID()};
 const child=spawn(windowsJobHelperPath(),[binding.recipe,binding.hostScopeId,
  binding.executionInstanceId,runtime.root,runtime.configSha256,desktopTarget??resolveWindowsDesktopTarget()],{
   shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
   env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
 const result=await diagnoseOwnedConfigChannel(child,binding,{codexHome:`${runtime.home}\\.codex`,
  configPath:`${runtime.home}\\.codex\\config.toml`,modelRef:runtime.modelRef,
  checkCwd:`${runtime.root}\\check`},options);
 return result.strictConfigVerified;
}

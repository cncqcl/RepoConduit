import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {assertPrivateInstallationDirectory} from '../../../runtime/local-security.js';
import {windowsJobHelperPath} from './windows-job-host.js';
import {resolveWindowsDesktopTarget} from './windows-desktop-target.js';
import {parsePreparedWindowsEvent,type PreparedWindowsBinding} from './windows-prepared-session.js';

interface Options {fixtureRoot:string;maxWallSeconds:number;signal?:AbortSignal}
interface Terminal {stopWriteSucceeded:boolean;stdoutEnded:boolean;stderrEnded:boolean;
 stderrEmpty:boolean;exitCode:number|null}
export interface WindowsPrepareOnlyComponent {
 readonly kind:'windows_prepare_only_component_v1';readonly protocol:'windows_job_stdio_v1';
 readonly helperVersion:'3';readonly recipe:'windows_app_server_readonly_v1';
 readonly hostScopeId:string;readonly executionInstanceId:string;
 readonly helper:{readonly pid:number;readonly creationFiletime:string};
 readonly prepared:{readonly kind:'prepared';readonly sequence:1;readonly childPresent:false};
 readonly preparedClosed:{readonly kind:'prepared_closed';readonly sequence:2;readonly childPresent:false;
  readonly members:{readonly complete:true;readonly assigned:0;readonly listed:0;readonly pids:readonly []}};
 readonly helperExitCode:0;
}
const unknown=()=>new Error('WINDOWS_PREPARE_ONLY_UNKNOWN');
const recipe='windows_app_server_readonly_v1' as const;

/** Pure transcript validation, not provenance, a saved launch fact, or production qualification. */
export function parseWindowsPrepareOnlyTranscript(lines:readonly string[],binding:PreparedWindowsBinding,
 actualHelperPid:number,terminal:Terminal):WindowsPrepareOnlyComponent|null{
 if(lines.length!==2||binding.recipe!==recipe||terminal.stopWriteSucceeded!==true||terminal.stdoutEnded!==true||
  terminal.stderrEnded!==true||terminal.stderrEmpty!==true||terminal.exitCode!==0)return null;
 const first=parsePreparedWindowsEvent(lines[0]!,binding,1);
 const last=parsePreparedWindowsEvent(lines[1]!,binding,2);
 if(first?.kind!=='prepared'||last?.kind!=='prepared_closed'||first.writer.helperPid!==actualHelperPid)return null;
 return Object.freeze({kind:'windows_prepare_only_component_v1',protocol:'windows_job_stdio_v1',
  helperVersion:'3',recipe,hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId,
  helper:Object.freeze({pid:actualHelperPid,creationFiletime:first.writer.helperCreationFiletime}),
  prepared:Object.freeze({kind:'prepared',sequence:1,childPresent:false}),
  preparedClosed:Object.freeze({kind:'prepared_closed',sequence:2,childPresent:false,members:last.members}),
  helperExitCode:0});
}

function fixturePaths(root:string){
 if(root!==resolve(root))throw unknown();
 const runtime=join(root,'runtime'),source=join(root,'source');
 const config=join(runtime,'home','.codex','config.toml');
 const expected:Record<string,string[]>={
  '':['runtime','source'],runtime:['AppDataLocal','AppDataRoaming','check','home','temp'],
  'runtime/home':['.codex'],'runtime/home/.codex':['config.toml'],
  'runtime/AppDataLocal':[],'runtime/AppDataRoaming':[],'runtime/temp':[],
  'runtime/check':[],source:['README.md']};
 for(const [relative,names] of Object.entries(expected)){
  const directory=join(root,relative),s=lstatSync(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||realpathSync.native(directory).toLowerCase()!==directory.toLowerCase()||
   readdirSync(directory).sort().join(',')!==names.sort().join(','))throw unknown();
 }
 // Reject junctions in every ancestor before entering the fixed native recipe.
 for(let p=root;;p=dirname(p)){
  const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||
   realpathSync.native(p).toLowerCase()!==p.toLowerCase())throw unknown();
  if(dirname(p)===p)break;
 }
 assertPrivateInstallationDirectory(root,config);
 const read=(path:string,expectedText:string)=>{
  const s=lstatSync(path);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==Buffer.byteLength(expectedText))throw unknown();
  const bytes=readFileSync(path);if(bytes.toString('utf8')!==expectedText)throw unknown();return bytes;
 };
 const bytes=read(config,'# RepoConduit prepare-only synthetic fixture\n');
 read(join(source,'README.md'),'RepoConduit prepare-only synthetic source\n');
 return {runtime,source,configSha256:createHash('sha256').update(bytes).digest('hex')};
}

/** Fixed synthetic prepare -> stop only; never exposes start, send, a writer or launch authority. */
export async function observeWindowsPrepareOnly(options:Options):Promise<WindowsPrepareOnlyComponent &
 {readonly configSha256:string}>{
 if(process.platform!=='win32'||!options||typeof options!=='object'||Array.isArray(options)||
  Object.keys(options).some(k=>!['fixtureRoot','maxWallSeconds','signal'].includes(k))||
  typeof options.fixtureRoot!=='string'||!Number.isSafeInteger(options.maxWallSeconds)||
  options.maxWallSeconds<1||options.maxWallSeconds>600||
  (options.signal!==undefined&&!(options.signal instanceof AbortSignal))||options.signal?.aborted)throw unknown();
 options=Object.freeze({...options});
 const budget=options.maxWallSeconds*1000,mono=performance.now(),deadline=Date.now()+budget;
 const remaining=()=>Math.min(deadline-Date.now(),budget-(performance.now()-mono));
 let paths:ReturnType<typeof fixturePaths>,binary:string,desktopTarget:string;
 try{
  paths=fixturePaths(options.fixtureRoot);binary=windowsJobHelperPath();
  desktopTarget=resolveWindowsDesktopTarget();
 }catch{throw unknown();}
 if(options.signal?.aborted||remaining()<=0)throw unknown();
 const binding:PreparedWindowsBinding=Object.freeze({recipe,hostScopeId:randomUUID(),executionInstanceId:randomUUID()});
 const child=spawn(binary,[recipe,binding.hostScopeId,binding.executionInstanceId,paths.runtime,
  paths.configSha256,paths.source,String(Math.max(1,Math.ceil(remaining()/1000))),desktopTarget],
 {shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
  env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
 return new Promise((resolveObservation,reject)=>{
  let partial=Buffer.alloc(0),total=0,failed=false,settled=false,stopSent=false;
  const lines:string[]=[];
  const terminal:Terminal={stopWriteSucceeded:false,stdoutEnded:false,stderrEnded:false,
   stderrEmpty:true,exitCode:null};
  let cleanupTimer:NodeJS.Timeout|undefined;
  const stop=()=>{
   if(stopSent)return;stopSent=true;
   try{child.stdin.end('stop\n',(error?:Error|null)=>{
    if(error){fail();return;}terminal.stopWriteSucceeded=true;
   });}catch{fail();}
  };
  const fail=()=>{
   if(settled)return;failed=true;stop();
   if(!cleanupTimer)cleanupTimer=setTimeout(()=>{
    settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',fail);
    try{child.kill();}catch{/* Killing is not evidence of closure. */}
    // Release our handles even if the helper's termination remains unknown.
    for(const stream of [child.stdin,child.stdout,child.stderr]){
     try{stream.destroy();}catch{/* Termination remains unknown. */}
    }
    try{child.unref();}catch{/* Termination remains unknown. */}
    reject(unknown());
   },5000);
  };
  const timer=setTimeout(fail,Math.max(1,Math.ceil(remaining())));
  child.on('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);
  child.stderr.on('data',()=>{terminal.stderrEmpty=false;fail();});
  child.stdout.on('end',()=>{terminal.stdoutEnded=true;});
  child.stderr.on('end',()=>{terminal.stderrEnded=true;});
  child.stdout.on('data',(bytes:Buffer)=>{
   if(failed||settled)return;
   total+=bytes.length;
   if(total>32768){fail();return;}
   partial=Buffer.concat([partial,bytes]);
   for(let end;(end=partial.indexOf(10))>=0;){
    let line:string;
    try{line=new TextDecoder('utf-8',{fatal:true}).decode(partial.subarray(0,end));}catch{fail();return;}
    partial=partial.subarray(end+1);
    const event=parsePreparedWindowsEvent(line,binding,lines.length+1);
    if(!event||lines.length>=2||
     (lines.length===0&&(event.kind!=='prepared'||event.writer.helperPid!==child.pid))||
     (lines.length===1&&(!stopSent||event.kind!=='prepared_closed'))){fail();return;}
    lines.push(line);if(lines.length===1)stop();
   }
   if(partial.length>16384)fail();
  });
  child.on('close',(code:number|null)=>{
   clearTimeout(timer);if(cleanupTimer)clearTimeout(cleanupTimer);
   options.signal?.removeEventListener('abort',fail);
   if(settled)return;settled=true;terminal.exitCode=code;
   const value=!failed&&!partial.length&&remaining()>0&&!options.signal?.aborted&&child.pid!==undefined?
    parseWindowsPrepareOnlyTranscript(lines,binding,child.pid,terminal):null;
   if(value)resolveObservation(Object.freeze({...value,configSha256:paths.configSha256}));else reject(unknown());
  });
  options.signal?.addEventListener('abort',fail,{once:true});
  if(options.signal?.aborted)fail();
 });
}

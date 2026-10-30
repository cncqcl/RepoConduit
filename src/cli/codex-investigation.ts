import {isAbsolute,join} from 'node:path';
import {SqliteStore} from '../adapters/storage/sqlite.js';
import {authorize} from '../core/policy/authorize.js';
import {openApplicationWithinInstallation} from '../runtime/application.js';
import {assertActiveInstallation,type InstallationRuntime} from '../runtime/installation.js';
import {loadAuthorizedWindowsRuntimeSource,loadWindowsInvestigatorModelRuntime}
 from '../runtime/windows-investigation-runtime-config.js';
import type {PersonalCodexInvestigatorConfiguration,PersonalCodexDiagnostic} from '../runtime/codex-owned-investigation.js';

type LocalIdentity={principal:string;audience:string;recipient:string};
const unavailable=()=>new Error('NOT_AVAILABLE');
const validName=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
type RuntimeSource={dataDirectory:string;workspaceId:string;profileRevision:string};
type RuntimeSelection=PersonalCodexInvestigatorConfiguration & {runtimeSource?:RuntimeSource};
function source(value:unknown):RuntimeSource{
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!=='dataDirectory,profileRevision,workspaceId')throw unavailable();
 const entry=value as Record<string,unknown>;
 if(typeof entry.dataDirectory!=='string'||!isAbsolute(entry.dataDirectory)||
  !validName(entry.workspaceId)||!validName(entry.profileRevision))throw unavailable();
 return {dataDirectory:entry.dataDirectory,workspaceId:entry.workspaceId,profileRevision:entry.profileRevision};
}
function selection(value:unknown):RuntimeSelection{
 if(!value||typeof value!=='object'||Array.isArray(value)||
  !['profileRevision,workspaceId','profileRevision,runtimeSource,workspaceId'].includes(
   Object.keys(value).sort().join(',')))throw unavailable();
 const entry=value as Record<string,unknown>;
 if(!validName(entry.workspaceId)||!validName(entry.profileRevision))throw unavailable();
 return {workspaceId:entry.workspaceId,profileRevision:entry.profileRevision,
  ...('runtimeSource' in entry?{runtimeSource:source(entry.runtimeSource)}:{})};
}

/** Native selection is local argv only. External command envelopes never carry it. */
export function parseCodexStartupArguments(argv:readonly string[]):{
 argv:readonly string[];selection?:RuntimeSelection;managed?:true
}{
 const remaining=argv.slice(0,3);let workspaceId:string|undefined,profileRevision:string|undefined;
 let selected=false;let sourceDirectory:string|undefined,sourceWorkspace:string|undefined,sourceProfile:string|undefined;
 let managed=false;
 for(let i=3;i<argv.length;i++){
  const flag=argv[i];
  if(flag==='--codex-managed'){
   if(managed||(argv[2]!=='mcp'&&argv[2]!=='serve-http'))throw unavailable();
   managed=true;continue;
  }
  if(!['--codex-workspace','--codex-profile','--codex-runtime-data-dir',
   '--codex-runtime-workspace','--codex-runtime-profile'].includes(flag!)){remaining.push(flag!);continue;}
  if(argv[2]!=='mcp'&&argv[2]!=='serve-http')throw unavailable();
  selected=true;const value=argv[++i];
  if(flag==='--codex-runtime-data-dir'){
   if(sourceDirectory!==undefined||typeof value!=='string'||!isAbsolute(value))throw unavailable();
   sourceDirectory=value;continue;
  }
  if(!validName(value))throw unavailable();
  if(flag==='--codex-workspace'){
   if(workspaceId!==undefined)throw unavailable();workspaceId=value;
  }else if(flag==='--codex-profile'){
   if(profileRevision!==undefined)throw unavailable();profileRevision=value;
  }else if(flag==='--codex-runtime-workspace'){
   if(sourceWorkspace!==undefined)throw unavailable();sourceWorkspace=value;
  }else{if(sourceProfile!==undefined)throw unavailable();sourceProfile=value;}
 }
 if(!selected){if(managed)throw unavailable();return {argv:remaining};}
 if(managed&&argv[2]==='mcp'&&remaining.length!==3)throw unavailable();
 if([sourceDirectory,sourceWorkspace,sourceProfile].some(v=>v!==undefined)&&
  [sourceDirectory,sourceWorkspace,sourceProfile].some(v=>v===undefined))throw unavailable();
 return {argv:remaining,selection:selection({workspaceId,profileRevision,
  ...(sourceDirectory?{runtimeSource:{dataDirectory:sourceDirectory,
   workspaceId:sourceWorkspace,profileRevision:sourceProfile}}:{})}),...(managed?{managed:true as const}:{})};
}

/** Selection grants no external permissions and never creates a runtime or reads auth contents. */
export function authorizeCodexSelection(runtime:InstallationRuntime,identity:LocalIdentity,
 input:unknown,boundWorkspaceId?:string):RuntimeSelection{
 assertActiveInstallation(runtime);
 const chosen=selection(input);
 if(boundWorkspaceId!==undefined&&chosen.workspaceId!==boundWorkspaceId)throw unavailable();
 if(chosen.runtimeSource){
  try{loadAuthorizedWindowsRuntimeSource(runtime.dataDirectory,
   {workspaceId:chosen.workspaceId,profileRevision:chosen.profileRevision},
   chosen.runtimeSource,identity);}catch{throw unavailable();}
  return chosen;
 }
 const store=new SqliteStore(join(runtime.dataDirectory,'state.sqlite'));
 try{
  authorize({...identity,surface:'local_admin',now:new Date()},'admin.configure_profile',
   {workspaceId:'management'},store.grantsFor(identity.principal,identity.audience));
  const profile=store.getCurrentProfileRevision(chosen.workspaceId);
  if(!store.getWorkspace(chosen.workspaceId)||profile?.id!==chosen.profileRevision||
   profile.presetRef!=='static_readonly_v1')throw unavailable();
  try{loadWindowsInvestigatorModelRuntime(runtime.dataDirectory,
   chosen.workspaceId,chosen.profileRevision);}
  catch{throw unavailable();}
  return chosen;
 }finally{store.close();}
}

async function closeApplication(app:ReturnType<typeof openApplicationWithinInstallation>,primary:unknown){
 try{await app.close();}
 catch(error){throw new AggregateError(primary?[primary,error]:[error],
  'CLI Codex cleanup unconfirmed',{cause:error});}
}

/** One explicitly selected queued request. No queue scan, request creation or automatic retry. */
export async function runCodexInvestigationCommand(runtime:InstallationRuntime,identity:LocalIdentity,input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input)||
  !['profileRevision,requestId,workspaceId','profileRevision,requestId,runtimeSource,workspaceId']
   .includes(Object.keys(input).sort().join(',')))throw unavailable();
 const entry=input as Record<string,unknown>;
 if(!validName(entry.requestId))throw unavailable();
 const chosen=authorizeCodexSelection(runtime,identity,
  {workspaceId:entry.workspaceId,profileRevision:entry.profileRevision,
   ...('runtimeSource' in entry?{runtimeSource:entry.runtimeSource}:{})});
 let diagnostic:PersonalCodexDiagnostic|undefined;
 const app=openApplicationWithinInstallation(runtime,{codexInvestigator:chosen,
  onCodexDiagnostic(value){if(value.requestId===entry.requestId)diagnostic=structuredClone(value);}});
 // A local signal stops only this owned attempt. It does not impersonate the external cancel actor.
 const stop=()=>{try{void Promise.resolve(app.close()).catch(()=>undefined);}catch{/* Await close below. */}};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let primary:unknown;
 try{
  await app.ready;
  const record=await app.runCodexInvestigation(entry.requestId);
  if(!record)throw unavailable();
  return {requestId:record.id,state:record.state,hasResult:record.result!==null,...(diagnostic?{diagnostic}:{})};
 }catch(error){primary=error;throw error;}
 finally{
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  await closeApplication(app,primary);
 }
}

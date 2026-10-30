import {join} from 'node:path';
import {SqliteStore} from '../adapters/storage/sqlite.js';
import {authorize} from '../core/policy/authorize.js';
import {openApplicationWithinInstallation} from '../runtime/application.js';
import {assertActiveInstallation,type InstallationRuntime} from '../runtime/installation.js';
import type {PersonalClaudeConfiguration,PersonalClaudeDiagnostic} from '../runtime/claude-personal-investigation.js';

type LocalIdentity={principal:string;audience:string;recipient:string};
const unavailable=()=>new Error('NOT_AVAILABLE');
const name=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
function selection(value:unknown):PersonalClaudeConfiguration{
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!=='profileRevision,workspaceId')throw unavailable();
 const input=value as Record<string,unknown>;
 if(!name(input.workspaceId)||!name(input.profileRevision))throw unavailable();
 return {workspaceId:input.workspaceId,profileRevision:input.profileRevision};
}

/** Local native selection is distinct from the agent-neutral external request. */
export function parseClaudeStartupArguments(raw:readonly string[]):{argv:readonly string[];selection?:PersonalClaudeConfiguration}{
 const argv=raw.slice(0,3);let workspaceId:string|undefined,profileRevision:string|undefined;
 for(let i=3;i<raw.length;i++){
  const flag=raw[i]!;
  if(flag!=='--claude-workspace'&&flag!=='--claude-profile'){argv.push(flag);continue;}
  if(raw[2]!=='mcp')throw unavailable();
  const value=raw[++i];if(!name(value))throw unavailable();
  if(flag==='--claude-workspace'){if(workspaceId!==undefined)throw unavailable();workspaceId=value;}
  else{if(profileRevision!==undefined)throw unavailable();profileRevision=value;}
 }
 if(workspaceId===undefined&&profileRevision===undefined)return {argv};
 return {argv,selection:selection({workspaceId,profileRevision})};
}

export function authorizeClaudeSelection(runtime:InstallationRuntime,identity:LocalIdentity,input:unknown,boundWorkspaceId?:string){
 assertActiveInstallation(runtime);
 const chosen=selection(input);
 if(boundWorkspaceId!==undefined&&chosen.workspaceId!==boundWorkspaceId)throw unavailable();
 const store=new SqliteStore(join(runtime.dataDirectory,'state.sqlite'));
 try{
  authorize({...identity,surface:'local_admin',now:new Date()},'admin.configure_profile',
   {workspaceId:'management'},store.grantsFor(identity.principal,identity.audience));
  const profile=store.getCurrentProfileRevision(chosen.workspaceId);
  if(!store.getWorkspace(chosen.workspaceId)||profile?.id!==chosen.profileRevision||profile.presetRef!=='static_readonly_v1')throw unavailable();
  return chosen;
 }finally{store.close();}
}

async function closeApplication(app:ReturnType<typeof openApplicationWithinInstallation>,primary:unknown){
 try{await app.close();}
 catch(error){throw new AggregateError(primary?[primary,error]:[error],'Claude CLI cleanup unconfirmed',{cause:error});}
}

/** Run exactly the selected queued request; no scans, retries, account changes or implicit login. */
export async function runClaudeInvestigationCommand(runtime:InstallationRuntime,identity:LocalIdentity,input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input)||
  Object.keys(input).sort().join(',')!=='profileRevision,requestId,workspaceId')throw unavailable();
 const entry=input as Record<string,unknown>;
 if(!name(entry.requestId))throw unavailable();
 const chosen=authorizeClaudeSelection(runtime,identity,{workspaceId:entry.workspaceId,profileRevision:entry.profileRevision});
 let diagnostic:PersonalClaudeDiagnostic|undefined;
 const app=openApplicationWithinInstallation(runtime,{claudeInvestigator:chosen,onClaudeDiagnostic(value){diagnostic=value;}});
 const stop=()=>{try{void Promise.resolve(app.close()).catch(()=>undefined);}catch{/* Finally awaits owned shutdown. */}};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let primary:unknown;
 try{
  await app.ready;
  const record=await app.runClaudeInvestigation(entry.requestId);if(!record)throw unavailable();
  return {requestId:record.id,state:record.state,hasResult:record.result!==null,...(diagnostic?{diagnostic}:{})};
 }catch(error){primary=error;throw error;}
 finally{
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  await closeApplication(app,primary);
 }
}

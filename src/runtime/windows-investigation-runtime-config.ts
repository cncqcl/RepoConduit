import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,
 readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {hostname,userInfo} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import type {SqliteStore} from '../adapters/storage/sqlite.js';
import type {InvestigationClaim,SqliteInvestigationStore} from
 '../adapters/storage/investigation-sqlite.js';
import {buildInvestigationSourcePlan} from '../application/investigation-source-plan.js';
import {WINDOWS_DESKTOP_CODEX} from
 '../adapters/codex/investigator/windows-preflight.js';
import {resolveWindowsDesktopTarget,desktopVersionMatches} from '../adapters/codex/investigator/windows-desktop-target.js';
import {WINDOWS_CODEX_PROTOCOL_TARGET} from './codex-model-investigation.js';
import {WINDOWS_LAST_APP_SERVER_PROTOCOL_TARGET,
 WINDOWS_PREVIOUS_0163_APP_SERVER_PROTOCOL_TARGET,WINDOWS_LAST_0163_APP_SERVER_PROTOCOL_TARGET} from '../adapters/codex/investigator/windows-launch-record.js';
import {runOwnedWindowsConfigCheck} from '../adapters/codex/investigator/windows-job-stdio.js';
import {assertPrivateDataDirectory,assertPrivateInstallationDirectory,assertPrivateInstallationBatch,
 assertPrivateRuntimeSourceBatch,
 protectNewDataDirectory} from './local-security.js';
import {authorize,type Grant,type RequestContext} from '../core/policy/authorize.js';

const recipe='windows_app_server_readonly_v1' as const;
const featureNames=['shell_tool','multi_agent','multi_agent_v2','plugins','apps'] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const unavailable=()=>new Error('NOT_AVAILABLE');

export interface WindowsRuntimeInput {workspaceId:string;profileRevision:string;modelRef:string}
export interface WindowsRuntimeCheckInput {workspaceId:string;runtimeId:string;profileRevision:string}
export interface WindowsRuntimeRecord extends WindowsRuntimeInput {
 kind:'windows_investigation_runtime_v1';runtimeId:string;recipe:typeof recipe;
 protocolTarget:typeof WINDOWS_CODEX_PROTOCOL_TARGET|typeof WINDOWS_LAST_APP_SERVER_PROTOCOL_TARGET|
  typeof WINDOWS_PREVIOUS_0163_APP_SERVER_PROTOCOL_TARGET|typeof WINDOWS_LAST_0163_APP_SERVER_PROTOCOL_TARGET;configSha256:string;
}
export interface WindowsRuntimePrepared extends WindowsRuntimeRecord {
 root:string;home:string;productionAvailable:false;
}

function exact(value:unknown,keys:string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')===keys.sort().join(',');
}
function validName(value:unknown):value is string{
 return typeof value==='string'&&safeName.test(value)&&value!=='.'&&value!=='..';
}
function normalize(path:string){return process.platform==='win32'?path.toLowerCase():path;}
function directoryShape(path:string){
 const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||normalize(realpathSync.native(path))!==normalize(resolve(path)))
  throw unavailable();
}
function safeDirectory(path:string){
 directoryShape(path);
 assertPrivateInstallationDirectory(path);
}
function makeDirectory(path:string){
 if(existsSync(path)) throw unavailable();
 mkdirSync(path,{mode:0o700});
 protectNewDataDirectory(path);
 safeDirectory(path);
}
function paths(root:string,workspaceId:string,revisionId:string){
 const parent=join(root,'windows-investigators');
 const slot=createHash('sha256').update(JSON.stringify([workspaceId,revisionId])).digest('hex');
 const runtime=join(parent,slot);
 const home=join(runtime,'home');
 return {parent,runtime,home,codexHome:join(home,'.codex'),
  appLocal:join(runtime,'AppDataLocal'),appRoaming:join(runtime,'AppDataRoaming'),
  temp:join(runtime,'temp'),check:join(runtime,'check')};
}
function config(modelRef:string){
 return `model = "${modelRef}"\napproval_policy = "never"\ncli_auth_credentials_store = "file"\n`+
  `default_permissions = "rcac_static"\nweb_search = "disabled"\n`+
  `check_for_update_on_startup = false\nproject_doc_max_bytes = 0\n\n`+
  `[permissions.rcac_static.filesystem]\n":root" = "none"\n":minimal" = "read"\n`+
  `[permissions.rcac_static.network]\nenabled = false\n\n[features]\n`+
  `shell_tool = false\nmulti_agent = false\nmulti_agent_v2 = false\n`+
  `plugins = false\napps = false\nskip_host_skill_discovery = true\n`;
}
function freshAuthority(store:SqliteStore,context:RequestContext,workspaceId:string,revisionId:string){
 authorize({...context,now:new Date()},'admin.configure_profile',{workspaceId:'management'},
  store.grantsFor(context.principal,context.audience));
 if(!store.getWorkspace(workspaceId)) throw unavailable();
 const revision=store.getProfileRevision(workspaceId,revisionId);
 if(!revision||revision.presetRef!=='static_readonly_v1'||
  store.getCurrentProfileRevision(workspaceId)?.id!==revision.id) throw unavailable();
}
function authority(root:string,store:SqliteStore,context:RequestContext,workspaceId:string,revisionId:string){
 assertPrivateDataDirectory(root);
 freshAuthority(store,context,workspaceId,revisionId);
}
function fileBytes(path:string){
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||normalize(realpathSync.native(path))!==normalize(resolve(path)))
  throw unavailable();
 return readFileSync(path);
}
function runtimeChecks(root:string,p:ReturnType<typeof paths>){
 const directories=[root,p.parent,p.runtime,p.home,p.codexHome,p.appLocal,p.appRoaming,p.temp,p.check];
 return [...directories.map(directory=>({directory})),
  {directory:p.runtime,file:join(p.runtime,'runtime.json')},
  {directory:p.codexHome,file:join(p.codexHome,'config.toml')}];
}
function runtimeShape(root:string,p:ReturnType<typeof paths>){
 const directories=[root,p.parent,p.runtime,p.home,p.codexHome,p.appLocal,p.appRoaming,p.temp,p.check];
 for(const dir of directories) directoryShape(dir);
}
function readRecordContent(p:ReturnType<typeof paths>,workspaceId:string,revisionId:string,
 allowOfficialLogin=false):WindowsRuntimePrepared{
 if(readdirSync(p.check).length!==0) throw unavailable();
 if(!allowOfficialLogin&&readdirSync(p.codexHome).some(name=>name.toLowerCase()==='auth.json')) throw unavailable();
 const raw=fileBytes(join(p.runtime,'runtime.json'));
 if(raw.length>8192) throw unavailable();
 let parsed:unknown;
 try{parsed=JSON.parse(raw.toString('utf8'));}catch{throw unavailable();}
 if(!exact(parsed,['kind','runtimeId','workspaceId','profileRevision','modelRef','recipe',
  'protocolTarget','configSha256'])) throw unavailable();
 const saved=parsed as unknown as WindowsRuntimeRecord;
 if(saved.kind!=='windows_investigation_runtime_v1'||!uuid.test(saved.runtimeId)||
  saved.workspaceId!==workspaceId||saved.profileRevision!==revisionId||
  !validName(saved.workspaceId)||!validName(saved.profileRevision)||!validName(saved.modelRef)||
  saved.recipe!==recipe||
  (saved.protocolTarget!==WINDOWS_CODEX_PROTOCOL_TARGET&&
   (!allowOfficialLogin||
    (saved.protocolTarget!==WINDOWS_LAST_APP_SERVER_PROTOCOL_TARGET&&
     saved.protocolTarget!==WINDOWS_PREVIOUS_0163_APP_SERVER_PROTOCOL_TARGET&&
     saved.protocolTarget!==WINDOWS_LAST_0163_APP_SERVER_PROTOCOL_TARGET)))||
  typeof saved.configSha256!=='string'||!/^[0-9a-f]{64}$/.test(saved.configSha256)) throw unavailable();
 const actual=fileBytes(join(p.codexHome,'config.toml'));
 if(actual.toString('utf8')!==config(saved.modelRef)||
  createHash('sha256').update(actual).digest('hex')!==saved.configSha256) throw unavailable();
 return {...saved,root:p.runtime,home:p.home,productionAvailable:false};
}
function readRecord(root:string,workspaceId:string,revisionId:string,allowOfficialLogin=false):WindowsRuntimePrepared{
 const p=paths(root,workspaceId,revisionId);
 runtimeShape(root,p);
 assertPrivateInstallationBatch(runtimeChecks(root,p));
 return readRecordContent(p,workspaceId,revisionId,allowOfficialLogin);
}

/** Load the exact current or immediately prior personal configuration. The prior
 * target identifies slot creation, not the executable/codec for a new attempt.
 * Full recipe/config validation remains mandatory; metadata and auth are never rewritten. */
export function loadWindowsInvestigatorModelRuntime(root:string,workspaceId:string,profileRevision:string):WindowsRuntimePrepared {
 if(!validName(workspaceId)||!validName(profileRevision))throw unavailable();
 return readRecord(root,workspaceId,profileRevision,true);
}

type RuntimeSourceSelection={dataDirectory:string;workspaceId:string;profileRevision:string};
type RuntimeTargetSelection={workspaceId:string;profileRevision:string};
type LocalRuntimeIdentity={principal:string;audience:string;recipient:string};
const localRuntimeIdentity=():LocalRuntimeIdentity=>{
 const principal=`${hostname()}\\${userInfo().username}`;
 return {principal,audience:'local-os',recipient:principal};
};
function canonicalRootShape(root:string){
 if(typeof root!=='string'||!root||resolve(root)!==root||
  !lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink()||
  normalize(realpathSync.native(root))!==normalize(root))throw unavailable();
}
function readValidatedLocalRuntimeProfile(root:string,selection:RuntimeTargetSelection,
 identity:LocalRuntimeIdentity){
 const db=new DatabaseSync(join(root,'state.sqlite'),{readOnly:true});
 try{
  const rows=db.prepare(`SELECT id,principal,audience,workspace_id,collaboration_id,recipient,
    permissions_json,data_paths_json,expires_at,revoked_at FROM grants
    WHERE principal=? AND audience=?`).all(identity.principal,identity.audience) as Array<{
     id:string;principal:string;audience:string;workspace_id:string;collaboration_id:string|null;
     recipient:string|null;permissions_json:string;data_paths_json:string|null;
     expires_at:string|null;revoked_at:string|null}>;
  const grants:Grant[]=rows.map(row=>{
   const permissions:unknown=JSON.parse(row.permissions_json);
   const dataPaths:unknown=row.data_paths_json?JSON.parse(row.data_paths_json):undefined;
   if(!Array.isArray(permissions)||!permissions.every(item=>typeof item==='string')||
    (dataPaths!==undefined&&(!Array.isArray(dataPaths)||
     !dataPaths.every(item=>typeof item==='string'))))throw unavailable();
   return {id:row.id,principal:row.principal,audience:row.audience,workspaceId:row.workspace_id,
    ...(row.collaboration_id?{collaborationId:row.collaboration_id}:{}),
    ...(row.recipient?{recipient:row.recipient}:{}),permissions,
    ...(dataPaths?{dataPaths}:{}),expiresAt:row.expires_at,revokedAt:row.revoked_at};
  });
  authorize({...identity,surface:'local_admin',now:new Date()},'admin.configure_profile',
   {workspaceId:'management'},grants);
  const workspace=db.prepare('SELECT id FROM workspaces WHERE id=?').get(selection.workspaceId);
  const row=db.prepare(`SELECT r.revision_json FROM profile_heads h JOIN profile_revisions r
    ON r.id=h.revision_id WHERE h.workspace_id=?`).get(selection.workspaceId) as
    {revision_json:string}|undefined;
  const profile=row?JSON.parse(row.revision_json) as Record<string,unknown>:null;
  if(!workspace||!profile||profile.workspaceId!==selection.workspaceId||
   profile.id!==selection.profileRevision||profile.presetRef!=='static_readonly_v1'||
   !profile.budget||typeof profile.budget!=='object')throw unavailable();
  return profile;
 }finally{db.close();}
}

/** Recheck both local authorities immediately before a sourced native launch. Reads no auth content. */
export function loadAuthorizedWindowsRuntimeSource(targetRoot:string,target:RuntimeTargetSelection,
 source:RuntimeSourceSelection,identity:LocalRuntimeIdentity=localRuntimeIdentity()):WindowsRuntimePrepared{
 if(!target||!source||!validName(target.workspaceId)||!validName(target.profileRevision)||
  !validName(source.workspaceId)||!validName(source.profileRevision))throw unavailable();
 canonicalRootShape(targetRoot);
 canonicalRootShape(source.dataDirectory);
 const p=paths(source.dataDirectory,source.workspaceId,source.profileRevision);
 runtimeShape(source.dataDirectory,p);
 assertPrivateRuntimeSourceBatch([targetRoot,source.dataDirectory],runtimeChecks(source.dataDirectory,p));
 const targetProfile=readValidatedLocalRuntimeProfile(targetRoot,target,identity);
 const sourceProfile=readValidatedLocalRuntimeProfile(source.dataDirectory,source,identity);
 // The source authorizes selection of its fixed logged-in runtime. Execution is
 // bounded by the target's current trusted profile, frozen request and owner.
 if(sourceProfile.presetRef!==targetProfile.presetRef)throw unavailable();
 return readRecordContent(p,source.workspaceId,source.profileRevision,true);
}
function writeNew(path:string,bytes:string){
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}

/** Only prepares an inert private configuration. This never qualifies native isolation.
 * Slots are create-only and new slots record the current target. Model reuse of
 * the exact immediately prior configuration is read-only; no slot is migrated. */
export function prepareWindowsInvestigatorRuntime(root:string,store:SqliteStore,
 context:RequestContext,input:WindowsRuntimeInput):WindowsRuntimePrepared{
 if(!exact(input,['workspaceId','profileRevision','modelRef'])||!validName(input.workspaceId)||
  !validName(input.profileRevision)||!validName(input.modelRef)) throw unavailable();
 authority(root,store,context,input.workspaceId,input.profileRevision);
 safeDirectory(root);
 const parent=join(root,'windows-investigators');
 if(!existsSync(parent)) makeDirectory(parent);else safeDirectory(parent);
 const runtimeId=randomUUID();const p=paths(root,input.workspaceId,input.profileRevision);
 if(existsSync(p.runtime)) throw unavailable();
 for(const dir of [p.runtime,p.home,p.codexHome,p.appLocal,p.appRoaming,p.temp,p.check])
  makeDirectory(dir);
 const bytes=config(input.modelRef);
 writeNew(join(p.codexHome,'config.toml'),bytes);
 const saved:WindowsRuntimeRecord={kind:'windows_investigation_runtime_v1',runtimeId,
  workspaceId:input.workspaceId,profileRevision:input.profileRevision,modelRef:input.modelRef,
  recipe,protocolTarget:WINDOWS_CODEX_PROTOCOL_TARGET,
  configSha256:createHash('sha256').update(bytes).digest('hex')};
 authority(root,store,context,input.workspaceId,input.profileRevision);
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 writeNew(join(p.runtime,'runtime.json'),JSON.stringify(saved));
 const prepared=readRecord(root,input.workspaceId,input.profileRevision);
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 return prepared;
}

export interface WindowsRuntimeCheck {
 runtimeId:string;configParseObserved:boolean;featureFlagsMatch:boolean;
 versionMatch:boolean;failureCause:'none'|'version'|'features'|'configuration'|'strict_config';
 isolationVerified:false;modelTurn:'not_run';productionAvailable:false;
 strictConfigVerified:boolean;authentication:'not_verified';
}
export type WindowsDiagnosticRunner=(command:{executable:string;args:readonly string[];
 cwd:string;env:Record<string,string>})=>{status:number|null;stdout:string;error?:unknown};

/** Fixed zero-model diagnostics; never reads auth.json or inherits caller credentials. */
export function checkWindowsInvestigatorRuntime(root:string,store:SqliteStore,
 context:RequestContext,input:WindowsRuntimeCheckInput,
 diagnosticRunner?:WindowsDiagnosticRunner):WindowsRuntimeCheck{
 if(!exact(input,['workspaceId','runtimeId','profileRevision'])||!validName(input.workspaceId)||
  !validName(input.profileRevision)||typeof input.runtimeId!=='string'||!uuid.test(input.runtimeId))
  throw unavailable();
 authority(root,store,context,input.workspaceId,input.profileRevision);
 const saved=readRecord(root,input.workspaceId,input.profileRevision);
 if(saved.runtimeId!==input.runtimeId) throw unavailable();
 const recheck=()=>{
  authority(root,store,context,input.workspaceId,input.profileRevision);
  const current=readRecord(root,input.workspaceId,input.profileRevision);
  if(current.runtimeId!==saved.runtimeId||current.configSha256!==saved.configSha256||
   current.modelRef!==saved.modelRef) throw unavailable();
  freshAuthority(store,context,input.workspaceId,input.profileRevision);
 };
 const p=paths(root,input.workspaceId,input.profileRevision);
 const env={SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
  HOME:p.home,USERPROFILE:p.home,CODEX_HOME:p.codexHome,APPDATA:p.appRoaming,
  LOCALAPPDATA:p.appLocal,TEMP:p.temp,TMP:p.temp};
 const base={runtimeId:saved.runtimeId,configParseObserved:false,featureFlagsMatch:false,
  versionMatch:false,failureCause:'version' as WindowsRuntimeCheck['failureCause'],
  isolationVerified:false as const,modelTurn:'not_run' as const,productionAvailable:false as const,
  strictConfigVerified:false as const,authentication:'not_verified' as const};
 if(process.platform!=='win32'&&!diagnosticRunner){
  freshAuthority(store,context,input.workspaceId,input.profileRevision);
  return base;
 }
 const desktopTarget=diagnosticRunner?WINDOWS_DESKTOP_CODEX:resolveWindowsDesktopTarget();
 const run=(args:string[])=>diagnosticRunner
  ? diagnosticRunner({executable:desktopTarget,args,cwd:p.check,env})
  : spawnSync(desktopTarget,args,{cwd:p.check,env,
     shell:false,windowsHide:true,encoding:'utf8',timeout:10_000,maxBuffer:128*1024});
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 const version=run(['--version']);
 recheck();
 if(version.error||version.status!==0||!desktopVersionMatches(version.stdout))
  return base;
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 const features=run(['features','list']);
 recheck();
 if(features.error||features.status!==0) return {...base,versionMatch:true,failureCause:'features'};
 const flags=featureNames.every(name=>new RegExp(`^${name}\\s+[^\\r\\n]*\\sfalse\\s*$`,'m').test(features.stdout))&&
  /^skip_host_skill_discovery\s+[^\r\n]*\strue\s*$/m.test(features.stdout);
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 return {...base,versionMatch:true,configParseObserved:true,featureFlagsMatch:flags,
  failureCause:flags?'none':'configuration'};
}

/** Actual owned Job plus strict app-server config/read; still no isolation or model claim. */
export async function checkWindowsInvestigatorRuntimeStrict(root:string,store:SqliteStore,
 context:RequestContext,input:WindowsRuntimeCheckInput):Promise<WindowsRuntimeCheck>{
 const feature=checkWindowsInvestigatorRuntime(root,store,context,input);
 if(!feature.featureFlagsMatch)return feature;
 const saved=readRecord(root,input.workspaceId,input.profileRevision);
 if(saved.runtimeId!==input.runtimeId)throw unavailable();
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 let strict=false;
 try{
  strict=await runOwnedWindowsConfigCheck(saved,{assertDiagnosticAuthority:()=>{
   freshAuthority(store,context,input.workspaceId,input.profileRevision);
   return true;
  }});
 }catch{/* Native diagnostic failure remains unverified. */}
 authority(root,store,context,input.workspaceId,input.profileRevision);
 const current=readRecord(root,input.workspaceId,input.profileRevision);
 if(current.runtimeId!==saved.runtimeId||current.configSha256!==saved.configSha256||
  current.modelRef!==saved.modelRef)throw unavailable();
 freshAuthority(store,context,input.workspaceId,input.profileRevision);
 return {...feature,strictConfigVerified:strict,failureCause:strict?'none':'strict_config'};
}

/** Internal production admission only. The current runtime has no authenticated,
 * isolated model-turn qualification, so even an exact persisted binding is refused.
 * Future owner wiring must add a concrete qualification and recheck immediately
 * before the durable start opportunity; this resolver creates no launch intent. */
export async function resolveWindowsInvestigationRuntime(dataRoot:string,store:SqliteStore,
 investigationStore:SqliteInvestigationStore,claim:InvestigationClaim,runtimeId:string):Promise<never>{
 if(!uuid.test(runtimeId)||!claim||typeof claim!=='object'||Array.isArray(claim))throw unavailable();
 const current=investigationStore.listUnsettled().find(item=>item.requestId===claim.requestId);
 if(!current||!isDeepStrictEqual(current,claim)||!current.windowsSource||
  current.windowsSource.preparedAt===null||current.phase!=='start_intent'||
  current.launchProtocol!=='resource_reservation_v1'||current.nativeRef!==null)
  throw unavailable();
 const record=investigationStore.get(current.requestId);
 if(!record||record.workspaceId!==current.workspaceId||!store.getWorkspace(current.workspaceId)||
  record.cancelRequested||record.result!==null||!['queued','running'].includes(record.state))
  throw unavailable();
 const profile=store.getCurrentProfileRevision(current.workspaceId);
 if(!profile||profile.presetRef!=='static_readonly_v1'||
  record.profileRef!==profile.id||record.budgetRef!==profile.id||
  !isDeepStrictEqual(record.budget,profile.budget))throw unavailable();
 const saved=readRecord(dataRoot,current.workspaceId,profile.id);
 if(saved.runtimeId!==runtimeId||saved.profileRevision!==profile.id||
  saved.workspaceId!==current.workspaceId||saved.productionAvailable!==false)
  throw unavailable();
 const source=current.windowsSource;
 if(source.descriptor.attemptId!==current.attemptId||
  source.descriptor.workspaceId!==current.workspaceId||
  source.descriptor.workerEpoch!==current.workerEpoch)throw unavailable();
 const selected=[...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
 investigationStore.preflightWindowsSourcePrepared(current,selected,profile.id,
  source.descriptor.sourceDigest,new Date());
 const snapshot=await store.getSnapshot(record.snapshotRef,record.workspaceId,
  record.collaborationId);
 if(!snapshot||snapshot.workspaceId!==record.workspaceId||
  snapshot.collaborationId!==record.collaborationId||
  snapshot.workingCopyId!==record.workingCopyId||
  snapshot.snapshot.id!==record.snapshotRef||
  snapshot.snapshot.workingCopyId!==record.workingCopyId)throw unavailable();
 const plan=buildInvestigationSourcePlan({record,claim:current,snapshot:snapshot.snapshot,
  expected:{workspaceId:record.workspaceId,collaborationId:record.collaborationId,
   workingCopyId:record.workingCopyId,snapshotRef:record.snapshotRef,
   contextRevisionId:record.contextRevisionId,recipient:record.recipient,
   requestId:record.id,attemptId:current.attemptId,workerEpoch:current.workerEpoch}});
 if(plan.digest!==source.descriptor.sourceDigest||investigationStore.getWindowsLaunch(current))
  throw unavailable();
 // The private config forbids auth.json and contains no real isolation proof.
 // A diagnostic success or caller-supplied verified flag cannot qualify it.
 throw new Error('WINDOWS_RUNTIME_UNQUALIFIED');
}

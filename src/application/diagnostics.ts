import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { authorize, operationPolicy, type Grant, type RequestContext } from '../core/policy/authorize.js';
import { validateFileOrigins } from '../adapters/mcp/platform-file-download.js';
import { assertPrivateDataDirectory } from '../runtime/local-security.js';

type McpStatus='not_configured'|'configured_authorized'|'configured_unavailable';
type McpReason='binding_absent'|'authorized'|'binding_invalid'|'authorization_unavailable';
type FileReason='remote_not_checked'|'origin_config_invalid';
export interface DoctorReport {
  schemaVersion:1;
  installation:{status:'readable';reason:'private_database_schema_valid'};
  service:{status:'not_checked';reason:'no_service_probe'};
  tools:{status:'not_checked';reason:'no_host_probe'};
  identity:{status:'not_checked';reason:'native_account_not_observed'};
  mcp:{status:McpStatus;reason:McpReason;authorizedOperations:number};
  sessions:{status:'foreground_adapter_installed';reason:'runtime_not_checked';
    account:'not_checked';binding:'not_checked';history:'not_checked';humanHandoff:'not_checked';
    unresolvedSends:'none'|'present'};
  investigator:{status:'runtime_unavailable';reason:'runtime_not_verified';profileConfigured:boolean};
  files:{status:'local_implemented';reason:FileReason;originsConfigured:boolean};
}

function privateRegular(root:string,path:string):void {
  const stat=lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (process.platform!=='win32' && (stat.mode & 0o077)!==0)) throw new Error('NOT_AVAILABLE');
  assertPrivateDataDirectory(root,path);
}

function hasEntry(path:string):boolean {
  return lstatSync(path,{throwIfNoEntry:false})!==undefined;
}

function boundedJson(root:string,name:string):unknown {
  const path=join(root,name);
  privateRegular(root,path);
  if (lstatSync(path).size>64*1024) throw new Error('NOT_AVAILABLE');
  return JSON.parse(readFileSync(path,'utf8')) as unknown;
}

function record(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) ||
      Object.keys(value).some(key=>!keys.includes(key))) throw new Error('NOT_AVAILABLE');
  return value as Record<string,unknown>;
}

function table(db:DatabaseSync,name:string):boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function requireColumns(db:DatabaseSync,name:string,required:readonly string[]):void {
  if (!table(db,name)) throw new Error('NOT_AVAILABLE');
  const found=new Set((db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>).map(row=>row.name));
  if (required.some(column=>!found.has(column))) throw new Error('NOT_AVAILABLE');
}

function mcpReport(root:string,db:DatabaseSync):DoctorReport['mcp'] {
  if (!hasEntry(join(root,'mcp-binding.json'))) return {
    status:'not_configured',reason:'binding_absent',authorizedOperations:0};
  let binding:Record<string,unknown>;
  try {
    binding=record(boundedJson(root,'mcp-binding.json'),
      ['principal','audience','recipient','workspaceId','collaborationId','visibleOperations']);
    if (!['principal','audience','recipient','workspaceId'].every(key=>
      typeof binding[key]==='string' && (binding[key] as string).length>0 &&
      (binding[key] as string).length<=256) ||
      (binding.collaborationId!==undefined &&
        (typeof binding.collaborationId!=='string' || binding.collaborationId.length>256)) ||
      !Array.isArray(binding.visibleOperations) || binding.visibleOperations.length<1 ||
      binding.visibleOperations.length>32 || !binding.visibleOperations.every(value=>
        typeof value==='string' && value.length>0 && value.length<=128)) throw new Error('NOT_AVAILABLE');
  } catch {return {status:'configured_unavailable',reason:'binding_invalid',authorizedOperations:0};}
  const principal=binding.principal as string;
  const audience=binding.audience as string;
  const recipient=binding.recipient as string;
  const workspaceId=binding.workspaceId as string;
  const collaborationId=binding.collaborationId as string|undefined;
  try {
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(workspaceId) ||
        (collaborationId && !db.prepare('SELECT 1 FROM collaborations WHERE id=? AND workspace_id=?')
          .get(collaborationId,workspaceId))) throw new Error('NOT_AVAILABLE');
    const rows=db.prepare(`SELECT id,principal,audience,workspace_id,collaboration_id,recipient,
      permissions_json,data_paths_json,expires_at,revoked_at FROM grants
      WHERE principal=? AND audience=? LIMIT 257`).all(principal,audience) as Array<Record<string,unknown>>;
    if (rows.length>256) throw new Error('NOT_AVAILABLE');
    const grants:Grant[]=rows.map(row=>({id:row.id as string,principal:row.principal as string,
      audience:row.audience as string,workspaceId:row.workspace_id as string,
      ...(row.collaboration_id===null?{}:{collaborationId:row.collaboration_id as string}),
      ...(row.recipient===null?{}:{recipient:row.recipient as string}),
      permissions:JSON.parse(row.permissions_json as string) as string[],
      ...(row.data_paths_json===null?{}:{dataPaths:JSON.parse(row.data_paths_json as string) as string[]}),
      expiresAt:row.expires_at as string|null,revokedAt:row.revoked_at as string|null}));
    const context:RequestContext={principal,audience,recipient,surface:'external_mcp',now:new Date()};
    for (const operation of binding.visibleOperations as string[]) {
      const scope=operation==='collab.open'?{workspaceId}:{workspaceId,
        ...(collaborationId?{collaborationId}:{})};
      if (!operationPolicy(operation).surfaces.includes('external_mcp')) throw new Error('NOT_AVAILABLE');
      authorize(context,operation,scope,grants);
    }
    return {status:'configured_authorized',reason:'authorized',
      authorizedOperations:(binding.visibleOperations as string[]).length};
  } catch {return {status:'configured_unavailable',reason:'authorization_unavailable',authorizedOperations:0};}
}

function filesReport(root:string):DoctorReport['files'] {
  if (!hasEntry(join(root,'oauth-config.json'))) return {
    status:'local_implemented',reason:'remote_not_checked',originsConfigured:false};
  try {
    const saved=record(boundedJson(root,'oauth-config.json'),
      ['issuer','bindings','allowedFileOrigins']);
    if (!saved.issuer || typeof saved.issuer!=='object' || Array.isArray(saved.issuer) ||
        !Array.isArray(saved.bindings) || saved.bindings.length!==1 ||
        !saved.bindings[0] || typeof saved.bindings[0]!=='object') {
      throw new Error('NOT_AVAILABLE');
    }
    const origins=validateFileOrigins(saved.allowedFileOrigins===undefined?[]:saved.allowedFileOrigins);
    return {status:'local_implemented',reason:'remote_not_checked',
      originsConfigured:origins.length>0};
  } catch {return {status:'local_implemented',reason:'origin_config_invalid',originsConfigured:false};}
}

/** Local, read-only capability projection. It never opens the application or a migrating store. */
export function diagnoseInstallation(root:string,context:RequestContext):DoctorReport {
  if (context.surface!=='local_cli' || !context.principal || context.audience!=='local-os' ||
      context.recipient!==context.principal) throw new Error('NOT_AVAILABLE');
  if (!lstatSync(root).isDirectory()) throw new Error('NOT_AVAILABLE');
  const file=join(root,'state.sqlite');
  privateRegular(root,file);
  // Immutable SQLite reads never create WAL/SHM files. A live WAL would make this
  // base-file view stale, so refuse it before and after the projection.
  const quiet=()=>!hasEntry(`${file}-wal`) && !hasEntry(`${file}-shm`);
  if (!quiet()) throw new Error('NOT_AVAILABLE');
  const before=lstatSync(file,{bigint:true});
  const db=new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`,{readOnly:true});
  let primary:unknown;
  try {
    requireColumns(db,'workspaces',['id','name','canonical_root','registered_by']);
    requireColumns(db,'collaborations',['id','workspace_id','opened_by','purpose','host_thread_id','state']);
    requireColumns(db,'grants',['id','principal','audience','workspace_id','collaboration_id',
      'recipient','permissions_json','data_paths_json','expires_at','revoked_at']);
    requireColumns(db,'profile_heads',['workspace_id','revision_id']);
    const sessionsTable=table(db,'conversation_commands');
    if (sessionsTable) {
      requireColumns(db,'conversation_commands',['command_id','operation','status','binding_id']);
      requireColumns(db,'session_control',['binding_id','workspace_id','collaboration_id',
        'provider_id','account_id','native_session_id','state_json']);
    }
    const unresolved=sessionsTable && Boolean(db.prepare(`SELECT 1 FROM conversation_commands
      WHERE operation='conversation.send' AND status IN ('sending','reconcile_required') LIMIT 1`).get());
    const profileConfigured=Boolean(db.prepare('SELECT 1 FROM profile_heads LIMIT 1').get());
    const report:DoctorReport={schemaVersion:1,
      installation:{status:'readable',reason:'private_database_schema_valid'},
      service:{status:'not_checked',reason:'no_service_probe'},
      tools:{status:'not_checked',reason:'no_host_probe'},
      identity:{status:'not_checked',reason:'native_account_not_observed'},
      mcp:mcpReport(root,db),
      sessions:{status:'foreground_adapter_installed',reason:'runtime_not_checked',
        account:'not_checked',binding:'not_checked',history:'not_checked',humanHandoff:'not_checked',
        unresolvedSends:unresolved?'present':'none'},
      investigator:{status:'runtime_unavailable',reason:'runtime_not_verified',profileConfigured},
      files:filesReport(root)};
    const after=lstatSync(file,{bigint:true});
    if (!quiet() || before.ino!==after.ino || before.size!==after.size ||
        before.mtimeNs!==after.mtimeNs) throw new Error('NOT_AVAILABLE');
    return report;
  } catch(error) {primary=error;throw error;}
  finally {closeDiagnosticDatabase(db,primary);}
}

function closeDiagnosticDatabase(db:DatabaseSync,primary:unknown):void {
  try {db.close();}
  catch(error) {throw new AggregateError([primary,error], 'Diagnostic database cleanup unconfirmed', {cause:error});}
}

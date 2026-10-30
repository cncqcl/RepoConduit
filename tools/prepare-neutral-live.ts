/** Prepare one installed Claude CLI investigation. This command never starts a model. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {homedir,hostname,userInfo} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const parent=process.env.RCAC_LIVE_FIXTURE_PARENT ?? join(homedir(),'repo-conduit-live-fixtures');
const sourcePath='src/provenance.ts';
const sourceBytes=Buffer.from('export const fixture = true;\n','utf8');
const ids={workspace:'neutral01_ws',collaboration:'neutral01_col',copy:'neutral01_copy',context:'neutral01_ctx'};
const identityPrincipal=`${hostname()}\\${userInfo().username}`;
const unavailable=()=>new Error('NEUTRAL01_PREPARE_UNAVAILABLE');
const json=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',
 {encoding:'utf8',flag:'wx',mode:0o600});

function installedPackage(cli:string):string{
 if(!isAbsolute(cli)||!existsSync(cli)||!lstatSync(cli).isFile()||lstatSync(cli).isSymbolicLink()||
  realpathSync.native(cli).toLowerCase()!==resolve(cli).toLowerCase()||
  !cli.replaceAll('\\','/').endsWith('/dist/src/cli/main.js'))throw unavailable();
 const packageRoot=resolve(dirname(cli),'../../..');
 const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8')) as {name?:string};
 if(manifest.name!=='repo-conduit')throw unavailable();
 return packageRoot;
}
async function installed<T>(packageRoot:string,relative:string):Promise<T>{
 const file=join(packageRoot,'dist/src',relative);
 if(!lstatSync(file).isFile())throw unavailable();
 return await import(pathToFileURL(file).href) as T;
}
async function main(){
 if(process.platform!=='win32'||process.argv.length!==3)throw unavailable();
 if(!isAbsolute(process.argv[2]!))throw unavailable();
 const cli=resolve(process.argv[2]!);const packageRoot=installedPackage(cli);
 if(!lstatSync(parent).isDirectory()||lstatSync(parent).isSymbolicLink()||
  realpathSync.native(parent).toLowerCase()!==resolve(parent).toLowerCase())throw unavailable();
 const root=mkdtempSync(join(parent,'neutral01-live-'));
 if(!root.startsWith(parent+sep)||!basename(root).startsWith('neutral01-live-'))throw unavailable();
 const security=await installed<typeof import('../src/runtime/local-security.js')>(packageRoot,
  'runtime/local-security.js');
 security.protectNewDataDirectory(root);
 mkdirSync(join(root,'src'),{mode:0o700});
 writeFileSync(join(root,sourcePath),sourceBytes,{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({phase:'case_created',root})+'\n');
 const storage=await installed<typeof import('../src/adapters/storage/sqlite.js')>(packageRoot,
  'adapters/storage/sqlite.js');
 const contextStorage=await installed<typeof import('../src/adapters/storage/context-decisions-sqlite.js')>(
  packageRoot,'adapters/storage/context-decisions-sqlite.js');
 const snapshots=await installed<typeof import('../src/adapters/repository/snapshots.js')>(packageRoot,
  'adapters/repository/snapshots.js');
 const context=await installed<typeof import('../src/core/collaboration/context.js')>(packageRoot,
  'core/collaboration/context.js');
 const store=new storage.SqliteStore(join(root,'state.sqlite'));
 let snapshotId:string,profileRevision:string;
 try{
  const expiresAt=new Date(Date.now()+60*60_000).toISOString();
  store.insertWorkspace({id:ids.workspace,name:'NEUTRAL01 synthetic',canonicalRoot:root,
   registeredBy:identityPrincipal});
  store.insertGrant({id:'neutral-admin',principal:identityPrincipal,audience:'local-os',
   recipient:identityPrincipal,workspaceId:'management',permissions:['admin.profile'],
   expiresAt,revokedAt:null});
  store.insertCollaboration({id:ids.collaboration,workspaceId:ids.workspace,
   openedBy:identityPrincipal,purpose:'One installed Claude read',hostThreadId:null,state:'open'});
  store.insertGrant({id:'neutral-request',principal:'external',audience:'mcp',recipient:'user',
   workspaceId:ids.workspace,collaborationId:ids.collaboration,
   permissions:['investigation.request','investigation.read'],expiresAt,revokedAt:null});
  store.insertGrant({id:'neutral-read',principal:'external',audience:'mcp',recipient:'user',
   workspaceId:ids.workspace,collaborationId:ids.collaboration,permissions:['data.read'],
   dataPaths:[sourcePath],expiresAt,revokedAt:null});
  store.insertWorkingCopy({id:ids.copy,workspaceId:ids.workspace,canonicalRoot:root});
  const snapshot=snapshots.createSnapshotFromFiles(ids.copy,'neutral01-synthetic',
   {[sourcePath]:readFileSync(join(root,sourcePath))}).toPersisted();
  snapshotId=snapshot.id;
  await store.saveSnapshot({workspaceId:ids.workspace,collaborationId:ids.collaboration,
   workingCopyId:ids.copy,snapshot},{workspaceId:ids.workspace,collaborationId:ids.collaboration,
    workingCopyId:ids.copy,commitRef:'neutral01-synthetic'},'neutral01-capture',
   identityPrincipal,'local_cli');
  const contexts=new contextStorage.ContextDecisionSqlite(join(root,'state.sqlite'));
  try{
   const proposal=context.proposeContext({id:'neutral01-proposal',workspaceId:ids.workspace,
    collaborationId:ids.collaboration,parentRevisionId:null,snapshotId,
    proposedBy:'external',sourceRefs:['neutral01-synthetic'],content:{
     goal:'Read the one synthetic TypeScript constant',constraints:['Only src/provenance.ts'],
     acceptedDecisions:[],rejectedDecisions:[],currentQuestions:[],evidenceRefs:[],
     expectedDeliverables:['receipt-backed result'],unknowns:[],recentChanges:[]}});
   const permit={grantId:'neutral-local-context',operation:'context.accept',
    effect:'state_write' as const,scope:{workspaceId:ids.workspace,collaborationId:ids.collaboration},
    principal:identityPrincipal,recipient:identityPrincipal};
   contexts.insertProposal(proposal);
   contexts.insertRevision(context.acceptContext(proposal,ids.context,permit,'local_host'),
    permit,'local_host');
  }finally{contexts.close();}
  const profile=store.insertProfileRevision({workspaceId:ids.workspace,expectedRevisionId:null,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:180,maxTurns:2,maxToolCalls:10}},
   identityPrincipal,new Date());
  profileRevision=profile.id;
 }finally{store.close();}
 json(join(root,'mcp-binding.json'),{principal:'external',audience:'mcp',recipient:'user',
  workspaceId:ids.workspace,collaborationId:ids.collaboration,
  visibleOperations:['investigate.submit','investigate.get']});
 const transport=new StdioClientTransport({command:process.execPath,cwd:packageRoot,stderr:'pipe',
  args:[cli,'--data-dir',root,'mcp','--claude-workspace',ids.workspace,
   '--claude-profile',profileRevision]});
 let stderr='';transport.stderr?.on('data',(part:Buffer)=>{stderr+=part.toString('utf8').slice(0,4096);});
 const client=new Client({name:'neutral01-prepare',version:'1.0.0'});
 try{
  await client.connect(transport);
  const reply=await client.callTool({name:'investigate.submit',arguments:{
   scope:{workspaceId:ids.workspace,collaborationId:ids.collaboration},
   idempotencyKey:'neutral01-submit-once',payload:{workingCopyId:ids.copy,input:{
    snapshotRef:snapshotId,contextRevisionId:ids.context,
    question:`Use repo.read on ${sourcePath}; report the exact value of fixture with its tool receipt.`,
    scope:{paths:[sourcePath],symbols:[],relatedTests:[]},
    requestedOutputs:['evidence'],parentInvestigationId:null}}}});
  assert.equal(reply.isError,undefined,JSON.stringify(reply));
  const record=JSON.parse((reply.content[0] as {text:string}).text) as
   {id:string;state:string;attempts:unknown[]};
  assert.match(record.id,/^inv_[0-9a-f-]{36}$/);
  assert.equal(record.state,'queued');assert.equal(record.attempts.length,0);
  json(join(root,'neutral01-case.json'),{kind:'neutral01_installed_claude_v1',root,cli,
   cliSha256:createHash('sha256').update(readFileSync(cli)).digest('hex'),
   workspaceId:ids.workspace,collaborationId:ids.collaboration,workingCopyId:ids.copy,
   contextRevisionId:ids.context,snapshotId,profileRevision,requestId:record.id,
   sourcePath,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex'),
   createdAt:new Date().toISOString()});
  process.stdout.write(JSON.stringify({phase:'prepared',root,requestId:record.id,
   modelCalls:0})+'\n');
 }catch(error){throw new Error(`Installed MCP prepare failed: ${stderr.slice(0,1024)}`,
  {cause:error});}
 finally{await client.close();}
}

main().catch(error=>{process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');
 process.exitCode=1;});

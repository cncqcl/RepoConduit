import { privateFixtureParent } from '../support/private-fixture-parent.js';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {hostname,userInfo} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {acquireInstallationRuntime} from '../../src/runtime/installation.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {authorizeClaudeSelection,parseClaudeStartupArguments,runClaudeInvestigationCommand}
 from '../../src/cli/claude-investigation.js';
import {seedBundleProvenance} from '../support/bundle-provenance.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

const cli=resolve(process.env.RCAC_CLAUDE_TEST_CLI??'src/cli/main.ts');
const principal=`${hostname()}\\${userInfo().username}`;
const identity={principal,audience:'local-os',recipient:principal};

function newFixtureRoot():string{
 const base=resolve(process.env.RCAC_TEST_FIXTURE_ROOT??
  privateFixtureParent());
 if(!statSync(base).isDirectory())throw new Error('approved synthetic fixture root is absent');
 const root=mkdtempSync(join(base,'rcac-claude-cli-'));
 assert.ok(resolve(root).startsWith(base+sep));
 protectNewDataDirectory(root);
 return root;
}

async function processExited(pid:number):Promise<boolean>{
 for(let tries=0;tries<40;tries++){
  try{process.kill(pid,0);}catch(error){
   if((error as NodeJS.ErrnoException).code==='ESRCH')return true;
   throw error;
  }
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 return false;
}

test('Claude CLI selection is explicit for MCP and rejects partial or mixed runtime flags',()=>{
 const base=['--data-dir','D:/fixture','mcp'];
 assert.deepEqual(parseClaudeStartupArguments(base),{argv:base});
 assert.deepEqual(parseClaudeStartupArguments([...base,'--claude-workspace','ws',
  '--claude-profile','revision']),{argv:base,
   selection:{workspaceId:'ws',profileRevision:'revision'}});
 for(const bad of [
  ['--claude-workspace','ws'],['--claude-profile','revision'],
  ['--claude-workspace','ws','--claude-profile','revision','--claude-profile','other'],
  ['--claude-workspace','../other','--claude-profile','revision'],
 ])assert.throws(()=>parseClaudeStartupArguments([...base,...bad]));
 assert.throws(()=>parseClaudeStartupArguments(['--data-dir','D:/fixture','run-claude-investigation',
  '--claude-workspace','ws','--claude-profile','revision']));
});

test('public MCP Claude selection queues and cancels a scoped request without opening native/model',
 {timeout:60_000},async()=>{
 const root=newFixtureRoot();
 const store=new SqliteStore(join(root,'state.sqlite'));
 let runtime:ReturnType<typeof acquireInstallationRuntime>|undefined;
 let client:Client|undefined;
 let transport:StdioClientTransport|undefined;
 let childPid:number|null=null;
 try{
  store.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:root,registeredBy:principal});
  store.insertGrant({id:'admin',...identity,workspaceId:'management',permissions:['admin.profile'],
   expiresAt:null,revokedAt:null});
  const profile=store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:null,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2}},
   principal,new Date());
  const selected={workspaceId:'ws',profileRevision:profile.id};
  runtime=acquireInstallationRuntime(root);
  assert.deepEqual(authorizeClaudeSelection(runtime,identity,selected),selected);
  assert.throws(()=>authorizeClaudeSelection(runtime!,{...identity,principal:'external'},selected));
  assert.throws(()=>authorizeClaudeSelection(runtime!,identity,selected,'other-workspace'));
  assert.throws(()=>authorizeClaudeSelection(runtime!,identity,{...selected,command:'shell'}));
  await assert.rejects(runClaudeInvestigationCommand(runtime,identity,
   {...selected,requestId:'absent',command:'shell'}));
  await assert.rejects(runClaudeInvestigationCommand(runtime,identity,
   {...selected,requestId:'absent'}),/NOT_AVAILABLE/);
  runtime.release();runtime=undefined;

  store.insertCollaboration({id:'col',workspaceId:'ws',openedBy:principal,purpose:'Read',
   hostThreadId:null,state:'open'});
  const {snapshotId}=await seedBundleProvenance(store,join(root,'state.sqlite'),
   {workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',root,revisionIds:['ctx']});
  store.insertGrant({id:'request',principal:'external',audience:'mcp',recipient:'user',
   workspaceId:'ws',collaborationId:'col',permissions:['investigation.request',
    'investigation.read','investigation.cancel'],expiresAt:null,revokedAt:null});
  store.insertGrant({id:'read',principal:'external',audience:'mcp',recipient:'user',
   workspaceId:'ws',collaborationId:'col',permissions:['data.read'],
   dataPaths:['src/provenance.ts'],expiresAt:null,revokedAt:null});
  writeFileSync(join(root,'mcp-binding.json'),JSON.stringify({principal:'external',
   audience:'mcp',recipient:'user',workspaceId:'ws',collaborationId:'col',
   visibleOperations:['investigate.submit','investigate.get','investigate.cancel']}));
  transport=new StdioClientTransport({command:process.execPath,cwd:resolve('.'),stderr:'pipe',
   args:['--import','tsx',cli,'--data-dir',root,'mcp','--claude-workspace','ws',
    '--claude-profile',profile.id]});
  let stderr='';transport.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString('utf8');});
  client=new Client({name:'claude-cli-composition',version:'1.0.0'});
  await client.connect(transport).catch(error=>{throw new Error(`MCP connect failed: ${stderr}`,{cause:error});});
  childPid=transport.pid;
  assert.ok(childPid,'actual CLI child process must exist');
  const scope={workspaceId:'ws',collaborationId:'col'};
  const submit={scope,idempotencyKey:'submit-once',payload:{workingCopyId:'copy',
   input:{snapshotRef:snapshotId,contextRevisionId:'ctx',question:'Read the synthetic constant',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['evidence'],parentInvestigationId:null}}};
  const reply=await client.callTool({name:'investigate.submit',arguments:submit});
  assert.equal(reply.isError,undefined,JSON.stringify(reply));
  const record=JSON.parse((reply.content[0] as {text:string}).text) as InvestigationRecord;
  assert.equal(record.state,'queued');assert.equal(record.attempts.length,0);
  const input={scope,payload:{workingCopyId:'copy',requestId:record.id}};
  const fetched=await client.callTool({name:'investigate.get',arguments:input});
  assert.equal((JSON.parse((fetched.content[0] as {text:string}).text) as InvestigationRecord).state,'queued');
  const cancelled=await client.callTool({name:'investigate.cancel',
   arguments:{...input,idempotencyKey:'cancel-once'}});
  assert.equal(cancelled.isError,undefined,JSON.stringify(cancelled));
  assert.equal((JSON.parse((cancelled.content[0] as {text:string}).text) as InvestigationRecord).state,'cancelled');
  assert.doesNotMatch(stderr,/claude_windows|native_open|model_outcome/);
  await client.close();client=undefined;transport=undefined;
  assert.equal(await processExited(childPid),true,'actual CLI child must exit after MCP close');

  const rejected=spawnSync(process.execPath,['--import','tsx',cli,'--data-dir',root,
   'mcp','--claude-workspace','ws','--claude-profile',profile.id,'--command','shell'],
   {cwd:resolve('.'),encoding:'utf8',timeout:15_000});
  assert.notEqual(rejected.status,0,'extra runtime command must be rejected before native open');
  assert.doesNotMatch(rejected.stdout,/investigation_result_v1/);
  const command=spawnSync(process.execPath,['--import','tsx',cli,'--data-dir',root,
   'run-claude-investigation'],{cwd:resolve('.'),encoding:'utf8',timeout:20_000,
    input:JSON.stringify({...selected,requestId:record.id})});
  assert.equal(command.status,0,command.stderr);
  assert.deepEqual(JSON.parse(command.stdout),{requestId:record.id,state:'cancelled',hasResult:false});
  store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:profile.id,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2}},
   principal,new Date());
  runtime=acquireInstallationRuntime(root);
  assert.throws(()=>authorizeClaudeSelection(runtime!,identity,selected),/NOT_AVAILABLE/);
 }finally{
  await client?.close();runtime?.release();store.close();
  if(childPid!==null)assert.equal(await processExited(childPid),true,'CLI child must be reaped');
  const base=resolve(process.env.RCAC_TEST_FIXTURE_ROOT??
   privateFixtureParent());
  assert.ok(resolve(root).startsWith(base+sep));
  rmSync(root,{recursive:true,force:true});
 }
});

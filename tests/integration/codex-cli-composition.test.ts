import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,hostname,userInfo} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {acquireInstallationRuntime} from '../../src/runtime/installation.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {prepareWindowsInvestigatorRuntime} from '../../src/runtime/windows-investigation-runtime-config.js';
import {parseCodexStartupArguments,authorizeCodexSelection,runCodexInvestigationCommand}
 from '../../src/cli/codex-investigation.js';
import {seedBundleProvenance} from '../support/bundle-provenance.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

test('Codex startup selection is an explicit pair on MCP/HTTP only',()=>{
 const base=['--data-dir','D:/fixture','mcp'];
 assert.deepEqual(parseCodexStartupArguments(base),{argv:base});
 assert.deepEqual(parseCodexStartupArguments([...base,'--codex-workspace','ws','--codex-profile','profile']),
  {argv:base,selection:{workspaceId:'ws',profileRevision:'profile'}});
 assert.deepEqual(parseCodexStartupArguments(['--data-dir','D:/fixture','serve-http','--mcp-port','5000',
  '--codex-profile','profile','--codex-workspace','ws']),
  {argv:['--data-dir','D:/fixture','serve-http','--mcp-port','5000'],selection:{workspaceId:'ws',profileRevision:'profile'}});
 for(const trailing of [['--codex-workspace','ws'],['--codex-profile','profile'],
  ['--codex-workspace','ws','--codex-profile','profile','--codex-profile','other'],
  ['--codex-workspace','../escape','--codex-profile','profile']]){
  assert.throws(()=>parseCodexStartupArguments([...base,...trailing]));
 }
 assert.throws(()=>parseCodexStartupArguments(['--data-dir','D:/fixture','request','--codex-workspace','ws','--codex-profile','profile']));
});

test('managed Codex is opt-in on a complete MCP or HTTP selection only',()=>{
 const base=['--data-dir','D:/fixture','mcp'];
 assert.deepEqual(parseCodexStartupArguments([...base,'--codex-workspace','ws',
  '--codex-profile','profile','--codex-managed']),
  {argv:base,selection:{workspaceId:'ws',profileRevision:'profile'},managed:true});
 assert.deepEqual(parseCodexStartupArguments([...base,'--codex-workspace','ws',
  '--codex-profile','profile']),
  {argv:base,selection:{workspaceId:'ws',profileRevision:'profile'}});
 const http=['--data-dir','D:/fixture','serve-http','--mcp-port','5000'];
 assert.deepEqual(parseCodexStartupArguments([...http,'--codex-workspace','ws',
  '--codex-profile','profile','--codex-managed']),
  {argv:http,selection:{workspaceId:'ws',profileRevision:'profile'},managed:true});
 for(const bad of [['--codex-managed'],['--codex-managed','false'],
  ['--codex-managed','--codex-managed'],['--codex-workspace','ws','--codex-managed']])
  assert.throws(()=>parseCodexStartupArguments([...base,...bad]));
 assert.throws(()=>parseCodexStartupArguments(['--data-dir','D:/fixture',
  'run-codex-investigation','--codex-managed']));
});

test('local selection requires administrator, current revision and existing prepared runtime',async()=>{
 const root=mkdtempSync(join(process.env.RCAC_TEST_FIXTURE_ROOT??homedir(),'rcac-codex-cli-'));protectNewDataDirectory(root);
 const store=new SqliteStore(join(root,'state.sqlite'));
 const principal=`${hostname()}\\${userInfo().username}`;
 const identity={principal,audience:'local-os',recipient:principal};
 let runtime:ReturnType<typeof acquireInstallationRuntime>|undefined;
 try{
  store.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:root,registeredBy:'owner'});
  store.insertGrant({id:'admin',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  const profile=store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:null,presetRef:'static_readonly_v1',
   budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2}},'owner',new Date());
  const selection={workspaceId:'ws',profileRevision:profile.id};
  runtime=acquireInstallationRuntime(root);
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selection),/NOT_AVAILABLE/);
  prepareWindowsInvestigatorRuntime(root,store,{...identity,surface:'local_admin',now:new Date()},
   {...selection,modelRef:'gpt-6-sol'});
  assert.deepEqual(authorizeCodexSelection(runtime,identity,selection),selection);
  assert.throws(()=>authorizeCodexSelection(runtime!,{...identity,principal:'external'},selection));
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selection,'other-workspace'),/NOT_AVAILABLE/);
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,{...selection,model:'gpt-6-sol'}),/NOT_AVAILABLE/);
  await assert.rejects(runCodexInvestigationCommand(runtime,identity,{...selection,requestId:'absent',command:'shell'}));
  await assert.rejects(runCodexInvestigationCommand(runtime,identity,{...selection,requestId:'absent'}),/NOT_AVAILABLE/);
  // Actual CLI subprocess/MCP SDK path; no native protocol fixture or model is needed to queue/cancel.
  store.insertCollaboration({id:'col',workspaceId:'ws',openedBy:'owner',purpose:'Read',hostThreadId:null,state:'open'});
  const {snapshotId}=await seedBundleProvenance(store,join(root,'state.sqlite'),
   {workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',root,revisionIds:['ctx']});
  store.insertGrant({id:'request',principal:'external',audience:'mcp',recipient:'user',workspaceId:'ws',collaborationId:'col',
   permissions:['investigation.request','investigation.read','investigation.cancel'],expiresAt:null,revokedAt:null});
  store.insertGrant({id:'read',principal:'external',audience:'mcp',recipient:'user',workspaceId:'ws',collaborationId:'col',
   permissions:['data.read'],dataPaths:['src/provenance.ts'],expiresAt:null,revokedAt:null});
  writeFileSync(join(root,'mcp-binding.json'),JSON.stringify({principal:'external',audience:'mcp',recipient:'user',
   workspaceId:'ws',collaborationId:'col',visibleOperations:['investigate.submit','investigate.get','investigate.cancel']}));
  const submit={scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'mcp-submit',payload:{workingCopyId:'copy',
   input:{snapshotRef:snapshotId,contextRevisionId:'ctx',question:'Read the constant',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['evidence'],parentInvestigationId:null}}};
  // The same bounded check can verify an explicitly selected installed CLI; fixture builders stay local.
  const cli=resolve(process.env.RCAC_CODEX_TEST_CLI??'src/cli/main.ts');let cancelledId='';
  for(const enabled of [false,true]){
   const client=new Client({name:'codex-selection-test',version:'1.0.0'});
   const transport=new StdioClientTransport({command:process.execPath,cwd:resolve('.'),stderr:'pipe',
    args:['--import','tsx',cli,'--data-dir',root,'mcp',...(enabled?['--codex-workspace','ws','--codex-profile',profile.id]:[])]});
   try{
    await client.connect(transport);
    const reply=await client.callTool({name:'investigate.submit',arguments:submit});
    if(!enabled){assert.equal(reply.isError,true);continue;}
    assert.equal(reply.isError,undefined);
    const record=JSON.parse((reply.content[0] as {text:string}).text) as InvestigationRecord;
    assert.equal(record.state,'queued');assert.equal(record.attempts.length,0);cancelledId=record.id;
    const args={scope:submit.scope,payload:{workingCopyId:'copy',requestId:record.id}};
    const fetched=await client.callTool({name:'investigate.get',arguments:args});
    assert.equal((JSON.parse((fetched.content[0] as {text:string}).text) as InvestigationRecord).state,'queued');
    assert.equal((await client.callTool({name:'investigate.submit',arguments:{...submit,
     payload:{...submit.payload,input:{...submit.payload.input,model:'forbidden'}}}})).isError,true);
    const cancelled=await client.callTool({name:'investigate.cancel',arguments:{...args,idempotencyKey:'mcp-cancel'}});
    assert.equal(cancelled.isError,undefined);
    assert.equal((JSON.parse((cancelled.content[0] as {text:string}).text) as {state:string}).state,'cancelled');
    store.revokeGrant('request',new Date().toISOString());
    assert.equal((await client.callTool({name:'investigate.submit',arguments:{...submit,idempotencyKey:'after-revoke'}})).isError,true);
   }finally{await client.close();}
  }
  assert.ok(cancelledId);
  const run=spawnSync(process.execPath,['--import','tsx',cli,'--data-dir',root,'run-codex-investigation'],
   {cwd:resolve('.'),encoding:'utf8',timeout:60_000,input:JSON.stringify({...selection,requestId:cancelledId})});
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(JSON.parse(run.stdout),{requestId:cancelledId,state:'cancelled',hasResult:false});
  store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:profile.id,presetRef:'static_readonly_v1',
   budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2}},'owner',new Date());
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selection),/NOT_AVAILABLE/);
 }finally{runtime?.release();store.close();rmSync(root,{recursive:true,force:true});}
});

test('managed MCP preserves recovery result and emits one bounded local native-open diagnostic',
 {timeout: 300_000},async(t)=>{
 // Windows fixture preparation invokes synchronous ACL helpers. Its allowance
 // is separate from the MCP handshake and the unchanged 15-second native budget.
 const started=performance.now();
 const root=mkdtempSync(join(process.env.RCAC_TEST_FIXTURE_ROOT??homedir(),'rcac-managed-diagnostic-'));
 let store:SqliteStore|undefined;
 let client:Client|undefined;
 let transport:StdioClientTransport|undefined;
 let childPid:number|null=null,stderrBytes=0;
 let stderr=Buffer.alloc(0),passed=false,primary:unknown;
 const cleanupErrors:unknown[]=[];
 let clientClose='not_started',storeClose='not_started',transportClosed=false;
 const phases:Array<{stage:string;elapsedMs:number}>=[];
 const retain=()=>{
  writeFileSync(join(root,'fixture-diagnostic.json'),JSON.stringify({phases,childPid,
   clientClose,storeClose,transportClosed,aborted:t.signal.aborted,
   stderrBytes,stderrRetainedBytes:stderr.length,stderrTruncated:stderrBytes>stderr.length},null,2),{mode:0o600});
  writeFileSync(join(root,'fixture-stderr.log'),stderr,{mode:0o600});
 };
 const phase=(stage:string)=>{
  const fact={stage,elapsedMs:Math.round(performance.now()-started)};phases.push(fact);
  process.stderr.write(`MANAGED_FIXTURE_PHASE ${JSON.stringify(fact)}\n`);
  retain();
 };
 let closing:Promise<void>|undefined;
 const closeClient=()=>closing??=(async()=>{
  childPid??=transport?.pid??null;clientClose='pending';phase('client_close_begin');
  try{await client?.close();clientClose=client?'resolved':'not_started';phase('client_close_end');}
  catch(error){clientClose='failed';phase('client_close_failed');throw error;}
 })();
 const abort=()=>{
  phase('test_aborted');void closeClient().catch(()=>undefined);
 };
 t.signal.addEventListener('abort',abort,{once:true});
 try{
  phase('fixture_begin');
  protectNewDataDirectory(root);phase('root_protected');
  store=new SqliteStore(join(root,'state.sqlite'));
  const principal=`${hostname()}\\${userInfo().username}`;
  store.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:root,registeredBy:principal});
  store.insertCollaboration({id:'col',workspaceId:'ws',openedBy:principal,purpose:'Read',hostThreadId:null,state:'open'});
  store.insertGrant({id:'admin',principal,audience:'local-os',recipient:principal,workspaceId:'management',
   permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  const profile=store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:null,presetRef:'static_readonly_v1',
   budget:{maxWallSeconds:15,maxTurns:1,maxToolCalls:2}},principal,new Date());
  prepareWindowsInvestigatorRuntime(root,store,{principal,audience:'local-os',recipient:principal,
   surface:'local_admin',now:new Date()},
   {workspaceId:'ws',profileRevision:profile.id,modelRef:'gpt-6-sol'});
  phase('runtime_prepared');
  const {snapshotId}=await seedBundleProvenance(store,join(root,'state.sqlite'),
   {workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',root,revisionIds:['ctx']});
  phase('provenance_seeded');t.signal.throwIfAborted();
  store.insertGrant({id:'request',principal:'external',audience:'mcp',recipient:'user',workspaceId:'ws',
   collaborationId:'col',permissions:['investigation.request','investigation.read'],expiresAt:null,revokedAt:null});
  store.insertGrant({id:'read',principal:'external',audience:'mcp',recipient:'user',workspaceId:'ws',
   collaborationId:'col',permissions:['data.read'],dataPaths:['src/provenance.ts'],expiresAt:null,revokedAt:null});
  writeFileSync(join(root,'mcp-binding.json'),JSON.stringify({principal:'external',audience:'mcp',recipient:'user',
   workspaceId:'ws',collaborationId:'col',visibleOperations:['investigate.submit','investigate.get']}));
  const preload=join(root,'fixture-preload.mjs');
  const moduleUrl=pathToFileURL(resolve('src/adapters/codex/investigator/windows-prepared-session.js')).href;
  writeFileSync(preload,`const {PreparedWindowsFixtureSession}=await import(${JSON.stringify(moduleUrl)});\n`+
   `const originalAdmission=PreparedWindowsFixtureSession.assertAppServerAvailable;\n`+
   `const originalOpen=PreparedWindowsFixtureSession.openAppServer;\n`+
   `PreparedWindowsFixtureSession.assertAppServerAvailable=()=>{};\n`+
   `PreparedWindowsFixtureSession.openAppServer=async()=>{process.stderr.write('FIXTURE_NATIVE_OPEN_CALLED\\n');`+
   `throw new Error('PRIVATE_NATIVE_ERROR')};\n`+
   `process.on('exit',()=>{PreparedWindowsFixtureSession.openAppServer=originalOpen;`+
   `PreparedWindowsFixtureSession.assertAppServerAvailable=originalAdmission;});\n`+
   `process.stderr.write('FIXTURE_NATIVE_PATCHED\\n');\n`);
  const cli=resolve('src/cli/main.ts');
  transport=new StdioClientTransport({command:process.execPath,cwd:resolve('.'),stderr:'pipe',
   args:['--import','tsx','--import',pathToFileURL(preload).href,cli,'--data-dir',root,'mcp',
    '--codex-workspace','ws','--codex-profile',profile.id,'--codex-managed']});
  transport.stderr?.on('data',(chunk:Buffer)=>{
   childPid??=transport?.pid??null;stderrBytes+=chunk.length;
   stderr=Buffer.concat([stderr,chunk.subarray(0,Math.max(0,65_536-stderr.length))]);retain();
  });
  transport.onclose=()=>{transportClosed=true;};
  client=new Client({name:'managed-diagnostic-fixture',version:'1.0.0'});
  phase('connect_begin');
  t.diagnostic('fixture connecting');
  await client.connect(transport,{timeout:30_000,signal:t.signal})
   .catch(error=>{throw new Error(`fixture connect: ${stderr.toString('utf8')}`,{cause:error});});
  childPid??=transport.pid;phase('connect_end');
  t.diagnostic('fixture connected');
  assert.match(stderr.toString('utf8'),/FIXTURE_NATIVE_PATCHED/,'native seam must be installed before submitting');
  const scope={workspaceId:'ws',collaborationId:'col'};
  phase('submit_begin');
  const reply=await client.callTool({name:'investigate.submit',arguments:{scope,idempotencyKey:'one-submit',
   payload:{workingCopyId:'copy',input:{snapshotRef:snapshotId,contextRevisionId:'ctx',question:'Read the constant',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],
    parentInvestigationId:null}}}},{signal:t.signal});
  phase('submit_end');
  t.diagnostic('fixture submitted');
  assert.equal(reply.isError,undefined,JSON.stringify(reply));
  const submitted=JSON.parse((reply.content[0] as {text:string}).text) as InvestigationRecord;
  // The queue can wait one 10-second tick, then verify the runtime twice before
  // creating the unchanged 15-second worker grant/native budget. The timed
  // fixture observed 11.8 seconds for one identical runtime verification.
  const deadline=performance.now()+60_000;
  while(performance.now()<deadline&&!stderr.includes('codex_managed_diagnostic')){
   t.signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,100));
  }
  t.signal.throwIfAborted();phase('diagnostic_observation_end');
  assert.match(stderr.toString('utf8'),/FIXTURE_NATIVE_OPEN_CALLED/,'replacement native open must have run');
  assert.match(stderr.toString('utf8'),/codex_managed_diagnostic/,'bounded diagnostic must arrive');
  phase('get_begin');
  const get=await client.callTool({name:'investigate.get',arguments:{scope,
   payload:{workingCopyId:'copy',requestId:submitted.id}}},{timeout:5_000,signal:t.signal})
   .catch(error=>{throw new Error(`fixture get: ${stderr.toString('utf8')}`,{cause:error});});
  phase('get_end');
  const fetched=JSON.parse((get.content[0] as {text:string}).text) as InvestigationRecord;
  t.diagnostic(`fixture observed ${fetched.state}, diagnostic=true`);
  assert.equal(fetched.state,'recovery_required');
  assert.equal(fetched.result,null);
  const facts=stderr.toString('utf8').split(/\r?\n/u).filter(line=>line.includes('codex_managed_diagnostic'));
  assert.equal(facts.length,1,stderr.toString('utf8'));
  assert.deepEqual(JSON.parse(facts[0]!),{kind:'codex_managed_diagnostic',requestId:submitted.id,
   failure:{stage:'native_open',code:'INTERNAL_ERROR'}});
  assert.doesNotMatch(stderr.toString('utf8'),/PRIVATE_NATIVE_ERROR/);
  assert.equal(stderrBytes,stderr.length,'fixture stderr must not overflow its retained bound');
  t.signal.throwIfAborted();passed=true;phase('assertions_passed');
 }catch(error){primary=error;phase('fixture_failed');}
 finally{
  try{await closeClient();}catch(error){cleanupErrors.push(error);}
  try{store?.close();storeClose=store?'resolved':'not_started';}
  catch(error){storeClose='failed';cleanupErrors.push(error);}
  t.signal.removeEventListener('abort',abort);phase('cleanup_end');
  if(passed&&!t.signal.aborted&&cleanupErrors.length===0&&transportClosed)
   rmSync(root,{recursive:true,force:true});
  else{
   t.diagnostic(`fixture retained: ${root}`);
   if(passed&&!transportClosed)cleanupErrors.push(new Error('Fixture transport close unconfirmed'));
  }
 }
 if(cleanupErrors.length)throw new AggregateError(primary?[primary,...cleanupErrors]:cleanupErrors,
  'Managed fixture cleanup failed');
 if(primary)throw primary;
});

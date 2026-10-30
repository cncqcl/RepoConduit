import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {createWindowsOriginalOwnerFactory} from
  '../../src/adapters/codex/investigator/windows-original-owner.js';
import {closeWindowsFrozenSource} from
  '../../src/adapters/codex/investigator/windows-source-view.js';
import {prepareWindowsInvestigationSource} from
  '../../src/runtime/windows-investigation-source-preparation.js';
import {prepareWindowsInvestigatorRuntime} from
  '../../src/runtime/windows-investigation-runtime-config.js';
import {runInvestigationCleanupTick} from '../../src/runtime/investigation-recovery.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';
import type {RequestContext} from '../../src/core/policy/authorize.js';

async function fixture(){
 const root=mkdtempSync(join(homedir(),'rcac-win-original-owner-'));
 protectNewDataDirectory(root);
 const file=join(root,'state.sqlite'),base=new SqliteStore(file),workspaceId=`ws_${randomUUID()}`;
 const context:RequestContext={principal:'owner',audience:'local-os',recipient:'owner',
  surface:'local_admin',now:new Date()};
 base.insertWorkspace({id:workspaceId,name:'synthetic',canonicalRoot:root,registeredBy:'owner'});
 base.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'synthetic',
  hostThreadId:null,state:'open'});
 base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:root});
 base.insertGrant({id:'admin',principal:'owner',audience:'local-os',recipient:'owner',
  workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
 base.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'remote',
  workspaceId,collaborationId:'col',permissions:['investigation.request','investigation.cancel'],
  expiresAt:null,revokedAt:null});
 base.insertGrant({id:'read',principal:'external',audience:'chatgpt',recipient:'remote',
  workspaceId,collaborationId:'col',permissions:['data.read'],dataPaths:['README.md'],
  expiresAt:null,revokedAt:null});
 const revision=base.insertProfileRevision({workspaceId,expectedRevisionId:null,
  presetRef:'static_readonly_v1',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:2}},
  'owner',new Date());
 const runtime=prepareWindowsInvestigatorRuntime(root,base,context,
  {workspaceId,profileRevision:revision.id,modelRef:'gpt-6-sol'});
 const snapshot=createSnapshotFromFiles('copy','a'.repeat(40),
  {'README.md':Buffer.from('synthetic original owner source\n')});
 await base.saveSnapshot({workspaceId,collaborationId:'col',workingCopyId:'copy',
  snapshot:snapshot.toPersisted()},
  {workspaceId,collaborationId:'col',workingCopyId:'copy',commitRef:'a'.repeat(40)},
  'capture','owner','local-os');
 const factory=createWindowsOriginalOwnerFactory();
 // These two admission substitutes are only for this synthetic integration test.
 const store=new SqliteInvestigationStore(file,{verifyIsolation:()=>true,
  verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
  verifyWindowsLaunch:()=>true,verifyWindowsLaunchNotStarted:factory.verifyNotStarted});
 const now=new Date();
 const record:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
  principal:'external',audience:'chatgpt',recipient:'remote',grantId:'request',
  profileRef:revision.id,budgetRef:revision.id,budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:2},
  contextRevisionId:'ctx',snapshotRef:snapshot.id,question:'synthetic',
  scope:{paths:['README.md'],symbols:[],relatedTests:[]},requestedOutputs:['flow'],
  parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,
  createdAt:now.toISOString()};
 store.enqueue(record,'key','fingerprint');
 const claim=store.claimRequest(record.id,{workerId:'synthetic-worker',
  isolationEvidence:'synthetic test component only',profileRevision:revision.id,
  permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
 const expected={workspaceId,collaborationId:'col',workingCopyId:'copy',snapshotRef:snapshot.id,
  contextRevisionId:'ctx',recipient:'remote',requestId:'inv',attemptId:claim.attemptId,
  workerEpoch:claim.workerEpoch};
 const staged=await prepareWindowsInvestigationSource({store,
  snapshots:{getSnapshot:base.getSnapshot.bind(base)},claim,expected,privateRoot:root,
  now:()=>new Date()});
 // This fixture owns its worker throughout source preparation. Keep its existing
 // 30-second lease current; a larger helper budget does not renew that lease.
 store.renewLease(staged.claim,new Date());
 const binding={collaborationId:'col',sourceDigest:staged.view.sourceDigest,
  profileRevision:revision.id,permissionEpoch:0,
  protocolTarget:'windows-desktop-codex-0.163.0-alpha.11' as const,
  recipe:'windows_app_server_readonly_v1' as const,runtimeId:runtime.runtimeId,
  configSha256:runtime.configSha256};
 const input={runtimeRoot:runtime.root,sourcePath:staged.view.viewPath,
  claim:staged.claim,binding,maxWallSeconds:record.budget.maxWallSeconds};
 return {root,file,base,store,factory,input,claim:staged.claim,close(verified:boolean){
  store.close();base.close();
  if(!verified){console.error('retained-native-fixture',root);return;}
  const actual=realpathSync.native(root),home=realpathSync.native(homedir());
  assert.ok(actual.startsWith(home+sep)&&basename(actual).startsWith('rcac-win-original-owner-')&&
    lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink()&&resolve(root)===root);
  rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
 }};
}

function settle(f:Awaited<ReturnType<typeof fixture>>){
 const at=new Date(Date.now()+31_000);
 const lease=f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'synthetic-cleanup',at)!;
 assert.ok(lease.windowsSource);
 const sourceClosed=closeWindowsFrozenSource(lease.windowsSource!.descriptor,
  lease.windowsSource!.privateRoot);
 return f.store.settleNotStartedWindowsLaunchAttempt(lease,sourceClosed,
  new Date(at.getTime()+1));
}

test('actual original helper owns prepared, durable begin, empty closure, SQLite fact and source recovery',
 {skip:process.platform!=='win32',timeout:180000},async t=>{
 const started=performance.now();
 const phase=(stage:string)=>console.error('ORIGINAL_OWNER_PHASE',JSON.stringify({
  test:'durable-closure',stage,elapsedMs:Math.round(performance.now()-started)}));
 phase('fixture_begin');const f=await fixture();phase('fixture_end');let verified=false;
 const failures:unknown[]=[];
 let owner:Awaited<ReturnType<typeof f.factory.prepare>>|undefined;
 try{
  phase('prepare_begin');
  owner=await f.factory.prepare(f.input);
  f.store.renewLease(f.claim,new Date());phase('lease_renewed');
  phase('prepare_end');phase('reserve_begin');
  const launch=owner.reserveLaunch(f.store,new Date());
  phase('reserve_end');
  assert.equal(f.store.getWindowsLaunch(f.claim)?.launchId,launch.launchId);
  f.base.revokeGrant('read',new Date().toISOString());
  assert.equal(f.factory.verifyNotStarted(launch,{
   kind:'windows_app_server_not_started_v1',launchId:launch.launchId} as never),false);
  phase('close_begin');const pending=owner.stopAndRecord(f.store,new Date());
  const wrong=new SqliteInvestigationStore(f.file);
  try{await assert.rejects(owner.stopAndRecord(wrong,new Date()));}
  finally{wrong.close();}
  await assert.rejects(owner.stopAndRecord(f.store,new Date(Number.NaN)));
  const fact=await pending;phase('close_end');
  assert.equal(fact.launchId,launch.launchId);
  assert.equal(fact.observation.preparedClosed.members.complete,true);
  assert.equal(fact.observation.preparedClosed.members.assigned,0);
  assert.equal(fact.observation.helperExitCode,0);
  assert.ok(fact.observation.helper.pid>0);
  console.log('actual-original-owner',JSON.stringify({launchId:fact.launchId,
   helper:fact.observation.helper,hostScopeId:fact.observation.hostScopeId,
   executionInstanceId:fact.observation.executionInstanceId,
   prepared:fact.observation.prepared,preparedClosed:fact.observation.preparedClosed,
   helperExitCode:fact.observation.helperExitCode}));
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim)?.recordedAt,fact.recordedAt);
  const reopened=new SqliteInvestigationStore(f.file);
  try{assert.equal(reopened.getWindowsLaunchNotStarted(f.claim)?.launchId,launch.launchId);}
  finally{reopened.close();}
  const db=new DatabaseSync(f.file);
  try{db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?')
   .run(new Date(Date.now()-1).toISOString(),'inv');}
  finally{db.close();}
  await runInvestigationCleanupTick(f.store,'synthetic-cleanup');
  const settled=f.store.get('inv')!;
  assert.equal(settled.failureReason,'windows_launch_not_started');
  assert.equal(settled.result,null);
  assert.equal(settled.attempts[0]?.terminationConfirmed,false);
  console.log('actual-original-owner-settlement',JSON.stringify({state:settled.state,
   failureReason:settled.failureReason,result:settled.result,
   terminationConfirmed:settled.attempts[0]?.terminationConfirmed}));
  assert.equal(f.store.listUnsettled().length,0);
  verified=true;phase('assertions_passed');
 }catch(error){failures.push(error);phase('failed');}
 finally{
  if(owner){phase('cleanup_close_begin');try{await owner.close();phase('cleanup_close_end');}
   catch(error){failures.push(error);phase('cleanup_close_failed');}}
  try{f.close(verified&&!t.signal.aborted&&failures.length===0);phase('fixture_close_end');}
  catch(error){failures.push(error);}
 }
 if(failures.length===1)throw failures[0];
 if(failures.length>1)throw new AggregateError(failures,
  'Original owner assertion and cleanup failed',{cause:failures[0]});
});

test('actual closed owner retries one original fact after SQLite insert failure without another stop',
 {skip:process.platform!=='win32',timeout:180000},async t=>{
 const started=performance.now();
 const phase=(stage:string)=>console.error('ORIGINAL_OWNER_PHASE',JSON.stringify({
  test:'original-fact-retry',stage,elapsedMs:Math.round(performance.now()-started)}));
 phase('fixture_begin');const f=await fixture();phase('fixture_end');let verified=false;
 const failures:unknown[]=[];
 let owner:Awaited<ReturnType<typeof f.factory.prepare>>|undefined;
 try{
  phase('prepare_begin');
  owner=await f.factory.prepare(f.input);
  f.store.renewLease(f.claim,new Date());phase('lease_renewed');
  phase('prepare_end');phase('reserve_begin');
  const launch=owner.reserveLaunch(f.store,new Date());
  phase('reserve_end');
  const db=new DatabaseSync(f.file);
  try{
   db.exec(`CREATE TRIGGER deny_original_fact BEFORE INSERT ON
    investigation_windows_app_server_not_started BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END;`);
   phase('close_begin');
   await assert.rejects(owner.stopAndRecord(f.store,new Date()),/synthetic insert failure/);
   phase('insert_failure_observed');
   assert.equal(f.store.getWindowsLaunchNotStarted(f.claim),null);
   db.exec('DROP TRIGGER deny_original_fact');
  }finally{db.close();}
  const completed=await owner.close();phase('close_end');
  const exact={kind:'windows_app_server_not_started_v1',protocol:'windows_job_stdio_v1',
   helperVersion:'3',recipe:'windows_app_server_readonly_v1',launchId:launch.launchId,
   hostScopeId:launch.binding.hostScopeId,executionInstanceId:launch.binding.executionInstanceId,
   helper:completed.helper,prepared:{kind:'prepared',sequence:1,childPresent:false},
   preparedClosed:{kind:'prepared_closed',sequence:2,childPresent:false,
    members:completed.members},helperExitCode:0};
  assert.equal(f.factory.verifyNotStarted(launch,exact as never),true);
  assert.equal(createWindowsOriginalOwnerFactory().verifyNotStarted(launch,exact as never),false);
  assert.equal(f.factory.verifyNotStarted({...launch,binding:{...launch.binding,
   sourceDigest:'a'.repeat(64)}},exact as never),false);
  assert.equal(f.factory.verifyNotStarted({...launch,workspaceId:'ws_other'},exact as never),false);
  assert.equal(f.factory.verifyNotStarted({...launch,launchEpoch:launch.launchEpoch+1},
   exact as never),false);
  assert.equal(f.factory.verifyNotStarted({...launch,binding:{...launch.binding,
   runtimeId:randomUUID()}},exact as never),false);
  assert.equal(f.factory.verifyNotStarted({...launch,binding:{...launch.binding,
   configSha256:'a'.repeat(64)}},exact as never),false);
  assert.equal(f.factory.verifyNotStarted(launch,{...exact,helper:{...exact.helper,
   pid:exact.helper.pid+1}} as never),false);
  const cancelled=f.store.requestCancel(f.store.get('inv')!,'late-cancel','request');
  assert.equal(cancelled.cancelRequested,true);
  f.base.revokeGrant('request',new Date().toISOString());
  const fact=await owner.stopAndRecord(f.store,new Date());
  assert.equal(fact.launchId,launch.launchId);
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim)?.launchId,launch.launchId);
  const settled=settle(f);
  assert.equal(settled.state,'cancelled');
  assert.equal(settled.result,null);
  assert.equal(settled.attempts[0]?.terminationConfirmed,false);
  assert.equal(f.store.listUnsettled().length,0);
  verified=true;phase('assertions_passed');
 }catch(error){failures.push(error);phase('failed');}
 finally{
  if(owner){phase('cleanup_close_begin');try{await owner.close();phase('cleanup_close_end');}
   catch(error){failures.push(error);phase('cleanup_close_failed');}}
  try{f.close(verified&&!t.signal.aborted&&failures.length===0);phase('fixture_close_end');}
  catch(error){failures.push(error);}
 }
 if(failures.length===1)throw failures[0];
 if(failures.length>1)throw new AggregateError(failures,
  'Original owner assertion and cleanup failed',{cause:failures[0]});
});

test('default SQLite launch admission refuses before begin; actual owner closes empty helper without a fact',
 {skip:process.platform!=='win32',timeout:180000},async t=>{
 const f=await fixture();let verified=false;
 let owner:Awaited<ReturnType<typeof f.factory.prepare>>|undefined;
 try{
  owner=await f.factory.prepare(f.input);
  t.signal.throwIfAborted();f.store.renewLease(f.claim,new Date());
  const denied=new SqliteInvestigationStore(f.file,{verifyIsolation:()=>true,
   verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false});
  try{assert.throws(()=>owner!.reserveLaunch(denied,new Date()));}
  finally{denied.close();}
  assert.throws(()=>owner!.reserveLaunch(f.store,new Date()));
  const closed=await owner.close();
  assert.equal(closed.kind,'prepared_closed');
  assert.equal(closed.members.assigned,0);
  assert.equal(closed.helperExitCode,0);
  assert.equal(f.store.getWindowsLaunch(f.claim),null);
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim),null);
  verified=true;
 }finally{if(owner)await owner.close().catch(()=>{});f.close(verified);}
});

test('source byte tamper, in-flight lock and closed tombstone refuse before helper spawn',
 {skip:process.platform!=='win32',timeout:180000},async()=>{
 const f=await fixture();let verified=false;
 try{
  const source=join(f.input.sourcePath,'README.md');
  const original=readFileSync(source);
  writeFileSync(source,'changed synthetic bytes\n');
  await assert.rejects(f.factory.prepare(f.input),
   {message:'WINDOWS_ORIGINAL_OWNER_UNAVAILABLE'});
  writeFileSync(source,original);
  const lock=join(f.root,`${f.claim.attemptId}.source.lock`);
  writeFileSync(lock,'synthetic in flight\n');
  await assert.rejects(f.factory.prepare(f.input),
   {message:'WINDOWS_ORIGINAL_OWNER_UNAVAILABLE'});
  unlinkSync(lock);
  const tombstone=join(f.root,`${f.claim.attemptId}.source.closed.json`);
  writeFileSync(tombstone,'{}');
  await assert.rejects(f.factory.prepare(f.input),
   {message:'WINDOWS_ORIGINAL_OWNER_UNAVAILABLE'});
  verified=true;
 }finally{f.close(verified);}
});

test('abort after original durable begin keeps the launch occupied and records no absence fact',
 {skip:process.platform!=='win32',timeout:180000},async t=>{
 const started=performance.now();
 const phase=(stage:string)=>console.error('ORIGINAL_OWNER_PHASE',JSON.stringify({
  test:'abort-after-begin',stage,elapsedMs:Math.round(performance.now()-started)}));
 phase('fixture_begin');
 const f=await fixture();
 phase('fixture_end');
 const abort=new AbortController();
 const abortTest=()=>abort.abort();
 t.signal.addEventListener('abort',abortTest,{once:true});
 let owner:Awaited<ReturnType<typeof f.factory.prepare>>|undefined;
 const failures:unknown[]=[];let observedAbort=false;
 try{
  t.signal.throwIfAborted();phase('prepare_begin');
  owner=await f.factory.prepare({...f.input,signal:abort.signal});
  phase('prepare_end');t.signal.throwIfAborted();
  f.store.renewLease(f.claim,new Date());phase('lease_renewed');
  owner.reserveLaunch(f.store,new Date());
  phase('reserve_end');
  abort.abort();
  observedAbort=true;
  phase('abort_sent');
  await assert.rejects(owner.stopAndRecord(f.store,new Date()));
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim),null);
  assert.equal(f.store.listUnsettled().length,1);
 }catch(error){failures.push(error);}
 finally{
  t.signal.removeEventListener('abort',abortTest);
  if(owner){
   phase('cleanup_close_begin');
   try{
    if(!observedAbort){await owner.close();phase('cleanup_close_end');}
    else{
     await assert.rejects(owner.close(),error=>{
      assert.ok(error instanceof Error&&error.message==='WINDOWS_ORIGINAL_OWNER_UNKNOWN');
      const cause=error.cause as Record<string,unknown>|undefined;
      assert.ok(cause&&cause.failed===true&&cause.aborted===true&&
       cause.stdoutEnded===true&&cause.stderrEnded===true&&cause.pidPresent===true&&
       typeof cause.exitCode==='number'&&
       (cause.firstFailure as {origin?:unknown}|undefined)?.origin==='abort',
      'abort cleanup requires an actual original-child close event, not a timeout');
      return true;
     });
     phase('aborted_child_exit_observed_without_absence_fact');
    }
   }catch(error){failures.push(error);phase('cleanup_close_unconfirmed');}
  }
  try{f.close(false);phase('fixture_close_end');}catch(error){failures.push(error);}
 }
 if(failures.length===1)throw failures[0];
 if(failures.length>1)throw new AggregateError(failures,
  'Original owner abort assertion and cleanup failed',{cause:failures[0]});
});

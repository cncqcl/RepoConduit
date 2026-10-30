import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SessionControlSqlite} from '../../src/adapters/storage/session-control-sqlite.js';
import {runInvestigationCleanupTick} from '../../src/runtime/investigation-recovery.js';
import {inspectInstallationStateDatabase} from '../../src/runtime/installation-state-preflight.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';
import type {WindowsAppServerNotStartedObservation} from
 '../../src/adapters/codex/investigator/windows-launch-record.js';

function fixture(verifyNotStarted?:()=>boolean){
 const dir=mkdtempSync(join(tmpdir(),'rcac-not-started-')),file=join(dir,'state.sqlite'),
  now=new Date(Date.now()-60_000);
 const base=new SqliteStore(file),workspaceId=`ws_${randomUUID()}`;
 base.insertWorkspace({id:workspaceId,name:'A',canonicalRoot:dir,registeredBy:'owner'});
 base.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'investigate',hostThreadId:null,state:'open'});
 base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:dir});
 base.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
  collaborationId:'col',permissions:['investigation.request'],expiresAt:null,revokedAt:null});
 base.insertGrant({id:'read',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
  collaborationId:'col',permissions:['data.read'],dataPaths:['src/a.ts'],expiresAt:null,revokedAt:null});
 const request:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
  principal:'external',audience:'chatgpt',recipient:'remote',grantId:'request',profileRef:'readonly',
  budgetRef:'bounded',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:2},contextRevisionId:'ctx',
  snapshotRef:'snap',question:'Trace flow',scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},
  requestedOutputs:['flow'],parentInvestigationId:null,state:'queued',cancelRequested:false,
  attempts:[],result:null,createdAt:now.toISOString()};
 const authority={verifyIsolation:()=>true,verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
  verifyWindowsLaunch:()=>true,...(verifyNotStarted?{verifyWindowsLaunchNotStarted:verifyNotStarted}:{})};
 const store=new SqliteInvestigationStore(file,authority);
 store.enqueue(request,'one','one');
 const first=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'component fixture',
  profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
 const sourceDigest='a'.repeat(64),privateRoot='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
 const descriptor={attemptId:first.attemptId,workspaceId,workerEpoch:first.workerEpoch,sourceDigest};
 const reserved=store.reserveWindowsSourceView(first,descriptor,privateRoot,['src/a.ts'],now);
 const claim=store.confirmWindowsSourcePrepared(reserved,{viewPath:win32.join(privateRoot,`${first.attemptId}.view`),
  sourceDigest,isolationVerified:false},now);
 const binding={collaborationId:'col',sourceDigest,profileRevision:'readonly',permissionEpoch:0,
  protocolTarget:'windows-desktop-codex-0.163.0-alpha.11' as const,
  recipe:'windows_app_server_readonly_v1' as const,hostScopeId:randomUUID(),
  executionInstanceId:randomUUID(),runtimeId:randomUUID(),configSha256:'b'.repeat(64)};
 const launch=store.beginWindowsAppServerLaunch(claim,binding,now);
 const observation={kind:'windows_app_server_not_started_v1' as const,protocol:'windows_job_stdio_v1' as const,
  helperVersion:'3' as const,recipe:'windows_app_server_readonly_v1' as const,launchId:launch.launchId,
  hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId,
  helper:{pid:1234,creationFiletime:'133000000000000000'},
  prepared:{kind:'prepared' as const,sequence:1 as const,childPresent:false as const},
  preparedClosed:{kind:'prepared_closed' as const,sequence:2 as const,childPresent:false as const,
   members:{complete:true as const,assigned:0 as const,listed:0 as const,pids:[] as []}},helperExitCode:0 as const};
 const sourceClosed={kind:'closed' as const,descriptor,viewPath:win32.join(privateRoot,`${first.attemptId}.view`),
  isolationVerified:false as const};
 return {dir,file,base,store,claim,launch,observation,sourceClosed,now,authority,
  close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('not-started registration requires exact transcript and independent verifier, then fences start and child facts',()=>{
 const denied=fixture();try{
  assert.throws(()=>denied.store.recordWindowsLaunchNotStarted(denied.launch,denied.observation,denied.now));
  assert.equal(denied.store.getWindowsLaunchNotStarted(denied.claim),null);
 }finally{denied.close();}
 const f=fixture(()=>true);try{
  for(const changed of [
   {...f.observation,helperExitCode:1},
   {...f.observation,preparedClosed:{...f.observation.preparedClosed,sequence:3}},
   {...f.observation,preparedClosed:{...f.observation.preparedClosed,childPresent:true}},
   {...f.observation,hostScopeId:randomUUID()},
  ]) assert.throws(()=>f.store.recordWindowsLaunchNotStarted(f.launch,
    changed as unknown as WindowsAppServerNotStartedObservation,f.now));
  const first=f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  assert.equal(first.observation.kind,'windows_app_server_not_started_v1');
  assert.deepEqual(f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,new Date(f.now.getTime()+1000)),first);
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim)?.launchId,f.launch.launchId);
  assert.equal(f.store.getWindowsLaunch(f.claim)?.state,'recovery_required');
  assert.throws(()=>f.store.dispatchWindowsLaunchStartOnce(f.claim,f.launch,f.now,()=>{}));
  assert.throws(()=>f.store.recordWindowsLaunchObservation(f.launch,{pid:42,
   creationFiletime:'133000000000000000',hostScopeId:f.launch.binding.hostScopeId,
   executionInstanceId:f.launch.binding.executionInstanceId},f.now));
  assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,f.launch.launchId,f.now));
  const peer=new SqliteInvestigationStore(f.file,f.authority);
  try{assert.deepEqual(peer.getWindowsLaunchNotStarted(f.claim),first);}finally{peer.close();}
 }finally{f.close();}
});

test('no saved not-started fact, missing reservation, or native journal cannot release occupied launch',()=>{
 const f=fixture(()=>true);try{
  const later=new Date(f.now.getTime()+30_001);
  assert.throws(()=>f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',later));
  const db=new DatabaseSync(f.file);
  try{db.prepare('DELETE FROM investigation_windows_app_server_start_intents WHERE launch_id=?').run(f.launch.launchId);
   assert.throws(()=>f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now));
  }finally{db.close();}
  assert.equal(f.store.listUnsettled().length,1);
 }finally{f.close();}
});

test('stable consumed start intent still permits independent no-child proof',()=>{
 const f=fixture(()=>true);try{
  const db=new DatabaseSync(f.file);
  try{
   const row=db.prepare('SELECT record_json FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
    .get(f.launch.launchId) as {record_json:string};
   db.prepare('UPDATE investigation_windows_app_server_start_intents SET record_json=? WHERE launch_id=?')
    .run(JSON.stringify({...JSON.parse(row.record_json) as object,consumedAt:f.now.toISOString()}),f.launch.launchId);
  }finally{db.close();}
  const fact=f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim)?.launchId,fact.launchId);
  const cleanup=f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',
   new Date(f.now.getTime()+30_001));
  assert.equal(cleanup?.workerEpoch,f.claim.workerEpoch+1);
 }finally{f.close();}
});

test('verifier reentry cannot retime the start opportunity or publish a no-child fact',()=>{
 let mutate=()=>{};
 const f=fixture(()=>{mutate();return true;});
 try{
  mutate=()=>{
   const db=(f.store as unknown as {db:DatabaseSync}).db;
   const row=db.prepare('SELECT record_json FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
    .get(f.launch.launchId) as {record_json:string};
   db.prepare('UPDATE investigation_windows_app_server_start_intents SET record_json=? WHERE launch_id=?')
    .run(JSON.stringify({...JSON.parse(row.record_json) as object,consumedAt:f.now.toISOString()}),f.launch.launchId);
  };
  assert.throws(()=>f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now));
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim),null);
  assert.equal(f.store.getWindowsLaunchStartIntent(f.claim)?.consumedAt,null);
 }finally{f.close();}
});

test('verifier reentry cannot add a native thread before no-child registration',()=>{
 let mutate=()=>{};
 const f=fixture(()=>{mutate();return true;});try{
  mutate=()=>{
   const db=(f.store as unknown as {db:DatabaseSync}).db;
   db.prepare(`INSERT INTO investigation_native_threads
     (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id)
     VALUES (?,?,?,?,?,NULL)`).run(f.claim.attemptId,f.claim.requestId,f.claim.workspaceId,
      'col',f.claim.workerEpoch);
  };
  assert.throws(()=>f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now));
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim),null);
  const db=new DatabaseSync(f.file,{readOnly:true});try{
   assert.equal((db.prepare('SELECT count(*) AS n FROM investigation_native_threads').get() as {n:number}).n,0);
  }finally{db.close();}
 }finally{f.close();}
});

test('historical target and attempts claiming a started process cannot settle no-child',()=>{
 const historical=fixture(()=>true);try{
  const old={...historical.launch,binding:{...historical.launch.binding,
   protocolTarget:'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' as const}};
  assert.throws(()=>historical.store.recordWindowsLaunchNotStarted(old,historical.observation,historical.now));
 }finally{historical.close();}
 const f=fixture(()=>true);try{
  f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  const db=new DatabaseSync(f.file);
  try{
   const row=db.prepare("SELECT record_json FROM investigation_requests WHERE id='inv'")
    .get() as {record_json:string};
   const record=JSON.parse(row.record_json) as {attempts:Array<Record<string,unknown>>};
   record.attempts[0]!.startedAt=f.now.toISOString();
   db.prepare("UPDATE investigation_requests SET record_json=? WHERE id='inv'")
    .run(JSON.stringify(record));
  }finally{db.close();}
  assert.throws(()=>f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',
   new Date(f.now.getTime()+30_001)));
 }finally{f.close();}
 const settling=fixture(()=>true);try{
  settling.store.recordWindowsLaunchNotStarted(settling.launch,settling.observation,settling.now);
  const cleanup=settling.store.acquireNotStartedWindowsLaunchCleanupLease(settling.claim,'cleanup',
   new Date(settling.now.getTime()+30_001))!;
  const db=new DatabaseSync(settling.file);try{
   const row=db.prepare("SELECT record_json FROM investigation_requests WHERE id='inv'")
    .get() as {record_json:string};
   const record=JSON.parse(row.record_json) as {attempts:Array<Record<string,unknown>>};
   record.attempts[0]!.startedAt=settling.now.toISOString();
   db.prepare("UPDATE investigation_requests SET record_json=? WHERE id='inv'")
    .run(JSON.stringify(record));
  }finally{db.close();}
  assert.throws(()=>settling.store.settleNotStartedWindowsLaunchAttempt(cleanup,
   settling.sourceClosed,new Date(settling.now.getTime()+30_002)));
  assert.equal(settling.store.listUnsettled().length,1);
 }finally{settling.close();}
});

test('not-started proof survives grant revocation and recovers source with a separate settlement, no result',async()=>{
 const f=fixture(()=>true);try{
  f.base.revokeGrant('read',f.now.toISOString());
  f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  const later=new Date(f.now.getTime()+30_001);
  let closes=0;
  await runInvestigationCleanupTick(f.store,'cleanup',undefined,f.store.listUnsettled(),undefined,undefined,
   {close:async()=>{closes++;return f.sourceClosed;}});
  assert.equal(closes,1);
  const settled=f.store.get('inv')!;
  assert.equal(settled.state,'failed');
  assert.equal(settled.failureReason,'windows_launch_not_started');
  assert.equal(settled.result,null);
  assert.equal(settled.attempts[0]?.terminationConfirmed,false);
  assert.equal(f.store.listUnsettled().length,0);
  const db=new DatabaseSync(f.file,{readOnly:true});
  try{
   assert.equal((db.prepare('SELECT count(*) AS n FROM investigation_windows_not_started_settlement_facts').get() as {n:number}).n,1);
   assert.equal((db.prepare('SELECT count(*) AS n FROM investigation_windows_launch_settlement_facts').get() as {n:number}).n,0);
  }finally{db.close();}
  assert.throws(()=>f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'other',later));
 }finally{f.close();}
});

test('wrong source closure and failed settlement insert keep the cleanup lease occupied',()=>{
 const f=fixture(()=>true);try{
  f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  const cleanup=f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',
   new Date(f.now.getTime()+30_001))!;
  assert.throws(()=>f.store.settleNotStartedWindowsLaunchAttempt(cleanup,
   {...f.sourceClosed,viewPath:'C:\\wrong.view'},new Date(f.now.getTime()+30_002)));
  const db=new DatabaseSync(f.file);
  try{
   db.exec(`CREATE TRIGGER deny_not_started_settlement BEFORE INSERT ON
    investigation_windows_not_started_settlement_facts BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;`);
   assert.throws(()=>f.store.settleNotStartedWindowsLaunchAttempt(cleanup,f.sourceClosed,
    new Date(f.now.getTime()+30_002)));
   assert.equal((db.prepare('SELECT count(*) AS n FROM investigation_windows_not_started_settlement_facts')
    .get() as {n:number}).n,0);
   assert.equal(f.store.get('inv')?.state,'recovery_required');
   assert.equal(f.store.listUnsettled().length,1);
   db.exec('DROP TRIGGER deny_not_started_settlement');
  }finally{db.close();}
  const later=new Date(f.now.getTime()+150_002);
  const second=f.store.acquireNotStartedWindowsLaunchCleanupLease(cleanup,'second',later)!;
  assert.equal(second.workerEpoch,cleanup.workerEpoch+1);
  assert.throws(()=>f.store.settleNotStartedWindowsLaunchAttempt(cleanup,f.sourceClosed,later));
  const settled=f.store.settleNotStartedWindowsLaunchAttempt(second,f.sourceClosed,
   new Date(later.getTime()+1));
  assert.equal(settled.state,'failed');
  assert.equal(settled.attempts[0]?.terminationConfirmed,false);
 }finally{f.close();}
});

test('cancelled no-child cleanup has null result and unconfirmed termination',()=>{
 const f=fixture(()=>true);try{
  f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  const cleanup=f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',
   new Date(f.now.getTime()+30_001))!;
  const db=new DatabaseSync(f.file);try{
   const row=db.prepare("SELECT record_json FROM investigation_requests WHERE id='inv'")
    .get() as {record_json:string};
   db.prepare("UPDATE investigation_requests SET record_json=? WHERE id='inv'")
    .run(JSON.stringify({...JSON.parse(row.record_json) as object,cancelRequested:true}));
  }finally{db.close();}
  const settled=f.store.settleNotStartedWindowsLaunchAttempt(cleanup,f.sourceClosed,
   new Date(f.now.getTime()+30_002));
  assert.equal(settled.state,'cancelled');
  assert.equal(settled.failureReason,'windows_launch_not_started');
  assert.equal(settled.result,null);
  assert.equal(settled.attempts[0]?.terminationConfirmed,false);
 }finally{f.close();}
});

const previousTargets=[
 'windows-desktop-26.930.3930.0-codex-0.160.0',
 'windows-desktop-26.930.4958.0-codex-0.160.0',
] as const;
function historicalize(f:ReturnType<typeof fixture>,target:typeof previousTargets[number]){
 const db=new DatabaseSync(f.file);
 try{
  const row=db.prepare('SELECT record_json FROM investigation_windows_app_server_launches WHERE attempt_id=?')
   .get(f.claim.attemptId) as {record_json:string};
  const current=JSON.parse(row.record_json) as typeof f.launch;
  const old={...current,binding:{...current.binding,protocolTarget:target}};
  db.prepare('UPDATE investigation_windows_app_server_launches SET record_json=? WHERE launch_id=?')
   .run(JSON.stringify(old),old.launchId);
  return old;
 }finally{db.close();}
}

test('previous full target cannot receive a new no-child fact after upgrade',()=>{
 for(const target of previousTargets){
 const f=fixture(()=>true);try{
  const old=historicalize(f,target);
  assert.throws(()=>f.store.recordWindowsLaunchNotStarted(old,f.observation,f.now));
  assert.equal(f.store.getWindowsLaunchNotStarted(f.claim),null);
  assert.throws(()=>f.store.dispatchWindowsLaunchStartOnce(f.claim,old,f.now,()=>{}));
 }finally{f.close();}
 }
});

test('previous full target reopens its existing exact no-child fact for idempotence and cleanup only',()=>{
 for(const target of previousTargets){
 const f=fixture(()=>true);try{
  const proof=f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  const old=historicalize(f,target);
  const peer=new SqliteInvestigationStore(f.file,f.authority);
  try{
   assert.deepEqual(peer.recordWindowsLaunchNotStarted(old,f.observation,
    new Date(f.now.getTime()+1)),proof);
   const later=new Date(f.now.getTime()+30_001);
   const cleanup=peer.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',later);
   assert.ok(cleanup);
   const settled=peer.settleNotStartedWindowsLaunchAttempt(cleanup!,f.sourceClosed,
    new Date(later.getTime()+1));
   assert.equal(settled.failureReason,'windows_launch_not_started');
   assert.equal(settled.result,null);
   assert.throws(()=>peer.assertWindowsLaunchUsable(f.claim,old.launchId,later));
  }finally{peer.close();}
 }finally{f.close();}
 }
});

test('installation scanner accepts exact settled previous full no-child row after reopen',()=>{
 for(const target of previousTargets){
 const f=fixture(()=>true);try{
  f.store.recordWindowsLaunchNotStarted(f.launch,f.observation,f.now);
  const later=new Date(f.now.getTime()+30_001);
  const cleanup=f.store.acquireNotStartedWindowsLaunchCleanupLease(f.claim,'cleanup',later)!;
  f.store.settleNotStartedWindowsLaunchAttempt(cleanup,f.sourceClosed,new Date(later.getTime()+1));
  historicalize(f,target);
  const sessions=new SessionControlSqlite(f.file);sessions.close();
  const readonly=new DatabaseSync(f.file,{readOnly:true});
  try{assert.doesNotThrow(()=>inspectInstallationStateDatabase(readonly));}
  finally{readonly.close();}
  const changed=new DatabaseSync(f.file);
  try{changed.prepare("UPDATE investigation_requests SET operation='investigate.request' WHERE id=?")
   .run('inv');}
  finally{changed.close();}
  const rejected=new DatabaseSync(f.file,{readOnly:true});
  try{assert.throws(()=>inspectInstallationStateDatabase(rejected),/INSTALLATION_STATE_UNSAFE/);}
  finally{rejected.close();}
 }finally{f.close();}
 }
});

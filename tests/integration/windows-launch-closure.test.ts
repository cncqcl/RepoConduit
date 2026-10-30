import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { LegacyWindowsAppServerLaunchBinding, WindowsAppServerClosureObservation,
  WindowsAppServerLaunchRecord } from
  '../../src/adapters/codex/investigator/windows-launch-record.js';

function fixture(verifyClosure?: (launch:WindowsAppServerLaunchRecord,
  observation:WindowsAppServerClosureObservation)=>boolean,
  verifyLaunch?:()=>boolean) {
  const dir=mkdtempSync(join(tmpdir(),'rcac-windows-closure-'));
  const file=join(dir,'state.sqlite'); const now=new Date();
  const base=new SqliteStore(file); const workspaceId=`ws_${randomUUID()}`;
  base.insertWorkspace({id:workspaceId,name:'A',canonicalRoot:dir,registeredBy:'owner'});
  base.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'investigate',
    hostThreadId:null,state:'open'});
  base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:dir});
  base.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
    collaborationId:'col',permissions:['investigation.request','investigation.cancel'],
    expiresAt:null,revokedAt:null});
  base.insertGrant({id:'read',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
    collaborationId:'col',permissions:['data.read'],dataPaths:['src/a.ts'],expiresAt:null,revokedAt:null});
  const record:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
    principal:'external',audience:'chatgpt',recipient:'remote',grantId:'request',profileRef:'readonly',
    budgetRef:'bounded',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:2},contextRevisionId:'ctx',
    snapshotRef:'snap',question:'Trace flow',scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['flow'],parentInvestigationId:null,state:'queued',cancelRequested:false,
    attempts:[],result:null,createdAt:now.toISOString()};
  const authority={verifyIsolation:()=>true,verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
    verifyWindowsLaunch:verifyLaunch??(()=>true),
    ...(verifyClosure?{verifyWindowsLaunchClosure:verifyClosure}:{})};
  const store=new SqliteInvestigationStore(file,authority);
  store.enqueue(record,'one','one');
  const claimed=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'fixture',
    profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
  const sourceDigest='a'.repeat(64);
  const descriptor={attemptId:claimed.attemptId,workspaceId,workerEpoch:claimed.workerEpoch,sourceDigest};
  const reserved=store.reserveWindowsSourceView(claimed,descriptor,
    'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator',['src/a.ts'],now);
  const claim=store.confirmWindowsSourcePrepared(reserved,
    {viewPath:win32.join('C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator',
      `${claimed.attemptId}.view`),sourceDigest,isolationVerified:false},now);
  const binding={collaborationId:'col',sourceDigest,profileRevision:'readonly',permissionEpoch:0,
    protocolTarget:'windows-desktop-codex-0.163.0-alpha.11' as const,
    recipe:'windows_app_server_readonly_v1' as const,
    hostScopeId:randomUUID(),executionInstanceId:randomUUID(),runtimeId:randomUUID(),
    configSha256:'b'.repeat(64)};
  const launch=store.beginWindowsAppServerLaunch(claim,binding,now);
  const identity={pid:1234,creationFiletime:'133000000000000000',
    hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId};
  const observation:WindowsAppServerClosureObservation={protocol:'windows_job_stdio_v1',
    helperVersion:'3',kind:'job_closed',recipe:'windows_app_server_readonly_v1',
    launchId:launch.launchId,hostScopeId:binding.hostScopeId,
    executionInstanceId:binding.executionInstanceId,root:{pid:identity.pid,
      creationFiletime:identity.creationFiletime},rootExited:true,stdoutEof:true,stderrEof:true,
    members:{complete:true,assigned:0,listed:0,pids:[]},helperExitCode:0,sequence:9};
  return {dir,file,base,store,claim,launch,identity,observation,now,
    close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('default closure verifier refuses persistence; observed exact closure is durable and idempotent',()=>{
  const closed=fixture();
  try {
    closed.store.recordWindowsLaunchObservation(closed.launch,closed.identity,closed.now);
    assert.throws(()=>closed.store.recordWindowsLaunchClosure(closed.launch,closed.observation,closed.now));
    assert.equal(closed.store.getWindowsLaunchClosure(closed.claim),null);
  } finally {closed.close();}
  const f=fixture((launch,observation)=>{
    assert.equal(Object.isFrozen(launch),true);
    assert.equal(Object.isFrozen(launch.binding),true);
    assert.equal(Object.isFrozen(launch.identity),true);
    assert.equal(Object.isFrozen(observation),true);
    assert.equal(Object.isFrozen(observation.members),true);
    return true;
  });
  try {
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    const first=f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
    assert.deepEqual(first.observation,f.observation);
    assert.equal(Object.isFrozen(first),true);
    assert.equal(Object.isFrozen(first.observation.root),true);
    const later=new Date(f.now.getTime()+1000);
    assert.deepEqual(f.store.recordWindowsLaunchClosure(f.launch,f.observation,later),first);
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,f.launch.launchId,later));
    assert.throws(()=>f.store.beginNativeThreadIntent(f.claim,'col',later));
    const peer=new SqliteInvestigationStore(f.file);
    try {assert.deepEqual(peer.getWindowsLaunchClosure(f.claim),first);}
    finally {peer.close();}
    assert.equal(f.store.get('inv')?.result,null);
    assert.equal(f.store.listUnsettled().length,1);
    assert.equal(f.store.getWindowsLaunch(f.claim)?.state,'observed');
  } finally {f.close();}
});

test('closure written by a trusted callback during launch recheck cannot permit RPC',()=>{
  let inject=false;
  const f=fixture(()=>true,()=>{
    if (inject) {
      // Fault injection within the outer SQLite transaction models a reentrant trusted callback.
      const db=(f.store as unknown as {db:DatabaseSync}).db;
      db.prepare(`INSERT INTO investigation_windows_app_server_closures
        (launch_id,record_json) VALUES (?,?)`).run(f.launch.launchId,
        JSON.stringify({launchId:f.launch.launchId,observation:f.observation,
          recordedAt:f.now.toISOString()}));
    }
    return true;
  });
  try {
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    inject=true;
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,f.launch.launchId,f.now));
    assert.equal(f.store.getWindowsLaunchClosure(f.claim),null);
  } finally {f.close();}
});

test('closure requires observed original identity and exact immutable origin',()=>{
  const f=fixture(()=>true);
  try {
    assert.throws(()=>f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now));
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    for(const observation of [
      {...f.observation,launchId:randomUUID()},
      {...f.observation,hostScopeId:randomUUID()},
      {...f.observation,executionInstanceId:randomUUID()},
      {...f.observation,root:{...f.observation.root,pid:f.identity.pid+1}},
      {...f.observation,root:{...f.observation.root,creationFiletime:'133000000000000001'}},
      {...f.observation,recipe:'desktop_readiness_v1'},
    ]) assert.throws(()=>f.store.recordWindowsLaunchClosure(f.launch,
      observation as WindowsAppServerClosureObservation,f.now));
    assert.throws(()=>f.store.recordWindowsLaunchClosure(
      {...f.launch,launchId:randomUUID()},f.observation,f.now));
    assert.equal(f.store.getWindowsLaunchClosure(f.claim),null);
  } finally {f.close();}
});

test('false terminal shapes, conflicting duplicate and invalid dates fail closed',()=>{
  const f=fixture(()=>true);
  try {
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    for(const observation of [
      {...f.observation,rootExited:false},
      {...f.observation,stdoutEof:false},
      {...f.observation,stderrEof:false},
      {...f.observation,members:{complete:true,assigned:1,listed:1,pids:[f.identity.pid]}},
      {...f.observation,members:{complete:false,assigned:0,listed:0,pids:[]}},
      {...f.observation,helperExitCode:1},
      {...f.observation,sequence:0},
      {...f.observation,sequence:4},
      {...f.observation,sequence:Number.MAX_SAFE_INTEGER+1},
    ]) assert.throws(()=>f.store.recordWindowsLaunchClosure(f.launch,
      observation as WindowsAppServerClosureObservation,f.now));
    assert.throws(()=>f.store.recordWindowsLaunchClosure(f.launch,f.observation,new Date('invalid')));
    const first=f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
    assert.throws(()=>f.store.recordWindowsLaunchClosure(f.launch,
      {...f.observation,sequence:10},f.now));
    assert.deepEqual(f.store.getWindowsLaunchClosure(f.claim),first);
  } finally {f.close();}
});

test('explicit false verifier refuses closure and a late identity can precede late closure',()=>{
  const denied=fixture(()=>false);
  try {
    denied.store.recordWindowsLaunchObservation(denied.launch,denied.identity,denied.now);
    assert.throws(()=>denied.store.recordWindowsLaunchClosure(
      denied.launch,denied.observation,denied.now));
    assert.equal(denied.store.getWindowsLaunchClosure(denied.claim),null);
  } finally {denied.close();}
  const late=fixture(()=>true);
  try {
    late.store.markWindowsLaunchRecoveryRequired(late.launch,late.now);
    const takeover=late.store.recoverAttempt(late.claim,{workerId:'recovery',
      isolationEvidence:'fixture',profileRevision:'readonly',permissionEpoch:0,
      now:new Date(late.now.getTime()+30_001)});
    late.base.revokeGrant('read',new Date(late.now.getTime()+30_001).toISOString());
    late.store.recordWindowsLaunchObservation(late.launch,late.identity,
      new Date(late.now.getTime()+30_002));
    const closure=late.store.recordWindowsLaunchClosure(late.launch,late.observation,
      new Date(late.now.getTime()+30_003));
    assert.deepEqual(late.store.getWindowsLaunchClosure(takeover),closure);
    assert.equal(late.store.getWindowsLaunch(takeover)?.state,'recovery_required');
  } finally {late.close();}
});

test('late exact closure after revoke and owner takeover preserves occupied source and slot',()=>{
  const f=fixture(()=>true);
  try {
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    f.store.markWindowsLaunchRecoveryRequired(f.launch,f.now);
    const takeover=f.store.recoverAttempt(f.claim,{workerId:'recovery',isolationEvidence:'fixture',
      profileRevision:'readonly',permissionEpoch:0,now:new Date(f.now.getTime()+30_001)});
    f.base.revokeGrant('read',new Date(f.now.getTime()+30_001).toISOString());
    const fact=f.store.recordWindowsLaunchClosure(f.launch,f.observation,
      new Date(f.now.getTime()+30_002));
    assert.deepEqual(f.store.getWindowsLaunchClosure(takeover),fact);
    assert.equal(f.store.getWindowsLaunch(takeover)?.state,'recovery_required');
    assert.equal(f.store.listUnsettled().length,1);
    assert.equal(f.store.get('inv')?.result,null);
    assert.throws(()=>f.store.assertWindowsLaunchUsable(takeover,f.launch.launchId,
      new Date(f.now.getTime()+30_002)));
  } finally {f.close();}
});

test('recovery read rejects a malformed persisted closure identity',()=>{
  const f=fixture(()=>true);
  try {
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    const closure=f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
    const db=new DatabaseSync(f.file);
    try {
      const altered={...closure,observation:{...closure.observation,
        root:{...closure.observation.root,pid:closure.observation.root.pid+1}}};
      db.prepare(`UPDATE investigation_windows_app_server_closures SET record_json=?
        WHERE launch_id=?`).run(JSON.stringify(altered),f.launch.launchId);
    } finally {db.close();}
    assert.throws(()=>f.store.getWindowsLaunchClosure(f.claim));
  } finally {f.close();}
});

test('legacy origin admits exact late closure but rejects a forged runtime rebind',()=>{
  const f=fixture(()=>true);
  try {
    const current=f.launch.binding;
    const binding:LegacyWindowsAppServerLaunchBinding={collaborationId:current.collaborationId,
      sourceDigest:current.sourceDigest,profileRevision:current.profileRevision,
      permissionEpoch:current.permissionEpoch,protocolTarget:"windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1",
      recipe:current.recipe,hostScopeId:current.hostScopeId,
      executionInstanceId:current.executionInstanceId};
    const legacy={...f.launch,binding};
    const db=new DatabaseSync(f.file);
    try {db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
      WHERE launch_id=?`).run(JSON.stringify(legacy),f.launch.launchId);}
    finally {db.close();}
    f.store.recordWindowsLaunchObservation(legacy,f.identity,f.now);
    assert.throws(()=>f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now));
    const fact=f.store.recordWindowsLaunchClosure(legacy,f.observation,f.now);
    assert.deepEqual(f.store.getWindowsLaunchClosure(f.claim),fact);
    assert.deepEqual(f.store.getWindowsLaunch(f.claim)?.binding,binding);
  } finally {f.close();}
});

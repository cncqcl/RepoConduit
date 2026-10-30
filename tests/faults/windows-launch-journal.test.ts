import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { CurrentWindowsAppServerLaunchBinding, LegacyWindowsAppServerLaunchBinding,
  WindowsAppServerClosureObservation, WindowsAppServerProcessIdentity } from
  '../../src/adapters/codex/investigator/windows-launch-record.js';

const privateRoot='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
const sourceDigest='a'.repeat(64);

function fixture(verified=false, verifyWindowsLaunch?: () => boolean) {
  const dir=mkdtempSync(join(tmpdir(),'rcac-windows-launch-'));
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
    ...(verifyWindowsLaunch?{verifyWindowsLaunch}:verified?{verifyWindowsLaunch:()=>true}:{})};
  const store=new SqliteInvestigationStore(file,authority);
  store.enqueue(record,'one','one');
  const claimed=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'fixture',
    profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
  const descriptor={attemptId:claimed.attemptId,workspaceId,workerEpoch:claimed.workerEpoch,sourceDigest};
  const reserved=store.reserveWindowsSourceView(claimed,descriptor,privateRoot,['src/a.ts'],now);
  const claim=store.confirmWindowsSourcePrepared(reserved,
    {viewPath:win32.join(privateRoot,`${claimed.attemptId}.view`),sourceDigest,isolationVerified:false},now);
  const binding:CurrentWindowsAppServerLaunchBinding={collaborationId:'col',sourceDigest,
    profileRevision:'readonly',permissionEpoch:0,
    protocolTarget:'windows-desktop-codex-0.163.0-alpha.11',
    recipe:'windows_app_server_readonly_v1',hostScopeId:randomUUID(),executionInstanceId:randomUUID(),
    runtimeId:randomUUID(),configSha256:'b'.repeat(64)};
  const identity:WindowsAppServerProcessIdentity={pid:1234,creationFiletime:'133000000000000000',
    hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId};
  return {dir,file,base,store,claim,binding,identity,now,descriptor,
    close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('new launch intent requires a complete dedicated runtime and config binding',()=>{
  const f=fixture(true);
  try {
    for (const binding of [
      {...f.binding,runtimeId:undefined},
      {...f.binding,configSha256:undefined},
      {...f.binding,runtimeId:null},
      {...f.binding,configSha256:null},
      {...f.binding,runtimeId:'not-a-uuid'},
      {...f.binding,configSha256:'B'.repeat(64)},
      {...f.binding,extra:'untrusted'},
    ]) assert.throws(()=>Reflect.apply(f.store.beginWindowsAppServerLaunch,f.store,
      [f.claim,binding,f.now]));
    const legacy=Object.fromEntries(Object.entries(f.binding).filter(([key])=>
      key!=='runtimeId' && key!=='configSha256'));
    assert.throws(()=>Reflect.apply(f.store.beginWindowsAppServerLaunch,f.store,
      [f.claim,legacy,f.now]));
    assert.equal(f.store.getWindowsLaunch(f.claim),null);
  } finally {f.close();}
});

test('stored legacy launch keeps late facts but never gains qualified RPC authority',()=>{
  let calls=0;
  const f=fixture(false,()=>{calls++;return true;});
  try {
    const current=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    const binding:LegacyWindowsAppServerLaunchBinding={collaborationId:current.binding.collaborationId,
      sourceDigest:current.binding.sourceDigest,profileRevision:current.binding.profileRevision,
      permissionEpoch:current.binding.permissionEpoch,protocolTarget:"windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1",
      recipe:current.binding.recipe,hostScopeId:current.binding.hostScopeId,
      executionInstanceId:current.binding.executionInstanceId};
    const legacy={...current,binding};
    const db=new DatabaseSync(f.file);
    try {db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
      WHERE launch_id=?`).run(JSON.stringify(legacy),current.launchId);}
    finally {db.close();}
    assert.deepEqual(f.store.getWindowsLaunch(f.claim),legacy);
    const observed=f.store.recordWindowsLaunchObservation(legacy,f.identity,f.now);
    assert.deepEqual(observed.identity,f.identity);
    calls=0;
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,current.launchId,f.now));
    assert.equal(calls,0);
    assert.throws(()=>f.store.beginNativeThreadIntent(f.claim,'col',f.now));
    assert.throws(()=>f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now));
    assert.throws(()=>f.store.acquireWindowsSourceCleanupLease(f.claim,'cleanup',
      new Date(f.now.getTime()+30_001)));
    assert.throws(()=>f.store.recordWindowsLaunchObservation(current,f.identity,f.now));
    assert.throws(()=>f.store.recordWindowsLaunchObservation({...legacy,binding:{
      ...legacy.binding,runtimeId:f.binding.runtimeId,configSha256:f.binding.configSha256,
    }},f.identity,f.now));
    const unknown=f.store.markWindowsLaunchRecoveryRequired(legacy,f.now);
    assert.equal(unknown.state,'recovery_required');
    assert.deepEqual(f.store.getWindowsLaunch(f.claim),unknown);
  } finally {f.close();}
});

test('reopened legacy JSON stays byte exact and late closure remains a recovery fact',()=>{
  const f=fixture(true);
  let originalClosed=false;
  let reopened:SqliteInvestigationStore|null=null;
  let qualified:SqliteInvestigationStore|null=null;
  let base:SqliteStore|null=null;
  try {
    const current=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    const binding:LegacyWindowsAppServerLaunchBinding={collaborationId:current.binding.collaborationId,
      sourceDigest:current.binding.sourceDigest,profileRevision:current.binding.profileRevision,
      permissionEpoch:current.binding.permissionEpoch,protocolTarget:"windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1",
      recipe:current.binding.recipe,hostScopeId:current.binding.hostScopeId,
      executionInstanceId:current.binding.executionInstanceId};
    const legacy={...current,binding};
    const raw=JSON.stringify(legacy);
    const db=new DatabaseSync(f.file);
    try {db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
      WHERE launch_id=?`).run(raw,current.launchId);}
    finally {db.close();}
    f.store.close();f.base.close();originalClosed=true;
    let launchCalls=0;
    reopened=new SqliteInvestigationStore(f.file,{verifyIsolation:()=>true,
      verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
      verifyWindowsLaunch:()=>{launchCalls++;return true;}});
    assert.deepEqual(reopened.getWindowsLaunch(f.claim),legacy);
    const check=new DatabaseSync(f.file);
    try {
      const row=check.prepare(`SELECT record_json FROM investigation_windows_app_server_launches
        WHERE launch_id=?`).get(current.launchId) as {record_json:string};
      assert.equal(row.record_json,raw);
    } finally {check.close();}
    assert.throws(()=>reopened!.assertWindowsLaunchUsable(f.claim,current.launchId,f.now));
    assert.equal(launchCalls,0);
    const unknown=reopened.markWindowsLaunchRecoveryRequired(legacy,f.now);
    const takeover=reopened.recoverAttempt(f.claim,{workerId:'recovery',
      isolationEvidence:'fixture',profileRevision:'readonly',permissionEpoch:0,
      now:new Date(f.now.getTime()+30_001)});
    base=new SqliteStore(f.file);
    base.revokeGrant('read',new Date(f.now.getTime()+30_001).toISOString());
    const late=new Date(f.now.getTime()+30_002);
    const observed=reopened.recordWindowsLaunchObservation(legacy,f.identity,late);
    assert.equal(observed.state,'recovery_required');
    assert.equal(unknown.identity,null);
    const observation:WindowsAppServerClosureObservation={protocol:'windows_job_stdio_v1',
      helperVersion:'3',kind:'job_closed',recipe:'windows_app_server_readonly_v1',
      launchId:legacy.launchId,hostScopeId:binding.hostScopeId,
      executionInstanceId:binding.executionInstanceId,
      root:{pid:f.identity.pid,creationFiletime:f.identity.creationFiletime},
      rootExited:true,stdoutEof:true,stderrEof:true,
      members:{complete:true,assigned:0,listed:0,pids:[]},helperExitCode:0,sequence:5};
    assert.throws(()=>reopened!.recordWindowsLaunchClosure(legacy,observation,late));
    qualified=new SqliteInvestigationStore(f.file,{verifyIsolation:()=>true,
      verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
      verifyWindowsLaunch:()=>{launchCalls++;return true;},
      verifyWindowsLaunchClosure:()=>true});
    assert.throws(()=>qualified!.recordWindowsLaunchClosure(current,observation,late));
    const closure=qualified.recordWindowsLaunchClosure(legacy,observation,late);
    assert.deepEqual(qualified.getWindowsLaunchClosure(takeover),closure);
    assert.deepEqual(qualified.getWindowsLaunch(takeover)?.binding,binding);
    assert.equal(qualified.listUnsettled().length,1);
    assert.equal(qualified.get('inv')?.result,null);
    assert.equal(launchCalls,0);
  } finally {
    qualified?.close();reopened?.close();base?.close();
    if (!originalClosed) {f.store.close();f.base.close();}
    rmSync(f.dir,{recursive:true,force:true});
  }
});

test('persisted partial and unknown binding keys fail closed without rewriting the row',()=>{
  const f=fixture(true);
  try {
    const launch=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    const db=new DatabaseSync(f.file);
    try {
      for (const binding of [
        {...launch.binding,runtimeId:null},
        {...launch.binding,configSha256:null},
        {...launch.binding,configSha256:undefined},
        {...launch.binding,unknown:'extra'},
      ]) {
        const corrupted={...launch,binding};
        const original=JSON.stringify(corrupted);
        db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
          WHERE launch_id=?`).run(original,launch.launchId);
        assert.throws(()=>f.store.getWindowsLaunch(f.claim));
        const row=db.prepare(`SELECT record_json FROM investigation_windows_app_server_launches
          WHERE launch_id=?`).get(launch.launchId) as {record_json:string};
        assert.equal(row.record_json,original);
      }
    } finally {db.close();}
  } finally {f.close();}
});

test('a different dedicated runtime or config cannot supply late launch facts',()=>{
  const f=fixture(true);
  try {
    const launch=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    for (const binding of [
      {...launch.binding,runtimeId:randomUUID()},
      {...launch.binding,configSha256:'c'.repeat(64)},
    ]) {
      const foreign={...launch,binding};
      assert.throws(()=>f.store.recordWindowsLaunchObservation(foreign,f.identity,f.now));
      assert.throws(()=>f.store.markWindowsLaunchRecoveryRequired(foreign,f.now));
    }
    assert.equal(f.store.getWindowsLaunch(f.claim)?.identity,null);
    assert.equal(f.store.getWindowsLaunch(f.claim)?.state,'intent');
  } finally {f.close();}
});

test('intent is unique and durable before create; default authority does not make observation usable',()=>{
  const f=fixture();
  try {
    assert.equal(f.store.getWindowsLaunch(f.claim),null);
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,'unknown',f.now));
    assert.throws(()=>f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now));
    assert.equal(f.store.getWindowsLaunch(f.claim),null);
  } finally {f.close();}
  const qualified=fixture(true);
  try {
    const launch=qualified.store.beginWindowsAppServerLaunch(qualified.claim,qualified.binding,qualified.now);
    assert.equal(launch.state,'intent'); assert.equal(launch.identity,null);
    assert.throws(()=>qualified.store.beginNativeThreadIntent(qualified.claim,'col',qualified.now));
    assert.throws(()=>qualified.store.beginWindowsAppServerLaunch(qualified.claim,qualified.binding,qualified.now));
    const peer=new SqliteInvestigationStore(qualified.file);
    try {
      assert.deepEqual(peer.getWindowsLaunch(qualified.claim),launch);
      const observed=qualified.store.recordWindowsLaunchObservation(launch,qualified.identity,qualified.now);
      assert.equal(observed.identity?.creationFiletime,qualified.identity.creationFiletime);
      assert.throws(()=>peer.assertWindowsLaunchUsable(qualified.claim,launch.launchId,qualified.now));
    } finally {peer.close();}
    assert.equal(qualified.store.listUnsettled().length,1);
    assert.equal(qualified.store.listUnsettled()[0]?.nativeRef,null);
  } finally {qualified.close();}
});

test('revocation and lease expiry deny RPC while late exact observation remains durable',()=>{
  const revoked=fixture(true);
  try {
    const launch=revoked.store.beginWindowsAppServerLaunch(revoked.claim,revoked.binding,revoked.now);
    revoked.base.revokeGrant('read',revoked.now.toISOString());
    const late=revoked.store.recordWindowsLaunchObservation(launch,revoked.identity,revoked.now);
    assert.deepEqual(late.identity,revoked.identity);
    assert.throws(()=>revoked.store.assertWindowsLaunchUsable(revoked.claim,launch.launchId,revoked.now));
    assert.throws(()=>revoked.store.beginNativeThreadIntent(revoked.claim,'col',revoked.now));
  } finally {revoked.close();}
  const expired=fixture(true);
  try {
    const launch=expired.store.beginWindowsAppServerLaunch(expired.claim,expired.binding,expired.now);
    expired.store.recordWindowsLaunchObservation(launch,expired.identity,expired.now);
    assert.throws(()=>expired.store.assertWindowsLaunchUsable(expired.claim,launch.launchId,
      new Date(expired.now.getTime()+30_001)));
    assert.equal(expired.store.getWindowsLaunch(expired.claim)?.identity?.pid,expired.identity.pid);
  } finally {expired.close();}
});

test('qualification callback cannot extend the original lease while inserting create intent',()=>{
  const f=fixture(false,()=>{
    const until=performance.now()+4;
    while(performance.now()<until) { /* bounded synthetic callback delay */ }
    return true;
  });
  try {
    assert.throws(()=>f.store.beginWindowsAppServerLaunch(f.claim,f.binding,
      new Date(f.now.getTime()+29_999)));
    assert.equal(f.store.getWindowsLaunch(f.claim),null);
  } finally {f.close();}
});

test('exact original late process identity persists after takeover without restoring RPC authority',()=>{
  const f=fixture(true);
  try {
    const launch=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    const takeover=f.store.recoverAttempt(f.claim,{workerId:'recovery',isolationEvidence:'fixture',
      profileRevision:'readonly',permissionEpoch:0,now:new Date(f.now.getTime()+30_001)});
    assert.equal(takeover.workerEpoch,f.claim.workerEpoch+1);
    const observed=f.store.recordWindowsLaunchObservation(launch,f.identity,
      new Date(f.now.getTime()+30_002));
    assert.deepEqual(f.store.getWindowsLaunch(takeover)?.identity,f.identity);
    assert.throws(()=>f.store.assertWindowsLaunchUsable(takeover,launch.launchId,
      new Date(f.now.getTime()+30_002)));
    assert.throws(()=>f.store.recordWindowsLaunchObservation(launch,
      {...f.identity,creationFiletime:'133000000000000001'},new Date(f.now.getTime()+30_002)));
    const unknown=f.store.markWindowsLaunchRecoveryRequired(launch,new Date(f.now.getTime()+30_003));
    assert.equal(unknown.state,'recovery_required');
    assert.deepEqual(unknown.identity,observed.identity);
  } finally {f.close();}
});

test('unknown create outcome retains later process facts without regaining native RPC authority',()=>{
  const f=fixture(true);
  try {
    const intent=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    const unknown=f.store.markWindowsLaunchRecoveryRequired(intent,f.now);
    assert.equal(unknown.state,'recovery_required');
    assert.equal(unknown.identity,null);
    const late=f.store.recordWindowsLaunchObservation(intent,f.identity,f.now);
    assert.equal(late.state,'recovery_required');
    assert.deepEqual(late.identity,f.identity);
    assert.deepEqual(f.store.markWindowsLaunchRecoveryRequired(intent,f.now),late);
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,intent.launchId,f.now));
    assert.throws(()=>f.store.beginNativeThreadIntent(f.claim,'col',f.now));
  } finally {f.close();}
});

test('observed exact launch requires repeated current authority and qualified callback',()=>{
  const f=fixture(true);
  try {
    const launch=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    f.store.dispatchWindowsLaunchStartOnce(f.claim,launch,f.now,()=>{});
    f.store.recordWindowsLaunchObservation(launch,f.identity,f.now);
    assert.doesNotThrow(()=>f.store.assertWindowsLaunchUsable(f.claim,launch.launchId,f.now));
    f.store.beginNativeThreadIntent(f.claim,'col',f.now);
    f.store.observeNativeThread(f.claim,'col','thread-1');
    f.store.beginNativeTurnIntent(f.claim,'col','intent-1','thread-1',f.now);
    f.store.observeNativeTurn(f.claim,'col','intent-1','turn-1');
    f.store.observeNativeTurnTerminal(f.claim,'col','intent-1','turn-1');
    f.store.markWindowsLaunchRecoveryRequired(launch,f.now);
    assert.throws(()=>f.store.beginNativeTurnIntent(f.claim,'col','intent-2','thread-1',f.now));
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,launch.launchId,f.now));
  } finally {f.close();}
});

test('launch intent fences both orders of pure staging cleanup',()=>{
  const first=fixture(true);
  try {
    first.store.beginWindowsAppServerLaunch(first.claim,first.binding,first.now);
    assert.throws(()=>first.store.acquireWindowsSourceCleanupLease(first.claim,'cleanup',
      new Date(first.now.getTime()+30_001)));
    assert.equal(first.store.listUnsettled().length,1);
  } finally {first.close();}
  const second=fixture(true);
  try {
    const cleanup=second.store.acquireWindowsSourceCleanupLease(second.claim,'cleanup',
      new Date(second.now.getTime()+30_001));
    assert.ok(cleanup);
    assert.throws(()=>second.store.beginWindowsAppServerLaunch(second.claim,second.binding,
      new Date(second.now.getTime()+30_002)));
  } finally {second.close();}
});

test('invalid process identity and malformed dates cannot authorize native RPC',()=>{
  const f=fixture(true);
  try {
    const launch=f.store.beginWindowsAppServerLaunch(f.claim,f.binding,f.now);
    for (const identity of [
      {...f.identity,pid:0},{...f.identity,pid:0x100000000},
      {...f.identity,creationFiletime:'0'},
      {...f.identity,creationFiletime:'18446744073709551616'},
      {...f.identity,hostScopeId:randomUUID()},
    ]) assert.throws(()=>f.store.recordWindowsLaunchObservation(launch,identity,f.now));
    assert.throws(()=>f.store.recordWindowsLaunchObservation(launch,f.identity,new Date('invalid')));
    assert.equal(f.store.getWindowsLaunch(f.claim)?.identity,null);
    assert.throws(()=>f.store.assertWindowsLaunchUsable(f.claim,launch.launchId,new Date('invalid')));
  } finally {f.close();}
});

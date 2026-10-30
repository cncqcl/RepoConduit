import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {closeWindowsFrozenSource} from '../../src/adapters/codex/investigator/windows-source-view.js';
import {prepareWindowsInvestigationSource} from '../../src/runtime/windows-investigation-source-preparation.js';
import {runInvestigationCleanupTick} from '../../src/runtime/investigation-recovery.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

async function fixture() {
  const root=mkdtempSync(join(homedir(),'rcac-launch-recovery-'));
  protectNewDataDirectory(root);
  const file=join(root,'state.sqlite');const at=new Date(Date.now()-90_000);
  const base=new SqliteStore(file);const workspaceId=`ws_${randomUUID()}`;
  base.insertWorkspace({id:workspaceId,name:'fixture',canonicalRoot:'D:/synthetic',registeredBy:'p'});
  base.insertCollaboration({id:'col',workspaceId,openedBy:'p',purpose:'fixture',hostThreadId:null,state:'open'});
  base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:'D:/synthetic'});
  base.insertGrant({id:'request',principal:'p',audience:'external',workspaceId,collaborationId:'col',
    recipient:'ext',permissions:['investigation.request','investigation.cancel'],expiresAt:null,revokedAt:null});
  base.insertGrant({id:'read',principal:'p',audience:'external',workspaceId,collaborationId:'col',
    recipient:'ext',permissions:['data.read'],dataPaths:['src/'],expiresAt:null,revokedAt:null});
  const snapshot=createSnapshotFromFiles('copy','a'.repeat(40),{'src/a.ts':Buffer.from('frozen A\n')});
  const scope={workspaceId,collaborationId:'col',workingCopyId:'copy'};
  await base.saveSnapshot({...scope,snapshot:snapshot.toPersisted()},
    {...scope,commitRef:'a'.repeat(40)},'capture','p','external');
  const authority={verifyIsolation:()=>true,verifyNativeReceipt:()=>false,
    verifyOutcomeReceipt:()=>false,verifyWindowsLaunch:()=>true,
    verifyWindowsLaunchClosure:()=>true,verifyWindowsLaunchNotStarted:()=>true};
  const store=new SqliteInvestigationStore(file,authority);
  const record:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
    principal:'p',audience:'external',recipient:'ext',grantId:'request',profileRef:'fixed',budgetRef:'fixed',
    budget:{maxWallSeconds:60,maxTurns:1,maxToolCalls:1},contextRevisionId:'ctx',snapshotRef:snapshot.id,
    question:'fixture',scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},requestedOutputs:['flow'],
    parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,
    createdAt:at.toISOString()};
  store.enqueue(record,'key','fingerprint');
  const claimed=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'fixture',
    profileRevision:'fixed',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now:at})!;
  const expected={...scope,snapshotRef:snapshot.id,contextRevisionId:'ctx',recipient:'ext',
    requestId:'inv',attemptId:claimed.attemptId,workerEpoch:claimed.workerEpoch};
  const prepared=await prepareWindowsInvestigationSource({store,
    snapshots:{getSnapshot:base.getSnapshot.bind(base)},claim:claimed,expected,privateRoot:root,
    now:()=>at});
  const binding={collaborationId:'col',sourceDigest:prepared.plan.digest,profileRevision:'fixed',
    permissionEpoch:0,protocolTarget:
      'windows-desktop-codex-0.163.0-alpha.11' as const,
    recipe:'windows_app_server_readonly_v1' as const,hostScopeId:randomUUID(),
    executionInstanceId:randomUUID(),runtimeId:randomUUID(),configSha256:'b'.repeat(64)};
  const launch=store.beginWindowsAppServerLaunch(prepared.claim,binding,at);
  const identity={pid:1234,creationFiletime:'133000000000000000',hostScopeId:binding.hostScopeId,
    executionInstanceId:binding.executionInstanceId};
  const observation={protocol:'windows_job_stdio_v1' as const,helperVersion:'3' as const,
    kind:'job_closed' as const,recipe:'windows_app_server_readonly_v1' as const,
    launchId:launch.launchId,hostScopeId:binding.hostScopeId,
    executionInstanceId:binding.executionInstanceId,
    root:{pid:identity.pid,creationFiletime:identity.creationFiletime},
    rootExited:true as const,stdoutEof:true as const,stderrEof:true as const,
    members:{complete:true as const,assigned:0 as const,listed:0 as const,pids:[] as []},
    helperExitCode:0 as const,sequence:5};
  let connectionsClosed=false;
  const closeConnections=()=>{if (!connectionsClosed) {store.close();base.close();connectionsClosed=true;}};
  return {root,file,base,store,claim:prepared.claim,launch,identity,observation,view:prepared.view,
    authority,closeConnections,close(){closeConnections();const child=relative(resolve(homedir()),resolve(root));
      assert.match(child,/^rcac-launch-recovery-[A-Za-z0-9_-]{6}$/);
      rmSync(root,{recursive:true,force:true});}};
}

test('Windows recovery tick preserves open launch, then closes real frozen view after saved closure',
  {skip:process.platform!=='win32'},async()=>{
    const f=await fixture();
    try {
      let closeCalls=0;
      await runInvestigationCleanupTick(f.store,'cleanup',undefined,undefined,undefined,undefined,
        {close:async()=>{closeCalls++;throw new Error('MUST_NOT_CLOSE');}});
      assert.equal(closeCalls,0);
      assert.equal(existsSync(f.view.viewPath),true);
      f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.claim.windowsSource?.preparedAt ?
        new Date(f.claim.windowsSource.preparedAt):new Date());
      f.store.recordWindowsLaunchClosure(f.launch,f.observation,new Date());
      f.base.revokeGrant('read',new Date().toISOString());
      await runInvestigationCleanupTick(f.store,'cleanup');
      assert.equal(existsSync(f.view.viewPath),false);
      assert.equal(f.store.get('inv')?.failureReason,'windows_launch_closed_without_outcome');
      assert.equal(f.store.listUnsettled().length,0);
      await runInvestigationCleanupTick(f.store,'cleanup');
      assert.equal(f.store.get('inv')?.result,null);
    } finally {f.close();}
  });

test('crash after real source close reopens tombstone and settles on later cleanup epoch',
  {skip:process.platform!=='win32'},async()=>{
    const f=await fixture();
    let reopened:SqliteInvestigationStore|null=null;
    try {
      f.store.recordWindowsLaunchObservation(f.launch,f.identity,new Date());
      f.store.recordWindowsLaunchClosure(f.launch,f.observation,new Date());
      const cleanup=f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'first-cleanup',new Date())!;
      const closed=closeWindowsFrozenSource(cleanup.windowsSource!.descriptor,
        cleanup.windowsSource!.privateRoot);
      assert.equal(closed.kind,'closed');
      assert.equal(existsSync(f.view.viewPath),false);
      const db=new DatabaseSync(f.file);
      try {db.prepare(`UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?`)
        .run(new Date(Date.now()-1).toISOString(),'inv');}
      finally {db.close();}
      f.closeConnections();
      reopened=new SqliteInvestigationStore(f.file,f.authority);
      await runInvestigationCleanupTick(reopened,'second-cleanup');
      assert.equal(reopened.get('inv')?.state,'failed');
      assert.equal(reopened.listUnsettled().length,0);
      const snapshot=()=>{
        const check=new DatabaseSync(f.file,{readOnly:true});
        try {return {
          facts:check.prepare(`SELECT attempt_id,request_id,launch_id,cleanup_epoch,fact_json
            FROM investigation_windows_launch_settlement_facts`).all(),
          launch:check.prepare(`SELECT record_json FROM investigation_windows_app_server_launches`).all(),
          closure:check.prepare(`SELECT record_json FROM investigation_windows_app_server_closures`).all(),
        };} finally {check.close();}
      };
      const before=snapshot();
      assert.equal(before.facts.length,1);
      await runInvestigationCleanupTick(reopened,'second-cleanup');
      assert.deepEqual(snapshot(),before);
    } finally {reopened?.close();f.close();}
  });

test('reopened no-child fact closes the real frozen Windows view and settles without a process',
  {skip:process.platform!=='win32'},async()=>{
    const f=await fixture();
    let reopened:SqliteInvestigationStore|null=null;
    try {
      const observation={kind:'windows_app_server_not_started_v1' as const,
        protocol:'windows_job_stdio_v1' as const,helperVersion:'3' as const,
        recipe:'windows_app_server_readonly_v1' as const,launchId:f.launch.launchId,
        hostScopeId:f.launch.binding.hostScopeId,
        executionInstanceId:f.launch.binding.executionInstanceId,
        helper:{pid:1234,creationFiletime:'133000000000000000'},
        prepared:{kind:'prepared' as const,sequence:1 as const,childPresent:false as const},
        preparedClosed:{kind:'prepared_closed' as const,sequence:2 as const,childPresent:false as const,
          members:{complete:true as const,assigned:0 as const,listed:0 as const,pids:[] as []}},
        helperExitCode:0 as const};
      f.store.recordWindowsLaunchNotStarted(f.launch,observation,new Date());
      assert.equal(existsSync(f.view.viewPath),true);
      f.closeConnections();
      reopened=new SqliteInvestigationStore(f.file,f.authority);
      await runInvestigationCleanupTick(reopened,'cleanup');
      assert.equal(existsSync(f.view.viewPath),false);
      const settled=reopened.get('inv')!;
      assert.equal(settled.failureReason,'windows_launch_not_started');
      assert.equal(settled.result,null);
      assert.equal(settled.attempts[0]?.terminationConfirmed,false);
      assert.equal(reopened.listUnsettled().length,0);
      const db=new DatabaseSync(f.file,{readOnly:true});
      try {
        assert.equal((db.prepare('SELECT count(*) AS n FROM investigation_windows_not_started_settlement_facts')
          .get() as {n:number}).n,1);
        assert.equal((db.prepare('SELECT count(*) AS n FROM investigation_windows_launch_settlement_facts')
          .get() as {n:number}).n,0);
      } finally {db.close();}
    } finally {reopened?.close();f.close();}
  });

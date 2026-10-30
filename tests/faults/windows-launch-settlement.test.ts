import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {runInvestigationCleanupTick} from '../../src/runtime/investigation-recovery.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';
import type {WindowsAppServerClosureObservation} from
  '../../src/adapters/codex/investigator/windows-launch-record.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'rcac-launch-settle-'));
  const file=join(dir,'state.sqlite');const now=new Date();
  const base=new SqliteStore(file);const workspaceId=`ws_${randomUUID()}`;
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
  const authority={verifyIsolation:()=>true,verifyNativeReceipt:()=>false,
    verifyOutcomeReceipt:()=>false,verifyWindowsLaunch:()=>true,
    verifyWindowsLaunchClosure:()=>true};
  const store=new SqliteInvestigationStore(file,authority);
  store.enqueue(record,'one','one');
  const first=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'fixture',
    profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
  const sourceDigest='a'.repeat(64);
  const descriptor={attemptId:first.attemptId,workspaceId,workerEpoch:first.workerEpoch,sourceDigest};
  const root='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
  const reserved=store.reserveWindowsSourceView(first,descriptor,root,['src/a.ts'],now);
  const claim=store.confirmWindowsSourcePrepared(reserved,{viewPath:win32.join(root,
    `${first.attemptId}.view`),sourceDigest,isolationVerified:false},now);
  const binding={collaborationId:'col',sourceDigest,profileRevision:'readonly',permissionEpoch:0,
    protocolTarget:'windows-desktop-codex-0.163.0-alpha.11' as const,
    recipe:'windows_app_server_readonly_v1' as const,hostScopeId:randomUUID(),
    executionInstanceId:randomUUID(),runtimeId:randomUUID(),configSha256:'b'.repeat(64)};
  const launch=store.beginWindowsAppServerLaunch(claim,binding,now);
  const identity={pid:1234,creationFiletime:'133000000000000000',
    hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId};
  const observation:WindowsAppServerClosureObservation={protocol:'windows_job_stdio_v1',
    helperVersion:'3',kind:'job_closed',recipe:'windows_app_server_readonly_v1',
    launchId:launch.launchId,hostScopeId:binding.hostScopeId,
    executionInstanceId:binding.executionInstanceId,
    root:{pid:identity.pid,creationFiletime:identity.creationFiletime},
    rootExited:true,stdoutEof:true,stderrEof:true,
    members:{complete:true,assigned:0,listed:0,pids:[]},helperExitCode:0,sequence:5};
  const sourceClosed={kind:'closed' as const,descriptor,viewPath:win32.join(root,
    `${first.attemptId}.view`),isolationVerified:false as const};
  return {dir,file,base,store,claim,launch,identity,observation,sourceClosed,now,authority,
    close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('only exact current persisted launch and closure may acquire closed-launch cleanup',()=>{
  const f=fixture();
  try {
    const later=new Date(f.now.getTime()+30_001);
    assert.throws(()=>f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',later));
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    assert.throws(()=>f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',later));
    f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
    assert.equal(f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',f.now),null);
    const cleanup=f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',later);
    assert.ok(cleanup);
    assert.equal(cleanup.workerEpoch,f.claim.workerEpoch+1);
    assert.equal(cleanup.windowsSource?.descriptor.workerEpoch,f.claim.workerEpoch);
    assert.throws(()=>f.store.settleClosedWindowsLaunchAttempt(f.claim,f.sourceClosed,later));
    assert.throws(()=>f.store.settleClosedWindowsLaunchAttempt(cleanup,
      {...f.sourceClosed,descriptor:{...f.sourceClosed.descriptor,sourceDigest:'c'.repeat(64)}},later));
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('closed launch settles failed or cancelled without a result, retry, or source authority',()=>{
  for (const cancel of [false,true]) {
    const f=fixture();
    try {
      f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
      f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
      if (cancel) f.store.requestCancel(f.store.get('inv')!,'cancel','request');
      f.base.revokeGrant('read',f.now.toISOString());
      const later=new Date(f.now.getTime()+30_001);
      const cleanup=f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',later)!;
      const settled=f.store.settleClosedWindowsLaunchAttempt(cleanup,f.sourceClosed,later);
      assert.equal(settled.state,cancel?'cancelled':'failed');
      assert.equal(settled.failureReason,'windows_launch_closed_without_outcome');
      assert.equal(settled.result,null);
      assert.equal(settled.attempts.length,1);
      assert.equal(settled.attempts[0]?.terminationConfirmed,true);
      assert.equal(f.store.listUnsettled().length,0);
      assert.throws(()=>f.store.settleClosedWindowsLaunchAttempt(cleanup,f.sourceClosed,later));
    } finally {f.close();}
  }
});

test('a closure recorded after cleanup time cannot authorize an earlier lease',()=>{
  const f=fixture();
  try {
    f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
    f.store.recordWindowsLaunchClosure(f.launch,f.observation,
      new Date(f.now.getTime()+40_000));
    assert.throws(()=>f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',
      new Date(f.now.getTime()+30_001)));
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('corrupt identity and legacy launch cannot settle even with a saved closure',()=>{
  for (const corruption of ['identity','legacy'] as const) {
    const f=fixture();
    try {
      f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
      f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
      const db=new DatabaseSync(f.file);
      try {
        const saved=f.store.getWindowsLaunch(f.claim)!;
        const binding=corruption==='legacy' ? Object.fromEntries(Object.entries(saved.binding)
          .filter(([key])=>key!=='runtimeId' && key!=='configSha256')) : saved.binding;
        const changed={...saved,binding,identity:corruption==='identity' ?
          {...f.identity,creationFiletime:'133000000000000001'} : saved.identity};
        db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
          WHERE launch_id=?`).run(JSON.stringify(changed),f.launch.launchId);
      } finally {db.close();}
      assert.throws(()=>f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',
        new Date(f.now.getTime()+30_001)));
      assert.equal(f.store.listUnsettled().length,1);
    } finally {f.close();}
  }
});

test('cross-attempt or workspace source descriptor never reaches Windows file close',async()=>{
  for (const field of ['attemptId','workspaceId'] as const) {
    const f=fixture();
    try {
      f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now);
      f.store.recordWindowsLaunchClosure(f.launch,f.observation,f.now);
      const db=new DatabaseSync(f.file);
      try {
        const row=db.prepare(`SELECT windows_source_json FROM investigation_active_attempts
          WHERE request_id='inv'`).get() as {windows_source_json:string};
        const source=JSON.parse(row.windows_source_json) as {
          descriptor:{attemptId:string;workspaceId:string};privateRoot:string};
        if (field==='attemptId') source.descriptor.attemptId=`attempt_${randomUUID()}`;
        else source.descriptor.workspaceId=`ws_${randomUUID()}`;
        db.prepare(`UPDATE investigation_active_attempts SET windows_source_json=?
          WHERE request_id='inv'`).run(JSON.stringify(source));
      } finally {db.close();}
      assert.throws(()=>f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',
        new Date(f.now.getTime()+30_001)));
      let closeCalls=0;
      await runInvestigationCleanupTick(f.store,'cleanup',undefined,[f.claim],undefined,undefined,
        {close:async()=>{closeCalls++;throw new Error('MUST_NOT_CLOSE');}});
      assert.equal(closeCalls,0);
      assert.equal(f.store.get('inv')?.result,null);
      const check=new DatabaseSync(f.file,{readOnly:true});
      try {
        const rows=check.prepare(`SELECT worker_id,worker_epoch
          FROM investigation_active_attempts WHERE request_id='inv'`).all() as
          {worker_id:string;worker_epoch:number}[];
        assert.equal(rows.length,1);
        assert.equal(rows[0]?.worker_id,f.claim.workerId);
        assert.equal(rows[0]?.worker_epoch,f.claim.workerEpoch);
      }
      finally {check.close();}
    } finally {f.close();}
  }
});

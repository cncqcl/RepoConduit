import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { CurrentWindowsAppServerLaunchRecord, WindowsAppServerClosureObservation,
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
  store.dispatchWindowsLaunchStartOnce(claim,launch,now,()=>{});
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


function observed(f: ReturnType<typeof fixture>): CurrentWindowsAppServerLaunchRecord {
  assert.equal(typeof f.store.sendWindowsLaunchControl,'function');
  return f.store.recordWindowsLaunchObservation(f.launch,f.identity,f.now) as CurrentWindowsAppServerLaunchRecord;
}

test('control emit runs once inside the usable-launch transaction',()=>{
  const f=fixture();
  try {
    const original=observed(f); let writes=0;
    const db=(f.store as unknown as {db:DatabaseSync}).db;
    f.store.sendWindowsLaunchControl(f.claim,original,f.now,()=>{
      assert.equal(db.isTransaction,true); writes++;
    });
    assert.equal(writes,1); assert.equal(db.isTransaction,false);
    assert.equal(f.store.get('inv')?.result,null);
  } finally {f.close();}
});

test('control emit rejects mismatched original identity, origin and legacy binding',()=>{
  const f=fixture();
  try {
    const original=observed(f); let writes=0;
    const changedIdentity=structuredClone(original); changedIdentity.identity!.pid++;
    const changedOrigin=structuredClone(original); changedOrigin.launchWorkerId='other';
    const legacy=structuredClone(original) as WindowsAppServerLaunchRecord;
    delete (legacy.binding as Partial<CurrentWindowsAppServerLaunchRecord['binding']>).runtimeId;
    delete (legacy.binding as Partial<CurrentWindowsAppServerLaunchRecord['binding']>).configSha256;
    for(const changed of [changedIdentity,changedOrigin,legacy]) {
      assert.throws(()=>f.store.sendWindowsLaunchControl(f.claim,
        changed as CurrentWindowsAppServerLaunchRecord,f.now,()=>{writes++;}));
    }
    assert.equal(writes,0);
  } finally {f.close();}
});

test('closure inserted during qualification prevents control emission',()=>{
  let inject=false;
  const f=fixture(()=>true,()=>{
    if(inject) {
      const db=(f.store as unknown as {db:DatabaseSync}).db;
      db.prepare('INSERT INTO investigation_windows_app_server_closures (launch_id,record_json) VALUES (?,?)')
        .run(f.launch.launchId,JSON.stringify({launchId:f.launch.launchId,
          observation:f.observation,recordedAt:f.now.toISOString()}));
    }
    return true;
  });
  try {
    const original=observed(f); inject=true; let writes=0;
    assert.throws(()=>f.store.sendWindowsLaunchControl(f.claim,original,f.now,()=>{writes++;}));
    assert.equal(writes,0);
  } finally {f.close();}
});

test('control emission refuses revoked grant, recovery and closed launch',()=>{
  for(const failure of ['revoke','recovery','closure']) {
    const f=fixture(()=>true);
    try {
      const original=observed(f); let writes=0;
      if(failure==='revoke') {
        const db=(f.store as unknown as {db:DatabaseSync}).db;
        db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(f.now.toISOString(),'read');
      } else if(failure==='recovery') f.store.markWindowsLaunchRecoveryRequired(original,f.now);
      else f.store.recordWindowsLaunchClosure(original,f.observation,f.now);
      assert.throws(()=>f.store.sendWindowsLaunchControl(f.claim,original,f.now,()=>{writes++;}));
      assert.equal(writes,0);
    } finally {f.close();}
  }
});

test('async control callbacks are rejected before invocation',()=>{
  const f=fixture();
  try {
    const original=observed(f); let writes=0;
    assert.throws(()=>f.store.sendWindowsLaunchControl(f.claim,original,f.now,async()=>{writes++;}));
    assert.equal(writes,0);
  } finally {f.close();}
});

test('control callback error is propagated without retrying or settling the launch',()=>{
  const f=fixture();
  try {
    const original=observed(f); let writes=0;
    assert.throws(()=>f.store.sendWindowsLaunchControl(f.claim,original,f.now,()=>{
      writes++; throw new Error('send outcome unknown');
    }),/send outcome unknown/);
    assert.equal(writes,1); assert.equal(f.store.getWindowsLaunch(f.claim)?.state,'observed');
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('rejected Promise from an ordinary control callback cannot crash the host',async()=>{
  if (process.env.RCAC_CONTROL_PROMISE_PROBE!=='1') {
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
      ['SYSTEMROOT','WINDIR','TEMP','TMP','PATH','PATHEXT','OS'].includes(key.toUpperCase())));
    const child=spawnSync(process.execPath,['--import','tsx','--test',
      '--test-name-pattern=rejected Promise from an ordinary control callback',
      'tests/integration/windows-launch-control-send.test.ts'],
    {env:{...env,RCAC_CONTROL_PROMISE_PROBE:'1'},encoding:'utf8',timeout:5000,windowsHide:true});
    assert.equal(child.status,0,child.stdout+child.stderr);
    assert.equal(child.error,undefined);
    return;
  }
  const f=fixture();
  try {
    const original=observed(f); let writes=0;
    assert.throws(()=>f.store.sendWindowsLaunchControl(f.claim,original,f.now,()=>{
      writes++; return Promise.reject(new Error('synthetic rejected send'));
    }),/INVALID_ARGUMENT/);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(writes,1);
    assert.equal(f.store.getWindowsLaunch(f.claim)?.state,'observed');
  } finally {f.close();}
});

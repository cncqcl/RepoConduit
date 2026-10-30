import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore, type CodexNativeReadTurn } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { WINDOWS_APP_SERVER_PROTOCOL_TARGET,
  type CurrentWindowsAppServerLaunchRecord } from '../../src/adapters/codex/investigator/windows-launch-record.js';

function fixture(maxToolCalls = 2, journal = true, syntheticWindowsLaunch = false) {
  const dir = mkdtempSync(join(tmpdir(),'rcac-codex-read-'));
  const file = join(dir,'state.sqlite'); const now = new Date();
  const base = new SqliteStore(file); const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({id:workspaceId,name:'fixture',canonicalRoot:dir,registeredBy:'owner'});
  base.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'read',hostThreadId:null,state:'open'});
  base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:dir});
  base.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
    collaborationId:'col',permissions:['investigation.request','investigation.cancel'],expiresAt:null,revokedAt:null});
  base.insertGrant({id:'source',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
    collaborationId:'col',permissions:['data.read'],dataPaths:['src/a.ts'],expiresAt:null,revokedAt:null});
  const workerId=`worker_${randomUUID()}`;
  base.insertGrant({id:'worker-read',principal:workerId,audience:'codex-investigator',recipient:'local-worker',
    workspaceId,collaborationId:'col',permissions:['data.read'],dataPaths:['src/a.ts'],
    expiresAt:new Date(now.getTime()+120_000).toISOString(),revokedAt:null});
  const store = new SqliteInvestigationStore(file,{verifyIsolation:()=>true,
    verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
    verifyWindowsLaunch:()=>syntheticWindowsLaunch});
  const record:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
    principal:'external',audience:'chatgpt',recipient:'remote',grantId:'request',profileRef:'readonly',
    budgetRef:'bounded',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls},contextRevisionId:'ctx',
    snapshotRef:'snap',question:'Trace flow',scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['flow'],parentInvestigationId:null,state:'queued',cancelRequested:false,
    attempts:[],result:null,createdAt:now.toISOString()};
  store.enqueue(record,'key','fingerprint');
  let claim=store.claimRequest('inv',{workerId,isolationEvidence:'fixture',profileRevision:'readonly',
    permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
  let launch: CurrentWindowsAppServerLaunchRecord | null = null;
  if (syntheticWindowsLaunch) {
    const sourceDigest='a'.repeat(64);
    const privateRoot='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
    claim=store.reserveWindowsSourceView(claim,{attemptId:claim.attemptId,workspaceId,
      workerEpoch:claim.workerEpoch,sourceDigest},privateRoot,['src/a.ts'],now);
    claim=store.confirmWindowsSourcePrepared(claim,{sourceDigest,
      viewPath:`${privateRoot}\\${claim.attemptId}.view`,isolationVerified:false},now);
    launch=store.beginWindowsAppServerLaunch(claim,{collaborationId:'col',sourceDigest,
      profileRevision:'readonly',permissionEpoch:0,
      protocolTarget:WINDOWS_APP_SERVER_PROTOCOL_TARGET,
      recipe:'windows_app_server_readonly_v1',hostScopeId:randomUUID(),executionInstanceId:randomUUID(),
      runtimeId:randomUUID(),configSha256:'b'.repeat(64)},now);
    store.dispatchWindowsLaunchStartOnce(claim,launch,now,()=>{});
    store.recordWindowsLaunchObservation(launch,{pid:42,creationFiletime:'134040960000000001',
      hostScopeId:launch.binding.hostScopeId,executionInstanceId:launch.binding.executionInstanceId},now);
  }
  const binding={collaborationId:'col',workingCopyId:'copy',snapshotId:'snap',paths:['src/a.ts'],
    workerGrantId:'worker-read',workerAudience:'codex-investigator',workerRecipient:'local-worker'};
  const turn:CodexNativeReadTurn={intentId:'intent-1',threadId:'thread-1',turnId:'turn-1'};
  const read={workspaceId,collaborationId:'col',workingCopyId:'copy',snapshotId:'snap',path:'src/a.ts'};
  const deadline=new Date(now.getTime()+60_000);
  const startNative=()=>{
    store.beginNativeThreadIntent(claim,'col',now); store.observeNativeThread(claim,'col',turn.threadId);
    store.beginNativeTurnIntent(claim,'col',turn.intentId,turn.threadId,now);
    store.observeNativeTurn(claim,'col',turn.intentId,turn.turnId);
  };
  if (journal) startNative();
  const content='export const a = 1;\n';
  const observation={snapshotId:'snap',path:'src/a.ts',contentHash:createHash('sha256').update(content).digest('hex'),
    byteRange:{start:0,end:Buffer.byteLength(content)},lineRange:{start:1,end:1},content,
    decoding:'utf-8' as const,completeness:'complete' as const};
  return {dir,file,base,store,claim,launch,workerId,binding,turn,read,now,deadline,observation,startNative,
    close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('Windows launch uncertainty fences an existing Codex read session and in-flight disclosure',()=>{
  const f=fixture(2,true,true);
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    const reservation=f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now);
    f.store.markWindowsLaunchRecoveryRequired(f.launch!,f.now);
    assert.throws(()=>reservation.complete(f.observation));
    assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-2',f.read,f.now));
    let bodyWrites=0;
    assert.throws(()=>f.store.discloseCodexRead(f.claim,f.binding,f.turn,f.now,()=>{bodyWrites++;}));
    assert.equal(bodyWrites,0);
    const db=new DatabaseSync(f.file);
    try {
      assert.equal((db.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?')
        .get('inv') as {reserved_calls:number}).reserved_calls,1);
      assert.equal((db.prepare('SELECT count(*) AS count FROM investigation_codex_read_receipts WHERE status=?')
        .get('succeeded') as {count:number}).count,0);
    } finally {db.close();}
    assert.equal(f.store.get('inv')?.result,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('Codex read receipt preserves exact native tuple and real page observation across reopen', () => {
  const f=fixture();
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    f.store.assertCodexReadAuthority(f.claim,f.binding,f.turn,f.now);
    const reservation=f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now);
    const id=reservation.complete(f.observation);
    assert.equal(typeof id,'string');
    const peer=new SqliteInvestigationStore(f.file);
    try {
      const receipts=peer.getSucceededCodexReadReceipts(f.claim,f.turn);
      assert.equal(receipts.length,1);
      assert.deepEqual([receipts[0]?.intentId,receipts[0]?.threadId,receipts[0]?.turnId,receipts[0]?.callId],
        ['intent-1','thread-1','turn-1','call-1']);
      assert.equal(receipts[0]?.pageContentHash,createHash('sha256').update(f.observation.content).digest('hex'));
      assert.equal('nativeRef' in receipts[0]!,false);
      assert.equal(f.store.get('inv')?.result,null);
      assert.equal(f.store.listUnsettled().length,1);
    } finally {peer.close();}
  } finally {f.close();}
});

test('first deadline and worker grant freeze before any native intent; no fake nativeRef', () => {
  const f=fixture(2,false);
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
    assert.equal(f.claim.nativeRef,null);
    assert.throws(()=>f.store.assertCodexReadAuthority(f.claim,f.binding,f.turn,f.now));
    f.startNative();
    assert.doesNotThrow(()=>f.store.assertCodexReadAuthority(f.claim,f.binding,f.turn,f.now));
    assert.throws(()=>f.store.assertCodexReadAuthority(f.claim,
      {...f.binding,workerRecipient:'other'},f.turn,f.now));
    assert.equal(f.store.listUnsettled()[0]?.nativeRef,null);
    assert.equal(f.store.listUnsettled()[0]?.phase,'start_intent');
  } finally {f.close();}
});

test('duplicate call ID fails without budget debit; distinct calls share durable request budget', () => {
  const f=fixture(2);
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now);
    const peer=new SqliteInvestigationStore(f.file);
    try {
      assert.throws(()=>peer.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now));
      assert.doesNotThrow(()=>peer.reserveCodexRead(f.claim,f.binding,f.turn,'call-2',f.read,f.now));
      assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-3',f.read,f.now));
      const db=new DatabaseSync(f.file);
      try { assert.equal((db.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?')
        .get('inv') as {reserved_calls:number}).reserved_calls,2); }
      finally {db.close();}
    } finally {peer.close();}
  } finally {f.close();}
});

test('failed page observation does not refund a committed Codex read reservation', () => {
  const f=fixture(1);
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    const reservation=f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now);
    assert.throws(()=>reservation.complete({...f.observation,content:'wrong bytes'}));
    assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-2',f.read,f.now));
    assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,0);
    const db=new DatabaseSync(f.file);
    try {assert.equal((db.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?')
      .get('inv') as {reserved_calls:number}).reserved_calls,1);}
    finally {db.close();}
  } finally {f.close();}
});

test('deadline is frozen; expiry, terminal turn and revoked worker grant refuse later work', () => {
  const f=fixture();
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    assert.throws(()=>f.store.prepareCodexReadSession(f.claim,f.binding,
      new Date(f.deadline.getTime()+1),f.now));
    assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'late',f.read,f.deadline));
    const reservation=f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now);
    f.store.observeNativeTurnTerminal(f.claim,'col',f.turn.intentId,f.turn.turnId);
    assert.throws(()=>reservation.complete(f.observation));
    assert.throws(()=>f.store.discloseCodexRead(f.claim,f.binding,f.turn,f.now,()=>{}));
    f.base.revokeGrant('worker-read',f.now.toISOString());
    assert.throws(()=>f.store.assertCodexReadAuthority(f.claim,f.binding,f.turn,f.now));
    assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,0);
  } finally {f.close();}
});

test('terminal native turn blocks new reads but preserves earlier successful receipt for review', () => {
  const f=fixture();
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now).complete(f.observation);
    f.store.observeNativeTurnTerminal(f.claim,'col',f.turn.intentId,f.turn.turnId);
    assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-2',f.read,f.now));
    f.base.revokeGrant('worker-read',f.now.toISOString());
    assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,1);
    assert.throws(()=>f.store.getSucceededCodexReadReceipts(f.claim,{...f.turn,turnId:'wrong'}));
  } finally {f.close();}
});

test('current original source and worker grants fence reservation and disclosure', () => {
  for (const revoked of ['source','request','worker-read']) {
    const f=fixture();
    try {
      f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
      let emitted=0;
      f.store.discloseCodexRead(f.claim,f.binding,f.turn,f.now,()=>{emitted++;});
      assert.equal(emitted,1);
      f.base.revokeGrant(revoked,f.now.toISOString());
      assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now));
      assert.throws(()=>f.store.discloseCodexRead(f.claim,f.binding,f.turn,f.now,()=>{emitted++;}));
      assert.equal(emitted,1);
      const db=new DatabaseSync(f.file);
      try {assert.equal((db.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?')
        .get('inv') as {reserved_calls:number}).reserved_calls,0);}
      finally {db.close();}
    } finally {f.close();}
  }
});

test('wrong native tuple and recovery epoch takeover cannot spend or disclose', () => {
  const f=fixture();
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,
      {...f.turn,turnId:'wrong'},'call-1',f.read,f.now));
    const descriptor={attemptId:f.claim.attemptId,workspaceId:f.claim.workspaceId,
      workerEpoch:f.claim.workerEpoch,sourceDigest:'a'.repeat(64)};
    const reserved=f.store.reserveWindowsSourceView(f.claim,descriptor,
      'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator',['src/a.ts'],f.now);
    assert.throws(()=>f.store.acquireWindowsSourceCleanupLease(reserved,'cleanup',
      new Date(f.now.getTime()+30_001)));
    const takeover=f.store.recoverAttempt(reserved,{workerId:'recovery',isolationEvidence:'fixture',
      profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',
      now:new Date(f.now.getTime()+30_001)});
    assert.ok(takeover);
    assert.throws(()=>f.store.assertCodexReadAuthority(f.claim,f.binding,f.turn,f.now));
    assert.throws(()=>f.store.assertCodexReadAuthority(takeover,f.binding,f.turn,
      new Date(f.now.getTime()+30_002)));
  } finally {f.close();}
});

test('cancellation, lease expiry and exact path scope fence the Codex session', () => {
  const cancelled=fixture();
  try {
    cancelled.store.prepareCodexReadSession(cancelled.claim,cancelled.binding,cancelled.deadline,cancelled.now);
    cancelled.store.requestCancel(cancelled.store.get('inv')!,'cancel','request');
    assert.throws(()=>cancelled.store.assertCodexReadAuthority(cancelled.claim,cancelled.binding,
      cancelled.turn,cancelled.now));
  } finally {cancelled.close();}
  const expired=fixture();
  try {
    expired.store.prepareCodexReadSession(expired.claim,expired.binding,expired.deadline,expired.now);
    assert.throws(()=>expired.store.assertCodexReadAuthority(expired.claim,expired.binding,
      expired.turn,new Date(expired.now.getTime()+30_001)));
    assert.throws(()=>expired.store.prepareCodexReadSession(expired.claim,
      {...expired.binding,paths:['src/b.ts']},expired.deadline,expired.now));
  } finally {expired.close();}
});

test('worker read grant must be distinct, scoped and expiring', () => {
  const f=fixture();
  try {
    f.base.insertGrant({id:'worker-no-expiry',principal:f.workerId,audience:'codex-investigator',
      recipient:'local-worker',workspaceId:f.claim.workspaceId,collaborationId:'col',
      permissions:['data.read'],dataPaths:['src/a.ts'],expiresAt:null,revokedAt:null});
    assert.throws(()=>f.store.prepareCodexReadSession(f.claim,
      {...f.binding,workerGrantId:'worker-no-expiry'},f.deadline,f.now));
    f.base.insertGrant({id:'worker-invalid-expiry',principal:f.workerId,audience:'codex-investigator',
      recipient:'local-worker',workspaceId:f.claim.workspaceId,collaborationId:'col',
      permissions:['data.read'],dataPaths:['src/a.ts'],expiresAt:'not-a-date',revokedAt:null});
    assert.throws(()=>f.store.prepareCodexReadSession(f.claim,
      {...f.binding,workerGrantId:'worker-invalid-expiry'},f.deadline,f.now));
    f.base.insertGrant({id:'worker-extra',principal:f.workerId,audience:'codex-investigator',
      recipient:'local-worker',workspaceId:f.claim.workspaceId,collaborationId:'col',
      permissions:['data.read','investigation.request'],dataPaths:['src/a.ts'],
      expiresAt:new Date(f.now.getTime()+120_000).toISOString(),revokedAt:null});
    assert.throws(()=>f.store.prepareCodexReadSession(f.claim,
      {...f.binding,workerGrantId:'worker-extra'},f.deadline,f.now));
    assert.throws(()=>f.store.prepareCodexReadSession(f.claim,
      {...f.binding,workerAudience:'chatgpt'},f.deadline,f.now));
    assert.doesNotThrow(()=>f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now));
  } finally {f.close();}
});

test('malformed persisted Codex session deadline fails closed before read or disclosure', () => {
  const f=fixture();
  try {
    f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
    const db=new DatabaseSync(f.file);
    try {db.prepare('UPDATE investigation_codex_read_sessions SET deadline_at=? WHERE attempt_id=?')
      .run('not-a-date',f.claim.attemptId);}
    finally {db.close();}
    assert.throws(()=>f.store.assertCodexReadAuthority(f.claim,f.binding,f.turn,f.now));
    assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'call-1',f.read,f.now));
    let emitted=false;
    assert.throws(()=>f.store.discloseCodexRead(f.claim,f.binding,f.turn,f.now,()=>{emitted=true;}));
    assert.equal(emitted,false);
  } finally {f.close();}
});

for (const field of ['request-expiry', 'owner-lease'] as const) {
  for (const prepared of [false, true]) {
    test(`malformed ${field} refuses authority ${prepared ? 'after' : 'before'} session prepare`, () => {
      const f=fixture();
      try {
        let reservation: ReturnType<typeof f.store.reserveCodexRead> | undefined;
        if (prepared) {
          f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now);
          reservation=f.store.reserveCodexRead(f.claim,f.binding,f.turn,'reserved',f.read,f.now);
        }
        const db=new DatabaseSync(f.file);
        try {
          if (field === 'request-expiry') db.prepare('UPDATE grants SET expires_at=? WHERE id=?')
            .run('not-a-date','request');
          else db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE attempt_id=?')
            .run('not-a-date',f.claim.attemptId);
        } finally {db.close();}
        if (!prepared) assert.throws(()=>f.store.prepareCodexReadSession(f.claim,f.binding,f.deadline,f.now));
        assert.throws(()=>f.store.reserveCodexRead(f.claim,f.binding,f.turn,'new',f.read,f.now));
        if (reservation) assert.throws(()=>reservation.complete(f.observation));
        let emitted=false;
        assert.throws(()=>f.store.discloseCodexRead(f.claim,f.binding,f.turn,f.now,()=>{emitted=true;}));
        assert.equal(emitted,false);
        const check=new DatabaseSync(f.file);
        try {
          assert.equal((check.prepare('SELECT COUNT(*) AS count FROM investigation_codex_read_receipts WHERE attempt_id=? AND status=?')
            .get(f.claim.attemptId,'succeeded') as {count:number}).count,0);
          assert.equal((check.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?')
            .get('inv') as {reserved_calls:number} | undefined)?.reserved_calls ?? 0,prepared ? 1 : 0);
        } finally {check.close();}
      } finally {f.close();}
    });
  }
}

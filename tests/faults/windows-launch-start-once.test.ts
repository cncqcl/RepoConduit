import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET } from
  '../../src/adapters/codex/investigator/windows-launch-record.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

function fixture(verifyLaunch: () => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-start-once-'));
  const file = join(dir, 'state.sqlite'), now = new Date();
  const base = new SqliteStore(file), workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'owner', purpose: 'investigate',
    hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: dir });
  base.insertGrant({ id: 'request', principal: 'external', audience: 'chatgpt', recipient: 'remote', workspaceId,
    collaborationId: 'col', permissions: ['investigation.request','investigation.cancel'],
    expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'external', audience: 'chatgpt', recipient: 'remote', workspaceId,
    collaborationId: 'col', permissions: ['data.read'], dataPaths: ['src/a.ts'],
    expiresAt: null, revokedAt: null });
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'external', audience: 'chatgpt', recipient: 'remote', grantId: 'request',
    profileRef: 'readonly', budgetRef: 'bounded', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 2 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'Trace flow',
    scope: { paths: ['src/a.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => false,
    verifyOutcomeReceipt: () => false, verifyWindowsLaunch: verifyLaunch };
  const store = new SqliteInvestigationStore(file, authority);
  store.enqueue(record, 'one', 'one');
  const claimed = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'fixture',
    profileRevision: 'readonly', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now })!;
  const sourceDigest = 'a'.repeat(64), privateRoot = 'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
  const descriptor = { attemptId: claimed.attemptId, workspaceId, workerEpoch: claimed.workerEpoch, sourceDigest };
  const reserved = store.reserveWindowsSourceView(claimed, descriptor, privateRoot, ['src/a.ts'], now);
  const claim = store.confirmWindowsSourcePrepared(reserved, { viewPath: win32.join(privateRoot,
    `${claimed.attemptId}.view`), sourceDigest, isolationVerified: false }, now);
  const binding = { collaborationId: 'col', sourceDigest, profileRevision: 'readonly', permissionEpoch: 0,
    protocolTarget: 'windows-desktop-codex-0.163.0-alpha.11' as const,
    recipe: 'windows_app_server_readonly_v1' as const, hostScopeId: randomUUID(),
    executionInstanceId: randomUUID(), runtimeId: randomUUID(), configSha256: 'b'.repeat(64) };
  const launch = store.beginWindowsAppServerLaunch(claim, binding, now);
  const db = new DatabaseSync(file);
  return { dir, file, now, base, store, db, claim, binding, launch,
    close() { db.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('begin creates strict unconsumed reservation atomically; once-only start remains observable', () => {
  const f = fixture();
  try {
    const row = f.db.prepare('SELECT record_json FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
      .get(f.launch.launchId) as {record_json:string};
    assert.deepEqual(JSON.parse(row.record_json), { kind: 'windows_app_server_start_intent_v1',
      launchId: f.launch.launchId, reservedAt: f.launch.intentAt, consumedAt: null });
    let starts = 0;
    f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; });
    assert.equal(starts, 1);
    const consumed = JSON.parse((f.db.prepare('SELECT record_json FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
      .get(f.launch.launchId) as {record_json:string}).record_json) as {consumedAt:string};
    assert.equal(typeof consumed.consumedAt, 'string');
    assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
    assert.equal(starts, 1);
    const observed = f.store.recordWindowsLaunchObservation(f.launch, { pid: 1234,
      creationFiletime: '133000000000000000', hostScopeId: f.binding.hostScopeId,
      executionInstanceId: f.binding.executionInstanceId }, f.now);
    assert.equal(observed.state, 'observed');
    assert.doesNotThrow(() => f.store.assertWindowsLaunchUsable(f.claim, f.launch.launchId, f.now));
  } finally { f.close(); }
});

test('missing reservation and legacy launch never emit or gain a start opportunity', () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    try {
      f.db.prepare('DELETE FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
        .run(f.launch.launchId);
      if (legacy) {
        const oldBinding = { ...Object.fromEntries(Object.entries(f.binding).filter(([key]) =>
          key !== 'runtimeId' && key !== 'configSha256')),
          protocolTarget: WINDOWS_HISTORICAL_APP_SERVER_PROTOCOL_TARGET };
        f.db.prepare('UPDATE investigation_windows_app_server_launches SET record_json=? WHERE launch_id=?')
          .run(JSON.stringify({ ...f.launch, binding: oldBinding }), f.launch.launchId);
      }
      let starts = 0;
      assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
      assert.equal(starts, 0);
      assert.equal(f.store.getWindowsLaunchStartIntent(f.claim), null);
    } finally { f.close(); }
  }
});

test('unconsumed or historical missing reservation may be observed but never usable', () => {
  for (const missing of [false, true]) {
    const f = fixture();
    try {
      if (missing) f.db.prepare('DELETE FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
        .run(f.launch.launchId);
      const observed = f.store.recordWindowsLaunchObservation(f.launch, { pid: 1234,
        creationFiletime: '133000000000000000', hostScopeId: f.binding.hostScopeId,
        executionInstanceId: f.binding.executionInstanceId }, f.now);
      assert.equal(observed.state, 'observed');
      assert.throws(() => f.store.assertWindowsLaunchUsable(f.claim, f.launch.launchId, f.now));
      let starts = 0;
      assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
      assert.equal(starts, 0);
    } finally { f.close(); }
  }
});

test('canonical consumed timestamp survives wall-clock rollback', () => {
  const f = fixture();
  try {
    f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => {});
    const backdated = { kind: 'windows_app_server_start_intent_v1', launchId: f.launch.launchId,
      reservedAt: f.launch.intentAt, consumedAt: new Date(f.now.getTime()-1000).toISOString() };
    f.db.prepare('UPDATE investigation_windows_app_server_start_intents SET record_json=? WHERE launch_id=?')
      .run(JSON.stringify(backdated), f.launch.launchId);
    assert.deepEqual(f.store.getWindowsLaunchStartIntent(f.claim), backdated);
    f.store.recordWindowsLaunchObservation(f.launch, { pid: 1234,
      creationFiletime: '133000000000000000', hostScopeId: f.binding.hostScopeId,
      executionInstanceId: f.binding.executionInstanceId }, f.now);
    assert.doesNotThrow(() => f.store.assertWindowsLaunchUsable(f.claim, f.launch.launchId, f.now));
  } finally { f.close(); }
});

test('two store instances compete for the same durable opportunity', () => {
  const f = fixture();
  const second = new SqliteInvestigationStore(f.file, { verifyIsolation: () => true,
    verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false, verifyWindowsLaunch: () => true });
  try {
    let starts = 0;
    f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; });
    assert.throws(() => second.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
    assert.equal(starts, 1);
    assert.equal(second.getWindowsLaunchStartIntent(f.claim)?.consumedAt, f.now.toISOString());
  } finally { second.close(); f.close(); }
});

test('reservation insertion failure rolls back the launch row', () => {
  const f = fixture();
  try {
    f.db.prepare('DELETE FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
      .run(f.launch.launchId);
    f.db.prepare('DELETE FROM investigation_windows_app_server_launches WHERE launch_id=?')
      .run(f.launch.launchId);
    f.db.exec(`CREATE TRIGGER reject_start_intent BEFORE INSERT ON investigation_windows_app_server_start_intents
      BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;`);
    assert.throws(() => f.store.beginWindowsAppServerLaunch(f.claim, f.binding, f.now));
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM investigation_windows_app_server_launches')
      .get() as {n:number}).n, 0);
  } finally { f.close(); }
});

test('verifier mutation and reentrant native journal prevent any start', () => {
  let inject = false;
  const f = fixture(() => {
    if (inject) {
      const db = (f.store as unknown as {db:DatabaseSync}).db;
      db.prepare(`INSERT INTO investigation_native_threads
        (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id)
        VALUES (?,?,?,?,?,NULL)`).run(f.claim.attemptId, f.claim.requestId,
        f.claim.workspaceId, 'col', f.claim.workerEpoch);
    }
    return true;
  });
  try {
    inject = true;
    let starts = 0;
    assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
    assert.equal(starts, 0);
    assert.equal(f.store.getWindowsLaunchStartIntent(f.claim)?.consumedAt, null);
  } finally { f.close(); }
});

test('verifier cannot drift the captured claim, launch or clock', () => {
  let inject = false;
  const f = fixture(() => {
    if (inject) {
      f.claim.workerId = 'other';
      f.launch.intentAt = new Date(0).toISOString();
      f.now.setTime(0);
    }
    return true;
  });
  try {
    const claim = structuredClone(f.claim), launch = structuredClone(f.launch), now = new Date(f.now);
    inject = true;
    let starts = 0;
    f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; });
    assert.equal(starts, 1);
    assert.equal(f.store.getWindowsLaunchStartIntent(claim)?.reservedAt, launch.intentAt);
    assert.equal(f.store.getWindowsLaunchStartIntent(claim)?.consumedAt, now.toISOString());
  } finally { f.close(); }
});

test('reentrant revocation after consumption prevents start and keeps consumed fact', () => {
  let checks = 0;
  const f = fixture(() => {
    checks++;
    if (checks === 3) {
      const db = (f.store as unknown as {db:DatabaseSync}).db;
      db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(f.now.toISOString(), 'read');
    }
    return true;
  });
  try {
    let starts = 0;
    assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
    assert.equal(starts, 0);
    assert.equal(typeof f.store.getWindowsLaunchStartIntent(f.claim)?.consumedAt, 'string');
    assert.equal(f.store.getWindowsLaunch(f.claim)?.state, 'recovery_required');
  } finally { f.close(); }
});

test('rejected native Promise does not crash host or restore consumed opportunity', () => {
  const f = fixture();
  try {
    const script = `import {SqliteInvestigationStore} from './src/adapters/storage/investigation-sqlite.ts';
      const s=new SqliteInvestigationStore(process.argv[1],{verifyIsolation:()=>true,
      verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,verifyWindowsLaunch:()=>true});
      const claim=JSON.parse(process.argv[2]), launch=JSON.parse(process.argv[3]), now=new Date(process.argv[4]);
      try {s.dispatchWindowsLaunchStartOnce(claim,launch,now,()=>Promise.reject(new Error('late')));
        process.exitCode=2;} catch {} await new Promise(resolve=>setTimeout(resolve,20)); s.close();`;
    const child = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',script,
      f.file,JSON.stringify(f.claim),JSON.stringify(f.launch),f.now.toISOString()],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(typeof f.store.getWindowsLaunchStartIntent(f.claim)?.consumedAt, 'string');
    assert.equal(f.store.getWindowsLaunch(f.claim)?.state, 'recovery_required');
  } finally { f.close(); }
});

test('async start callback is refused before its body and before consumption', () => {
  const f = fixture();
  try {
    let starts = 0;
    assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now,
      async () => { starts++; }));
    assert.equal(starts, 0);
    assert.equal(f.store.getWindowsLaunchStartIntent(f.claim)?.consumedAt, null);
  } finally { f.close(); }
});

test('verifier cannot remove the consumed fact during usable check', () => {
  let inject = false;
  const f = fixture(() => {
    if (inject) {
      const db = (f.store as unknown as {db:DatabaseSync}).db;
      db.prepare('UPDATE investigation_windows_app_server_start_intents SET record_json=? WHERE launch_id=?')
        .run(JSON.stringify({ kind: 'windows_app_server_start_intent_v1', launchId: f.launch.launchId,
          reservedAt: f.launch.intentAt, consumedAt: null }), f.launch.launchId);
    }
    return true;
  });
  try {
    f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => {});
    f.store.recordWindowsLaunchObservation(f.launch, { pid: 1234,
      creationFiletime: '133000000000000000', hostScopeId: f.binding.hostScopeId,
      executionInstanceId: f.binding.executionInstanceId }, f.now);
    inject = true;
    assert.throws(() => f.store.assertWindowsLaunchUsable(f.claim, f.launch.launchId, f.now));
  } finally { f.close(); }
});

test('crash after A commit but before B emit cannot replay start', () => {
  const f = fixture();
  try {
    const marker = join(f.dir, 'emitted.marker');
    const script = `import {SqliteInvestigationStore} from './src/adapters/storage/investigation-sqlite.ts';
      import {writeFileSync} from 'node:fs'; let checks=0;
      const s=new SqliteInvestigationStore(process.argv[1],{verifyIsolation:()=>true,
      verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,
      verifyWindowsLaunch:()=>{if(++checks===2)process.exit(17);return true;}});
      s.dispatchWindowsLaunchStartOnce(JSON.parse(process.argv[2]),JSON.parse(process.argv[3]),
      new Date(process.argv[4]),()=>{writeFileSync(process.argv[5],'emitted');});`;
    const child = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',script,
      f.file,JSON.stringify(f.claim),JSON.stringify(f.launch),f.now.toISOString(),marker],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 17, child.stderr);
    assert.equal(existsSync(marker), false);
    const reopened = new SqliteInvestigationStore(f.file, { verifyIsolation: () => true,
      verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false, verifyWindowsLaunch: () => true });
    try {
      assert.equal(typeof reopened.getWindowsLaunchStartIntent(f.claim)?.consumedAt, 'string');
      let starts = 0;
      assert.throws(() => reopened.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
      assert.equal(starts, 0);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('callback failure consumes opportunity and makes original launch recovery required', () => {
  for (const result of ['throw','promise','false'] as const) {
    const f = fixture();
    try {
      let starts = 0;
      assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => {
        starts++;
        if (result === 'throw') throw new Error('unknown start');
        if (result === 'promise') return Promise.resolve();
        return false;
      }));
      assert.equal(starts, 1);
      assert.equal(f.store.getWindowsLaunch(f.claim)?.state, 'recovery_required');
      assert.throws(() => f.store.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
      assert.equal(starts, 1);
    } finally { f.close(); }
  }
});

test('restart after consumption without observed start refuses a second dispatch', () => {
  const f = fixture();
  try {
    const script = `import {SqliteInvestigationStore} from './src/adapters/storage/investigation-sqlite.ts';
      const s=new SqliteInvestigationStore(process.argv[1],{verifyIsolation:()=>true,
      verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false,verifyWindowsLaunch:()=>true});
      const claim=JSON.parse(process.argv[2]), launch=JSON.parse(process.argv[3]), now=new Date(process.argv[4]);
      s.dispatchWindowsLaunchStartOnce(claim,launch,now,()=>{process.exit(17);});`;
    const child = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',script,
      f.file,JSON.stringify(f.claim),JSON.stringify(f.launch),f.now.toISOString()],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 17, child.stderr);
    const reopened = new SqliteInvestigationStore(f.file, { verifyIsolation: () => true,
      verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false, verifyWindowsLaunch: () => true });
    try {
      assert.equal(typeof reopened.getWindowsLaunchStartIntent(f.claim)?.consumedAt, 'string');
      let starts = 0;
      assert.throws(() => reopened.dispatchWindowsLaunchStartOnce(f.claim, f.launch, f.now, () => { starts++; }));
      assert.equal(starts, 0);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { cleanupInvestigationScratch, cleanupPersistedContainer, runStaticInvestigation } from '../../src/adapters/investigator/docker-worker.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';

test('expired Docker attempt is fenced, records exact ID, and releases slot only after cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-cleanup-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true };
  const store = new SqliteInvestigationStore(file, authority);
  const now = new Date();
  const name = `rcac-investigator-${randomUUID()}`;
  try {
    base.insertWorkspace({ id: 'a', name: 'a', canonicalRoot: 'D:/a', registeredBy: 'p' });
    base.insertCollaboration({ id: 'col-a', workspaceId: 'a', openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
    base.insertWorkingCopy({ id: 'copy-a', workspaceId: 'a', canonicalRoot: 'D:/a' });
    base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId: 'a', collaborationId: 'col-a',
      recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
    base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'a', collaborationId: 'col-a',
      recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
    const record: InvestigationRecord = { id: 'inv-a', workspaceId: 'a', collaborationId: 'col-a', workingCopyId: 'copy-a',
      principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
      budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
      question: 'test', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
      parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
      createdAt: now.toISOString() };
    store.enqueue(record, 'key', 'fingerprint');
    const claim = store.claimNext({ workerId: 'old', isolationEvidence: 'verified', profileRevision: 'fixed', permissionEpoch: 0, now })!;
    store.reserveContainerName(claim, name, join(dir, name), now);
    base.revokeGrant('request', new Date().toISOString());
    assert.equal(store.acquireCleanupLease(claim, 'new', new Date(now.getTime() + 10_000)), null);
    const recovery = store.acquireCleanupLease(claim, 'new', new Date(now.getTime() + 31_000))!;
    assert.equal(recovery.workerEpoch, 2);
    assert.equal(store.get('inv-a')?.state, 'recovery_required');
    assert.throws(() => store.recordObservedContainer(claim, 'a'.repeat(64), new Date(now.getTime() + 31_001)), StoreConflict);
    store.recordObservedContainer(recovery, 'a'.repeat(64), new Date(now.getTime() + 31_001));
    assert.equal(store.listUnsettled()[0]?.containerId, 'a'.repeat(64));
    assert.throws(() => store.recordObservedContainer(recovery, 'b'.repeat(64), new Date(now.getTime() + 31_002)), StoreConflict);
    assert.equal(store.listUnsettled().length, 1);
    const settled = store.finishCleanup(recovery, new Date(now.getTime() + 31_003));
    assert.equal(settled.state, 'failed');
    assert.equal(settled.result, null);
    assert.equal(settled.attempts.length, 1);
    assert.equal(settled.attempts[0]?.terminationConfirmed, true);
    assert.deepEqual(store.listUnsettled(), []);
    assert.deepEqual(store.listPending(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('scratch cleanup refuses a junction or symlink ancestor', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-cleanup-path-'));
  const name = `rcac-investigator-${randomUUID()}`;
  const outside = join(dir, 'outside');
  const link = join(dir, 'redirect');
  mkdirSync(join(outside, name), { recursive: true });
  writeFileSync(join(outside, name, 'keep.txt'), 'owned elsewhere');
  try {
    try { symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { t.skip('host cannot create a test junction or symlink'); return; }
    await assert.rejects(cleanupInvestigationScratch(name, join(link, name)), /RECOVERY_REQUIRED/);
    const missingName = `rcac-investigator-${randomUUID()}`;
    await assert.rejects(cleanupInvestigationScratch(missingName, join(link, missingName)), /RECOVERY_REQUIRED/);
    assert.equal(existsSync(join(outside, name, 'keep.txt')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const imageId = (() => {
  try { return execFileSync('docker', ['image', 'inspect', 'alpine:3.20', '--format', '{{.Id}}'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();

test('empty Docker name lookup without a persisted ID cannot release an attempt',
  { skip: !imageId && 'Docker daemon is unavailable' }, async () => {
    let persisted = false;
    await assert.rejects(cleanupPersistedContainer(`rcac-investigator-${randomUUID()}`, null,
      () => { persisted = true; }), /ISOLATION_TERMINATION_UNCONFIRMED/);
    assert.equal(persisted, false);
  });

test('normal worker records exact ID before rm so restart recognizes a removed container',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
    const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-worker-id-'));
    const dir = join(outer, 'data');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'state.sqlite');
    let scratch = '';
    let app: ReturnType<typeof openApplication> | undefined;
    try {
      protectNewDataDirectory(dir);
      new SqliteStore(file).close();
      const store = new SqliteInvestigationStore(file);
      const claim = { requestId: 'inv-normal', attemptId: 'attempt-normal', workerId: 'worker-normal',
        workerEpoch: 1, workspaceId: 'a', nativeRef: null, phase: 'start_intent' as const };
      const record: InvestigationRecord = { id: claim.requestId, workspaceId: 'a', collaborationId: 'col-a',
        workingCopyId: 'copy-a', principal: 'p', audience: 'external', recipient: 'ext', grantId: 'revoked',
        profileRef: 'fixed', budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
        contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'test',
        scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
        parentInvestigationId: null, state: 'running', cancelRequested: false,
        attempts: [{ id: claim.attemptId, state: 'claimed', nativeRef: null, workerEpoch: 1,
          startedAt: null, finishedAt: null, terminationConfirmed: false }], result: null,
        createdAt: new Date().toISOString() };
      const worker = runStaticInvestigation({ snapshot: createSnapshotFromFiles('copy', 'fixture',
        { 'source.txt': Buffer.from('synthetic marker\n') }), imageId: imageId!, paths: ['source.txt'],
        patterns: ['marker'], maxWallSeconds: 20, maxOutputBytes: 4096 }, (name, root) => {
        scratch = root;
        const db = new DatabaseSync(file);
        try {
          db.prepare(`INSERT INTO investigation_requests
            (id,workspace_id,collaboration_id,principal,audience,operation,idempotency_key,fingerprint,record_json)
            VALUES (?,?,?,?,?,'investigate.submit',?,?,?)`)
            .run(record.id, 'a', 'col-a', 'p', 'external', 'normal', 'normal', JSON.stringify(record));
          db.prepare(`INSERT INTO investigation_outbox(request_id,workspace_id,collaboration_id,created_at)
            VALUES (?,?,?,?)`).run(record.id, 'a', 'col-a', record.createdAt);
          db.prepare(`INSERT INTO investigation_active_attempts
            (request_id,attempt_id,workspace_id,worker_id,worker_epoch,phase,native_ref,container_name,scratch_root,
             lease_until,profile_revision,permission_epoch,isolation_evidence)
            VALUES (?,?,?,?,?,'start_intent',NULL,?,?,?,?,?,?)`)
            .run(record.id, claim.attemptId, 'a', claim.workerId, 1, name, root,
              new Date(Date.now() + 30_000).toISOString(), 'fixed', 0, 'historical');
        } finally { db.close(); }
      }, id => { store.recordObservedContainer(claim, id, new Date()); });
      if (process.platform === 'win32') await assert.rejects(worker, /RECOVERY_REQUIRED/);
      else await worker;
      const saved = store.listUnsettled()[0]!;
      assert.match(saved.containerId ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(spawnSync('docker', ['container', 'inspect', saved.containerName!], { encoding: 'utf8' }).status, 0);
      store.close();
      const db = new DatabaseSync(file);
      try { db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?')
        .run('2026-09-27T00:00:00.000Z', claim.requestId); }
      finally { db.close(); }
      app = openApplication(dir);
      await app.ready;
      const check = new SqliteInvestigationStore(file);
      try {
        assert.equal(check.get(record.id)?.state, process.platform === 'win32' ? 'recovery_required' : 'failed');
        assert.equal(check.listUnsettled().length, process.platform === 'win32' ? 1 : 0);
      } finally { check.close(); }
    } finally {
      await app?.close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      rmSync(outer, { recursive: true, force: true });
    }
  });

test('production startup removes exact Docker worker and retains uncertain Windows scratch and slot',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
    const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-cleanup-live-'));
    const dir = join(outer, 'data');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'state.sqlite');
    const name = `rcac-investigator-${randomUUID()}`;
    const unrelated = `rcac-investigator-${randomUUID()}`;
    const scratch = join(dir, name);
    let app: ReturnType<typeof openApplication> | undefined;
    try {
      protectNewDataDirectory(dir);
      const base = new SqliteStore(file);
      base.close();
      const store = new SqliteInvestigationStore(file);
      store.close();
      const created = spawnSync('docker', ['create', '--name', name, imageId!, '/bin/true'], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(created.status, 0, created.stderr || String(created.error));
      const other = spawnSync('docker', ['create', '--name', unrelated, imageId!, '/bin/true'], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(other.status, 0, other.stderr || String(other.error));
      mkdirSync(scratch);
      writeFileSync(join(scratch, 'source.txt'), 'synthetic worker bytes');
      const record: InvestigationRecord = { id: 'inv-live', workspaceId: 'a', collaborationId: 'col-a', workingCopyId: 'copy-a',
        principal: 'p', audience: 'external', recipient: 'ext', grantId: 'revoked', profileRef: 'fixed', budgetRef: 'fixed',
        budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
        question: 'test', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
        parentInvestigationId: null, state: 'running', cancelRequested: false,
        attempts: [{ id: 'attempt-live', state: 'running', nativeRef: null, workerEpoch: 1,
          startedAt: null, finishedAt: null, terminationConfirmed: false }], result: null,
        createdAt: '2026-09-27T00:00:00.000Z' };
      const db = new DatabaseSync(file);
      try {
        db.prepare(`INSERT INTO investigation_requests
          (id,workspace_id,collaboration_id,principal,audience,operation,idempotency_key,fingerprint,record_json)
          VALUES (?,?,?,?,?,'investigate.submit',?,?,?)`).run(record.id, 'a', 'col-a', 'p', 'external', 'key', 'fp', JSON.stringify(record));
        db.prepare(`INSERT INTO investigation_outbox(request_id,workspace_id,collaboration_id,created_at)
          VALUES (?,?,?,?)`).run(record.id, 'a', 'col-a', record.createdAt);
        db.prepare(`INSERT INTO investigation_active_attempts
          (request_id,attempt_id,workspace_id,worker_id,worker_epoch,phase,native_ref,container_name,scratch_root,
           lease_until,profile_revision,permission_epoch,isolation_evidence)
          VALUES (?,?,?,?,?,'start_intent',NULL,?,?,?,?,?,?)`)
          .run(record.id, 'attempt-live', 'a', 'dead-worker', 1, name, scratch,
            '2026-09-27T00:00:00.000Z', 'fixed', 0, 'historical');
      } finally { db.close(); }
      app = openApplication(dir);
      await app.ready;
      assert.notEqual(spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8' }).status, 0);
      assert.equal(spawnSync('docker', ['container', 'inspect', unrelated], { encoding: 'utf8' }).status, 0);
      assert.equal(existsSync(scratch), process.platform === 'win32');
      const check = new SqliteInvestigationStore(file);
      try {
        assert.equal(check.get(record.id)?.state, process.platform === 'win32' ? 'recovery_required' : 'failed');
        assert.equal(check.listUnsettled().length, process.platform === 'win32' ? 1 : 0);
        if (process.platform === 'win32') assert.match(check.listUnsettled()[0]?.containerId ?? '', /^[0-9a-f]{64}$/);
      }
      finally { check.close(); }
    } finally {
      await app?.close();
      spawnSync('docker', ['rm', '-f', name, unrelated], { encoding: 'utf8', timeout: 10_000 });
      rmSync(outer, { recursive: true, force: true });
    }
  });

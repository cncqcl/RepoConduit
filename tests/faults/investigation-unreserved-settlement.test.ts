import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore, type InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-27T00:00:00.000Z');
const expired = new Date(at.getTime() + 30_001);
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true };

function record(): InvestigationRecord {
  return { id: 'inv-reservation', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed',
    budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'test',
    scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
}

function fixture(protocol?: 'resource_reservation_v1') {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-unreserved-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'ws', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const store = new SqliteInvestigationStore(file, authority);
  const peer = new SqliteInvestigationStore(file, authority);
  store.enqueue(record(), 'key', 'fingerprint');
  const claim = store.claimRequest('inv-reservation', { workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, now: at, ...(protocol ? { launchProtocol: protocol } : {}) })!;
  return { dir, file, base, store, peer, claim, close() {
    peer.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('new protocol settles only after lease expiry, without grant, and does not requeue', () => {
  const f = fixture('resource_reservation_v1');
  try {
    assert.equal(f.claim.launchProtocol, 'resource_reservation_v1');
    assert.equal(f.peer.listUnsettled()[0]?.launchProtocol, 'resource_reservation_v1');
    assert.equal(f.peer.settleExpiredUnreservedAttempt(f.claim, at), null);
    f.base.revokeGrant('request', at.toISOString());
    const settled = f.peer.settleExpiredUnreservedAttempt(f.claim, expired)!;
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'abandoned_before_resource_reservation');
    assert.equal(settled.result, null);
    assert.equal(settled.attempts[0]?.state, 'failed');
    assert.equal(settled.attempts[0]?.startedAt, null);
    assert.equal(settled.attempts[0]?.finishedAt, expired.toISOString());
    assert.equal(settled.attempts[0]?.terminationConfirmed, false);
    assert.deepEqual(f.store.listUnsettled(), []);
    assert.deepEqual(f.store.listPending(), []);
    assert.throws(() => f.store.settleExpiredUnreservedAttempt(f.claim, expired), StoreConflict);
  } finally { f.close(); }
});

test('legacy null protocol remains unsettled even when all resource fields are null', () => {
  const f = fixture();
  try {
    assert.equal(f.claim.launchProtocol, null);
    assert.equal(f.peer.settleExpiredUnreservedAttempt(f.claim, expired), null);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.listPending().length, 1);
    assert.equal(f.store.get(f.claim.requestId)?.state, 'queued');
    assert.equal(f.store.recordNativeStart(f.claim, 'native-old', 'receipt', at).phase, 'started');
  } finally { f.close(); }
});

test('new protocol rejects native start before observed Docker or WSL identity', () => {
  const f = fixture('resource_reservation_v1');
  try {
    assert.throws(() => f.store.recordNativeStart(f.claim, 'native-new', 'receipt', at), StoreConflict);
    const name = `rcac-investigator-${randomUUID()}`;
    const reserved = f.store.reserveContainerName(f.claim, name, join(f.dir, name), at);
    assert.throws(() => f.store.recordNativeStart(reserved, 'native-new', 'receipt', at), StoreConflict);
    const observed = f.store.recordObservedContainer(reserved, 'a'.repeat(64), at);
    assert.equal(f.store.recordNativeStart(observed, 'native-new', 'receipt', at).phase, 'started');
  } finally { f.close(); }
});

test('new protocol accepts observed WSL identity and keeps the expired reserved attempt', () => {
  const f = fixture('resource_reservation_v1');
  try {
    const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu',
      uid: 1000, bootId: randomUUID() };
    const reserved = f.store.reserveWslResource(f.claim, reservation, at);
    assert.throws(() => f.store.recordNativeStart(reserved, 'native-wsl', 'receipt', at), StoreConflict);
    const observed = f.store.observeWslResource(reserved, { invocationId: 'a'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${reservation.unitName}` }, at);
    assert.equal(f.store.recordNativeStart(observed, 'native-wsl', 'receipt', at).phase, 'started');
    assert.equal(f.peer.settleExpiredUnreservedAttempt(f.claim, expired), null);
  } finally { f.close(); }
});

test('any persisted Docker, scratch, WSL, or native field prevents unreserved settlement', () => {
  for (const column of ['container_name', 'container_id', 'scratch_root', 'wsl_unit_name', 'wsl_distro',
    'wsl_uid', 'wsl_boot_id', 'wsl_invocation_id', 'wsl_control_group', 'wsl_launch_gate_json', 'native_ref']) {
    const f = fixture('resource_reservation_v1');
    try {
      const db = new DatabaseSync(f.file);
      try { db.prepare(`UPDATE investigation_active_attempts SET ${column}=? WHERE request_id=?`)
        .run(column === 'wsl_uid' ? 1000 : 'marker', f.claim.requestId); }
      finally { db.close(); }
      assert.equal(f.peer.settleExpiredUnreservedAttempt(f.claim, expired), null, column);
      const check = new DatabaseSync(f.file);
      try {
        assert.equal((check.prepare('SELECT COUNT(*) AS count FROM investigation_active_attempts')
          .get() as { count: number }).count, 1, column);
      } finally { check.close(); }
    } finally { f.close(); }
  }
});

test('reservation and settlement are serialized across connections and stale epochs conflict', () => {
  const first = fixture('resource_reservation_v1');
  try {
    const name = `rcac-investigator-${randomUUID()}`;
    first.peer.reserveContainerName(first.claim, name, join(first.dir, name), at);
    assert.equal(first.store.settleExpiredUnreservedAttempt(first.claim, expired), null);
  } finally { first.close(); }
  const second = fixture('resource_reservation_v1');
  try {
    second.peer.settleExpiredUnreservedAttempt(second.claim, expired);
    const name = `rcac-investigator-${randomUUID()}`;
    assert.throws(() => second.store.reserveContainerName(second.claim, name, join(second.dir, name), at), StoreConflict);
  } finally { second.close(); }
  const third = fixture('resource_reservation_v1');
  try {
    const stale: InvestigationClaim = { ...third.claim, workerEpoch: third.claim.workerEpoch + 1 };
    assert.throws(() => third.store.settleExpiredUnreservedAttempt(stale, expired), StoreConflict);
    assert.equal(third.store.listUnsettled().length, 1);
  } finally { third.close(); }
});

test('generic recovery cannot turn an expired unreserved intent into an uncollectable unknown', () => {
  const f = fixture('resource_reservation_v1');
  try {
    assert.throws(() => f.peer.recoverAttempt(f.claim, { workerId: 'recovery', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: expired }), StoreConflict);
    assert.equal(f.store.listUnsettled()[0]?.phase, 'start_intent');
    assert.equal(f.store.settleExpiredUnreservedAttempt(f.claim, expired)?.state, 'failed');
    assert.deepEqual(f.store.listUnsettled(), []);
  } finally { f.close(); }
});

test('claim accepts only the exact protocol marker', () => {
  const f = fixture();
  try {
    assert.equal(f.claim.launchProtocol, null);
    const db = new DatabaseSync(f.file);
    try {
      const column = db.prepare("SELECT launch_protocol FROM investigation_active_attempts WHERE request_id=?")
        .get(f.claim.requestId) as { launch_protocol: string | null };
      assert.equal(column.launch_protocol, null);
      db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(f.claim.requestId);
      db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(record()), f.claim.requestId);
    } finally { db.close(); }
    assert.throws(() => f.peer.claimRequest(f.claim.requestId, { workerId: 'worker',
      isolationEvidence: 'verified', profileRevision: 'fixed', permissionEpoch: 0, now: at,
      launchProtocol: 'resource_reservation_v2' as 'resource_reservation_v1' }), /NOT_AVAILABLE/);
    assert.equal(f.store.get(f.claim.requestId)?.attempts.length, 0);
  } finally { f.close(); }
});

test('existing active table migrates nullable protocol without reclassifying legacy rows', () => {
  const f = fixture();
  try {
    f.peer.close();
    f.store.close();
    const old = new DatabaseSync(f.file);
    try { old.exec('ALTER TABLE investigation_active_attempts DROP COLUMN launch_protocol'); }
    finally { old.close(); }
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try {
      const saved = reopened.listUnsettled()[0];
      assert.equal(saved?.launchProtocol, null);
      assert.equal(reopened.settleExpiredUnreservedAttempt(saved!, expired), null);
    } finally { reopened.close(); }
  } finally { f.base.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

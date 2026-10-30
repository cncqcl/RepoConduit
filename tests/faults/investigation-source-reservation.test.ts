import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { SourceViewDescriptor, SourceViewState } from '../../src/adapters/codex/investigator/source-view.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-27T00:00:00.000Z');
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

function fixture(withWsl = true) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-source-reservation-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'test', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'test', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claimed = store.claimRequest(record.id, { workerId: 'first', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const descriptor: SourceViewDescriptor = { distro: 'Ubuntu', linuxUser: 'investigator', uid: 1000,
    attemptId: claimed.attemptId, workspaceId, workerEpoch: claimed.workerEpoch,
    sourceDigest: 'a'.repeat(64), bootId: randomUUID() };
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const claim = withWsl ? store.reserveWslResource(claimed, { unitName, distro: descriptor.distro,
    uid: descriptor.uid, bootId: descriptor.bootId,
    gate: { protocol: 'attempt_gate_v1', linuxUser: descriptor.linuxUser,
      root: '/home/investigator/private-gate', payloadKind: 'canary_v1' } }, at) : claimed;
  const root = '/home/investigator/private-source';
  const closed: SourceViewState = { attemptId: descriptor.attemptId, workspaceId, uid: descriptor.uid,
    workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, kind: 'closed', digest: descriptor.sourceDigest };
  return { dir, file, base, store, claim, descriptor, root, closed, unitName, close() {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('source view requires prior matching WSL reservation', () => {
  const absent = fixture(false);
  try {
    assert.throws(() => absent.store.reserveSourceView(absent.claim, absent.descriptor, absent.root, at), StoreConflict);
  } finally { absent.close(); }
  const mismatched = fixture();
  try {
    assert.throws(() => mismatched.store.reserveSourceView(mismatched.claim,
      { ...mismatched.descriptor, distro: 'Other' }, mismatched.root, at), StoreConflict);
    assert.throws(() => mismatched.store.reserveSourceView(mismatched.claim,
      { ...mismatched.descriptor, linuxUser: 'other' }, '/home/other/private-source', at), StoreConflict);
    assert.throws(() => mismatched.store.reserveSourceView({ ...mismatched.claim,
      workspaceId: `ws_${randomUUID()}` }, mismatched.descriptor, mismatched.root, at), StoreConflict);
  } finally { mismatched.close(); }
});

test('reservation survives restart, binds exact descriptor/root and prevents unreserved settlement', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveSourceView(f.claim, f.descriptor, f.root, at);
    assert.deepEqual(reserved.sourceView, { descriptor: f.descriptor, privateRoot: f.root, closedAt: null });
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try {
      assert.deepEqual(reopened.listUnsettled()[0]?.sourceView, reserved.sourceView);
      assert.deepEqual(reopened.reserveSourceView(f.claim, f.descriptor, f.root, at).sourceView, reserved.sourceView);
      assert.throws(() => reopened.reserveSourceView(f.claim, { ...f.descriptor, sourceDigest: 'b'.repeat(64) }, f.root, at), StoreConflict);
      assert.throws(() => reopened.reserveSourceView(f.claim, f.descriptor, '/home/investigator/other', at), StoreConflict);
      assert.throws(() => reopened.reserveSourceView(f.claim, { ...f.descriptor, workspaceId: `ws_${randomUUID()}` }, f.root, at), StoreConflict);
      assert.equal(reopened.settleExpiredUnreservedAttempt(f.claim, new Date(at.getTime() + 30_001)), null);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('closure is fenced and must match the original descriptor across cleanup epoch', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveSourceView(f.claim, f.descriptor, f.root, at);
    assert.throws(() => f.store.confirmSourceViewClosed(f.claim, f.closed, at), StoreConflict);
    assert.throws(() => f.store.confirmSourceViewClosed(reserved, { ...f.closed, kind: 'ready' }, at), StoreConflict);
    assert.throws(() => f.store.confirmSourceViewClosed(reserved, { ...f.closed, workspaceId: `ws_${randomUUID()}` }, at), StoreConflict);
    assert.throws(() => f.store.confirmSourceViewClosed({ ...reserved, sourceView: { ...reserved.sourceView!,
      privateRoot: '/home/investigator/other' } }, f.closed, at), StoreConflict);
    assert.throws(() => f.store.confirmSourceViewClosed(reserved, f.closed, new Date(at.getTime() + 30_000)), StoreConflict);
    const recovered = f.store.acquireSourceViewCleanupLease(reserved, 'recovery', new Date(at.getTime() + 30_001))!;
    assert.equal(recovered.workerEpoch, 2);
    assert.equal(recovered.sourceView?.descriptor.workerEpoch, 1);
    assert.throws(() => f.store.confirmSourceViewClosed(reserved, f.closed, new Date(at.getTime() + 30_002)), StoreConflict);
    assert.throws(() => f.store.confirmSourceViewClosed(recovered, { ...f.closed, workerEpoch: 2 }, new Date(at.getTime() + 30_002)), StoreConflict);
    f.store.confirmSourceViewClosed(recovered, f.closed, new Date(at.getTime() + 30_002));
    assert.equal(f.store.listUnsettled()[0]?.sourceView?.closedAt, new Date(at.getTime() + 30_002).toISOString());
  } finally { f.close(); }
});

test('incomplete source cleanup retains slot and fails closed on release', () => {
  const f = fixture();
  try {
    f.store.reserveSourceView(f.claim, f.descriptor, f.root, at);
    const recovered = f.store.acquireWslCleanupLease(f.claim, 'recovery', new Date(at.getTime() + 30_001))!;
    const closure = { kind: 'closed_unconsumed', attemptId: f.claim.attemptId,
      workspaceId: f.claim.workspaceId, bootId: f.descriptor.bootId, uid: f.descriptor.uid,
      unitName: f.unitName };
    assert.throws(() => f.store.settleClosedUnconsumedWslAttempt(recovered, closure,
      new Date(at.getTime() + 30_002)), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
    f.store.confirmSourceViewClosed(recovered, f.closed, new Date(at.getTime() + 30_003));
    assert.equal(f.store.settleClosedUnconsumedWslAttempt(recovered, closure,
      new Date(at.getTime() + 30_004)).state, 'failed');
    assert.deepEqual(f.store.listUnsettled(), []);
  } finally { f.close(); }
});

test('observed WSL cleanup cannot release a slot while source closure is unknown', () => {
  const f = fixture();
  try {
    f.store.reserveSourceView(f.claim, f.descriptor, f.root, at);
    const observed = f.store.observeWslResource(f.claim, { invocationId: 'b'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.unitName}` }, at);
    const recovered = f.store.acquireWslCleanupLease(observed, 'recovery', new Date(at.getTime() + 30_001))!;
    assert.throws(() => f.store.finishWslCleanup(recovered, 'termination',
      new Date(at.getTime() + 30_002)), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
    f.store.confirmSourceViewClosed(recovered, f.closed, new Date(at.getTime() + 30_003));
    assert.equal(f.store.finishWslCleanup(recovered, 'termination',
      new Date(at.getTime() + 30_004)).state, 'failed');
  } finally { f.close(); }
});

test('pre-source-view active table migrates nullable columns without losing its WSL claim', () => {
  const f = fixture();
  f.store.close();
  try {
    const legacy = new DatabaseSync(f.file);
    try {
      legacy.exec(`ALTER TABLE investigation_active_attempts DROP COLUMN source_view_closed_at;
        ALTER TABLE investigation_active_attempts DROP COLUMN source_view_json;`);
      const columns = legacy.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
      assert.equal(columns.some(column => column.name.startsWith('source_view_')), false);
    } finally { legacy.close(); }
    const migrated = new SqliteInvestigationStore(f.file, authority);
    try {
      const saved = migrated.listUnsettled()[0]!;
      assert.equal(saved.attemptId, f.claim.attemptId);
      assert.equal(saved.workspaceId, f.claim.workspaceId);
      assert.deepEqual(saved.wslResource, f.claim.wslResource);
      assert.equal(saved.sourceView, undefined);
      const db = new DatabaseSync(f.file);
      try {
        const row = db.prepare(`SELECT source_view_json,source_view_closed_at
          FROM investigation_active_attempts WHERE request_id=?`).get(f.claim.requestId) as
          { source_view_json: string | null; source_view_closed_at: string | null };
        assert.equal(row.source_view_json, null);
        assert.equal(row.source_view_closed_at, null);
      } finally { db.close(); }
      migrated.reserveSourceView(saved, f.descriptor, f.root, at);
    } finally { migrated.close(); }
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try {
      assert.deepEqual(reopened.listUnsettled()[0]?.sourceView,
        { descriptor: f.descriptor, privateRoot: f.root, closedAt: null });
    } finally { reopened.close(); }
  } finally { f.base.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

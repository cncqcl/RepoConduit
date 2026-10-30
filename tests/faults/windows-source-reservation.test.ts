import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-28T00:00:00.000Z');
const paths = ['src/a.ts', 'tests/a.test.ts'];
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-win-reservation-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'test', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/', 'tests/'], expiresAt: null, revokedAt: null });
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'test', scope: { paths: ['src/a.ts'], symbols: [], relatedTests: ['tests/a.test.ts'] },
    requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued', cancelRequested: false,
    attempts: [], result: null, createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest(record.id, { workerId: 'first', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const descriptor = { attemptId: claim.attemptId, workspaceId, workerEpoch: claim.workerEpoch,
    sourceDigest: 'a'.repeat(64) };
  const privateRoot = 'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
  return { dir, file, base, store, claim, descriptor, privateRoot, close() {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('Windows reservation binds exact claim, selection, authorization and root across restart', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, [], at), StoreConflict);
    const reserved = f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at);
    assert.equal(reserved.windowsSource?.preparedAt, null);
    const peer = new SqliteInvestigationStore(f.file, authority);
    try {
      assert.deepEqual(peer.listUnsettled()[0]?.windowsSource, reserved.windowsSource);
      assert.throws(() => peer.reserveWindowsSourceView(f.claim, { ...f.descriptor,
        sourceDigest: 'b'.repeat(64) }, f.privateRoot, paths, at), StoreConflict);
      assert.throws(() => peer.reserveWindowsSourceView(f.claim, f.descriptor, 'C:\\other', paths, at), StoreConflict);
      assert.throws(() => peer.reserveWindowsSourceView({ ...f.claim, workerEpoch: 2 }, f.descriptor,
        f.privateRoot, paths, at), StoreConflict);
      assert.equal(peer.settleExpiredUnreservedAttempt(f.claim, new Date(at.getTime() + 30_001)), null);
      const containerName = `rcac-investigator-${randomUUID()}`;
      assert.throws(() => peer.reserveContainerName(f.claim, containerName,
        join(f.dir, containerName), at), StoreConflict);
      assert.throws(() => peer.reserveWslResource(f.claim, { unitName: `rcac-investigator-${randomUUID()}.service`,
        distro: 'Ubuntu', uid: 1000, bootId: randomUUID() }, at), StoreConflict);
    } finally { peer.close(); }
  } finally { f.close(); }
});

test('prepared confirmation is fenced and never constitutes OS isolation or native launch', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at);
    const viewPath = `${f.privateRoot}\\${f.claim.attemptId}.view`;
    assert.throws(() => f.store.preflightWindowsSourcePrepared(reserved, paths, 'fixed', f.descriptor.sourceDigest, at), StoreConflict);
    assert.throws(() => f.store.confirmWindowsSourcePrepared(f.claim, { viewPath,
      sourceDigest: f.descriptor.sourceDigest, isolationVerified: false }, at), StoreConflict);
    assert.throws(() => f.store.confirmWindowsSourcePrepared(reserved, { viewPath,
      sourceDigest: f.descriptor.sourceDigest, isolationVerified: true as never }, at), StoreConflict);
    const prepared = f.store.confirmWindowsSourcePrepared(reserved, { viewPath,
      sourceDigest: f.descriptor.sourceDigest, isolationVerified: false }, at);
    assert.equal(prepared.windowsSource?.preparedAt, at.toISOString());
    assert.doesNotThrow(() => f.store.preflightWindowsSourcePrepared(prepared, paths, 'fixed',
      f.descriptor.sourceDigest, at));
    assert.throws(() => f.store.preflightWindowsSourcePrepared(prepared, paths, 'other',
      f.descriptor.sourceDigest, at), StoreConflict);
    assert.throws(() => f.store.preflightWindowsSourcePrepared(prepared, paths, 'fixed',
      'b'.repeat(64), at), StoreConflict);
    assert.throws(() => f.store.recordNativeStart(prepared, 'thread', 'receipt', at), StoreConflict);
    assert.throws(() => f.store.completeAttempt(prepared, {} as never, 'receipt', at));
  } finally { f.close(); }
});

test('revocation and stale lease refuse Windows staging; corruption is fail closed', () => {
  const f = fixture();
  try {
    f.base.revokeGrant('read', new Date().toISOString());
    assert.throws(() => f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at));
    f.base.close(); f.store.close();
    const db = new DatabaseSync(f.file);
    try { db.exec('UPDATE investigation_active_attempts SET windows_source_json=\'{"descriptor":1}\''); }
    finally { db.close(); }
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try { assert.throws(() => reopened.listUnsettled(), StoreConflict); }
    finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('legacy active table migrates Windows column without releasing an existing claim', () => {
  const f = fixture();
  f.store.close();
  try {
    const db = new DatabaseSync(f.file);
    try { db.exec('ALTER TABLE investigation_active_attempts DROP COLUMN windows_source_json'); }
    finally { db.close(); }
    const migrated = new SqliteInvestigationStore(f.file, authority);
    try {
      assert.equal(migrated.listUnsettled()[0]?.attemptId, f.claim.attemptId);
      assert.equal(migrated.listUnsettled()[0]?.windowsSource, undefined);
      const reserved = migrated.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at);
      assert.equal(reserved.windowsSource?.descriptor.sourceDigest, f.descriptor.sourceDigest);
      assert.equal(migrated.settleExpiredUnreservedAttempt(f.claim, new Date(at.getTime() + 30_001)), null);
    } finally { migrated.close(); }
  } finally { f.base.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('expired Windows reservation remains occupied in recovery and cannot be prepared by stale epoch', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at);
    const later = new Date(at.getTime() + 30_001);
    assert.throws(() => f.store.confirmWindowsSourcePrepared(reserved, {
      viewPath: `${f.privateRoot}\\${f.claim.attemptId}.view`, sourceDigest: f.descriptor.sourceDigest,
      isolationVerified: false }, later), StoreConflict);
    const recovered = f.store.recoverAttempt(reserved, { workerId: 'recovery', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: later });
    assert.equal(recovered.phase, 'unknown');
    assert.equal(recovered.windowsSource?.descriptor.workerEpoch, 1);
    assert.equal(recovered.workerEpoch, 2);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.throws(() => f.store.preflightWindowsSourcePrepared(recovered, paths, 'fixed',
      f.descriptor.sourceDigest, later), StoreConflict);
    assert.throws(() => f.store.reserveWindowsSourceView(recovered, f.descriptor,
      f.privateRoot, paths, later), StoreConflict);
  } finally { f.close(); }
});

test('Windows reservation cannot attach to an existing Docker or WSL attempt', () => {
  const docker = fixture();
  try {
    const name = `rcac-investigator-${randomUUID()}`;
    const reserved = docker.store.reserveContainerName(docker.claim, name, join(docker.dir, name), at);
    assert.throws(() => docker.store.reserveWindowsSourceView(reserved, docker.descriptor,
      docker.privateRoot, paths, at), StoreConflict);
  } finally { docker.close(); }
  const wsl = fixture();
  try {
    const reserved = wsl.store.reserveWslResource(wsl.claim, {
      unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
      bootId: randomUUID() }, at);
    assert.throws(() => wsl.store.reserveWindowsSourceView(reserved, wsl.descriptor,
      wsl.privateRoot, paths, at), StoreConflict);
  } finally { wsl.close(); }
});

test('Windows reservation refuses cancellation and expired lease before touching storage', () => {
  const canceled = fixture();
  try {
    canceled.store.requestCancel(canceled.store.get('inv')!, 'cancel', 'request');
    assert.throws(() => canceled.store.reserveWindowsSourceView(canceled.claim, canceled.descriptor,
      canceled.privateRoot, paths, at), StoreConflict);
    assert.equal(canceled.store.listUnsettled()[0]?.windowsSource, undefined);
  } finally { canceled.close(); }
  const expired = fixture();
  try {
    assert.throws(() => expired.store.reserveWindowsSourceView(expired.claim, expired.descriptor,
      expired.privateRoot, paths, new Date(at.getTime() + 30_000)), StoreConflict);
  } finally { expired.close(); }
});

test('Windows cleanup fences expired worker and settles only exact closed source observation', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at);
    const later = new Date(at.getTime() + 30_001);
    const cleanup = f.store.acquireWindowsSourceCleanupLease(reserved, 'cleanup-worker', later);
    assert.ok(cleanup);
    assert.equal(cleanup.workerEpoch, reserved.workerEpoch + 1);
    assert.equal(cleanup.windowsSource?.descriptor.workerEpoch, reserved.workerEpoch);
    assert.equal(f.store.listUnsettled().length, 1);
    const observation = { kind: 'closed' as const, descriptor: f.descriptor,
      viewPath: `${f.privateRoot}\\${f.claim.attemptId}.view`, isolationVerified: false as const };
    assert.throws(() => f.store.settleClosedWindowsSourceAttempt(reserved, observation, later), StoreConflict);
    assert.throws(() => f.store.settleClosedWindowsSourceAttempt(cleanup, {
      ...observation, descriptor: { ...f.descriptor, workspaceId: 'other' } }, later), StoreConflict);
    assert.throws(() => f.store.settleClosedWindowsSourceAttempt(cleanup, {
      ...observation, viewPath: 'C:\\other\\view' }, later), StoreConflict);
    const settled = f.store.settleClosedWindowsSourceAttempt(cleanup, observation, later);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'closed_before_native_launch');
    assert.equal(settled.attempts[0]?.terminationConfirmed, false);
    assert.equal(f.store.listUnsettled().length, 0);
    assert.throws(() => f.store.acquireWindowsSourceCleanupLease(reserved, 'again', later), StoreConflict);
  } finally { f.close(); }
});

test('Windows cleanup can settle revoked source authority, but not a live lease', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveWindowsSourceView(f.claim, f.descriptor, f.privateRoot, paths, at);
    f.base.revokeGrant('read', new Date(at.getTime() + 1).toISOString());
    assert.equal(f.store.acquireWindowsSourceCleanupLease(reserved, 'early', at), null);
    const later = new Date(at.getTime() + 30_001);
    const cleanup = f.store.acquireWindowsSourceCleanupLease(reserved, 'cleanup-worker', later);
    assert.ok(cleanup);
    const settled = f.store.settleClosedWindowsSourceAttempt(cleanup, {
      kind: 'closed', descriptor: f.descriptor,
      viewPath: `${f.privateRoot}\\${f.claim.attemptId}.view`, isolationVerified: false }, later);
    assert.equal(settled.state, 'failed');
  } finally { f.close(); }
});

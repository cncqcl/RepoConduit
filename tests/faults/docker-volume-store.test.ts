import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const t0 = new Date('2026-09-29T00:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const owner = () => `rcac-investigator-owner-${randomUUID()}`;
const reader = () => `rcac-investigator-reader-${randomUUID()}`;
const ownerId = 'a'.repeat(64);
const readerId = 'b'.repeat(64);
const volumeName = 'c'.repeat(64);
const daemonId = 'c20f7230-59a2-4824-a2f4-fda71c982ee6';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-volume-store-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'ws', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true,
    verifyDockerVolumeCleanupReceipt: (_claim: unknown, resource: { ownerId: string | null; readerId: string | null }, receipt: string) =>
      receipt === `${resource.ownerId}:${resource.readerId}:absent` };
  let store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'test', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: t0.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimNext({ workerId: 'worker', isolationEvidence: 'verified', profileRevision: 'fixed',
    permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: t0 })!;
  return { claim, file, base, get store() { return store; }, reopen() { store.close(); store = new SqliteInvestigationStore(file, authority); },
    close() { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Docker volume identities persist across reopen; cleanup takeover fences stale worker and unknown reader', () => {
  const f = fixture();
  try {
    const name = owner();
    const readerName = reader();
    const reserved = f.store.reserveDockerVolumeOwner(f.claim, name, daemonId, at(1));
    assert.equal(reserved.dockerVolume?.daemonId, daemonId);
    assert.equal(reserved.dockerVolume?.ownerName, name);
    assert.equal(f.store.acquireDockerVolumeCleanupLease(reserved, 'cleanup', at(1000)), null);
    f.reopen();
    const observed = f.store.observeDockerVolumeOwner(f.store.listUnsettled()[0]!, ownerId, volumeName, at(2));
    const intent = f.store.reserveDockerVolumeMaterialization(observed, at(3));
    const materialized = f.store.markDockerVolumeMaterialized(intent, at(3));
    const readerIntent = f.store.reserveDockerVolumeReader(materialized, readerName, at(4));
    f.reopen();
    assert.deepEqual(f.store.listUnsettled()[0]?.dockerVolume, readerIntent.dockerVolume);
    const recovery = f.store.acquireDockerVolumeCleanupLease(f.store.listUnsettled()[0]!, 'cleanup', at(31_000))!;
    assert.equal(recovery.workerEpoch, 2);
    assert.throws(() => f.store.observeDockerVolumeReader(readerIntent, readerId, at(31_001)), StoreConflict);
    assert.throws(() => f.store.finishDockerVolumeCleanup(recovery, `${ownerId}:null:absent`, at(31_001)), StoreConflict);
    const found = f.store.observeDockerVolumeReader(recovery, readerId, at(31_002));
    assert.throws(() => f.store.finishDockerVolumeCleanup(found, 'forged', at(31_003)), /NOT_AVAILABLE/);
    const settled = f.store.finishDockerVolumeCleanup(found, `${ownerId}:${readerId}:absent`, at(31_003));
    assert.equal(settled.state, 'failed');
    assert.deepEqual(f.store.listUnsettled(), []);
  } finally { f.close(); }
});

test('Docker volume cleanup refuses name-only owner and cannot mix legacy scratch resource', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveDockerVolumeOwner(f.claim, owner(), daemonId, at(1));
    const legacyName = `rcac-investigator-${randomUUID()}`;
    assert.throws(() => f.store.reserveContainerName(reserved, legacyName,
      join(tmpdir(), legacyName), at(2)), StoreConflict);
    const recovery = f.store.acquireDockerVolumeCleanupLease(reserved, 'cleanup', at(31_000))!;
    assert.throws(() => f.store.finishDockerVolumeCleanup(recovery, 'irrelevant', at(31_001)), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.throws(() => f.store.observeDockerVolumeOwner(reserved, ownerId, volumeName, at(31_001)), StoreConflict);
  } finally { f.close(); }
});

test('Docker owner reservation binds the original daemon identity', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.reserveDockerVolumeOwner(f.claim, owner(), 'unknown', at(1)),
      /INVALID_ARGUMENT/);
    const name = owner();
    const reserved = f.store.reserveDockerVolumeOwner(f.claim, name, daemonId, at(1));
    assert.throws(() => f.store.reserveDockerVolumeOwner(reserved, name,
      '3f7d894c-41e3-4c87-a6c0-e0106e559a2f', at(2)), StoreConflict);
    f.reopen();
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.daemonId, daemonId);
  } finally { f.close(); }
});

test('revocation blocks every new source or reader side effect while exact identity remains recordable', () => {
  for (const stage of ['owner', 'materialize', 'reader'] as const) {
    const f = fixture();
    try {
      let claim = f.claim;
      if (stage !== 'owner') {
        claim = f.store.reserveDockerVolumeOwner(claim, owner(), daemonId, at(1));
        claim = f.store.observeDockerVolumeOwner(claim, ownerId, volumeName, at(2));
      }
      if (stage === 'reader') {
        claim = f.store.reserveDockerVolumeMaterialization(claim, at(3));
        claim = f.store.markDockerVolumeMaterialized(claim, at(4));
      }
      f.base.revokeGrant('read', at(5).toISOString());
      if (stage === 'owner') assert.throws(() => f.store.reserveDockerVolumeOwner(claim, owner(), daemonId, at(6)), StoreConflict);
      if (stage === 'materialize') {
        assert.throws(() => f.store.reserveDockerVolumeMaterialization(claim, at(6)), StoreConflict);
        assert.equal(f.store.observeDockerVolumeOwner(claim, ownerId, volumeName, at(7)).dockerVolume?.ownerId, ownerId);
      }
      if (stage === 'reader') assert.throws(() => f.store.reserveDockerVolumeReader(claim, reader(), at(6)), StoreConflict);
    } finally { f.close(); }
  }
});

test('Docker volume cannot poison native start or generic completion, including after reopen', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveDockerVolumeOwner(f.claim, owner(), daemonId, at(1));
    assert.throws(() => f.store.recordNativeStart(reserved, 'native', 'receipt', at(2)), StoreConflict);
    f.reopen();
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerName, reserved.dockerVolume?.ownerName);
    assert.equal(f.store.get('inv')?.state, 'queued');
  } finally { f.close(); }
});

test('cleanup takeover can persist a previously unobserved exact owner after restart', () => {
  const f = fixture();
  try {
    f.store.reserveDockerVolumeOwner(f.claim, owner(), daemonId, at(1));
    f.reopen();
    const recovery = f.store.acquireDockerVolumeCleanupLease(f.store.listUnsettled()[0]!, 'cleanup', at(31_000))!;
    const observed = f.store.observeDockerVolumeOwner(recovery, ownerId, volumeName, at(31_001));
    assert.equal(observed.dockerVolume?.volumeName, volumeName);
    assert.throws(() => f.store.observeDockerVolumeOwner(f.claim, readerId, volumeName, at(31_002)), StoreConflict);
    assert.throws(() => f.store.observeDockerVolumeOwner(observed, readerId, volumeName, at(31_002)), StoreConflict);
  } finally { f.close(); }
});

test('native thread intent and Docker volume reservation are mutually exclusive in both orders', () => {
  for (const order of ['native_first', 'volume_first'] as const) {
    const f = fixture();
    try {
      if (order === 'native_first') {
        f.store.beginNativeThreadIntent(f.claim, 'col', at(1));
        assert.throws(() => f.store.reserveDockerVolumeOwner(f.claim, owner(), daemonId, at(2)), StoreConflict);
        assert.equal(f.store.listUnsettled()[0]?.dockerVolume, undefined);
      } else {
        const reserved = f.store.reserveDockerVolumeOwner(f.claim, owner(), daemonId, at(1));
        assert.throws(() => f.store.beginNativeThreadIntent(reserved, 'col', at(2)), StoreConflict);
        assert.equal(f.store.getNativeJournal(reserved, 'col'), null);
        assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerName, reserved.dockerVolume?.ownerName);
      }
      f.reopen();
      assert.equal(f.store.listUnsettled().length, 1);
    } finally { f.close(); }
  }
});

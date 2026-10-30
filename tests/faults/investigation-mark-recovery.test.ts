import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-28T00:00:00.000Z');
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-mark-recovery-'));
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
  const peer = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'test', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  return { dir, base, store, peer, claim, workspaceId, close() {
    peer.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('uncertain reserved start is durably recovery_required and retains source, resource and slot', () => {
  const f = fixture();
  try {
    const bootId = randomUUID();
    const resource = f.store.reserveWslResource(f.claim, { unitName: `rcac-investigator-${randomUUID()}.service`,
      distro: 'Ubuntu', uid: 1000, bootId, gate: { protocol: 'attempt_gate_v1', linuxUser: 'investigator',
        root: '/home/investigator/private-gate', payloadKind: 'canary_v1' } }, at);
    const descriptor = { attemptId: f.claim.attemptId, workspaceId: f.workspaceId, workerEpoch: f.claim.workerEpoch,
      distro: 'Ubuntu', linuxUser: 'investigator', uid: 1000, bootId, sourceDigest: 'a'.repeat(64) };
    const reserved = f.store.reserveSourceView(resource, descriptor, '/home/investigator/private-source', at);
    const marked = f.peer.markRecoveryRequired(reserved, at);
    assert.equal(marked.phase, 'unknown');
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.get('inv')?.attempts[0]?.state, 'recovery_required');
    assert.equal(f.store.get('inv')?.result, null);
    assert.deepEqual(f.store.listUnsettled()[0]?.sourceView, reserved.sourceView);
    assert.deepEqual(f.store.listUnsettled()[0]?.wslResource, reserved.wslResource);
    assert.equal(f.store.claimRequest('inv', { workerId: 'next', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: at }), null);
    assert.deepEqual(f.store.listPending(), [{ requestId: 'inv', workspaceId: f.workspaceId, collaborationId: 'col' }]);
    assert.deepEqual(f.peer.markRecoveryRequired(reserved, at), marked);
  } finally { f.close(); }
});

test('observed native identity marks reconcile and stale or expired workers cannot mutate', () => {
  const f = fixture();
  try {
    const bootId = randomUUID();
    const unitName = `rcac-investigator-${randomUUID()}.service`;
    const reserved = f.store.reserveWslResource(f.claim, { unitName, distro: 'Ubuntu', uid: 1000, bootId }, at);
    const observed = f.store.observeWslResource(reserved, { invocationId: 'b'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` }, at);
    assert.throws(() => f.peer.markRecoveryRequired({ ...observed, workerEpoch: 2 }, at), StoreConflict);
    assert.throws(() => f.peer.markRecoveryRequired({ ...observed, workerId: 'other' }, at), StoreConflict);
    assert.throws(() => f.peer.markRecoveryRequired(observed, new Date(at.getTime() + 30_000)), StoreConflict);
    assert.equal(f.store.get('inv')?.state, 'queued');
    const marked = f.peer.markRecoveryRequired(observed, at);
    assert.equal(marked.phase, 'reconcile');
    assert.deepEqual(f.store.listUnsettled()[0]?.wslResource, observed.wslResource);
    assert.equal(f.store.listUnsettled()[0]?.workerEpoch, observed.workerEpoch);
    assert.equal(f.store.get('inv')?.attempts[0]?.terminationConfirmed, false);
    assert.throws(() => f.peer.markRecoveryRequired({ ...marked, workerEpoch: 2 }, at), StoreConflict);
    const later = new Date(at.getTime() + 30_001);
    const recovered = f.store.recoverAttempt(marked, { workerId: 'takeover', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: later });
    assert.equal(recovered.workerEpoch, marked.workerEpoch + 1);
    assert.throws(() => f.peer.markRecoveryRequired(marked, later), StoreConflict);
    assert.deepEqual(f.peer.markRecoveryRequired(recovered, later), recovered);
  } finally { f.close(); }
});

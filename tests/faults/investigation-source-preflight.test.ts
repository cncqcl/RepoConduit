import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { SourceViewDescriptor } from '../../src/adapters/codex/investigator/source-view.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const now = new Date('2026-09-28T00:00:00.000Z');
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

function fixture(withGate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-source-preflight-'));
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
    attempts: [], result: null, createdAt: now.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claimed = store.claimRequest(record.id, { workerId: 'first', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now })!;
  const descriptor: SourceViewDescriptor = { distro: 'Ubuntu', linuxUser: 'investigator', uid: 1000,
    attemptId: claimed.attemptId, workspaceId, workerEpoch: claimed.workerEpoch,
    sourceDigest: 'a'.repeat(64), bootId: randomUUID() };
  const claim = store.reserveWslResource(claimed, { unitName: `rcac-investigator-${randomUUID()}.service`,
    distro: descriptor.distro, uid: descriptor.uid, bootId: descriptor.bootId,
    ...(withGate ? { gate: { protocol: 'attempt_gate_v1' as const, linuxUser: descriptor.linuxUser,
      root: '/home/investigator/private-gate', payloadKind: 'canary_v1' as const } } : {}) }, now);
  const reserve = (paths?: readonly string[], at = now) =>
    store.reserveSourceView(claim, descriptor, '/home/investigator/private-source', at, paths);
  return { file, base, store, record, claim, descriptor, reserve, close() {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('source reservation requires a persisted canary gate for recovery', () => {
  const f = fixture(false);
  try {
    assert.throws(() => f.reserve(['src/a.ts', 'tests/a.test.ts']), StoreConflict);
    assert.equal(f.store.listUnsettled()[0]?.sourceView, undefined);
  } finally { f.close(); }
});

test('source reservation requires the exact materialized path selection', () => {
  const f = fixture();
  try {
    assert.throws(() => f.reserve(), StoreConflict);
    assert.throws(() => f.reserve([]), StoreConflict);
    assert.throws(() => f.reserve(['src/a.ts']), StoreConflict);
    assert.throws(() => f.reserve(['src/a.ts', 'tests/a.test.ts', 'src/extra.ts']), StoreConflict);
    assert.throws(() => f.reserve(['src/a.ts', 'tests/a.test.ts', 'src/a.ts']), StoreConflict);
    assert.throws(() => f.reserve(['src/../a.ts', 'tests/a.test.ts']), StoreConflict);
    assert.equal(f.reserve(['src/a.ts', 'tests/a.test.ts']).sourceView?.descriptor.sourceDigest,
      f.descriptor.sourceDigest);
  } finally { f.close(); }
});

test('source reservation refuses changed request/read authority and permission epoch', () => {
  for (const grant of ['request', 'read']) {
    const f = fixture();
    try {
      f.base.revokeGrant(grant, new Date().toISOString());
      assert.throws(() => f.reserve(['src/a.ts', 'tests/a.test.ts']), StoreConflict);
      assert.equal(f.store.listUnsettled()[0]?.sourceView, undefined);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const db = new DatabaseSync(f.file);
    try { db.prepare(`UPDATE grants SET data_paths_json='["src/"]' WHERE id='read'`).run(); }
    finally { db.close(); }
    assert.throws(() => f.reserve(['src/a.ts', 'tests/a.test.ts']), /NOT_AVAILABLE/);
  } finally { f.close(); }
});

test('source reservation refuses canceled, expired, and stale claims', () => {
  const canceled = fixture();
  try {
    canceled.store.requestCancel(canceled.store.get(canceled.record.id)!, 'cancel-key', 'request');
    assert.throws(() => canceled.reserve(['src/a.ts', 'tests/a.test.ts']), StoreConflict);
  } finally { canceled.close(); }
  const expired = fixture();
  try {
    assert.throws(() => expired.reserve(['src/a.ts', 'tests/a.test.ts'],
      new Date(now.getTime() + 30_000)), StoreConflict);
    assert.throws(() => expired.store.reserveSourceView({ ...expired.claim, workerEpoch: 2 },
      expired.descriptor, '/home/investigator/private-source', now,
      ['src/a.ts', 'tests/a.test.ts']), StoreConflict);
  } finally { expired.close(); }
});

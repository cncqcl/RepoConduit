import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

function seed(file: string): SqliteStore {
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'workspace', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'investigate', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'grant', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  return base;
}

test('restart retains a cancelled-before-start request without recreating its outbox entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const item: InvestigationRecord = { id: 'inv_1', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant', profileRef: 'readonly', budgetRef: 'budget',
    budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-26T00:00:00.000Z' };
  let store = new SqliteInvestigationStore(file);
  try {
    store.enqueue(item, 'key', 'fingerprint');
    store.close();
    store = new SqliteInvestigationStore(file);
    assert.deepEqual(store.listPending().map(row => row.requestId), ['inv_1']);
    assert.deepEqual(store.enqueue({ ...item, id: 'another' }, 'key', 'fingerprint'), item);
    store.requestCancel(item, 'cancel-key', 'grant');
    store.close();
    store = new SqliteInvestigationStore(file);
    assert.equal(store.get('inv_1')?.cancelRequested, true);
    assert.equal(store.get('inv_1')?.state, 'cancelled');
    assert.equal(store.get('inv_1')?.result, null);
    assert.equal(store.requestCancel(item, 'cancel-key', 'grant').state, 'cancelled');
    assert.deepEqual(store.listPending(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('outbox write failure rolls back request and idempotency key together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  const probe = new DatabaseSync(file);
  const item: InvestigationRecord = { id: 'inv_fault', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant', profileRef: 'readonly', budgetRef: 'budget',
    budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-26T00:00:00.000Z' };
  try {
    probe.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON investigation_outbox
      BEGIN SELECT RAISE(ABORT, 'injected outbox fault'); END;`);
    assert.throws(() => store.enqueue(item, 'key', 'fingerprint'), /injected outbox fault/);
    assert.equal(store.get(item.id), null);
    assert.deepEqual(store.listPending(), []);
    probe.exec('DROP TRIGGER reject_outbox');
    assert.deepEqual(store.enqueue(item, 'key', 'fingerprint'), item);
  } finally { probe.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cancel receipt failure rolls back cancel intent and permits a clean retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  const probe = new DatabaseSync(file);
  const item: InvestigationRecord = { id: 'inv_cancel_fault', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant', profileRef: 'readonly', budgetRef: 'budget',
    budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-26T00:00:00.000Z' };
  try {
    store.enqueue(item, 'submit-key', 'fingerprint');
    probe.exec(`CREATE TRIGGER reject_cancel_receipt BEFORE INSERT ON investigation_cancel_receipts
      BEGIN SELECT RAISE(ABORT, 'injected cancel receipt fault'); END;`);
    assert.throws(() => store.requestCancel(item, 'cancel-key', 'grant'), /injected cancel receipt fault/);
    assert.equal(store.get(item.id)?.cancelRequested, false);
    probe.exec('DROP TRIGGER reject_cancel_receipt');
    assert.equal(store.requestCancel(item, 'cancel-key', 'grant').cancelRequested, true);
  } finally { probe.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('revoked cancel grant prevents intent and receipt in the same transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  const item: InvestigationRecord = { id: 'inv_cancel_revoked', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant', profileRef: 'readonly', budgetRef: 'budget',
    budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-26T00:00:00.000Z' };
  try {
    store.enqueue(item, 'submit-key', 'fingerprint');
    base.revokeGrant('grant', new Date().toISOString());
    assert.throws(() => store.requestCancel(item, 'cancel-key', 'grant'), /NOT_AVAILABLE/);
    assert.equal(store.get(item.id)?.cancelRequested, false);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

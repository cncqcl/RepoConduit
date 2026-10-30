import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

function record(id: string): InvestigationRecord {
  return { id, workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant',
    profileRef: 'readonly', budgetRef: 'budget', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'Trace flow',
    scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-26T00:00:00.000Z' };
}

function seed(file: string): SqliteStore {
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'workspace', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'investigate', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'grant', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/', 'tests/'], expiresAt: null, revokedAt: null });
  return base;
}

const claimAuthority = {
  verifyIsolation: (evidence: string, request: InvestigationRecord, revision: string) =>
    evidence === `isolated:${request.id}` && revision === request.profileRef,
  verifyNativeReceipt: () => false,
  verifyOutcomeReceipt: () => false,
};
function claimInput(id: string) {
  return { workerId: 'worker', isolationEvidence: `isolated:${id}`,
    profileRevision: 'readonly', permissionEpoch: 0, now: new Date('2026-09-27T00:00:00.000Z') };
}

test('candidate claim starts only its named queued request and preserves one workspace slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, claimAuthority);
  const peer = new SqliteInvestigationStore(file, claimAuthority);
  try {
    store.enqueue(record('inv_1'), 'one', 'one');
    store.enqueue(record('inv_2'), 'two', 'two');
    assert.equal(store.claimRequest('missing', claimInput('missing')), null);
    const chosen = store.claimRequest('inv_2', claimInput('inv_2'))!;
    assert.equal(chosen.requestId, 'inv_2');
    assert.equal(chosen.phase, 'start_intent');
    assert.equal(store.get('inv_1')?.attempts.length, 0);
    assert.equal(peer.claimRequest('inv_1', claimInput('inv_1')), null);
    assert.equal(peer.claimRequest('inv_2', claimInput('inv_2')), null);
    assert.deepEqual(peer.listUnsettled(), [chosen]);
  } finally { peer.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('candidate claim rechecks profile, epoch, and grant for the exact request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, claimAuthority);
  try {
    store.enqueue(record('inv_1'), 'one', 'one');
    assert.throws(() => store.claimRequest('inv_1', { ...claimInput('inv_1'),
      isolationEvidence: 'isolated:other' }), /NOT_AVAILABLE/);
    assert.equal(store.get('inv_1')?.attempts.length, 0);
    base.revokeGrant('grant', new Date('2026-09-27T00:00:01.000Z').toISOString());
    assert.equal(base.permissionEpoch('p', 'external', 'ws'), 1);
    assert.equal(store.claimRequest('inv_1', claimInput('inv_1')), null);
    assert.equal(store.claimRequest('inv_1', { ...claimInput('inv_1'), permissionEpoch: 1 }), null);
    assert.equal(store.get('inv_1')?.attempts.length, 0);
    assert.deepEqual(store.listUnsettled(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('enqueue requires current recipient-bound data.read over paths and related tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    const request = { ...record('inv_scope'), scope: { paths: ['src/main.ts'], symbols: [], relatedTests: ['tests/private.test.ts'] } };
    base.revokeGrant('read', new Date().toISOString());
    assert.throws(() => store.enqueue(request, 'scope', 'scope'), /NOT_AVAILABLE/);
    assert.deepEqual(store.listPending(), []);
    base.insertGrant({ id: 'read-src', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
      recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
    base.insertGrant({ id: 'read-other-recipient', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
      recipient: 'other', permissions: ['data.read'], dataPaths: ['tests/'], expiresAt: null, revokedAt: null });
    base.insertGrant({ id: 'read-empty', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
      recipient: 'ext', permissions: ['data.read'], dataPaths: [], expiresAt: null, revokedAt: null });
    assert.throws(() => store.enqueue(request, 'scope', 'scope'), /NOT_AVAILABLE/);
    base.insertGrant({ id: 'read-tests', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
      recipient: 'ext', permissions: ['data.read'], dataPaths: ['tests/private.test.ts'], expiresAt: null, revokedAt: null });
    assert.equal(store.enqueue(request, 'scope', 'scope').id, request.id);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('idempotent replay does not disclose a saved request after read authority is revoked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    store.enqueue(record('inv_1'), 'one', 'one');
    base.revokeGrant('read', new Date().toISOString());
    assert.throws(() => store.enqueue(record('inv_replay'), 'one', 'one'), /NOT_AVAILABLE/);
    assert.equal(store.listPending().length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('claim refuses queued request after data.read revocation under the current epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, claimAuthority);
  try {
    store.enqueue(record('inv_1'), 'one', 'one');
    base.revokeGrant('read', new Date().toISOString());
    assert.equal(store.claimRequest('inv_1', { ...claimInput('inv_1'), permissionEpoch: 1 }), null);
    assert.equal(store.claimNext({ ...claimInput('inv_1'), permissionEpoch: 1 }), null);
    assert.equal(store.get('inv_1')?.attempts.length, 0);
    assert.deepEqual(store.listUnsettled(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('claim refuses data.read that expires during synchronous isolation verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let deadline = 0;
  const authority = { ...claimAuthority, verifyIsolation: () => {
    while (Date.now() <= deadline) { /* Exercise grant expiry between eligibility checks. */ }
    return true;
  } };
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(record('inv_1'), 'one', 'one');
    deadline = Date.now() + 250;
    const connection = new DatabaseSync(file);
    try {
      connection.prepare('UPDATE grants SET expires_at=? WHERE id=?')
        .run(new Date(deadline).toISOString(), 'read');
    } finally { connection.close(); }
    assert.equal(store.claimRequest('inv_1', claimInput('inv_1')), null);
    assert.equal(store.get('inv_1')?.attempts.length, 0);
    assert.deepEqual(store.listUnsettled(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('candidate claim refuses an old permission epoch even when its grant remains active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, claimAuthority);
  try {
    base.insertGrant({ id: 'unrelated', principal: 'p', audience: 'external', workspaceId: 'ws',
      collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request'],
      expiresAt: null, revokedAt: null });
    store.enqueue(record('inv_1'), 'one', 'one');
    base.revokeGrant('unrelated', new Date('2026-09-27T00:00:01.000Z').toISOString());
    assert.equal(store.claimRequest('inv_1', claimInput('inv_1')), null);
    assert.equal(store.claimRequest('inv_1', { ...claimInput('inv_1'), permissionEpoch: 1 })?.requestId, 'inv_1');
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('candidate claims reserve at most two global slots across three workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, claimAuthority);
  const peer = new SqliteInvestigationStore(file, claimAuthority);
  try {
    for (const id of ['b', 'c']) {
      base.insertWorkspace({ id, name: id, canonicalRoot: `D:/fixture-${id}`, registeredBy: 'p' });
      base.insertCollaboration({ id: `col-${id}`, workspaceId: id, openedBy: 'p', purpose: id,
        hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: `copy-${id}`, workspaceId: id, canonicalRoot: `D:/fixture-${id}` });
      base.insertGrant({ id: `grant-${id}`, principal: 'p', audience: 'external', workspaceId: id,
        collaborationId: `col-${id}`, recipient: 'ext', permissions: ['investigation.request'],
        expiresAt: null, revokedAt: null });
      base.insertGrant({ id: `read-${id}`, principal: 'p', audience: 'external', workspaceId: id,
        collaborationId: `col-${id}`, recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'],
        expiresAt: null, revokedAt: null });
    }
    store.enqueue(record('inv_a'), 'a', 'a');
    for (const id of ['b', 'c']) {
      const request = { ...record(`inv_${id}`), workspaceId: id, collaborationId: `col-${id}`,
        workingCopyId: `copy-${id}`, grantId: `grant-${id}` };
      store.enqueue(request, id, id);
    }
    assert.equal(store.claimRequest('inv_a', claimInput('inv_a'))?.requestId, 'inv_a');
    assert.equal(peer.claimRequest('inv_b', claimInput('inv_b'))?.requestId, 'inv_b');
    assert.equal(store.claimRequest('inv_c', claimInput('inv_c')), null);
    assert.equal(store.get('inv_c')?.attempts.length, 0);
    assert.equal(store.listUnsettled().length, 2);
  } finally { peer.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('enqueue persists one request and one outbox entry, replays exact input, and conflicts on changed input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    const first = record('inv_1');
    assert.deepEqual(store.enqueue(first, 'key', 'fingerprint-a'), first);
    assert.deepEqual(store.enqueue(record('inv_new'), 'key', 'fingerprint-a'), first);
    assert.equal(store.listPending().length, 1);
    assert.deepEqual(store.listPending()[0], { requestId: 'inv_1', workspaceId: 'ws', collaborationId: 'col' });
    assert.throws(() => store.enqueue(record('inv_changed'), 'key', 'fingerprint-b'), StoreConflict);
    assert.equal(store.listPending().length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('queued cancellation is terminal, removes outbox atomically, and stale updates cannot overwrite it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    const first = store.enqueue(record('inv_1'), 'key', 'fingerprint');
    const cancelled = store.requestCancel(first, 'cancel-1', 'grant');
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.result, null);
    assert.deepEqual(store.listPending(), []);
    assert.deepEqual(store.get(first.id), cancelled);
    assert.deepEqual(store.requestCancel(cancelled, 'cancel-1', 'grant'), cancelled);
    assert.throws(() => store.requestCancel(first, 'cancel-2', 'grant'), StoreConflict);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cancel key replays one target and conflicts when reused for another request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    const first = store.enqueue(record('inv_a'), 'create-a', 'fingerprint-a');
    const second = store.enqueue(record('inv_b'), 'create-b', 'fingerprint-b');
    const cancelled = store.requestCancel(first, 'cancel-key', 'grant');
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual(store.listPending().map(row => row.requestId), [second.id]);
    assert.deepEqual(store.requestCancel(cancelled, 'cancel-key', 'grant'), cancelled);
    assert.throws(() => store.requestCancel(second, 'cancel-key', 'grant'), StoreConflict);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cancel request cannot overwrite a terminal result written by another connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  const other = new DatabaseSync(file);
  try {
    const queued = store.enqueue(record('inv_1'), 'key', 'fingerprint');
    const terminal = { ...queued, state: 'completed' as const };
    other.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
      .run(JSON.stringify(terminal), queued.id);
    assert.throws(() => store.requestCancel(queued, 'cancel-terminal', 'grant'), StoreConflict);
    assert.deepEqual(store.get(queued.id), terminal);
  } finally { other.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('same idempotency key across collaborations conflicts instead of creating a second job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    store.enqueue(record('inv_1'), 'shared-key', 'fingerprint-col-1');
    const changedTarget = { ...record('inv_2'), collaborationId: 'col-2' };
    assert.throws(() => store.enqueue(changedTarget, 'shared-key', 'fingerprint-col-2'), StoreConflict);
    assert.deepEqual(store.listPending().map(row => row.requestId), ['inv_1']);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('revoked grant cannot create a queued request at commit time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file);
  try {
    base.revokeGrant('grant', new Date().toISOString());
    assert.throws(() => store.enqueue(record('inv_revoked'), 'revoked-key', 'fingerprint'), /NOT_AVAILABLE/);
    assert.deepEqual(store.listPending(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy table with ambiguous same key across collaborations refuses automatic migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(`CREATE TABLE investigation_requests (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL,
      principal TEXT NOT NULL, audience TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, record_json TEXT NOT NULL,
      UNIQUE (workspace_id, collaboration_id, principal, audience, idempotency_key));`);
    const insert = legacy.prepare(`INSERT INTO investigation_requests
      (id,workspace_id,collaboration_id,principal,audience,idempotency_key,fingerprint,record_json)
      VALUES (?,?,?,?,?,?,?,?)`);
    insert.run('inv_1', 'ws', 'col', 'p', 'external', 'shared', 'a', JSON.stringify(record('inv_1')));
    insert.run('inv_2', 'ws', 'col-2', 'p', 'external', 'shared', 'b', JSON.stringify({ ...record('inv_2'), collaborationId: 'col-2' }));
    let opened: SqliteInvestigationStore | null = null;
    try { assert.throws(() => { opened = new SqliteInvestigationStore(file); }, StoreConflict); }
    finally { (opened as SqliteInvestigationStore | null)?.close(); }
    const rows = legacy.prepare('SELECT id FROM investigation_requests ORDER BY id').all() as { id: string }[];
    assert.deepEqual(rows.map(row => row.id), ['inv_1', 'inv_2']);
  } finally { legacy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unambiguous legacy key migrates without losing request or pending outbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-investigation-'));
  const file = join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(`CREATE TABLE investigation_requests (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL,
      principal TEXT NOT NULL, audience TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, record_json TEXT NOT NULL,
      UNIQUE (workspace_id, collaboration_id, principal, audience, idempotency_key));
      CREATE TABLE investigation_outbox (
        request_id TEXT PRIMARY KEY REFERENCES investigation_requests(id),
        workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
    const old = record('inv_1');
    legacy.prepare(`INSERT INTO investigation_requests
      (id,workspace_id,collaboration_id,principal,audience,idempotency_key,fingerprint,record_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(old.id, old.workspaceId, old.collaborationId, old.principal,
      old.audience, 'key', 'fingerprint', JSON.stringify(old));
    legacy.prepare(`INSERT INTO investigation_outbox(request_id,workspace_id,collaboration_id,created_at)
      VALUES (?,?,?,?)`).run(old.id, old.workspaceId, old.collaborationId, old.createdAt);
    const base = seed(file);
    const store = new SqliteInvestigationStore(file);
    try {
      assert.deepEqual(store.enqueue(record('inv_new'), 'key', 'fingerprint'), old);
      assert.deepEqual(store.listPending().map(row => row.requestId), [old.id]);
      assert.throws(() => store.enqueue({ ...record('inv_2'), collaborationId: 'other' }, 'key', 'other'), StoreConflict);
    } finally { store.close(); base.close(); }
  } finally { legacy.close(); rmSync(dir, { recursive: true, force: true }); }
});

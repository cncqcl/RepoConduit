import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import { authorize, PolicyError, type Grant } from '../../src/core/policy/authorize.js';

function removeFixture(dir: string): void {
  const child = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(child.startsWith('rcac-db-') && !child.includes('..') && !child.includes('\\'));
  rmSync(dir, { recursive: true, force: true });
}

test('idempotency survives a process-style reopen and rejects changed input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const path = join(dir, 'state.sqlite');
  const key = { principal: 'p', audience: 'a', workspaceId: 'ws_1', operation: 'collab.open', idempotencyKey: 'k' };
  try {
    let calls = 0;
    let db = new SqliteStore(path);
    const first = db.runIdempotent(key, { purpose: 'review' }, () => { calls++; return { id: 'col_1' }; });
    assert.deepEqual(first, { id: 'col_1' });
    db.close();
    db = new SqliteStore(path);
    assert.deepEqual(db.runIdempotent(key, { purpose: 'review' }, () => { calls++; return { id: 'col_2' }; }), first);
    assert.equal(calls, 1);
    assert.throws(() => db.runIdempotent(key, { purpose: 'different' }, () => ({ id: 'col_3' })), StoreConflict);
    db.close();
  } finally {
    removeFixture(dir);
  }
});

test('failed state mutation leaves no idempotency receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const key = { principal: 'p', audience: 'a', workspaceId: 'ws_1', operation: 'collab.open', idempotencyKey: 'k' };
  try {
    assert.throws(() => db.runIdempotent(key, { purpose: 'review' }, () => { throw Error('fault'); }));
    assert.deepEqual(db.runIdempotent(key, { purpose: 'review' }, () => ({ id: 'col_ok' })), { id: 'col_ok' });
  } finally {
    db.close();
    removeFixture(dir);
  }
});

test('workspace and collaboration associations persist and reject cross-workspace references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  try {
    db.insertWorkspace({ id: 'ws_a', name: 'A', canonicalRoot: 'D:/fixture-a', registeredBy: 'owner' });
    db.insertWorkspace({ id: 'ws_b', name: 'B', canonicalRoot: 'D:/fixture-b', registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col_a', workspaceId: 'ws_a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    assert.equal(db.getCollaboration('col_a', 'ws_a')?.id, 'col_a');
    assert.equal(db.getCollaboration('col_a', 'ws_b'), null);
    assert.throws(() => db.insertCollaboration({ id: 'col_bad', workspaceId: 'ws_missing', openedBy: 'owner', purpose: 'x', hostThreadId: null, state: 'open' }));
  } finally {
    db.close();
    removeFixture(dir);
  }
});

test('async mutation is rejected before an idempotency receipt can be stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const key = { principal: 'p', audience: 'a', workspaceId: 'ws_1', operation: 'collab.open', idempotencyKey: 'async' };
  try {
    const invalidPromiseMutation = (() => Promise.resolve({ id: 'late' })) as unknown as () => { id: string };
    assert.throws(() => db.runIdempotent(key, { x: 1 }, invalidPromiseMutation), /synchronous/i);
    assert.deepEqual(db.runIdempotent(key, { x: 1 }, () => ({ id: 'actual' })), { id: 'actual' });
  } finally {
    db.close();
    removeFixture(dir);
  }
});

test('async mutation cannot schedule a late write after rollback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const key = { principal: 'p', audience: 'a', workspaceId: 'ws_1', operation: 'collab.open', idempotencyKey: 'late' };
  try {
    const invalidAsyncMutation = (async () => {
      await Promise.resolve();
      db.insertWorkspace({ id: 'late_ws', name: 'late', canonicalRoot: 'D:/late', registeredBy: 'p' });
      return { id: 'late_ws' };
    }) as unknown as () => { id: string };
    assert.throws(() => db.runIdempotent(key, { x: 1 }, invalidAsyncMutation), /synchronous/i);
    await Promise.resolve();
    assert.equal(db.getWorkspace('late_ws'), null);
  } finally {
    db.close();
    removeFixture(dir);
  }
});

test('grant revocation persists across restart and increments permission epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const path = join(dir, 'state.sqlite');
  const grant: Grant = { id: 'gr_1', principal: 'external', audience: 'mcp', workspaceId: 'ws_a',
    recipient: 'external', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null };
  let db = new SqliteStore(path);
  try {
    db.insertGrant(grant);
    assert.equal(db.permissionEpoch('external', 'mcp', 'ws_a'), 0);
    db.revokeGrant(grant.id, '2026-09-26T00:00:00.000Z');
    assert.equal(db.permissionEpoch('external', 'mcp', 'ws_a'), 1);
    db.close();
    db = new SqliteStore(path);
    assert.equal(db.permissionEpoch('external', 'mcp', 'ws_a'), 1);
    assert.throws(() => authorize({ principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp', now: new Date() },
      'repo.read', { workspaceId: 'ws_a' }, db.grantsFor('external', 'mcp')), PolicyError);
  } finally {
    db.close();
    removeFixture(dir);
  }
});

test('data paths survive restart and legacy grant rows stay unscoped after migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const path = join(dir, 'state.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE grants (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, audience TEXT NOT NULL,
    workspace_id TEXT NOT NULL, collaboration_id TEXT, recipient TEXT,
    permissions_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
  )`);
  old.prepare(`INSERT INTO grants(id,principal,audience,workspace_id,recipient,permissions_json)
    VALUES (?,?,?,?,?,?)`).run('legacy', 'external', 'mcp', 'ws_a', 'external', '["data.read"]');
  old.close();
  let db: SqliteStore | undefined;
  try {
    db = new SqliteStore(path);
    const grant: Grant = { id: 'scoped', principal: 'external', audience: 'mcp', workspaceId: 'ws_a',
      recipient: 'external', permissions: ['data.read'], dataPaths: ['src/ok.ts', 'docs/'], expiresAt: null, revokedAt: null };
    db.insertGrant(grant);
    db.close();
    db = new SqliteStore(path);
    const grants = db.grantsFor('external', 'mcp');
    assert.equal(grants.find((item) => item.id === 'legacy')?.dataPaths, undefined);
    assert.deepEqual(grants.find((item) => item.id === 'scoped')?.dataPaths, ['src/ok.ts', 'docs/']);
    const context = { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
    assert.throws(() => authorize(context, 'repo.read', { workspaceId: 'ws_a' }, grants.filter((item) => item.id === 'legacy')), PolicyError);
    assert.deepEqual(authorize(context, 'repo.read', { workspaceId: 'ws_a' }, grants).dataPaths, ['src/ok.ts', 'docs/']);
  } finally {
    db?.close();
    removeFixture(dir);
  }
});

test('read-only idempotency lookup detects an exact replay before filesystem work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-db-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const key = { principal: 'p', audience: 'a', workspaceId: 'ws_1', operation: 'artifact.begin', idempotencyKey: 'k' };
  try {
    assert.equal(db.lookupIdempotent(key, { bundle: 'b1' }), null);
    db.runIdempotent(key, { bundle: 'b1' }, () => ({ id: 'b1' }));
    assert.deepEqual(db.lookupIdempotent(key, { bundle: 'b1' }), { id: 'b1' });
    assert.throws(() => db.lookupIdempotent(key, { bundle: 'b2' }), StoreConflict);
  } finally {
    db.close();
    removeFixture(dir);
  }
});

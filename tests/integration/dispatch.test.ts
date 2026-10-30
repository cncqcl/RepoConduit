import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DispatchService } from '../../src/application/dispatch.js';
import { PolicyError, type Grant } from '../../src/core/policy/authorize.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';

test('local registration and external open share one authorized dispatcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const grants: Grant[] = [
    { id: 'gr_admin', principal: 'owner', audience: 'cli-admin', workspaceId: 'management',
      permissions: ['admin.workspace'], expiresAt: null, revokedAt: null },
  ];
  const app = new DispatchService(db, () => grants);
  const admin = { principal: 'owner', audience: 'cli-admin', recipient: 'owner', surface: 'local_admin' as const, now: new Date() };
  try {
    const workspace = await app.dispatch(admin, { operation: 'admin.register_workspace', scope: { workspaceId: 'management' },
      idempotencyKey: 'register-a', payload: { name: 'Fixture A', root: dir } }) as { id: string };
    grants.push({ id: 'gr_open', principal: 'external', audience: 'mcp-a', workspaceId: workspace.id,
      recipient: 'external', permissions: ['collab.create', 'collab.read'], expiresAt: null, revokedAt: null });
    const external = { principal: 'external', audience: 'mcp-a', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
    const command = { operation: 'collab.open', scope: { workspaceId: workspace.id }, idempotencyKey: 'open-1', payload: { purpose: 'review flow' } };
    const first = await app.dispatch(external, command) as { id: string; workspaceId: string };
    const replay = await app.dispatch(external, command) as { id: string };
    assert.equal(first.id, replay.id);
    assert.equal(first.workspaceId, workspace.id);
    assert.equal((await app.dispatch(external, { operation: 'collab.get', scope: { workspaceId: workspace.id, collaborationId: first.id }, payload: {} }) as { id: string }).id, first.id);
    await assert.rejects(app.dispatch(external, { operation: 'collab.open', scope: { workspaceId: workspace.id }, idempotencyKey: 'open-2',
      payload: { purpose: 'x', principal: 'owner' } }), /payload/i);
    grants.splice(1);
    await assert.rejects(app.dispatch(external, { operation: 'collab.get', scope: { workspaceId: workspace.id, collaborationId: first.id }, payload: {} }), PolicyError);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collaboration-scoped grant cannot list another issue or create a new one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  const own = 'col_01234567-89ab-4cde-8f01-234567890abc';
  const other = 'col_01234567-89ab-4cde-8f01-234567890abd';
  db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  db.insertCollaboration({ id: own, workspaceId: ws, openedBy: 'owner', purpose: 'visible', hostThreadId: null, state: 'open' });
  db.insertCollaboration({ id: other, workspaceId: ws, openedBy: 'owner', purpose: 'secret', hostThreadId: null, state: 'open' });
  const grant: Grant = { id: 'gr_scoped', principal: 'external', audience: 'mcp', workspaceId: ws,
    collaborationId: own, recipient: 'external', permissions: ['collab.read', 'collab.create'], expiresAt: null, revokedAt: null };
  const app = new DispatchService(db, () => [grant]);
  const external = { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
  try {
    const listed = await app.dispatch(external, { operation: 'collab.list', scope: { workspaceId: ws, collaborationId: own }, payload: {} }) as { id: string }[];
    assert.deepEqual(listed.map((item) => item.id), [own]);
    await assert.rejects(app.dispatch(external, { operation: 'collab.open', scope: { workspaceId: ws, collaborationId: own },
      idempotencyKey: 'new', payload: { purpose: 'new issue' } }), PolicyError);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('result disclosure is denied when grant is revoked during handler execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  const col = 'col_01234567-89ab-4cde-8f01-234567890abc';
  db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'private', hostThreadId: null, state: 'open' });
  let checks = 0;
  const grant: Grant = { id: 'gr', principal: 'external', audience: 'mcp', workspaceId: ws, collaborationId: col,
    recipient: 'external', permissions: ['collab.read'], expiresAt: null, revokedAt: null };
  const app = new DispatchService(db, () => ++checks === 1 ? [grant] : []);
  try {
    await assert.rejects(app.dispatch({ principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp', now: new Date() },
      { operation: 'collab.get', scope: { workspaceId: ws, collaborationId: col }, payload: {} }), PolicyError);
    assert.equal(checks, 2);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin grant rejects empty recipient and empty explicit collaboration scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  const adminGrant: Grant = { id: 'gr_admin', principal: 'owner', audience: 'admin', workspaceId: 'management',
    permissions: ['admin.grant'], expiresAt: null, revokedAt: null };
  const app = new DispatchService(db, () => [adminGrant]);
  const admin = { principal: 'owner', audience: 'admin', recipient: 'owner', surface: 'local_admin' as const, now: new Date() };
  const payload = { principal: 'external', audience: 'mcp', workspaceId: ws,
    recipient: 'external', permissions: ['data.read'], expiresAt: null };
  try {
    await assert.rejects(app.dispatch(admin, { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'empty-recipient', payload: { ...payload, recipient: '' } }), /Invalid grant/);
    await assert.rejects(app.dispatch(admin, { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'empty-col', payload: { ...payload, collaborationId: '' } }), /Invalid grant/);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin grant requires explicit valid data paths for code reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  const adminGrant: Grant = { id: 'gr_admin', principal: 'owner', audience: 'admin', workspaceId: 'management',
    permissions: ['admin.grant'], expiresAt: null, revokedAt: null };
  const app = new DispatchService(db, () => [adminGrant]);
  const admin = { principal: 'owner', audience: 'admin', recipient: 'owner', surface: 'local_admin' as const, now: new Date() };
  const payload = { principal: 'external', audience: 'mcp', workspaceId: ws,
    recipient: 'external', permissions: ['data.read'], expiresAt: null };
  try {
    await assert.rejects(app.dispatch(admin, { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'missing-paths', payload }), /Invalid grant/);
    await assert.rejects(app.dispatch(admin, { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'bad-paths', payload: { ...payload, dataPaths: ['src/../secret.ts'] } }), /Invalid grant/);
    const receipt = await app.dispatch(admin, { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'scoped-paths', payload: { ...payload, dataPaths: ['src/'] } }) as { id: string; dataPaths: string[] };
    assert.deepEqual(receipt.dataPaths, ['src/']);
    assert.deepEqual(db.grantsFor('external', 'mcp')[0]?.dataPaths, ['src/']);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grant expiry is checked against a fresh trusted clock before disclosure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  const col = 'col_01234567-89ab-4cde-8f01-234567890abc';
  db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'private', hostThreadId: null, state: 'open' });
  const grant: Grant = { id: 'gr', principal: 'external', audience: 'mcp', workspaceId: ws, collaborationId: col,
    recipient: 'external', permissions: ['collab.read'], expiresAt: '2026-09-26T00:00:01.000Z', revokedAt: null };
  let checks = 0;
  const app = new DispatchService(db, () => [grant], () => ++checks === 1 ? new Date('2026-09-26T00:00:00.000Z') : new Date('2026-09-26T00:00:02.000Z'));
  try {
    await assert.rejects(app.dispatch({ principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp', now: new Date('2026-09-26T00:00:00.000Z') },
      { operation: 'collab.get', scope: { workspaceId: ws, collaborationId: col }, payload: {} }), PolicyError);
    assert.equal(checks, 2);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

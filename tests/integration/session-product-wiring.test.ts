import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { BindingApplication } from '../../src/application/bindings.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();

test('successor command uses trusted observation, fences old binding, and replays after restart', async () => {
  const outer = mkdtempSync(join(fixtureRoot, 'rcac-successor-product-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const seed = new SqliteStore(file);
  const ws = 'workspace-a', col = 'issue-a';
  seed.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', recipient: 'owner', workspaceId: ws,
    collaborationId: col, permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO context_revisions (id,workspace_id,collaboration_id,revision_json) VALUES (?,?,?,?)')
    .run('ctx-a', ws, col, '{}');
  raw.close(); seed.close();
  const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
  const scope = { workspaceId: ws, collaborationId: col };
  let observed = 'chat-a', observations = 0, syncs = 0;
  let app = openApplication(dir, { conversation: { observeBinding: async () => {
    observations++;
    return { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: observed, cursor: 'turn-1' };
  } }, conversationPort: { syncDelta: async (state) => {
    syncs++;
    return { providerId: state.providerId, accountId: state.accountId, nativeSessionId: state.nativeSessionId,
      fromCursor: state.cursor, nextCursor: state.cursor, complete: true, generating: false,
      historyChanged: false, messages: [] };
  } } });
  try {
    const first = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      idempotencyKey: 'bind-a', payload: {} }) as { bindingId: string; epoch: number; revision: number };
    const syncCommand = { operation: 'conversation.sync', scope, idempotencyKey: 'sync-a',
      payload: { bindingId: first.bindingId, expectedEpoch: first.epoch } };
    const synced = await app.dispatch.dispatch(context, syncCommand) as { state: { revision: number } };
    assert.equal(syncs, 1);
    observed = 'chat-b';
    const command = { operation: 'conversation.successor', scope, idempotencyKey: 'successor-a',
      payload: { predecessorBindingId: first.bindingId, expectedEpoch: first.epoch,
        expectedRevision: synced.state.revision, contextRevisionId: 'ctx-a' } };
    const next = await app.dispatch.dispatch(context, command) as { bindingId: string; parentBindingId: string;
      lifecycle: string; contextRevisionId: string; control: string };
    assert.equal(next.parentBindingId, first.bindingId);
    assert.equal(next.contextRevisionId, 'ctx-a');
    assert.equal(next.lifecycle, 'current');
    assert.equal(next.control, 'human_controlled');
    assert.equal(observations, 2);
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.handoff', scope,
      idempotencyKey: 'old-handoff', payload: { bindingId: first.bindingId, expectedEpoch: 0 } }));
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      idempotencyKey: 'old-send', payload: { bindingId: first.bindingId, expectedEpoch: 0, text: 'forbidden' } }));
    app.close();
    app = openApplication(dir);
    assert.deepEqual(await app.dispatch.dispatch(context, command), next);
    assert.deepEqual(await app.dispatch.dispatch(context, syncCommand), synced);
    assert.equal(syncs, 1);
    await assert.rejects(app.dispatch.dispatch(context, { ...syncCommand, idempotencyKey: 'sync-new' }));
    await assert.rejects(app.dispatch.dispatch(context, { ...command, idempotencyKey: 'successor-c',
      payload: { ...command.payload, contextRevisionId: 'missing' } }));
  } finally {
    app.close();
    assert.match(relative(resolve(fixtureRoot), resolve(outer)), /^rcac-successor-product-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('production bind uses trusted observed identity and handoff survives restart', async () => {
  const outer = mkdtempSync(join(fixtureRoot, 'rcac-session-product-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const seed = new SqliteStore(file);
  const ws = 'workspace-a', col = 'issue-a';
  seed.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', workspaceId: ws, collaborationId: col,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  seed.close();
  const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
  const scope = { workspaceId: ws, collaborationId: col };
  let observations = 0;
  let app = openApplication(dir, { conversation: { observeBinding: async () => {
    observations++;
    return { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1' };
  } } });
  try {
    const command = { operation: 'conversation.bind', scope, idempotencyKey: 'bind-1', payload: {} };
    const first = await app.dispatch.dispatch(context, command) as { bindingId: string; nativeSessionId: string; epoch: number };
    assert.equal(first.nativeSessionId, 'chat-a');
    assert.equal(first.epoch, 0);
    assert.deepEqual(await app.dispatch.dispatch(context, command), first);
    assert.equal(observations, 1);
    await assert.rejects(app.dispatch.dispatch(context, { ...command, idempotencyKey: 'bind-2',
      payload: { nativeSessionId: 'attacker-chat' } }), /payload/i);
    const handoffCommand = { operation: 'conversation.handoff', scope, idempotencyKey: 'handoff-1',
      payload: { bindingId: first.bindingId, expectedEpoch: 0 } };
    const handoff = await app.dispatch.dispatch(context, handoffCommand) as { control: string; epoch: number };
    assert.equal(handoff.control, 'human_controlled');
    assert.equal(handoff.epoch, 1);
    app.close();
    app = openApplication(dir);
    assert.deepEqual(await app.dispatch.dispatch(context, handoffCommand), handoff);
    await assert.rejects(app.dispatch.dispatch(context, { ...handoffCommand,
      payload: { bindingId: first.bindingId, expectedEpoch: 1 } }), /CONFLICT/);
    await assert.rejects(app.dispatch.dispatch(context, { ...handoffCommand, idempotencyKey: 'handoff-2' }), /CONFLICT|epoch/i);
    await assert.rejects(app.dispatch.dispatch(context, { ...command, idempotencyKey: 'bind-3' }), /capability/i);
  } finally {
    app.close();
    assert.match(relative(resolve(fixtureRoot), resolve(outer)), /^rcac-session-product-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('binding rejects native chat reuse and cross-collaboration handoff', async () => {
  const outer = mkdtempSync(join(fixtureRoot, 'rcac-session-product-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  for (const ws of ['workspace-a', 'workspace-b']) {
    seed.insertWorkspace({ id: ws, name: ws, canonicalRoot: join(dir, ws), registeredBy: 'owner' });
    seed.insertCollaboration({ id: `issue-${ws}`, workspaceId: ws, openedBy: 'owner', purpose: ws, hostThreadId: null, state: 'open' });
    seed.insertGrant({ id: `grant-${ws}`, principal: 'owner', audience: 'host', workspaceId: ws,
      permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  }
  seed.close();
  const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
  let nativeSessionId = 'chat-a';
  const app = openApplication(dir, { conversation: { observeBinding: async () =>
    ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId, cursor: 'turn-1' }) } });
  try {
    const firstScope = { workspaceId: 'workspace-a', collaborationId: 'issue-workspace-a' };
    const secondScope = { workspaceId: 'workspace-b', collaborationId: 'issue-workspace-b' };
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope: firstScope,
      idempotencyKey: 'bind-a', payload: {} }) as { bindingId: string };
    nativeSessionId = 'chat-b';
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.bind', scope: firstScope,
      idempotencyKey: 'bind-a-second-chat', payload: {} }));
    nativeSessionId = 'chat-a';
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.bind', scope: secondScope,
      idempotencyKey: 'bind-b', payload: {} }));
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.handoff', scope: secondScope,
      idempotencyKey: 'handoff-b', payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }));
  } finally {
    app.close();
    assert.match(relative(resolve(fixtureRoot), resolve(outer)), /^rcac-session-product-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('binding fails closed on incomplete observation and revoked authority before write', async () => {
  const outer = mkdtempSync(join(fixtureRoot, 'rcac-session-product-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  seed.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', workspaceId: 'workspace-a',
    collaborationId: 'issue-a', permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
  const command = { operation: 'conversation.bind', scope, idempotencyKey: 'bind-1', payload: {} };
  const incomplete = openApplication(dir, { conversation: { observeBinding: async () =>
    ({ providerId: 'provider-a', accountId: '', nativeSessionId: 'chat-a', cursor: 'turn-1' }) } });
  try { await assert.rejects(incomplete.dispatch.dispatch(context, command), /incomplete/i); }
  finally { incomplete.close(); }
  const revoked = openApplication(dir, { conversation: { observeBinding: async () => {
    seed.revokeGrant('grant', new Date().toISOString());
    return { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1' };
  } } });
  try {
    await assert.rejects(revoked.dispatch.dispatch(context, command));
    seed.insertGrant({ id: 'grant-2', principal: 'owner', audience: 'host', workspaceId: 'workspace-a',
      collaborationId: 'issue-a', permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
    const bound = await revoked.dispatch.dispatch(context, command) as { bindingId: string };
    assert.ok(bound.bindingId);
    await assert.rejects(revoked.dispatch.dispatch(context, { ...command, payload: { cursor: 'forged' } }), /payload/i);
  } finally {
    revoked.close(); seed.close();
    assert.match(relative(resolve(fixtureRoot), resolve(outer)), /^rcac-session-product-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('a stale prechecked grant cannot commit bind or handoff inside the SQLite write transaction', async () => {
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-session-product-'));
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const seed = new SqliteStore(file);
  const db = new SessionControlSqlite(file);
  const workspaceId = 'workspace-a', collaborationId = 'issue-a';
  seed.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant-a', principal: 'owner', audience: 'host', workspaceId,
    collaborationId, permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  const permit = authorize(context, 'conversation.bind', { workspaceId, collaborationId },
    seed.grantsFor('owner', 'host'));
  const request = { context, workspaceId, collaborationId, idempotencyKey: 'bind-stale' };
  const service = new BindingApplication(db, async () => permit, { observeBinding: async () =>
    ({ providerId: 'provider', accountId: 'account', nativeSessionId: 'chat-a', cursor: 'turn-1' }) });
  try {
    seed.revokeGrant('grant-a', new Date().toISOString());
    await assert.rejects(service.bind(request));
    assert.equal(db.lookupIdempotent({ principal: 'owner', audience: 'host', workspaceId,
      operation: 'conversation.bind', idempotencyKey: 'bind-stale' },
    { scope: { workspaceId, collaborationId }, payload: {} }), null);
    seed.insertGrant({ id: 'grant-b', principal: 'owner', audience: 'host', workspaceId,
      collaborationId, permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
    const currentPermit = authorize(context, 'conversation.bind', { workspaceId, collaborationId },
      seed.grantsFor('owner', 'host'));
    const current = new BindingApplication(db, async () => currentPermit, { observeBinding: async () =>
      ({ providerId: 'provider', accountId: 'account', nativeSessionId: 'chat-a', cursor: 'turn-1' }) });
    const bound = await current.bind({ ...request, idempotencyKey: 'bind-current' });
    const handoffPermit = authorize(context, 'conversation.handoff', { workspaceId, collaborationId },
      seed.grantsFor('owner', 'host'));
    const handoffService = new BindingApplication(db, async () => handoffPermit);
    seed.revokeGrant('grant-b', new Date().toISOString());
    await assert.rejects(handoffService.handoff({ ...request, idempotencyKey: 'handoff-stale',
      bindingId: bound.bindingId, expectedEpoch: 0 }));
    assert.equal(db.get(bound.bindingId)?.control, 'host_controlled');
    assert.equal(db.get(bound.bindingId)?.epoch, 0);
  } finally { db.close(); seed.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy duplicate current bindings require explicit reconciliation without losing history', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-session-product-'));
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const seed = new SqliteStore(file);
  seed.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.close();
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(`CREATE TABLE session_control (
      binding_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, account_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL, epoch INTEGER NOT NULL, state_json TEXT NOT NULL);
      CREATE UNIQUE INDEX session_control_native_chat
      ON session_control(provider_id,account_id,native_session_id);`);
    for (const native of ['chat-a', 'chat-b']) {
      const state = { bindingId: native, workspaceId: 'workspace-a', collaborationId: 'issue-a',
        providerId: 'provider', accountId: 'account', nativeSessionId: native, cursor: 'turn-1',
        control: 'host_controlled', epoch: 0, revision: 0 };
      legacy.prepare(`INSERT INTO session_control
        (binding_id,workspace_id,collaboration_id,provider_id,account_id,native_session_id,revision,epoch,state_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(native, state.workspaceId, state.collaborationId,
        state.providerId, state.accountId, native, 0, 0, JSON.stringify(state));
    }
  } finally { legacy.close(); }
  try {
    assert.throws(() => new SessionControlSqlite(file), /RECONCILE_REQUIRED/);
    const inspect = new DatabaseSync(file);
    try {
      assert.equal((inspect.prepare('SELECT COUNT(*) AS count FROM session_control').get() as { count: number }).count, 2);
    } finally { inspect.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

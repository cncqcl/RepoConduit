import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlService } from '../../src/application/session-control.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import type { Permit } from '../../src/core/policy/authorize.js';

const initial: SessionState = {
  bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
  providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
  control: 'host_controlled', epoch: 0, revision: 0,
};

test('current scope lookup returns only the explicitly selected current binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-scope-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-scope', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    assert.equal(store.currentForScope('workspace-a', 'issue-a'), null);
    store.create(initial);
    assert.equal(store.currentForScope('workspace-a', 'issue-a')?.bindingId, 'binding-a');
    assert.equal(store.currentForScope('other', 'issue-a'), null);
    assert.equal(store.currentForScope('workspace-a', 'other'), null);
    const db = new DatabaseSync(file);
    try { db.prepare("UPDATE session_control SET lifecycle='superseded' WHERE binding_id=?").run('binding-a'); }
    finally { db.close(); }
    assert.equal(store.currentForScope('workspace-a', 'issue-a'), null);
  } finally { store?.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('handoff and resumed cursor survive a real SQLite reopen with epoch fencing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-db-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    store.create(initial);
    const port = { syncDelta: async () => ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-4', complete: true, generating: false,
      historyChanged: false, messages: [
        { nativeMessageId: 'm1', version: 'v1', text: 'human 1' },
        { nativeMessageId: 'm2', version: 'v1', text: 'human 2' },
        { nativeMessageId: 'm3', version: 'v1', text: 'human 3' },
      ] }) };
    const first = new SessionControlService(store, port);
    assert.equal(first.handoff('binding-a', 0).epoch, 1);
    store.close();
    store = new SessionControlSqlite(file);
    const resumed = new SessionControlService(store, port);
    assert.equal(store.get('binding-a')?.control, 'human_controlled');
    assert.throws(() => resumed.assertHostCanSend('binding-a', 0), /epoch|control/i);
    const receipt = await resumed.syncAndResume('binding-a', 1);
    assert.equal(receipt.complete, true);
    assert.deepEqual(receipt.messages, [
      { nativeMessageId: 'm1', version: 'v1', text: 'human 1' },
      { nativeMessageId: 'm2', version: 'v1', text: 'human 2' },
      { nativeMessageId: 'm3', version: 'v1', text: 'human 3' },
    ]);
    assert.equal(receipt.state.epoch, 2);
    store.close();
    store = new SessionControlSqlite(file);
    assert.equal(store.get('binding-a')?.cursor, 'turn-4');
    const replay = await new SessionControlService(store, port).syncAndResume('binding-a', 1);
    assert.equal(replay.receiptId, receipt.receiptId);
    assert.deepEqual(replay.messages, receipt.messages);
    const acked = new SessionControlService(store, port).ackSyncReceipt('binding-a', receipt.receiptId!);
    assert.equal(acked.control, 'host_controlled');
    assert.equal(acked.epoch, 2);
    store.close();
    store = new SessionControlSqlite(file);
    assert.equal(new SessionControlService(store, port).ackSyncReceipt('binding-a', receipt.receiptId!).revision, acked.revision);
    assert.equal(new SessionControlService(store, port).assertHostCanSend('binding-a', 2).control, 'host_controlled');
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submitted send reconciles only with correlated native user and reply evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-db-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  let sends = 0;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    store.create(initial);
    const port = {
      syncDelta: async (binding: SessionState) => binding.sendIntent ? {
        providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
        fromCursor: 'turn-1', nextCursor: 'turn-3', complete: true, generating: false,
        historyChanged: false, messages: [
          { nativeMessageId: 'user-2', version: 'v1', text: 'question' },
          { nativeMessageId: 'reply-3', version: 'v1', text: 'answer' },
        ], completedSend: { sendIntentId: binding.sendIntent.id,
          nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' },
      } : { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
        fromCursor: 'turn-1', nextCursor: 'turn-1', complete: true, generating: false,
        historyChanged: false, messages: [] },
      send: async () => { sends++; return { status: 'submitted' as const }; },
    };
    const service = new SessionControlService(store, port);
    assert.equal((await service.send('binding-a', 0, 'question')).status, 'submitted');
    assert.equal(store.get('binding-a')?.sendIntent?.status, 'awaiting_result');
    assert.throws(() => service.assertHostCanSend('binding-a', 0), /intent/i);
    store.close();
    store = new SessionControlSqlite(file);
    const resumed = new SessionControlService(store, port);
    const receipt = await resumed.reconcileAwaitingResult('binding-a', 0);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.state.control, 'host_controlled');
    assert.equal(receipt.state.cursor, 'turn-3');
    assert.equal(receipt.state.epoch, 1);
    assert.equal(receipt.state.sendIntent, undefined);
    assert.deepEqual(receipt.messages.map((message) => message.nativeMessageId), ['user-2', 'reply-3']);
    assert.throws(() => resumed.assertHostCanSend('binding-a', 1), /intent|receipt/i);
    store.close();
    store = new SessionControlSqlite(file);
    const replay = await new SessionControlService(store, port).syncAndResume('binding-a', 0);
    assert.equal(replay.receiptId, receipt.receiptId);
    new SessionControlService(store, port).ackSyncReceipt('binding-a', receipt.receiptId!);
    assert.equal(new SessionControlService(store, port).assertHostCanSend('binding-a', 1).cursor, 'turn-3');
    assert.equal(sends, 1);
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native chat cannot bind across workspaces for one provider and account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-db-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const store = new SessionControlSqlite(file);
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertWorkspace({ id: 'workspace-b', name: 'B', canonicalRoot: 'D:/fixture-session-b', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertCollaboration({ id: 'issue-b', workspaceId: 'workspace-b', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store.create(initial);
    assert.throws(() => store.create({ ...initial, bindingId: 'binding-b', workspaceId: 'workspace-b',
      collaborationId: 'issue-b' }));
    store.create({ ...initial, bindingId: 'binding-c', workspaceId: 'workspace-b',
      collaborationId: 'issue-b', providerId: 'provider-b' });
    assert.equal(store.get('binding-b'), null);
    assert.equal(store.get('binding-c')?.providerId, 'provider-b');
    assert.throws(() => store.compareAndSwap(0, { ...initial, providerId: 'provider-b', revision: 1 }), /CONFLICT/);
  } finally {
    store.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy session rows without provider identity require reconciliation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-db-'));
  const file = join(dir, 'state.sqlite');
  const old = new DatabaseSync(file);
  try {
    old.exec(`CREATE TABLE session_control (
      binding_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL,
      account_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL, epoch INTEGER NOT NULL, state_json TEXT NOT NULL
    )`);
    old.prepare(`INSERT INTO session_control VALUES (?,?,?,?,?,?,?,?)`).run(
      'binding-a', 'workspace-a', 'issue-a', 'account-a', 'chat-a', 0, 0, JSON.stringify(initial));
    old.close();
    assert.throws(() => new SessionControlSqlite(file), /RECONCILE_REQUIRED/);
    const check = new DatabaseSync(file);
    assert.equal((check.prepare('SELECT COUNT(*) AS count FROM session_control').get() as { count: number }).count, 1);
    check.close();
  } finally {
    if (old.isOpen) old.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy duplicate current bindings reject lifecycle migration without mutating rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-migrate-'));
  const file = join(dir, 'state.sqlite');
  const old = new DatabaseSync(file);
  try {
    old.exec(`CREATE TABLE session_control (
      binding_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, account_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL, epoch INTEGER NOT NULL, state_json TEXT NOT NULL
    )`);
    const insert = old.prepare('INSERT INTO session_control VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run('binding-a', 'workspace-a', 'issue-a', 'provider-a', 'account-a', 'chat-a', 0, 0, JSON.stringify(initial));
    insert.run('binding-b', 'workspace-a', 'issue-a', 'provider-a', 'account-a', 'chat-b', 0, 0,
      JSON.stringify({ ...initial, bindingId: 'binding-b', nativeSessionId: 'chat-b' }));
    old.close();
    assert.throws(() => new SessionControlSqlite(file), /RECONCILE_REQUIRED/);
    const inspect = new DatabaseSync(file);
    assert.equal((inspect.prepare('SELECT COUNT(*) AS count FROM session_control').get() as { count: number }).count, 2);
    const columns = inspect.prepare('PRAGMA table_info(session_control)').all() as { name: string }[];
    assert.equal(columns.some((column) => column.name === 'lifecycle'), false);
    inspect.close();
  } finally {
    if (old.isOpen) old.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy binding with provider identity migrates to current lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-migrate-'));
  const file = join(dir, 'state.sqlite');
  const old = new DatabaseSync(file);
  let migrated: SessionControlSqlite | undefined;
  try {
    old.exec(`CREATE TABLE session_control (
      binding_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, account_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL, epoch INTEGER NOT NULL, state_json TEXT NOT NULL
    )`);
    old.prepare('INSERT INTO session_control VALUES (?,?,?,?,?,?,?,?,?)').run('binding-a',
      'workspace-a', 'issue-a', 'provider-a', 'account-a', 'chat-a', 0, 0, JSON.stringify(initial));
    old.close();
    migrated = new SessionControlSqlite(file);
    assert.equal(migrated.isCurrent('binding-a'), true);
    assert.equal(migrated.get('binding-a')?.lifecycle, 'current');
  } finally {
    migrated?.close(); if (old.isOpen) old.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('binding creation rejects wrong workspace and stale SQLite connection loses CAS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-db-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const first = new SessionControlSqlite(file);
  const second = new SessionControlSqlite(file);
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertWorkspace({ id: 'workspace-b', name: 'B', canonicalRoot: 'D:/fixture-session-b', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    assert.throws(() => first.create({ ...initial, workspaceId: 'workspace-b' }), /NOT_AVAILABLE/);
    first.create(initial);
    assert.equal(first.get('missing'), null);
    const stale = second.get('binding-a')!;
    assert.equal(first.compareAndSwap(0, { ...initial, control: 'human_controlled', epoch: 1, revision: 1 }), true);
    assert.equal(second.compareAndSwap(stale.revision, { ...stale, control: 'host_controlled', revision: 1 }), false);
    assert.equal(second.get('binding-a')?.epoch, 1);
    assert.throws(() => first.compareAndSwap(1, { ...initial, workspaceId: 'workspace-b', revision: 2 }), /CONFLICT/);
  } finally {
    second.close();
    first.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit successor is atomic, scoped, replayable, and preserves predecessor history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-successor-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let first: SessionControlSqlite | undefined;
  let second: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner',
      purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertWorkspace({ id: 'workspace-b', name: 'B', canonicalRoot: join(dir, 'other'), registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-b', workspaceId: 'workspace-b', openedBy: 'owner',
      purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', recipient: 'owner',
      workspaceId: 'workspace-a', collaborationId: 'issue-a', permissions: ['conversation.control'],
      expiresAt: null, revokedAt: null });
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO context_revisions (id,workspace_id,collaboration_id,revision_json) VALUES (?,?,?,?)')
      .run('ctx-a', 'workspace-a', 'issue-a', '{}');
    raw.close();
    first = new SessionControlSqlite(file);
    second = new SessionControlSqlite(file);
    first.create(initial);
    first.create({ ...initial, bindingId: 'other-chat', workspaceId: 'workspace-b',
      collaborationId: 'issue-b', nativeSessionId: 'chat-used' });
    const scope = { principal: 'owner', audience: 'host', workspaceId: 'workspace-a',
      operation: 'conversation.successor', idempotencyKey: 'successor-1' };
    const permit: Permit = { grantId: 'grant', principal: 'owner', recipient: 'owner',
      operation: 'conversation.successor', effect: 'state_write',
      scope: { workspaceId: 'workspace-a', collaborationId: 'issue-a' } };
    const input = { predecessorBindingId: 'binding-a', expectedEpoch: 0, expectedRevision: 0,
      observed: { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-b', cursor: 'turn-1' },
      contextRevisionId: 'ctx-a', newBindingId: 'binding-b', scope, permit };
    assert.throws(() => first!.successor({ ...input, contextRevisionId: 'missing' }), /AVAILABLE/i);
    assert.throws(() => first!.successor({ ...input, observed: { ...input.observed, accountId: 'account-b' } }), /CONFLICT/);
    assert.throws(() => first!.successor({ ...input, expectedRevision: 1 }), /CONFLICT/);
    assert.throws(() => first!.successor({ ...input, observed: { ...input.observed,
      nativeSessionId: 'chat-used' } }));
    assert.equal(first.isCurrent('binding-a'), true);
    const sendScope = { ...scope, operation: 'conversation.send', idempotencyKey: 'prepared-send' };
    const sendPermit: Permit = { ...permit, operation: 'conversation.send', effect: 'external_send' };
    first.claimCommand({ commandId: 'send-prepared', scope: sendScope, permit: sendPermit,
      payload: { text: 'old unsent text' }, bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 });
    const history = new DatabaseSync(file);
    history.prepare('INSERT INTO conversation_messages VALUES (?,?,?,?)').run('binding-a', 'native-1', 'v1', 'prior text');
    history.close();
    const next = first.successor(input);
    assert.equal(next.control, 'human_controlled');
    assert.equal(next.parentBindingId, 'binding-a');
    assert.equal(next.contextRevisionId, 'ctx-a');
    assert.equal(first.get('binding-a')?.lifecycle, 'superseded');
    assert.equal(second.get('binding-b')?.nativeSessionId, 'chat-b');
    assert.equal(second.isCurrent('binding-a'), false);
    assert.deepEqual(second.successor(input), next);
    assert.deepEqual(second.successor({ ...input, observed: { ...input.observed, nativeSessionId: 'chat-c' } }), next);
    assert.throws(() => second!.successor({ ...input, contextRevisionId: 'ctx-other' }), /CONFLICT/);
    assert.throws(() => second!.successor({ ...input, scope: { ...scope, idempotencyKey: 'race-loser' },
      newBindingId: 'binding-c' }), /AVAILABLE/i);
    assert.equal(first.compareAndSwap(0, { ...initial, revision: 1 }), false);
    assert.throws(() => first!.create({ ...initial, bindingId: 'binding-c', nativeSessionId: 'chat-c' }));
    assert.deepEqual(second.listMessages('binding-a'), [{ nativeMessageId: 'native-1', version: 'v1', text: 'prior text' }]);
    assert.equal(first.getCommand('send-prepared')?.status, 'completed');
    assert.equal(first.getCommand('send-prepared')?.outcome, 'rejected');
    assert.deepEqual(first.getCommandResult('send-prepared'), { commandId: 'send-prepared',
      bindingId: 'binding-a', sendIntentId: 'send-prepared', status: 'rejected' });
    assert.throws(() => first!.markSending('send-prepared', sendPermit, 0, 0), /CONFLICT/);
    const intentPayload = { scope: { workspaceId: 'workspace-a', collaborationId: 'issue-a' },
      payload: { predecessorBindingId: 'binding-a', expectedEpoch: 0, expectedRevision: 0,
        contextRevisionId: 'ctx-a' } };
    assert.deepEqual(second.lookupIdempotent(scope, intentPayload), next);
    const inspect = new DatabaseSync(file);
    try {
      const rows = inspect.prepare("SELECT binding_id,lifecycle,parent_binding_id,context_revision_id FROM session_control WHERE workspace_id='workspace-a' ORDER BY binding_id").all();
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { binding_id: 'binding-a', lifecycle: 'superseded', parent_binding_id: null, context_revision_id: null },
        { binding_id: 'binding-b', lifecycle: 'current', parent_binding_id: 'binding-a', context_revision_id: 'ctx-a' },
      ]);
    } finally { inspect.close(); }
  } finally {
    second?.close(); first?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('successor refuses an unresolved send and leaves the current binding intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-send-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner',
      purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', recipient: 'owner',
      workspaceId: 'workspace-a', collaborationId: 'issue-a', permissions: ['conversation.control'],
      expiresAt: null, revokedAt: null });
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO context_revisions (id,workspace_id,collaboration_id,revision_json) VALUES (?,?,?,?)')
      .run('ctx-a', 'workspace-a', 'issue-a', '{}');
    raw.close();
    store = new SessionControlSqlite(file);
    store.create(initial);
    const permit: Permit = { grantId: 'grant', principal: 'owner', recipient: 'owner',
      operation: 'conversation.send', effect: 'external_send',
      scope: { workspaceId: 'workspace-a', collaborationId: 'issue-a' } };
    store.claimCommand({ commandId: 'sending', bindingId: 'binding-a', expectedRevision: 0,
      expectedEpoch: 0, scope: { principal: 'owner', audience: 'host', workspaceId: 'workspace-a',
        operation: 'conversation.send', idempotencyKey: 'send-1' },
      payload: { text: 'question' }, permit });
    store.markSending('sending', permit, 0, 0);
    const successorPermit: Permit = { ...permit, operation: 'conversation.successor', effect: 'state_write' };
    assert.throws(() => store!.successor({ predecessorBindingId: 'binding-a', expectedEpoch: 0,
      expectedRevision: 1, observed: { providerId: 'provider-a', accountId: 'account-a',
        nativeSessionId: 'chat-b', cursor: 'turn-1' }, contextRevisionId: 'ctx-a', newBindingId: 'binding-b',
      scope: { principal: 'owner', audience: 'host', workspaceId: 'workspace-a',
        operation: 'conversation.successor', idempotencyKey: 'successor-1' }, permit: successorPermit }), /CONFLICT/);
    assert.equal(store.isCurrent('binding-a'), true);
    assert.equal(store.get('binding-b'), null);
    assert.equal(store.getCommand('sending')?.status, 'sending');
  } finally {
    store?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

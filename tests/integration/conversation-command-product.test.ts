import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('completed send receipt remains replayable after successor without another provider call', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-send-successor-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const seed = new SqliteStore(file);
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', recipient: 'owner', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO context_revisions (id,workspace_id,collaboration_id,revision_json) VALUES (?,?,?,?)')
    .run('ctx-a', scope.workspaceId, scope.collaborationId, '{}');
  raw.close();
  const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
  let observed = 'chat-a', calls = 0;
  let app = openApplication(dir, { conversation: { observeBinding: async () => ({ providerId: 'provider-a',
    accountId: 'account-a', nativeSessionId: observed, cursor: 'turn-1' }) },
  conversationPort: { syncDelta: async (state) => ({ providerId: state.providerId, accountId: state.accountId,
    nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
    complete: true, generating: false, historyChanged: false, messages: [] }),
  send: async () => { calls++; return { status: 'rejected' as const }; } } });
  try {
    const first = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      idempotencyKey: 'bind-a', payload: {} }) as { bindingId: string };
    const send = { operation: 'conversation.send', scope, idempotencyKey: 'send-a',
      payload: { bindingId: first.bindingId, expectedEpoch: 0, text: 'synthetic' } };
    const receipt = await app.dispatch.dispatch(context, send) as { status: string; commandId: string };
    assert.equal(receipt.status, 'rejected');
    assert.equal(calls, 1);
    const store = new SessionControlSqlite(file);
    const revision = store.get(first.bindingId)!.revision;
    store.close();
    observed = 'chat-b';
    await app.dispatch.dispatch(context, { operation: 'conversation.successor', scope,
      idempotencyKey: 'successor-a', payload: { predecessorBindingId: first.bindingId,
        expectedEpoch: 0, expectedRevision: revision, contextRevisionId: 'ctx-a' } });
    app.close();
    app = openApplication(dir);
    assert.deepEqual(await app.dispatch.dispatch(context, send), receipt);
    assert.equal(calls, 1);
    await assert.rejects(app.dispatch.dispatch(context, { ...send,
      payload: { ...send.payload, text: 'different' } }), /CONFLICT/);
    await assert.rejects(app.dispatch.dispatch(context, { ...send, idempotencyKey: 'new-send' }));
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

test('product conversation send is one scoped durable command across repeated calls', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-conversation-command-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  const workspaceId = 'workspace-a', collaborationId = 'issue-a';
  seed.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', workspaceId, collaborationId,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  const scope = { workspaceId, collaborationId };
  let sends = 0;
  const app = openApplication(dir, {
    conversation: { observeBinding: async () => ({ providerId: 'chatgpt', accountId: 'approved-account',
      nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
    conversationPort: {
      syncDelta: async () => ({ providerId: 'chatgpt', accountId: 'approved-account',
        nativeSessionId: 'chat-a', fromCursor: 'cursor-1', nextCursor: 'cursor-1',
        complete: true, generating: false, historyChanged: false, messages: [] }),
      send: async () => { sends++; return { status: 'submitted' as const }; },
    },
  });
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind-a' }) as { bindingId: string };
    const command = { operation: 'conversation.send', scope, idempotencyKey: 'send-a',
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'Review this snapshot' } };
    const receipt = await app.dispatch.dispatch(context, command) as { status: string; sendIntentId: string };
    assert.equal(receipt.status, 'submitted');
    assert.ok(receipt.sendIntentId);
    assert.deepEqual(await app.dispatch.dispatch(context, command), receipt);
    assert.equal(sends, 1);
    await assert.rejects(app.dispatch.dispatch(context, { ...command,
      payload: { ...command.payload, text: 'Different question' } }), /CONFLICT/);
    assert.equal(sends, 1);
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

test('product sync preserves human control and resume imports once before restoring host control', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-conversation-sync-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  let cursor = 'cursor-1';
  const app = openApplication(dir, {
    conversation: { observeBinding: async () => ({ providerId: 'chatgpt', accountId: 'approved-account',
      nativeSessionId: 'chat-a', cursor }) },
    conversationPort: { syncDelta: async (state) => ({ providerId: state.providerId,
      accountId: state.accountId, nativeSessionId: state.nativeSessionId,
      fromCursor: state.cursor, nextCursor: cursor, complete: true, generating: false,
      historyChanged: false, messages: state.cursor === cursor ? [] :
        [{ nativeMessageId: 'm1', version: 'v1', text: 'human note' }] }) },
  });
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind-sync' }) as { bindingId: string };
    const handoff = await app.dispatch.dispatch(context, { operation: 'conversation.handoff', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'handoff-sync' }) as { epoch: number };
    assert.equal(handoff.epoch, 1);
    cursor = 'cursor-2';
    const syncCommand = { operation: 'conversation.sync', scope, idempotencyKey: 'sync-1',
      payload: { bindingId: bound.bindingId, expectedEpoch: 1 } };
    const synced = await app.dispatch.dispatch(context, syncCommand) as { state: { control: string; cursor: string } };
    assert.equal(synced.state.control, 'human_controlled');
    assert.equal(synced.state.cursor, 'cursor-2');
    assert.deepEqual(await app.dispatch.dispatch(context, syncCommand), synced);
    const resumed = await app.dispatch.dispatch(context, { operation: 'conversation.resume', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 1 }, idempotencyKey: 'resume-1' }) as
      { state: { control: string; epoch: number } };
    assert.equal(resumed.state.control, 'host_controlled');
    assert.equal(resumed.state.epoch, 2);
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

test('submitted send requires native pair proof before atomic sync closes intent', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-conversation-pair-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  let completedSendId = '';
  let cursor = 'cursor-1';
  const app = openApplication(dir, {
    conversation: { observeBinding: async () => ({ providerId: 'chatgpt', accountId: 'approved-account',
      nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
    conversationPort: {
      syncDelta: async (state) => ({ providerId: state.providerId, accountId: state.accountId,
        nativeSessionId: state.nativeSessionId, fromCursor: state.cursor,
        nextCursor: completedSendId ? 'cursor-2' : cursor, complete: true,
        generating: false, historyChanged: false,
        messages: completedSendId ? [
          { nativeMessageId: 'user-1', version: 'v1', text: 'question' },
          { nativeMessageId: 'reply-1', version: 'v1', text: 'answer' },
        ] : [],
        ...(completedSendId ? { completedSend: { sendIntentId: completedSendId,
          nativeUserMessageId: 'user-1', nativeReplyMessageId: 'reply-1' } } : {}) }),
      send: async (state) => { completedSendId = state.sendIntent!.id; return { status: 'submitted' as const }; },
    },
  });
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind-pair' }) as { bindingId: string };
    const sent = await app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' }, idempotencyKey: 'send-pair' }) as
      { status: string; sendIntentId: string };
    assert.equal(sent.status, 'submitted');
    assert.equal(sent.sendIntentId, completedSendId);
    const synced = await app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'sync-pair' }) as
      { complete: boolean; state: { cursor: string; sendIntent?: unknown }; messages: unknown[] };
    assert.equal(synced.complete, true);
    assert.equal(synced.state.cursor, 'cursor-2');
    assert.equal(synced.state.sendIntent, undefined);
    assert.equal(synced.messages.length, 2);
    completedSendId = '';
    cursor = 'cursor-2';
    const next = await app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'follow up' }, idempotencyKey: 'send-follow-up' }) as
      { status: string };
    assert.equal(next.status, 'submitted');
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

test('legacy pending sync receipt imports messages and replays after restart', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-pending-receipt-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  const app = openApplication(dir, { conversation: { observeBinding: async () => ({
    providerId: 'chatgpt', accountId: 'approved-account', nativeSessionId: 'chat-a', cursor: 'cursor-1' }) } });
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind-legacy' }) as { bindingId: string };
    const old = new SessionControlSqlite(join(dir, 'state.sqlite'));
    try {
      const prior = old.get(bound.bindingId)!;
      assert.equal(old.compareAndSwap(prior.revision, { ...prior, revision: prior.revision + 1,
        control: 'host_controlled', epoch: 1, cursor: 'cursor-2',
        pendingSyncReceipt: { receiptId: 'old-receipt', fromEpoch: 0, fromCursor: 'cursor-1',
          nextCursor: 'cursor-2', messages: [{ nativeMessageId: 'old-message', version: 'v1', text: 'old' }] } }), true);
    } finally { old.close(); }
    const command = { operation: 'conversation.resume', scope, idempotencyKey: 'legacy-resume',
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 } };
    const receipt = await app.dispatch.dispatch(context, command) as
      { complete: boolean; state: { control: string; pendingSyncReceipt?: unknown }; messages: unknown[] };
    assert.equal(receipt.complete, true);
    assert.equal(receipt.state.control, 'host_controlled');
    assert.equal(receipt.state.pendingSyncReceipt, undefined);
    assert.equal(receipt.messages.length, 1);
    assert.deepEqual(await app.dispatch.dispatch(context, command), receipt);
    const reopened = new SessionControlSqlite(join(dir, 'state.sqlite'));
    try { assert.equal(reopened.listMessages(bound.bindingId).length, 1); }
    finally { reopened.close(); }
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

test('failed pre-send observation durably quarantines host control until explicit resume', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-preflight-retry-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  let preflights = 0, sends = 0;
  const port = {
      syncDelta: async (state: SessionState) => {
        if (++preflights === 1) throw new Error('transient page error');
        return { providerId: state.providerId, accountId: state.accountId,
          nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
          complete: true, generating: false, historyChanged: false, messages: [] };
      },
      send: async () => { sends++; return { status: 'submitted' as const }; },
  };
  let app = openApplication(dir, {
    conversation: { observeBinding: async () => ({ providerId: 'chatgpt', accountId: 'approved-account',
      nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
    conversationPort: port,
  });
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind-retry' }) as { bindingId: string };
    const command = { operation: 'conversation.send', scope, idempotencyKey: 'send-retry',
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } };
    await assert.rejects(app.dispatch.dispatch(context, command), /Conversation pre-send sync failed/);
    assert.equal(sends, 0);
    app.close();
    app = openApplication(dir, { conversationPort: port });
    const persisted = new SessionControlSqlite(join(dir, 'state.sqlite'));
    try { assert.equal(persisted.get(bound.bindingId)?.control, 'reconcile_required'); }
    finally { persisted.close(); }
    await assert.rejects(app.dispatch.dispatch(context, command));
    assert.equal(sends, 0);
    const synced = await app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      idempotencyKey: 'sync-after-failure', payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }) as
      { state: { control: string } };
    assert.equal(synced.state.control, 'human_controlled');
    await assert.rejects(app.dispatch.dispatch(context, { ...command, idempotencyKey: 'send-before-resume' }));
    const resumed = await app.dispatch.dispatch(context, { operation: 'conversation.resume', scope,
      idempotencyKey: 'resume-after-failure', payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }) as
      { state: { control: string; epoch: number } };
    assert.equal(resumed.state.control, 'host_controlled');
    assert.equal(resumed.state.epoch, 1);
    const receipt = await app.dispatch.dispatch(context, { ...command, idempotencyKey: 'send-after-resume',
      payload: { ...command.payload, expectedEpoch: 1 } }) as { status: string };
    assert.equal(receipt.status, 'submitted');
    assert.equal(sends, 1);
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

test('invalid native identity, history, or generating observation fences host across restart', async () => {
  for (const [index, patch] of [
    { accountId: 'different-account' }, { historyChanged: true }, { generating: true },
  ].entries()) {
    const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-invalid-delta-'));
    const dir = join(outer, 'data');
    mkdirSync(dir, { mode: 0o700 });
    protectNewDataDirectory(dir);
    const seed = new SqliteStore(join(dir, 'state.sqlite'));
    const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
    seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
      purpose: 'review', hostThreadId: null, state: 'open' });
    seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
      permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
    const context = { principal: 'owner', audience: 'host', recipient: 'owner',
      surface: 'local_host' as const, now: new Date() };
    let invalid = true, sends = 0;
    const port = { syncDelta: async (state: SessionState) => ({ providerId: state.providerId,
      accountId: state.accountId, nativeSessionId: state.nativeSessionId,
      fromCursor: state.cursor, nextCursor: state.cursor, complete: true,
      generating: false, historyChanged: false, messages: [], ...(invalid ? patch : {}) }),
    send: async () => { sends++; return { status: 'submitted' as const }; } };
    let app = openApplication(dir, { conversation: { observeBinding: async () => ({
      providerId: 'chatgpt', accountId: 'approved-account', nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
    conversationPort: port });
    try {
      const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
        payload: {}, idempotencyKey: `bind-${index}` }) as { bindingId: string };
      await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
        idempotencyKey: `invalid-${index}`, payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }),
      (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
      app.close();
      invalid = false;
      app = openApplication(dir, { conversationPort: port });
      const reopened = new SessionControlSqlite(join(dir, 'state.sqlite'));
      try {
        assert.equal(reopened.get(bound.bindingId)?.control, 'reconcile_required');
        assert.equal(reopened.get(bound.bindingId)?.epoch, 0);
      } finally { reopened.close(); }
      await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
        idempotencyKey: `send-before-resume-${index}`,
        payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } }));
      assert.equal(sends, 0);
      const synced = await app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
        idempotencyKey: `valid-sync-${index}`, payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }) as
        { state: { control: string } };
      assert.equal(synced.state.control, 'human_controlled');
      await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
        idempotencyKey: `send-after-sync-${index}`,
        payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } }));
      const resumed = await app.dispatch.dispatch(context, { operation: 'conversation.resume', scope,
        idempotencyKey: `resume-${index}`, payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }) as
        { state: { control: string; epoch: number } };
      assert.equal(resumed.state.control, 'host_controlled');
      assert.equal(resumed.state.epoch, 1);
      await app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
        idempotencyKey: `send-after-resume-${index}`,
        payload: { bindingId: bound.bindingId, expectedEpoch: 1, text: 'question' } });
      assert.equal(sends, 1);
    } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
  }
});

test('failed observation does not overwrite handoff and does not bypass revoked grant', async () => {
  for (const action of ['handoff', 'revoke'] as const) {
    const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-sync-race-'));
    const dir = join(outer, 'data');
    mkdirSync(dir, { mode: 0o700 });
    protectNewDataDirectory(dir);
    const seed = new SqliteStore(join(dir, 'state.sqlite'));
    const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
    seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
      purpose: 'review', hostThreadId: null, state: 'open' });
    seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
      permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
    const context = { principal: 'owner', audience: 'host', recipient: 'owner',
      surface: 'local_host' as const, now: new Date() };
    const app = openApplication(dir, { conversation: { observeBinding: async () => ({
      providerId: 'chatgpt', accountId: 'approved-account', nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
    conversationPort: { syncDelta: async (state) => {
      if (action === 'handoff') {
        const concurrent = new SessionControlSqlite(join(dir, 'state.sqlite'));
        try {
          const current = concurrent.get(state.bindingId)!;
          assert.equal(concurrent.compareAndSwap(current.revision, { ...current,
            revision: current.revision + 1, epoch: current.epoch + 1, control: 'human_controlled' }), true);
        } finally { concurrent.close(); }
      } else seed.revokeGrant('grant', new Date().toISOString());
      return { providerId: state.providerId, accountId: 'changed-account',
        nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
        complete: true, generating: false, historyChanged: false, messages: [] };
    }, send: async () => { throw new Error('send must not run'); } } });
    try {
      const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
        payload: {}, idempotencyKey: `bind-${action}` }) as { bindingId: string };
      await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
        payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: `sync-${action}` }),
      (error: unknown) => (error as { code?: string }).code ===
        (action === 'handoff' ? 'CONFLICT' : 'RECONCILE_REQUIRED'));
      const persisted = new SessionControlSqlite(join(dir, 'state.sqlite'));
      try {
        assert.equal(persisted.get(bound.bindingId)?.control,
          action === 'handoff' ? 'human_controlled' : 'reconcile_required');
        assert.equal(persisted.get(bound.bindingId)?.epoch, action === 'handoff' ? 1 : 0);
      } finally { persisted.close(); }
      if (action === 'revoke') await assert.rejects(app.dispatch.dispatch(context, {
        operation: 'conversation.resume', scope, idempotencyKey: 'resume-revoked',
        payload: { bindingId: bound.bindingId, expectedEpoch: 0 } }));
    } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
  }
});

test('malformed resolved native delta quarantines send and sync across SQLite reopen', async () => {
  const shapes = ['missing-messages', 'null', 'throwing-cursor'] as const;
  for (const operation of ['conversation.send', 'conversation.sync'] as const) {
    for (const shape of shapes) {
      const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-malformed-delta-'));
      const dir = join(outer, 'data');
      mkdirSync(dir, { mode: 0o700 });
      protectNewDataDirectory(dir);
      const seed = new SqliteStore(join(dir, 'state.sqlite'));
      const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
      seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
      seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
        purpose: 'review', hostThreadId: null, state: 'open' });
      seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
        permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
      const context = { principal: 'owner', audience: 'host', recipient: 'owner',
        surface: 'local_host' as const, now: new Date() };
      let sends = 0;
      const app = openApplication(dir, { conversation: { observeBinding: async () => ({
        providerId: 'chatgpt', accountId: 'approved-account', nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
      conversationPort: { syncDelta: async (state) => {
        if (shape === 'null') return null as never;
        const base = { providerId: state.providerId, accountId: state.accountId,
          nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
          complete: true, generating: false, historyChanged: false, messages: [] };
        if (shape === 'missing-messages') return { ...base, accountId: 'changed-account',
          historyChanged: true, messages: undefined } as never;
        return { ...base, get nextCursor(): string { throw new Error('cursor getter failed'); } };
      }, send: async () => { sends++; return { status: 'submitted' as const }; } } });
      try {
        const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
          payload: {}, idempotencyKey: `bind-${operation}-${shape}` }) as { bindingId: string };
        await assert.rejects(app.dispatch.dispatch(context, { operation, scope,
          idempotencyKey: `malformed-${operation}-${shape}`,
          payload: { bindingId: bound.bindingId, expectedEpoch: 0,
            ...(operation === 'conversation.send' ? { text: 'question' } : {}) } }),
        (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
        app.close();
        const reopened = new SessionControlSqlite(join(dir, 'state.sqlite'));
        try {
          assert.equal(reopened.get(bound.bindingId)?.control, 'reconcile_required');
          assert.equal(reopened.get(bound.bindingId)?.epoch, 0);
        } finally { reopened.close(); }
        assert.equal(sends, 0);
        const resumedApp = openApplication(dir, { conversationPort: {
          syncDelta: async (state) => ({ providerId: state.providerId, accountId: state.accountId,
            nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
            complete: true, generating: false, historyChanged: false, messages: [] }),
          send: async () => { sends++; return { status: 'submitted' as const }; },
        } });
        try {
          await assert.rejects(resumedApp.dispatch.dispatch(context, { operation: 'conversation.send', scope,
            idempotencyKey: `blocked-${operation}-${shape}`,
            payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } }));
        } finally { resumedApp.close(); }
        assert.equal(sends, 0);
      } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
    }
  }
});

test('unknown send closes once only after exact native pair proof across restart', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-unknown-pair-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner',
    surface: 'local_host' as const, now: new Date() };
  let sends = 0;
  let intentId = '';
  let observed: Record<string, unknown> = {};
  let duringObserve: (() => void) | undefined;
  const port = {
    syncDelta: async (state: SessionState) => {
      duringObserve?.();
      return {
        providerId: state.providerId, accountId: state.accountId, nativeSessionId: state.nativeSessionId,
        fromCursor: state.cursor, nextCursor: 'cursor-2', complete: true, generating: false,
        historyChanged: false, messages: [
          { nativeMessageId: 'user-1', version: 'v1', text: 'question' },
          { nativeMessageId: 'reply-1', version: 'v1', text: 'answer' },
        ], completedSend: { sendIntentId: intentId, nativeUserMessageId: 'user-1', nativeReplyMessageId: 'reply-1' },
        ...observed,
      };
    },
    send: async (state: SessionState) => {
      sends++;
      intentId = state.sendIntent!.id;
      throw new Error('transport lost after provider accepted send');
    },
  };
  let app = openApplication(dir, { conversation: { observeBinding: async () => ({
    providerId: 'chatgpt', accountId: 'approved-account', nativeSessionId: 'chat-a', cursor: 'cursor-1' }) },
    conversationPort: { ...port, syncDelta: async (state) => state.sendIntent ? port.syncDelta(state) : ({
      providerId: state.providerId, accountId: state.accountId, nativeSessionId: state.nativeSessionId,
      fromCursor: state.cursor, nextCursor: state.cursor, complete: true, generating: false,
      historyChanged: false, messages: [],
    }) },
  });
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind-unknown' }) as { bindingId: string };
    const sendCommand = { operation: 'conversation.send', scope, idempotencyKey: 'send-unknown',
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } };
    const sent = await app.dispatch.dispatch(context, sendCommand) as { commandId: string; status: string };
    assert.equal(sent.status, 'unknown');
    assert.equal(sends, 1);
    app.close();
    app = openApplication(dir, { conversationPort: { ...port, syncDelta: async (state) => port.syncDelta(state) } });
    const syncCommand = { operation: 'conversation.resume', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'resume-unknown' };
    for (const patch of [
      { nextCursor: 'cursor-1', messages: [] },
      { complete: false }, { generating: true }, { historyChanged: true },
      { providerId: 'wrong-provider' }, { accountId: 'wrong-account' },
      { nativeSessionId: 'wrong-chat' }, { fromCursor: 'wrong-cursor' },
      { completedSend: { sendIntentId: 'wrong-intent', nativeUserMessageId: 'user-1', nativeReplyMessageId: 'reply-1' } },
      { completedSend: { sendIntentId: intentId, nativeUserMessageId: 'user-1', nativeReplyMessageId: 'missing' } },
    ]) {
      observed = patch;
      await assert.rejects(app.dispatch.dispatch(context, { ...syncCommand,
        idempotencyKey: `bad-${Object.keys(patch)[0]}-${JSON.stringify(patch)}` }),
      (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
      const persisted = new SessionControlSqlite(join(dir, 'state.sqlite'));
      try {
        assert.equal(persisted.get(bound.bindingId)?.sendIntent?.status, 'unknown');
        assert.equal(persisted.getCommand(sent.commandId)?.status, 'reconcile_required');
        assert.equal(persisted.listMessages(bound.bindingId).length, 0);
      } finally { persisted.close(); }
    }
    observed = {};
    duringObserve = () => {
      const concurrent = new SessionControlSqlite(join(dir, 'state.sqlite'));
      try {
        const state = concurrent.get(bound.bindingId)!;
        assert.equal(concurrent.compareAndSwap(state.revision, { ...state, revision: state.revision + 1,
          epoch: state.epoch + 1, control: 'reconcile_required' }), true);
      } finally { concurrent.close(); }
      duringObserve = undefined;
    };
    await assert.rejects(app.dispatch.dispatch(context, { ...syncCommand,
      idempotencyKey: 'raced-resume' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    const raced = new SessionControlSqlite(join(dir, 'state.sqlite'));
    try {
      assert.equal(raced.get(bound.bindingId)?.control, 'reconcile_required');
      assert.equal(raced.get(bound.bindingId)?.sendIntent?.status, 'unknown');
      assert.equal(raced.getCommand(sent.commandId)?.status, 'reconcile_required');
      assert.equal(raced.listMessages(bound.bindingId).length, 0);
    } finally { raced.close(); }
    const resumedCommand = { ...syncCommand, payload: { bindingId: bound.bindingId, expectedEpoch: 1 } };
    const synced = await app.dispatch.dispatch(context, resumedCommand) as
      { state: { control: string; cursor: string; epoch: number; sendIntent?: unknown }; messages: unknown[] };
    assert.equal(synced.state.control, 'host_controlled');
    assert.equal(synced.state.epoch, 2);
    assert.equal(synced.state.cursor, 'cursor-2');
    assert.equal(synced.state.sendIntent, undefined);
    assert.equal(synced.messages.length, 2);
    assert.deepEqual(await app.dispatch.dispatch(context, resumedCommand), synced);
    assert.deepEqual(await app.dispatch.dispatch(context, sendCommand), sent);
    assert.equal(sends, 1);
    const persisted = new SessionControlSqlite(join(dir, 'state.sqlite'));
    try {
      assert.equal(persisted.getCommand(sent.commandId)?.status, 'completed');
      assert.equal(persisted.getCommand(sent.commandId)?.outcome, 'unknown');
      assert.equal(persisted.listMessages(bound.bindingId).length, 2);
    } finally { persisted.close(); }
  } finally { app.close(); seed.close(); rmSync(outer, { recursive: true, force: true }); }
});

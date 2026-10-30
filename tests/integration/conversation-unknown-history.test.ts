import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ConversationDelta } from '../../src/application/session-control.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

async function fixture() {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-unknown-history-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const seed = new SqliteStore(file);
  const scope = { workspaceId: 'ws', collaborationId: 'issue' };
  seed.insertWorkspace({ id: 'ws', name: 'synthetic', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: 'issue', workspaceId: 'ws', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', recipient: 'owner', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
  let appended = false, sends = 0, observations = 0;
  let override: Partial<ConversationDelta> = {};
  let onObserve: (() => void) | undefined;
  const app = openApplication(dir, {
    conversation: { observeBinding: async () => ({ providerId: 'chatgpt', accountId: 'account', nativeSessionId: 'chat', cursor: 'cursor-1' }) },
    conversationPort: {
      syncDelta: async state => {
        observations++; onObserve?.();
        const hasNew = appended && state.cursor === 'cursor-1';
        return { providerId: state.providerId, accountId: state.accountId, nativeSessionId: state.nativeSessionId,
          fromCursor: state.cursor, nextCursor: hasNew ? 'cursor-2' : state.cursor,
          complete: true, generating: false, historyChanged: false,
          messages: hasNew ? [{ nativeMessageId: 'native-user', version: 'v1', text: '[$app](app://exact-id) question' },
            { nativeMessageId: 'native-reply', version: 'v1', text: 'synthetic answer' }] : [], ...override };
      },
      send: async () => { sends++; return { status: 'unknown' as const }; },
    },
  });
  const sessions = new SessionControlSqlite(file);
  const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope, payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
  const send = { operation: 'conversation.send', scope, idempotencyKey: 'original-send',
    payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'App question' } };
  const unknown = await app.dispatch.dispatch(context, send) as { commandId: string; status: string };
  assert.equal(unknown.status, 'unknown'); appended = true;
  const resume = { operation: 'conversation.resume', scope, idempotencyKey: 'accept-history',
    payload: { bindingId: bound.bindingId, expectedEpoch: 0, acceptUnknownSendIntentId: unknown.commandId } };
  return { app, seed, sessions, context, scope, send, resume, unknown, file,
    get sends() { return sends; }, get observations() { return observations; },
    setDelta: (value: Partial<ConversationDelta>) => { override = value; },
    onObserve: (callback: () => void) => { onObserve = callback; },
    close: () => {
      sessions.close(); app.close(); seed.close();
      assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
        /^rcac-unknown-history-[A-Za-z0-9_-]{6}$/);
      rmSync(outer, { recursive: true, force: true });
    } };
}

test('explicit local resume accepts observed history while original send remains unknown', async () => {
  const f = await fixture();
  let db: DatabaseSync | undefined;
  try {
    const before = f.sessions.get(f.resume.payload.bindingId)!;
    db = new DatabaseSync(f.file);
    const old = db.prepare('SELECT send_text,payload_hash,outcome,result_json FROM conversation_commands WHERE command_id=?').get(f.unknown.commandId);
    const receipt = await f.app.dispatch.dispatch(f.context, f.resume) as {
      state: { control: string; epoch: number; sendIntent?: unknown; cursor: string };
      unknownSendDisposition: unknown;
    };
    assert.equal(receipt.state.control, 'host_controlled'); assert.equal(receipt.state.epoch, 1);
    assert.equal(receipt.state.sendIntent, undefined); assert.equal(receipt.state.cursor, 'cursor-2');
    assert.deepEqual(receipt.unknownSendDisposition, { kind: 'accepted_observed_history', sendIntent: before.sendIntent,
      fromCursor: 'cursor-1', nextCursor: 'cursor-2', nativeMessageIds: ['native-user', 'native-reply'] });
    assert.equal('completedSend' in receipt, false);
    assert.deepEqual(db.prepare('SELECT send_text,payload_hash,outcome,result_json FROM conversation_commands WHERE command_id=?').get(f.unknown.commandId), old);
    assert.equal(f.sessions.getCommand(f.unknown.commandId)?.status, 'completed');
    assert.deepEqual(await f.app.dispatch.dispatch(f.context, f.send), f.unknown);
    const count = f.observations;
    assert.deepEqual(await f.app.dispatch.dispatch(f.context, f.resume), receipt);
    assert.equal(f.observations, count); assert.equal(f.sends, 1);
    assert.equal(f.sessions.listMessages(f.resume.payload.bindingId).length, 2);
  } finally { db?.close(); f.close(); }
});

test('ordinary resume keeps unmatched unknown blocked', async () => {
  const f = await fixture(); try {
    const payload = { bindingId: f.resume.payload.bindingId, expectedEpoch: f.resume.payload.expectedEpoch };
    await assert.rejects(f.app.dispatch.dispatch(f.context, { ...f.resume, payload }));
    assert.equal(f.sessions.get(f.resume.payload.bindingId)?.sendIntent?.id, f.unknown.commandId);
    assert.equal(f.sends, 1);
  } finally { f.close(); }
});

for (const [label, delta] of Object.entries({
  account: { accountId: 'different' }, chat: { nativeSessionId: 'different' }, provider: { providerId: 'different' },
  incomplete: { complete: false }, generating: { generating: true }, edited: { historyChanged: true },
  empty: { messages: [] }, cursor: { nextCursor: 'cursor-1' },
  duplicate: { messages: [{ nativeMessageId: 'same', version: 'v1', text: 'one' }, { nativeMessageId: 'same', version: 'v1', text: 'two' }] },
  competingProof: { completedSend: { sendIntentId: 'wrong', nativeUserMessageId: 'native-user', nativeReplyMessageId: 'native-reply' } },
})) test(`explicit history resume rejects ${label}`, async () => {
  const f = await fixture(); try {
    f.setDelta(delta);
    await assert.rejects(f.app.dispatch.dispatch(f.context, f.resume));
    assert.equal(f.sessions.get(f.resume.payload.bindingId)?.sendIntent?.id, f.unknown.commandId);
    assert.equal(f.sessions.getCommand(f.unknown.commandId)?.status, 'reconcile_required');
    assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test('explicit history resume rejects wrong intent and external callers without observations', async () => {
  const f = await fixture(); try {
    const count = f.observations;
    await assert.rejects(f.app.dispatch.dispatch(f.context, { ...f.resume,
      payload: { ...f.resume.payload, acceptUnknownSendIntentId: 'different' } }));
    await assert.rejects(f.app.dispatch.dispatch({ ...f.context, surface: 'external_mcp' }, f.resume));
    assert.equal(f.observations, count);
    for (const operation of ['conversation.send', 'conversation.sync']) {
      await assert.rejects(f.app.dispatch.dispatch(f.context, { ...f.resume, operation,
        payload: { ...f.resume.payload, ...(operation === 'conversation.send' ? { text: 'question' } : {}) } }));
    }
    assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test('grant revocation during history observation preserves original unknown', async () => {
  const f = await fixture(); try {
    f.onObserve(() => f.seed.revokeGrant('grant', new Date().toISOString()));
    await assert.rejects(f.app.dispatch.dispatch(f.context, f.resume));
    assert.equal(f.sessions.get(f.resume.payload.bindingId)?.sendIntent?.id, f.unknown.commandId);
    assert.equal(f.sessions.listMessages(f.resume.payload.bindingId).length, 0);
  } finally { f.close(); }
});

test('revision change during history observation cannot clear original unknown', async () => {
  const f = await fixture(); try {
    f.onObserve(() => { const state = f.sessions.get(f.resume.payload.bindingId)!;
      f.sessions.compareAndSwap(state.revision, { ...state, epoch: state.epoch + 1, revision: state.revision + 1 }); });
    await assert.rejects(f.app.dispatch.dispatch(f.context, f.resume));
    assert.equal(f.sessions.get(f.resume.payload.bindingId)?.sendIntent?.id, f.unknown.commandId);
    assert.equal(f.sessions.listMessages(f.resume.payload.bindingId).length, 0);
  } finally { f.close(); }
});

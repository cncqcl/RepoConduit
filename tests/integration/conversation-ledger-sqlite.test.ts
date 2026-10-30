import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlService } from '../../src/application/session-control.js';
import { handoffState } from '../../src/core/collaboration/session-control.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import type { Permit } from '../../src/core/policy/authorize.js';

const initial: SessionState = {
  bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
  providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
  control: 'host_controlled', epoch: 0, revision: 0,
};
const permit: Permit = { grantId: 'grant-send', operation: 'conversation.send', effect: 'external_send',
  scope: { workspaceId: 'workspace-a', collaborationId: 'issue-a' }, principal: 'agent', recipient: 'agent' };
const scope = { principal: 'agent', audience: 'transport', workspaceId: 'workspace-a',
  operation: 'conversation.send', idempotencyKey: 'request-1' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-conversation-ledger-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-a', registeredBy: 'owner' });
  base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
  base.insertGrant({ id: 'grant-send', principal: 'agent', audience: 'transport', workspaceId: 'workspace-a',
    collaborationId: 'issue-a', recipient: 'agent', permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'grant-sync', principal: 'agent', audience: 'transport', workspaceId: 'workspace-a',
    collaborationId: 'issue-a', recipient: 'agent', permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  const store = new SessionControlSqlite(file);
  store.create(initial);
  return { base, store, file, close: () => { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('send claim is durable, scoped and a pending replay cannot dispatch again', () => {
  const f = fixture();
  try {
    const input = { commandId: 'cmd-1', scope, payload: { text: 'question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    assert.equal(f.store.claimCommand(input).disposition, 'claimed');
    assert.equal(f.store.claimCommand(input).disposition, 'replay_pending');
    assert.throws(() => f.store.claimCommand({ ...input, commandId: 'cmd-2', payload: { text: 'changed' } }), /CONFLICT/);
    assert.equal(f.store.claimCommand({ ...input, commandId: 'cmd-2', scope: { ...scope, idempotencyKey: 'request-2' } })
      .disposition, 'claimed');
    const reopened = new SessionControlSqlite(f.file);
    try { assert.equal(reopened.claimCommand(input).disposition, 'replay_pending'); }
    finally { reopened.close(); }
    f.base.revokeGrant('grant-send', new Date().toISOString());
    assert.throws(() => f.store.claimCommand(input), /NOT_AVAILABLE/);
  } finally { f.close(); }
});

test('mark sending checks fresh grant and stale epoch cannot complete across handoff', () => {
  const f = fixture();
  try {
    const input = { commandId: 'cmd-1', scope, payload: { text: 'question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    f.store.claimCommand(input);
    f.base.revokeGrant('grant-send', new Date().toISOString());
    assert.throws(() => f.store.markSending('cmd-1', permit, 0, 0), /NOT_AVAILABLE/);
    assert.equal(f.store.getCommand('cmd-1')?.status, 'prepared');
    f.store.compareAndSwap(0, { ...initial, control: 'human_controlled', revision: 1, epoch: 1 });
    assert.throws(() => f.store.finishSend('cmd-1', 0, 0, 'unknown'), /CONFLICT/);
  } finally { f.close(); }
});

test('sync atomically records versioned messages and cursor; duplicate version is stable', () => {
  const f = fixture();
  try {
    const syncPermit: Permit = { ...permit, grantId: 'grant-sync', operation: 'conversation.sync', effect: 'state_write' };
    const syncScope = { ...scope, operation: 'conversation.sync' };
    const messages = [{ nativeMessageId: 'm1', version: 'v1', text: 'first' }];
    const next = { ...initial, cursor: 'turn-2', revision: 1 };
    const input = { commandId: 'sync-1', scope: syncScope, payload: { bindingId: 'binding-a', cursor: 'turn-2' },
      permit: syncPermit, bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0,
      nextState: next, messages, receipt: { receiptId: 'receipt-1' } };
    assert.deepEqual(f.store.commitSync(input), { receiptId: 'receipt-1' });
    assert.deepEqual(f.store.lookupCommandResult(syncScope, input.payload, syncPermit, 'binding-a', 0),
      { receiptId: 'receipt-1' });
    assert.throws(() => f.store.lookupCommandResult(syncScope, { bindingId: 'binding-a', cursor: 'turn-9' },
      syncPermit, 'binding-a', 0), /CONFLICT/);
    assert.deepEqual(f.store.commitSync(input), { receiptId: 'receipt-1' });
    assert.equal(f.store.get('binding-a')?.cursor, 'turn-2');
    assert.deepEqual(f.store.listMessages('binding-a'), messages);
    assert.deepEqual(f.store.commitSync({ ...input, commandId: 'sync-2', scope: { ...syncScope, idempotencyKey: 'request-2' },
      expectedRevision: 1, nextState: { ...next, revision: 2, cursor: 'turn-3' },
      messages: [{ nativeMessageId: 'm1', version: 'v2', text: 'edited' }], receipt: { receiptId: 'receipt-2' } }),
    { receiptId: 'receipt-2' });
    assert.deepEqual(f.store.listMessages('binding-a').map((m) => m.version), ['v1', 'v2']);
    assert.throws(() => f.store.commitSync({ ...input, commandId: 'sync-3', scope: { ...syncScope, idempotencyKey: 'request-3' },
      expectedRevision: 2, nextState: { ...next, revision: 3, cursor: 'turn-4' },
      messages: [{ nativeMessageId: 'm1', version: 'v2', text: 'tampered' }] }), /CONFLICT/);
    assert.equal(f.store.get('binding-a')?.cursor, 'turn-3');
  } finally { f.close(); }
});

test('sync replay lookup rechecks grant and binding before returning receipt', () => {
  const f = fixture();
  try {
    const syncPermit: Permit = { ...permit, grantId: 'grant-sync', operation: 'conversation.sync', effect: 'state_write' };
    const syncScope = { ...scope, operation: 'conversation.sync' };
    const payload = { bindingId: 'binding-a', cursor: 'turn-2' };
    assert.equal(f.store.lookupCommandResult(syncScope, payload, syncPermit, 'binding-a', 0), null);
    f.store.commitSync({ commandId: 'sync-1', scope: syncScope, payload, permit: syncPermit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0,
      nextState: { ...initial, cursor: 'turn-2', revision: 1 }, messages: [],
      receipt: { receiptId: 'receipt-1' } });
    assert.throws(() => f.store.lookupCommandResult(syncScope, payload, syncPermit, 'binding-other', 0), /NOT_AVAILABLE/);
    f.base.revokeGrant('grant-sync', new Date().toISOString());
    assert.throws(() => f.store.lookupCommandResult(syncScope, payload, syncPermit, 'binding-a', 0), /NOT_AVAILABLE/);
  } finally { f.close(); }
});

test('submitted send remains blocked until correlated sync atomically completes it', () => {
  const f = fixture();
  try {
    const input = { commandId: 'cmd-1', scope, payload: { text: 'question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    f.store.claimCommand(input);
    assert.equal(f.store.markSending('cmd-1', permit, 0, 0).status, 'sending');
    assert.equal(f.store.get('binding-a')?.sendIntent?.id, 'cmd-1');
    assert.equal(f.store.get('binding-a')?.revision, 1);
    assert.equal(f.store.finishSend('cmd-1', 1, 0, 'submitted').status, 'reconcile_required');
    assert.equal(f.store.get('binding-a')?.sendIntent?.status, 'awaiting_result');
    assert.deepEqual(f.store.getCommandResult('cmd-1'), { commandId: 'cmd-1', bindingId: 'binding-a',
      sendIntentId: 'cmd-1', status: 'submitted' });
    assert.equal(f.store.claimCommand(input).disposition, 'replay_pending');
    const syncPermit: Permit = { ...permit, grantId: 'grant-sync', operation: 'conversation.sync', effect: 'state_write' };
    const sync = { commandId: 'sync-1', scope: { ...scope, operation: 'conversation.sync' },
      payload: { bindingId: 'binding-a', cursor: 'turn-3' }, permit: syncPermit,
      bindingId: 'binding-a', expectedRevision: 2, expectedEpoch: 0,
      nextState: { ...initial, cursor: 'turn-3', revision: 3, epoch: 1 },
      messages: [{ nativeMessageId: 'user-2', version: 'v1', text: 'question' },
        { nativeMessageId: 'reply-3', version: 'v1', text: 'answer' }],
      receipt: { receiptId: 'receipt-1' } };
    assert.throws(() => f.store.commitSync(sync), /CONFLICT/);
    assert.equal(f.store.get('binding-a')?.cursor, 'turn-1');
    assert.deepEqual(f.store.listMessages('binding-a'), []);
    f.store.commitSync({ ...sync, completesCommandId: 'cmd-1', completedSend: {
      sendIntentId: 'cmd-1', nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' } });
    assert.equal(f.store.getCommand('cmd-1')?.status, 'completed');
    assert.equal(f.store.get('binding-a')?.cursor, 'turn-3');
  } finally { f.close(); }
});

test('provider outcome after handoff records fact without restoring host control', () => {
  const f = fixture();
  try {
    const input = { commandId: 'cmd-1', scope, payload: { text: 'question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    f.store.claimCommand(input);
    f.store.markSending('cmd-1', permit, 0, 0);
    const sending = f.store.get('binding-a')!;
    assert.equal(f.store.compareAndSwap(1, { ...sending, control: 'reconcile_required', epoch: 1, revision: 2 }), true);
    f.base.revokeGrant('grant-send', new Date().toISOString());
    assert.equal(f.store.finishSend('cmd-1', 1, 0, 'submitted').outcome, 'submitted');
    assert.equal(f.store.get('binding-a')?.control, 'reconcile_required');
    assert.equal(f.store.get('binding-a')?.epoch, 1);
    assert.equal(f.store.get('binding-a')?.sendIntent?.status, 'unknown');
    assert.throws(() => f.store.claimCommand(input), /NOT_AVAILABLE/);
  } finally { f.close(); }
});

test('definite send rejection after handoff clears its intent and allows human resume', async () => {
  const f = fixture();
  try {
    const input = { commandId: 'cmd-1', scope, payload: { text: 'question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    f.store.claimCommand(input);
    f.store.markSending('cmd-1', permit, 0, 0);
    const sending = f.store.get('binding-a')!;
    assert.equal(f.store.compareAndSwap(1, handoffState(sending, 0)), true);
    assert.equal(f.store.get('binding-a')?.control, 'reconcile_required');
    assert.equal(f.store.finishSend('cmd-1', 1, 0, 'rejected').status, 'completed');
    const after = f.store.get('binding-a')!;
    assert.equal(after.control, 'human_controlled');
    assert.equal(after.epoch, 1);
    assert.equal(after.sendIntent, undefined);
    const service = new SessionControlService(f.store, { syncDelta: async () => ({
      providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-2', complete: true, generating: false,
      historyChanged: false, messages: [{ nativeMessageId: 'human-2', version: 'v1', text: 'follow-up' }],
    }) });
    const receipt = await service.syncAndResume('binding-a', 1);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.state.cursor, 'turn-2');
  } finally { f.close(); }
});

test('unknown provider outcome keeps a durable blocked intent after reopen', () => {
  const f = fixture();
  try {
    const input = { commandId: 'cmd-1', scope, payload: { text: 'question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    f.store.claimCommand(input);
    f.store.markSending('cmd-1', permit, 0, 0);
    f.store.finishSend('cmd-1', 1, 0, 'unknown');
    const reopened = new SessionControlSqlite(f.file);
    try {
      assert.equal(reopened.get('binding-a')?.control, 'reconcile_required');
      assert.equal(reopened.get('binding-a')?.sendIntent?.status, 'unknown');
      assert.equal(reopened.claimCommand(input).disposition, 'replay_pending');
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('abandoned prepared command does not block a fresh send or sync', () => {
  const f = fixture();
  try {
    const abandoned = { commandId: 'abandoned', scope, payload: { text: 'old question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    f.store.claimCommand(abandoned);
    const fresh = { ...abandoned, commandId: 'fresh', scope: { ...scope, idempotencyKey: 'request-2' },
      payload: { text: 'new question' } };
    assert.equal(f.store.claimCommand(fresh).disposition, 'claimed');
    assert.equal(f.store.markSending('fresh', permit, 0, 0).status, 'sending');
    assert.equal(f.store.get('binding-a')?.sendIntent?.text, 'new question');
  } finally { f.close(); }

  const g = fixture();
  try {
    g.store.claimCommand({ commandId: 'abandoned', scope, payload: { text: 'old question' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 });
    const syncPermit: Permit = { ...permit, grantId: 'grant-sync', operation: 'conversation.sync', effect: 'state_write' };
    const syncScope = { ...scope, operation: 'conversation.sync', idempotencyKey: 'sync-request' };
    assert.equal(g.store.claimCommand({ commandId: 'sync-1', scope: syncScope,
      payload: { cursor: 'turn-2' }, permit: syncPermit, bindingId: 'binding-a',
      expectedRevision: 0, expectedEpoch: 0 }).disposition, 'claimed');
    assert.deepEqual(g.store.commitSync({ commandId: 'sync-1', scope: syncScope,
      payload: { cursor: 'turn-2' }, permit: syncPermit, bindingId: 'binding-a',
      expectedRevision: 0, expectedEpoch: 0, nextState: { ...initial, cursor: 'turn-2', revision: 1 },
      messages: [], receipt: { receiptId: 'sync-receipt' } }), { receiptId: 'sync-receipt' });
  } finally { g.close(); }
});

test('two prepared sends on one binding have exactly one sending winner', () => {
  const f = fixture();
  try {
    const first = { commandId: 'send-1', scope, payload: { text: 'one' }, permit,
      bindingId: 'binding-a', expectedRevision: 0, expectedEpoch: 0 };
    const second = { ...first, commandId: 'send-2', scope: { ...scope, idempotencyKey: 'request-2' },
      payload: { text: 'two' } };
    f.store.claimCommand(first);
    f.store.claimCommand(second);
    const competing = new SessionControlSqlite(f.file);
    try {
      assert.equal(f.store.markSending('send-1', permit, 0, 0).status, 'sending');
      assert.throws(() => competing.markSending('send-2', permit, 0, 0), /CONFLICT/);
    } finally { competing.close(); }
    assert.equal(f.store.get('binding-a')?.sendIntent?.id, 'send-1');
    assert.equal(f.store.getCommand('send-2')?.status, 'prepared');
  } finally { f.close(); }
});

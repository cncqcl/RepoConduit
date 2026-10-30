import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHostControl, handoffState } from '../../src/core/collaboration/session-control.js';
import { SessionControlService, type ConversationPort, type SessionStateStore } from '../../src/application/session-control.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';

const initial: SessionState = {
  bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
  providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', control: 'host_controlled',
  epoch: 0, revision: 0, cursor: 'turn-1',
};

test('superseded conversation cannot regain host control or handoff', () => {
  const old: SessionState = { ...initial, lifecycle: 'superseded' };
  assert.throws(() => assertHostControl(old, 0), { code: 'CONFLICT' });
  assert.throws(() => handoffState(old, 0), { code: 'CONFLICT' });
});

function fixture() {
  let state = { ...initial };
  const store: SessionStateStore = {
    get: () => ({ ...state }),
    compareAndSwap: (expected, next) => {
      if (state.revision !== expected) return false;
      state = { ...next };
      return true;
    },
  };
  let delta = { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', fromCursor: 'turn-1',
    nextCursor: 'turn-4', complete: true, generating: false, historyChanged: false,
    messages: [
      { nativeMessageId: 'm1', version: 'v1', text: 'human 1' },
      { nativeMessageId: 'm2', version: 'v1', text: 'human 2' },
      { nativeMessageId: 'm3', version: 'v1', text: 'human 3' },
    ] };
  const port: ConversationPort = { syncDelta: async () => ({ ...delta, messages: [...delta.messages] }) };
  return { service: new SessionControlService(store, port), state: () => state, setDelta: (value: typeof delta) => { delta = value; } };
}

test('handoff fences old host epoch and syncs all human turns before resuming', async () => {
  const f = fixture();
  const handoff = f.service.handoff('binding-a', 0);
  assert.equal(handoff.control, 'human_controlled');
  assert.equal(handoff.epoch, 1);
  assert.throws(() => f.service.assertHostCanSend('binding-a', 0), /control|epoch/i);
  const receipt = await f.service.syncAndResume('binding-a', 1);
  assert.deepEqual(receipt.messages, [
    { nativeMessageId: 'm1', version: 'v1', text: 'human 1' },
    { nativeMessageId: 'm2', version: 'v1', text: 'human 2' },
    { nativeMessageId: 'm3', version: 'v1', text: 'human 3' },
  ]);
  assert.equal(receipt.state.control, 'host_controlled');
  assert.equal(receipt.state.cursor, 'turn-4');
  assert.equal(receipt.state.epoch, 2);
  assert.throws(() => f.service.assertHostCanSend('binding-a', 0), /epoch/i);
  assert.throws(() => f.service.assertHostCanSend('binding-a', 2), /receipt|control/i);
  f.service.ackSyncReceipt('binding-a', receipt.receiptId!);
  assert.equal(f.service.assertHostCanSend('binding-a', 2).nativeSessionId, 'chat-a');
});

test('incomplete sync, generation, and account changes block host resumption', async () => {
  for (const patch of [{ complete: false }, { generating: true }, { accountId: 'other' },
    { providerId: 'other' }, { historyChanged: true },
    { messages: [{ nativeMessageId: '', version: 'v1', text: 'unidentified' }] },
    { messages: [{ nativeMessageId: 'm1', version: 'v1', text: 'a' },
      { nativeMessageId: 'm1', version: 'v2', text: 'b' }] }]) {
    const f = fixture();
    f.service.handoff('binding-a', 0);
    f.setDelta({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', fromCursor: 'turn-1',
      nextCursor: 'turn-4', complete: true, generating: false, historyChanged: false,
      messages: [{ nativeMessageId: 'm1', version: 'v1', text: 'human 1' }], ...patch });
    const receipt = await f.service.syncAndResume('binding-a', 1);
    assert.equal(receipt.state.control, 'reconcile_required');
    assert.throws(() => f.service.assertHostCanSend('binding-a', receipt.state.epoch), /control/i);
  }
});

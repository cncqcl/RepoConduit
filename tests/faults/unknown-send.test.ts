import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionControlService, type ConversationPort, type SessionStateStore } from '../../src/application/session-control.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';

test('transport loss after send intent is unknown and never retried blindly', async () => {
  let state: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
    providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
    control: 'host_controlled', epoch: 0, revision: 0 };
  const store: SessionStateStore = {
    get: () => ({ ...state }),
    compareAndSwap: (expected, next) => {
      if (state.revision !== expected) return false;
      state = { ...next };
      return true;
    },
  };
  let sends = 0;
  const port: ConversationPort = {
    syncDelta: async () => ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-1', complete: true, generating: false,
      historyChanged: false, messages: [] }),
    send: async () => { sends += 1; throw new Error('connection lost'); },
  };
  const service = new SessionControlService(store, port);
  const first = await service.send('binding-a', 0, 'question');
  assert.equal(first.status, 'unknown');
  assert.equal(state.control, 'reconcile_required');
  assert.equal(sends, 1);
  await assert.rejects(() => service.send('binding-a', 0, 'question'), /control|epoch/i);
  assert.equal(sends, 1);
});

test('handoff during pre-send observation prevents a stale sender', async () => {
  let state: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
    providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
    control: 'host_controlled', epoch: 0, revision: 0 };
  const store: SessionStateStore = {
    get: () => ({ ...state }),
    compareAndSwap: (expected, next) => {
      if (state.revision !== expected) return false;
      state = { ...next };
      return true;
    },
  };
  let sends = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const port: ConversationPort = {
    syncDelta: async () => { await gate; return { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-1', complete: true, generating: false,
      historyChanged: false, messages: [] }; },
    send: async () => { sends += 1; return { status: 'submitted' }; },
  };
  const service = new SessionControlService(store, port);
  const pending = service.send('binding-a', 0, 'question');
  service.handoff('binding-a', 0);
  release();
  await assert.rejects(pending, /epoch|control/i);
  assert.equal(sends, 0);
});

test('handoff during an in-flight send fences the worker and retains unknown intent', async () => {
  let state: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
    providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
    control: 'host_controlled', epoch: 0, revision: 0 };
  const store: SessionStateStore = {
    get: () => ({ ...state }),
    compareAndSwap: (expected, next) => {
      if (state.revision !== expected) return false;
      state = { ...next };
      return true;
    },
  };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reachedSend = new Promise<void>((resolve) => { entered = resolve; });
  const port: ConversationPort = {
    syncDelta: async () => ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-1', complete: true, generating: false,
      historyChanged: false, messages: [] }),
    send: async () => { entered(); await gate; return { status: 'submitted' }; },
  };
  const service = new SessionControlService(store, port);
  const pending = service.send('binding-a', 0, 'question');
  await reachedSend;
  assert.equal(service.handoff('binding-a', 0).control, 'reconcile_required');
  release();
  assert.equal((await pending).status, 'unknown');
  assert.equal(state.sendIntent?.status, 'unknown');
  assert.equal(state.control, 'reconcile_required');
  assert.equal(state.epoch, 1);
});

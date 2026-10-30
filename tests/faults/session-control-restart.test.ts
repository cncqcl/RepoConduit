import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlService } from '../../src/application/session-control.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';

test('unknown send survives restart and account or history mismatch remains reconcile_required', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-fault-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  const initial: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
    providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1', control: 'host_controlled', epoch: 0, revision: 0 };
  let sends = 0;
  const port = { syncDelta: async () => ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
    fromCursor: 'turn-1', nextCursor: 'turn-1', complete: true, generating: false,
    historyChanged: false, messages: [] }),
    send: async () => { sends++; throw new Error('transport lost'); } };
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    store.create(initial);
    assert.equal((await new SessionControlService(store, port).send('binding-a', 0, 'question')).status, 'unknown');
    store.close();
    store = new SessionControlSqlite(file);
    assert.equal(store.get('binding-a')?.control, 'reconcile_required');
    assert.equal(store.get('binding-a')?.sendIntent?.status, 'unknown');
    await assert.rejects(() => new SessionControlService(store!, port).send('binding-a', 0, 'question'), /control|epoch/i);
    assert.equal(sends, 1);
    for (const delta of [{ accountId: 'other', historyChanged: false }, { accountId: 'account-a', historyChanged: true }]) {
      const bindingId = `binding-${delta.accountId}-${delta.historyChanged}`;
      const providerId = `provider-${bindingId}`;
      store.create({ ...initial, bindingId, providerId, control: 'human_controlled', epoch: 1 });
      const changedPort = { syncDelta: async () => ({ ...await port.syncDelta(), providerId, ...delta, nextCursor: 'turn-2' }) };
      const receipt = await new SessionControlService(store, changedPort).syncAndResume(bindingId, 1);
      assert.equal(receipt.complete, false);
      assert.equal(receipt.state.control, 'reconcile_required');
      store.close();
      store = new SessionControlSqlite(file);
      assert.equal(store.get(bindingId)?.control, 'reconcile_required');
      assert.throws(() => new SessionControlService(store!, changedPort).assertHostCanSend(bindingId, 1), /control/i);
    }
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('send intent is durable before remote send runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-fault-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const store = new SessionControlSqlite(file);
  let observer: SessionControlSqlite | undefined;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store.create({ bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1', control: 'host_controlled', epoch: 0, revision: 0 });
    const service = new SessionControlService(store, {
      syncDelta: async () => ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', fromCursor: 'turn-1',
        nextCursor: 'turn-1', complete: true, generating: false, historyChanged: false, messages: [] }),
      send: async () => { entered(); await gate; return { status: 'unknown' }; },
    });
    const pending = service.send('binding-a', 0, 'question');
    await reached;
    observer = new SessionControlSqlite(file);
    assert.equal(observer.get('binding-a')?.sendIntent?.status, 'sending');
    assert.equal(observer.get('binding-a')?.sendIntent?.text, 'question');
    release();
    assert.equal((await pending).status, 'unknown');
  } finally {
    release();
    observer?.close();
    store.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncing state after process loss resumes from persisted cursor; unknown send remains blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-fault-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  let syncs = 0;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    const initial: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
      control: 'human_controlled', epoch: 1, revision: 0 };
    store.create(initial);
    assert.equal(store.compareAndSwap(0, { ...initial, control: 'syncing', revision: 1 }), true);
    store.close();
    store = new SessionControlSqlite(file);
    const port = { syncDelta: async () => { syncs++; return { providerId: 'provider-a', accountId: 'account-a',
      nativeSessionId: 'chat-a', fromCursor: 'turn-1', nextCursor: 'turn-2', complete: true,
      generating: false, historyChanged: false,
      messages: [{ nativeMessageId: 'm2', version: 'v1', text: 'human reply' }] }; } };
    const receipt = await new SessionControlService(store, port).syncAndResume('binding-a', 1);
    assert.equal(receipt.complete, true);
    assert.equal(syncs, 1);
    assert.equal(receipt.state.cursor, 'turn-2');
    assert.equal(receipt.state.epoch, 2);
    store.create({ ...initial, bindingId: 'binding-unknown', providerId: 'provider-b',
      control: 'syncing', sendIntent: { id: 'intent-1', text: 'question', status: 'unknown' } });
    store.close();
    store = new SessionControlSqlite(file);
    const blocked = await new SessionControlService(store, port).syncAndResume('binding-unknown', 1);
    assert.equal(blocked.complete, false);
    assert.deepEqual(blocked.messages, []);
    assert.equal(blocked.state.control, 'reconcile_required');
    assert.equal(blocked.state.cursor, 'turn-1');
    assert.equal(blocked.state.sendIntent?.status, 'unknown');
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submitted send cannot resume from quiet, mismatched, or uncorrelated observations after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-fault-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    const initial: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
      control: 'host_controlled', epoch: 0, revision: 0,
      sendIntent: { id: 'intent-a', text: 'question', status: 'awaiting_result' } };
    store.create(initial);
    store.close();
    store = new SessionControlSqlite(file);
    const normal = { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-3', complete: true, generating: false,
      historyChanged: false, messages: [
        { nativeMessageId: 'user-2', version: 'v1', text: 'question' },
        { nativeMessageId: 'reply-3', version: 'v1', text: 'answer' },
      ], completedSend: { sendIntentId: 'intent-a', nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' } };
    for (const [index, patch] of [
      { completedSend: undefined },
      { completedSend: { ...normal.completedSend, sendIntentId: 'other' } },
      { completedSend: { ...normal.completedSend, nativeReplyMessageId: 'missing' } },
      { completedSend: { ...normal.completedSend, nativeReplyMessageId: 'user-2' } },
      { accountId: 'other' },
      { nextCursor: 'turn-1' },
      { generating: true },
      { complete: false },
      { historyChanged: true },
    ].entries()) {
      const bindingId = `binding-${index}`;
      store.create({ ...initial, bindingId, providerId: `provider-${index}` });
      const delta = { ...normal, providerId: `provider-${index}`, ...patch };
      const receipt = await new SessionControlService(store, { syncDelta: async () => delta })
        .reconcileAwaitingResult(bindingId, 0);
      assert.equal(receipt.complete, false);
      assert.deepEqual(receipt.messages, []);
      assert.equal(receipt.state.control, 'reconcile_required');
      assert.equal(receipt.state.cursor, 'turn-1');
      assert.equal(receipt.state.sendIntent?.status, 'awaiting_result');
    }
    const unknownId = 'binding-unknown-reconcile';
    store.create({ ...initial, bindingId: unknownId, providerId: 'provider-unknown',
      control: 'reconcile_required', sendIntent: { ...initial.sendIntent!, status: 'unknown' } });
    const unknownPort = { syncDelta: async () => ({ ...normal, providerId: 'provider-unknown' }) };
    await assert.rejects(() => new SessionControlService(store!, unknownPort)
      .reconcileAwaitingResult(unknownId, 0), /control|intent/i);
    assert.equal(store.get(unknownId)?.sendIntent?.status, 'unknown');
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('awaiting-result reconciliation resumes from durable syncing state after process loss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-fault-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    const initial: SessionState = { bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
      control: 'host_controlled', epoch: 0, revision: 0,
      sendIntent: { id: 'intent-a', text: 'question', status: 'awaiting_result' } };
    store.create(initial);
    assert.equal(store.compareAndSwap(0, { ...initial, control: 'syncing', revision: 1 }), true);
    store.close();
    store = new SessionControlSqlite(file);
    const port = { syncDelta: async () => ({ providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-3', complete: true, generating: false,
      historyChanged: false, messages: [
        { nativeMessageId: 'user-2', version: 'v1', text: 'question' },
        { nativeMessageId: 'reply-3', version: 'v1', text: 'answer' },
      ], completedSend: { sendIntentId: 'intent-a', nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' } }) };
    const receipt = await new SessionControlService(store, port).reconcileAwaitingResult('binding-a', 0);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.state.cursor, 'turn-3');
    assert.equal(receipt.state.epoch, 1);
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('awaiting-result reconciliation retries after incomplete observation or transport failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-session-fault-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: SessionControlSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: 'D:/fixture-session-a', registeredBy: 'owner' });
    base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    store = new SessionControlSqlite(file);
    const initial: SessionState = { bindingId: 'binding-incomplete', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a', cursor: 'turn-1',
      control: 'host_controlled', epoch: 0, revision: 0,
      sendIntent: { id: 'intent-a', text: 'question', status: 'awaiting_result' } };
    store.create(initial);
    store.create({ ...initial, bindingId: 'binding-error', providerId: 'provider-b' });
    const complete = { providerId: 'provider-a', accountId: 'account-a', nativeSessionId: 'chat-a',
      fromCursor: 'turn-1', nextCursor: 'turn-3', complete: true, generating: false,
      historyChanged: false, messages: [
        { nativeMessageId: 'user-2', version: 'v1', text: 'question' },
        { nativeMessageId: 'reply-3', version: 'v1', text: 'answer' },
      ], completedSend: { sendIntentId: 'intent-a', nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' } };
    const incomplete = await new SessionControlService(store, { syncDelta: async () => ({ ...complete, generating: true }) })
      .reconcileAwaitingResult('binding-incomplete', 0);
    assert.equal(incomplete.complete, false);
    await assert.rejects(() => new SessionControlService(store!, { syncDelta: async () => { throw Error('offline'); } })
      .reconcileAwaitingResult('binding-error', 0), /sync failed/i);
    store.close();
    store = new SessionControlSqlite(file);
    for (const [bindingId, providerId] of [['binding-incomplete', 'provider-a'], ['binding-error', 'provider-b']] as const) {
      const before = store.get(bindingId);
      assert.equal(before?.control, 'reconcile_required');
      assert.equal(before.sendIntent?.status, 'awaiting_result');
      const receipt = await new SessionControlService(store, { syncDelta: async () => ({ ...complete, providerId }) })
        .reconcileAwaitingResult(bindingId, 0);
      assert.equal(receipt.complete, true);
      assert.equal(receipt.state.cursor, 'turn-3');
      assert.equal(receipt.state.epoch, 1);
      assert.equal(receipt.state.sendIntent, undefined);
      assert.ok(receipt.receiptId);
    }
  } finally {
    store?.close();
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

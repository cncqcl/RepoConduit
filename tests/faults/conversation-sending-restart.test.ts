import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const scope = { workspaceId: 'workspace-a', collaborationId: 'issue-a' };
const context = { principal: 'owner', audience: 'host', recipient: 'owner',
  surface: 'local_host' as const, now: new Date() };

const sendingChild = `
import { openApplication } from './src/runtime/application.ts';
const app = openApplication(process.env.RCAC_TEST_DIR, { conversationPort: {
  syncDelta: async (state) => ({ providerId: state.providerId, accountId: state.accountId,
    nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
    complete: true, generating: false, historyChanged: false, messages: [] }),
  send: async () => { process.stdout.write('SENDING\\n');
    await new Promise(() => { setInterval(() => {}, 1000); });
    return { status: 'submitted' }; },
} });
await app.dispatch.dispatch({ principal: 'owner', audience: 'host', recipient: 'owner',
  surface: 'local_host', now: new Date() }, { operation: 'conversation.send',
  scope: { workspaceId: 'workspace-a', collaborationId: 'issue-a' }, idempotencyKey: 'send',
  payload: { bindingId: process.env.RCAC_TEST_BINDING, expectedEpoch: 0, text: 'question' } });
`;

async function waitForSending(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Child did not enter send: ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.includes('SENDING\n')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk).slice(0, 2000); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Child exited before send (${code}): ${stderr}`)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function fixture(outcome: 'submitted' | 'rejected' = 'submitted') {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-sending-restart-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(join(dir, 'state.sqlite'));
  seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', ...scope,
    permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
  let calls = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let proof = false;
  let observedUserText = 'question';
  const conversationPort = {
    syncDelta: async (state: SessionState) => ({
      providerId: state.providerId, accountId: state.accountId, nativeSessionId: state.nativeSessionId,
      fromCursor: state.cursor, nextCursor: proof ? 'cursor-2' : state.cursor,
      complete: true, generating: false, historyChanged: false,
      messages: proof ? [
        { nativeMessageId: 'user-1', version: 'v1', text: observedUserText },
        { nativeMessageId: 'reply-1', version: 'v1', text: 'answer' },
      ] : [],
      ...(proof ? { completedSend: { sendIntentId: state.sendIntent?.id ?? '',
        nativeUserMessageId: 'user-1', nativeReplyMessageId: 'reply-1' } } : {}),
    }),
    send: async () => { calls++; entered(); await held; return { status: outcome }; },
  };
  const options = { conversation: { observeBinding: async () => ({ providerId: 'chatgpt',
    accountId: 'approved-account', nativeSessionId: 'chat-a', cursor: 'cursor-1' }) }, conversationPort };
  return { dir, seed, options, started, release, prove: () => { proof = true; },
    userText: (text: string) => { observedUserText = text; }, calls: () => calls,
    inspect: () => new SessionControlSqlite(join(dir, 'state.sqlite')),
    cleanup: () => { seed.close(); rmSync(outer, { recursive: true, force: true }); } };
}

test('restart leaves durable sending unresolved until exact pair proof, then persists replay receipt', async () => {
  const f = fixture();
  let app = openApplication(f.dir, f.options);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
    const send = { operation: 'conversation.send', scope, idempotencyKey: 'send',
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } };
    await app.close();
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', sendingChild], {
      cwd: process.cwd(), env: { ...process.env, RCAC_TEST_DIR: f.dir, RCAC_TEST_BINDING: bound.bindingId },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForSending(child);
    const before = f.inspect();
    const sending = before.get(bound.bindingId)!;
    assert.equal(sending.sendIntent?.status, 'sending');
    assert.equal(before.getCommand(sending.sendIntent!.id)?.status, 'sending');
    before.close();
    const terminated = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    assert.equal(child.kill('SIGKILL'), true);
    await terminated;
    assert.notEqual(child.exitCode, 0);
    app = openApplication(f.dir, { conversationPort: f.options.conversationPort });
    const reopened = f.inspect();
    assert.equal(reopened.get(bound.bindingId)?.sendIntent?.status, 'sending');
    assert.equal(reopened.getCommand(sending.sendIntent!.id)?.status, 'sending');
    reopened.close();
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.resume', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'resume-without-handoff' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    const sync = { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'no-proof' };
    await assert.rejects(app.dispatch.dispatch(context, sync),
      (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
    const parked = f.inspect();
    try {
      assert.equal(parked.get(bound.bindingId)?.sendIntent?.status, 'sending');
      assert.equal(parked.get(bound.bindingId)?.control, 'reconcile_required');
      assert.equal(parked.getCommand(sending.sendIntent!.id)?.status, 'sending');
      assert.equal(parked.listMessages(bound.bindingId).length, 0);
    } finally { parked.close(); }
    await assert.rejects(app.dispatch.dispatch(context, send),
      (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
    await assert.rejects(app.dispatch.dispatch(context, { ...send, idempotencyKey: 'fresh-send' }),
      (error: unknown) => /CONFLICT/.test(String(error)));
    assert.equal(f.calls(), 0);
    f.prove();
    f.userText('different question');
    await assert.rejects(app.dispatch.dispatch(context, { ...sync, idempotencyKey: 'wrong-user-text' }),
      (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
    const mismatch = f.inspect();
    assert.equal(mismatch.getCommand(sending.sendIntent!.id)?.status, 'sending');
    mismatch.close();
    f.userText('question');
    const receipt = await app.dispatch.dispatch(context, { ...sync, idempotencyKey: 'with-proof' }) as
      { state: { sendIntent?: unknown; cursor: string }; messages: unknown[] };
    assert.equal(receipt.state.sendIntent, undefined);
    assert.equal(receipt.state.cursor, 'cursor-2');
    assert.equal(receipt.messages.length, 2);
    const complete = f.inspect();
    assert.equal(complete.getCommand(sending.sendIntent!.id)?.status, 'completed');
    assert.equal(complete.getCommand(sending.sendIntent!.id)?.outcome, 'unknown');
    complete.close();
    assert.equal((await app.dispatch.dispatch(context, send) as { status: string }).status, 'unknown');
    assert.equal(f.calls(), 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const terminated = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await terminated;
    }
    await app.close();
    f.cleanup();
  }
});

test('pair proof completes an active send once and a late submitted result preserves completion', async () => {
  const f = fixture();
  const app = openApplication(f.dir, f.options);
  let active: Promise<unknown> | undefined;
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
    const send = { operation: 'conversation.send', scope, idempotencyKey: 'send',
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' } };
    active = app.dispatch.dispatch(context, send);
    await f.started;
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 1 }, idempotencyKey: 'stale' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    const before = f.inspect();
    assert.equal(before.get(bound.bindingId)?.sendIntent?.status, 'sending');
    const commandId = before.get(bound.bindingId)!.sendIntent!.id;
    before.close();
    f.prove();
    const synced = await app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'recover' }) as
      { state: { sendIntent?: unknown }; messages: unknown[] };
    assert.equal(synced.state.sendIntent, undefined);
    assert.equal(synced.messages.length, 2);
    f.release();
    assert.equal((await active as { status: string }).status, 'unknown');
    const after = f.inspect();
    assert.equal(after.get(bound.bindingId)?.sendIntent, undefined);
    assert.equal(after.getCommand(commandId)?.status, 'completed');
    assert.equal(after.listMessages(bound.bindingId).length, 2);
    after.close();
    assert.equal(f.calls(), 1);
  } finally { f.release(); await active?.catch(() => {}); await app.close(); f.cleanup(); }
});

test('revoked control grant leaves persisted sending untouched on explicit recovery', async () => {
  const f = fixture();
  const app = openApplication(f.dir, f.options);
  let active: Promise<unknown> | undefined;
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
    active = app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' }, idempotencyKey: 'send' });
    await f.started;
    f.seed.revokeGrant('grant', new Date().toISOString());
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'recover' }),
    (error: unknown) => (error as { code?: string }).code === 'NOT_AVAILABLE');
    const check = f.inspect();
    const state = check.get(bound.bindingId)!;
    assert.equal(state.sendIntent?.status, 'sending');
    assert.equal(check.getCommand(state.sendIntent!.id)?.status, 'sending');
    check.close();
  } finally { f.release(); await active?.catch(() => {}); await app.close(); f.cleanup(); }
});

test('no-proof sync during pre-send authorization preserves definite no-send rejection', async () => {
  const f = fixture();
  const app = openApplication(f.dir, f.options);
  let entered!: () => void;
  let release!: () => void;
  const preCall = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let authorizations = 0;
  let pending: Promise<unknown> | undefined;
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
    const gated = { ...context, assertFreshAuthority: async () => {
      if (++authorizations === 4) { entered(); await held; }
    } };
    pending = app.dispatch.dispatch(gated, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' }, idempotencyKey: 'send' });
    await preCall;
    const parked = f.inspect();
    const commandId = parked.get(bound.bindingId)!.sendIntent!.id;
    assert.equal(parked.getCommand(commandId)?.status, 'sending');
    parked.close();
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'recover' }),
    (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
    f.seed.revokeGrant('grant', new Date().toISOString());
    release();
    await assert.rejects(pending);
    const after = f.inspect();
    try {
      assert.equal(after.getCommand(commandId)?.status, 'completed');
      assert.equal(after.getCommand(commandId)?.outcome, 'rejected');
      assert.equal(after.get(bound.bindingId)?.sendIntent, undefined);
      assert.equal(after.get(bound.bindingId)?.control, 'reconcile_required');
    } finally { after.close(); }
    assert.equal(f.calls(), 0);
  } finally { release(); await pending?.catch(() => {}); await app.close(); f.cleanup(); }
});

test('contradictory late provider rejection cannot overwrite pair-proven completion', async () => {
  const f = fixture('rejected');
  const app = openApplication(f.dir, f.options);
  let pending: Promise<unknown> | undefined;
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
    pending = app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' }, idempotencyKey: 'send' });
    await f.started;
    const before = f.inspect();
    const commandId = before.get(bound.bindingId)!.sendIntent!.id;
    before.close();
    f.prove();
    await app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'recover' });
    f.release();
    await assert.rejects(pending, /CONFLICT/);
    const after = f.inspect();
    assert.equal(after.getCommand(commandId)?.status, 'completed');
    assert.equal(after.get(bound.bindingId)?.sendIntent, undefined);
    assert.equal(after.get(bound.bindingId)?.control, 'host_controlled');
    after.close();
  } finally { f.release(); await pending?.catch(() => {}); await app.close(); f.cleanup(); }
});

test('definitive provider rejection after a no-proof sync clears the original sending intent', async () => {
  const f = fixture('rejected');
  const app = openApplication(f.dir, f.options);
  let pending: Promise<unknown> | undefined;
  try {
    const bound = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope,
      payload: {}, idempotencyKey: 'bind' }) as { bindingId: string };
    pending = app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'question' }, idempotencyKey: 'send' });
    await f.started;
    const before = f.inspect();
    const commandId = before.get(bound.bindingId)!.sendIntent!.id;
    before.close();
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.sync', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0 }, idempotencyKey: 'no-proof' }),
    (error: unknown) => (error as { code?: string }).code === 'RECONCILE_REQUIRED');
    f.release();
    assert.equal((await pending as { status: string }).status, 'rejected');
    const after = f.inspect();
    try {
      assert.equal(after.getCommand(commandId)?.status, 'completed');
      assert.equal(after.getCommand(commandId)?.outcome, 'rejected');
      assert.equal(after.get(bound.bindingId)?.sendIntent, undefined);
      assert.equal(after.get(bound.bindingId)?.control, 'reconcile_required');
    } finally { after.close(); }
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'conversation.send', scope,
      payload: { bindingId: bound.bindingId, expectedEpoch: 0, text: 'another question' },
      idempotencyKey: 'fresh-after-rejection' }),
    (error: unknown) => /CONFLICT/.test(String(error)));
    assert.equal(f.calls(), 1);
  } finally { f.release(); await pending?.catch(() => {}); await app.close(); f.cleanup(); }
});

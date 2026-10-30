import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';
import type { CodexControlSend } from '../../src/adapters/codex/protocol/stdio.js';
import { parseCodexRepoReadArguments } from '../../src/adapters/codex/protocol/repo-read-tool.js';
import type { CodexRepoReadCall, CodexRepoReadCapability, FixedDynamicToolResponse } from '../../src/adapters/codex/protocol/repo-read-tool.js';

const target = 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1';
const cwd = 'D:\\repo\\source';
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const reply = { thread: { id: threadId, cwd }, cwd, model: 'gpt-6-sol', modelProvider: 'openai',
  approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false },
  runtimeWorkspaceRoots: [cwd], activePermissionProfile: { id: 'investigator' } };
const call = (id: number | string, changes: Record<string, unknown> = {}) => ({ id, method: 'item/tool/call',
  params: { threadId, turnId, callId: 'call-1', namespace: 'repo', tool: 'read',
    arguments: { path: 'src/a.ts', maxBytes: 1024 }, ...changes } });
const answer: FixedDynamicToolResponse = { success: true, contentItems: [{ type: 'inputText', text: 'page' }] };

function harness(enabled = true, readImpl?: CodexRepoReadCapability['read'], beforeSend?: (frame: CodexControlSend) => void) {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const exited = new EventEmitter();
  const writes: Record<string, unknown>[] = [];
  let terminated = false;
  const transport = new CodexJsonlTransport({ input, output, errors, exited,
    terminate: () => { terminated = true; } },
  { maxFrameBytes: 8192, maxTotalBytes: 512 * 1024, maxNotifications: 100,
    requestTimeoutMs: 1000 }, target, beforeSend);
  input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const calls: CodexRepoReadCall[] = [];
  let release: (() => void) | undefined;
  if (enabled) transport.installRepoReadCapability({ read: readImpl ?? ((request, emit) => {
    calls.push(request);
    return new Promise<void>(resolve => { release = () => { emit(answer); resolve(); }; });
  }) });
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const initialize = async () => {
    const pending = transport.initialize();
    const request = writes.at(-1)!;
    send({ id: request.id, result: {} });
    await pending;
    return request;
  };
  const thread = async () => {
    const pending = transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' });
    const request = writes.at(-1)!;
    send({ id: request.id, result: reply });
    await pending;
    return request;
  };
  const turn = async (onObservedNativeId?: (id: string) => Promise<void>) => {
    const pending = transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' }, onObservedNativeId);
    const request = writes.at(-1)!;
    send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    await pending;
    return request;
  };
  return { transport, writes, calls, send, initialize, thread, turn,
    get release() { return release; }, get terminated() { return terminated; } };
}

test('repo.read is opt-in, Windows-only and registers one fixed namespaced tool', async () => {
  const defaultPair = harness(false);
  const init = await defaultPair.initialize();
  assert.deepEqual((init.params as {capabilities: unknown}).capabilities, { experimentalApi: false });
  const request = await defaultPair.thread();
  assert.deepEqual((request.params as {dynamicTools: unknown}).dynamicTools, []);
  defaultPair.send(call('srv-1'));
  assert.equal(defaultPair.terminated, true);

  const p = harness();
  const initialized = await p.initialize();
  assert.equal(((initialized.params as {capabilities: {experimentalApi: boolean}}).capabilities).experimentalApi, true);
  const started = await p.thread();
  const tools = (started.params as {dynamicTools: Array<Record<string, unknown>>}).dynamicTools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'repo');
  assert.deepEqual((tools[0]?.tools as Array<{name: string}>).map(item => item.name), ['read']);
  assert.throws(() => p.transport.installRepoReadCapability({ read: async () => {} }), /PROTOCOL_REJECTED/);
  p.transport.close();
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const wsl = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(), terminate() {} },
    { maxFrameBytes: 8192, maxTotalBytes: 65536, maxNotifications: 10, requestTimeoutMs: 100 });
  assert.throws(() => wsl.installRepoReadCapability({ read: async () => {} }), /PROTOCOL_REJECTED/);
  wsl.close();
});

test('repo.read parser applies bounded defaults and refuses widened arguments', () => {
  assert.deepEqual(parseCodexRepoReadArguments({ path: 'src/a.ts' }),
    { path: 'src/a.ts', maxBytes: 4096, maxLines: 200 });
  assert.deepEqual(parseCodexRepoReadArguments({ path: 'src/a.ts', maxBytes: 8192, maxLines: 400, cursor: 'opaque' }),
    { path: 'src/a.ts', maxBytes: 8192, maxLines: 400, cursor: 'opaque' });
  for (const args of [{ path: '../x' }, { path: 'CON.txt' }, { path: 'a\\b' },
    { path: 'a/', maxBytes: 10 }, { path: 'a', maxBytes: 8193 },
    { path: 'a', maxLines: 401 }, { path: 'a', cursor: '' }, { path: 'a', executable: 'cmd' }])
    assert.throws(() => parseCodexRepoReadArguments(args), /PROTOCOL_REJECTED/);
});

test('early tool call waits for persisted observed turn ID and validated start response', async () => {
  const p = harness();
  await p.initialize(); await p.thread();
  let releasePersistence: (() => void) | undefined;
  const persisted = new Promise<void>(resolve => { releasePersistence = resolve; });
  const start = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' }, () => persisted);
  const request = p.writes.at(-1)!;
  p.send(call('srv-1'));
  assert.equal(p.calls.length, 0);
  p.send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
  await Promise.resolve();
  assert.equal(p.calls.length, 0);
  releasePersistence?.(); await start;
  await Promise.resolve();
  assert.equal(p.calls.length, 1);
  assert.equal(p.writes.some(frame => frame.id === 'srv-1'), false);
  p.release?.(); await Promise.resolve();
  assert.deepEqual(p.writes.at(-1), { id: 'srv-1', result: answer });
  p.transport.close();
});

test('invalid method, pair and duplicate server IDs fail before callback', async () => {
  for (const invalid of [
    { ...call('srv-1'), method: 'item/commandExecution/requestApproval' },
    call('srv-1', { namespace: 'other' }), call('srv-1', { threadId: 'other' }),
    call('srv-1', { turnId: 'other' }),
  ]) {
    const p = harness(); await p.initialize(); await p.thread(); await p.turn();
    p.send(invalid);
    assert.equal(p.terminated, true);
    assert.equal(p.calls.length, 0);
  }
  const p = harness(); await p.initialize(); await p.thread(); await p.turn();
  p.send(call('srv-1')); await Promise.resolve(); p.send(call('srv-1', { callId: 'call-2' }));
  assert.equal(p.calls.length, 1);
  assert.equal(p.terminated, true);
  const duplicateCall = harness(); await duplicateCall.initialize(); await duplicateCall.thread(); await duplicateCall.turn();
  duplicateCall.send(call('srv-1')); await Promise.resolve();
  duplicateCall.send(call('srv-2'));
  assert.equal(duplicateCall.terminated, true);
});

test('invalid repo.read arguments return a fixed error and a corrected call can succeed', async () => {
  for (const args of [
    { path: 'src/store.py', maxBytes: 20000, maxLines: 500 },
    { path: '../secret' }, { path: 'src/a.ts', shell: 'private-command' },
    { path: 'src/a.ts', cursor: null }, null, {}, 'private-argument',
  ]) {
    const p = harness(); await p.initialize(); await p.thread(); await p.turn();
    p.send(call('invalid', { arguments: args }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(p.terminated, false);
    assert.equal(p.calls.length, 0);
    assert.deepEqual(p.writes.at(-1), { id: 'invalid', result: { success: false,
      contentItems: [{ type: 'inputText', text: 'repo.read failed' }] } });
    p.send(call('corrected', { callId: 'corrected-call', arguments: { path: 'src/a.ts' } }));
    await Promise.resolve(); assert.equal(p.calls.length, 1);
    p.release?.(); await Promise.resolve();
    assert.deepEqual(p.writes.at(-1), { id: 'corrected', result: answer });
    p.transport.close();
  }
});

test('invalid arguments wait for durable turn binding and do not reply after close', async () => {
  for (const close of [false, true]) {
    const p = harness(); await p.initialize(); await p.thread();
    let persisted!: () => void;
    const persistence = new Promise<void>(resolve => { persisted = resolve; });
    const start = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' }, () => persistence);
    const request = p.writes.at(-1)!;
    p.send(call('invalid', { arguments: { path: 'src/a.ts', maxBytes: 20000 } }));
    p.send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    await Promise.resolve();
    assert.equal(p.writes.some(frame => frame.id === 'invalid'), false);
    if (close) p.transport.close();
    persisted();
    if (close) await assert.rejects(start, /PROTOCOL_CLOSED/);
    else await start;
    await Promise.resolve();
    assert.equal(p.writes.some(frame => frame.id === 'invalid'), !close);
    assert.equal(p.calls.length, 0); p.transport.close();
  }
});

test('interruption suppresses a queued invalid-arguments reply', async () => {
  const p = harness(); await p.initialize(); await p.thread(); await p.turn();
  p.send(call('invalid', { arguments: { path: 'src/a.ts', maxBytes: 20000 } }));
  const stop = p.transport.interruptBoundTurn(threadId, turnId);
  p.send({ id: p.writes.at(-1)!.id, result: {} }); await stop;
  assert.equal(p.writes.some(frame => frame.id === 'invalid'), false);
  assert.equal(p.calls.length, 0); p.transport.close();
});

test('invalid-arguments failures still require the guarded control-send authority', async () => {
  let checks = 0;
  const p = harness(true, undefined, frame => {
    if (frame.kind === 'repo-read-failure') { checks++; throw new Error('private authority failure'); }
  });
  await p.initialize(); await p.thread(); await p.turn();
  p.send(call('invalid', { arguments: {} })); await Promise.resolve(); await Promise.resolve();
  assert.equal(checks, 1); assert.equal(p.terminated, true); assert.equal(p.calls.length, 0);
  assert.equal(p.writes.some(frame => frame.id === 'invalid'), false);
});

test('invalid arguments still consume protocol call limits and duplicate identities fail closed', async () => {
  const p = harness(); await p.initialize(); await p.thread(); await p.turn();
  for (let i = 0; i < 40; i++) {
    p.send(call(`invalid-${i}`, { callId: `invalid-${i}`, arguments: {} }));
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(p.terminated, false); assert.equal(p.calls.length, 0);
  assert.equal(p.writes.filter(frame => 'result' in frame).length, 40);
  p.send(call('invalid-40', { callId: 'invalid-40', arguments: {} }));
  assert.equal(p.terminated, true);
  const busy = harness(); await busy.initialize(); await busy.thread(); await busy.turn();
  for (let i = 0; i < 8; i++) busy.send(call(`busy-${i}`, { callId: `busy-${i}`, arguments: {} }));
  assert.equal(busy.terminated, false);
  busy.send(call('busy-8', { callId: 'busy-8', arguments: {} }));
  assert.equal(busy.terminated, true); assert.equal(busy.calls.length, 0);
  for (const duplicate of [call('invalid', { callId: 'other' }), call('other')]) {
    const q = harness(); await q.initialize(); await q.thread(); await q.turn();
    q.send(call('invalid', { arguments: {} })); await Promise.resolve(); await Promise.resolve();
    q.send(duplicate); assert.equal(q.terminated, true); assert.equal(q.calls.length, 0);
  }
});

test('safe integer server request ID is independent of outgoing RPC IDs', async () => {
  const p = harness(); await p.initialize(); await p.thread(); await p.turn();
  p.send(call(1)); await Promise.resolve();
  assert.equal(p.calls.length, 1);
  p.release?.(); await Promise.resolve();
  assert.deepEqual(p.writes.at(-1), { id: 1, result: answer });
  p.transport.close();
});

test('terminal or close during repo.read suppresses late callback output and candidate', async () => {
  const p = harness(); await p.initialize(); await p.thread(); await p.turn();
  const wait = p.transport.waitForBoundTurn({ threadId, turnId, timeoutMs: 100 });
  p.send(call('srv-1'));
  p.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [
    { id: 'a', type: 'agentMessage', text: 'candidate' },
  ] } } });
  await assert.rejects(wait, /PROTOCOL_REJECTED/);
  const count = p.writes.length;
  p.release?.(); await Promise.resolve();
  assert.equal(p.writes.length, count);
});

test('wrong early turn ID fails after native start without invoking read', async () => {
  const p = harness(); await p.initialize(); await p.thread();
  const start = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' });
  const request = p.writes.at(-1)!;
  p.send(call('srv-1', { turnId: 'wrong-turn' }));
  p.send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
  await assert.rejects(start, /PROTOCOL_REJECTED/);
  assert.equal(p.calls.length, 0);
  assert.equal(p.terminated, true);
});

test('repo.read queue caps at eight and total call IDs at forty', async () => {
  const busy = harness(); await busy.initialize(); await busy.thread(); await busy.turn();
  for (let i = 0; i < 8; i++) busy.send(call(`srv-${i}`, { callId: `call-${i}` }));
  await Promise.resolve();
  assert.equal(busy.calls.length, 8);
  busy.send(call('srv-8', { callId: 'call-8' }));
  assert.equal(busy.terminated, true);

  const p = harness(); await p.initialize(); await p.thread(); await p.turn();
  for (let i = 0; i < 40; i++) {
    p.send(call(`srv-${i}`, { callId: `call-${i}` }));
    await Promise.resolve(); p.release?.(); await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(p.calls.length, 40);
  p.send(call('srv-40', { callId: 'call-40' }));
  assert.equal(p.terminated, true);
});

test('repo.read rejection emits a generic bounded failure without exception text', async () => {
  const p = harness(true, async () => { throw new Error('secret path and credential'); });
  await p.initialize(); await p.thread(); await p.turn();
  p.send(call('srv-1'));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(p.writes.at(-1), { id: 'srv-1', result: { success: false,
    contentItems: [{ type: 'inputText', text: 'repo.read failed' }] } });
  assert.equal(JSON.stringify(p.writes).includes('secret path'), false);
  p.transport.close();
});

test('interrupt and local close suppress a late repo.read emission', async () => {
  const interrupted = harness(); await interrupted.initialize(); await interrupted.thread(); await interrupted.turn();
  interrupted.send(call('srv-1')); await Promise.resolve();
  const pending = interrupted.transport.interruptBoundTurn(threadId, turnId);
  const interruptRequest = interrupted.writes.at(-1)!;
  const count = interrupted.writes.length;
  interrupted.release?.(); await Promise.resolve();
  assert.equal(interrupted.writes.length, count);
  interrupted.send({ id: interruptRequest.id, result: {} });
  await pending;
  interrupted.transport.close();

  const detached = harness(); await detached.initialize(); await detached.thread(); await detached.turn();
  detached.send(call('srv-1')); await Promise.resolve();
  const before = detached.writes.length;
  detached.transport.close({ terminate: false });
  detached.release?.(); await Promise.resolve();
  assert.equal(detached.writes.length, before);
  assert.equal(detached.terminated, false);
});

test('repo.read refuses an oversized or malformed capability response', async () => {
  for (const response of [
    { success: true, contentItems: [{ type: 'inputText', text: 'x'.repeat(9000) }] },
    { success: true, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,a' }] },
  ]) {
    const p = harness(true, async (_call, emit) => { emit(response as FixedDynamicToolResponse); });
    await p.initialize(); await p.thread(); await p.turn();
    const count = p.writes.length;
    p.send(call('srv-1')); await Promise.resolve(); await Promise.resolve();
    assert.equal(p.terminated, true);
    assert.equal(p.writes.length, count);
  }
});

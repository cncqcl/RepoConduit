import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { WSL_EXECUTABLE, readVersionProbe, versionLaunchSpec, wslCodexArgs, verifyWslCodexVersion } from '../../src/adapters/codex/investigator/preflight.js';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';

const restrictedThreadResponse = (id: string, changes: Record<string, unknown> = {}) => ({
  thread: { id, cwd: '/home/fixture/fixture' }, cwd: '/home/fixture/fixture',
  model: 'gpt-6-sol', modelProvider: 'openai',
  approvalPolicy: 'never', approvalsReviewer: 'user',
  sandbox: { type: 'readOnly', networkAccess: false },
  runtimeWorkspaceRoots: ['/home/fixture/fixture'],
  activePermissionProfile: { id: 'investigator' },
  ...changes,
});

test('WSL preflight accepts only trusted distro and absolute Linux binary', () => {
  assert.equal(WSL_EXECUTABLE, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(wslCodexArgs({ distro: 'Ubuntu-22.04', binary: '/usr/local/bin/codex' }, 'version'),
    ['-d', 'Ubuntu-22.04', '--exec', '/usr/local/bin/codex', '--version']);
  assert.deepEqual(wslCodexArgs({ distro: 'Ubuntu-22.04', binary: '/usr/local/bin/codex' }, 'stdio'),
    ['-d', 'Ubuntu-22.04', '--exec', '/usr/local/bin/codex', 'app-server', '--stdio']);
  for (const binary of ['codex', '../codex', '/bin/codex\n--evil', '/mnt/c/Users/x/codex']) {
    assert.throws(() => wslCodexArgs({ distro: 'Ubuntu-22.04', binary }, 'version'), /INVALID_ARGUMENT/);
  }
  assert.throws(() => wslCodexArgs({ distro: 'Ubuntu;rm -rf /', binary: '/usr/bin/codex' }, 'version'), /INVALID_ARGUMENT/);
});

test('version launch ignores a PATH-supplied wsl.exe candidate', () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = 'C:\\fake-wsl-location;' + (original ?? '');
    const spec = versionLaunchSpec({ distro: 'Ubuntu-22.04', binary: '/usr/local/bin/codex' });
    assert.equal(spec.executable, WSL_EXECUTABLE);
    assert.notEqual(spec.executable, 'wsl.exe');
    assert.deepEqual(spec.args, ['-d', 'Ubuntu-22.04', '--exec', '/usr/local/bin/codex', '--version']);
  } finally { process.env.PATH = original; }
});

test('stdio input EPIPE rejects the pending call and closes the transport', async () => {
  const p = pair();
  const pending = p.transport.initialize();
  p.input.emit('error', Object.assign(new Error('closed input'), { code: 'EPIPE' }));
  await assert.rejects(pending, /PROTOCOL_CLOSED/);
  assert.equal(p.terminated, true);
});

test('transport remains closed when a termination callback throws during a stream error', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const exited = new EventEmitter();
  const transport = new CodexJsonlTransport({ input, output, errors, exited,
    terminate: () => { throw new Error('synthetic termination failure'); } },
  { maxFrameBytes: 256, maxTotalBytes: 1024, maxNotifications: 3, requestTimeoutMs: 100 });
  const pending = transport.initialize();
  assert.doesNotThrow(() => output.emit('error', new Error('synthetic output failure')));
  await assert.rejects(pending, /PROTOCOL_CLOSED/);
  await assert.rejects(transport.initialize(), /PROTOCOL_CLOSED|PROTOCOL_REJECTED/);
});

test('stdio output and stderr errors fail closed without unhandled stream errors', async () => {
  for (const stream of ['output', 'errors'] as const) {
    const p = pair();
    const pending = p.transport.initialize();
    p[stream].emit('error', Object.assign(new Error('broken stream'), { code: 'EIO' }));
    await assert.rejects(pending, /PROTOCOL_CLOSED/);
    assert.equal(p.terminated, true);
  }
});

test('version probe stdout and stderr errors fail closed', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true; return true; },
    });
    const pending = readVersionProbe(child, 100);
    child[stream].emit('error', Object.assign(new Error('broken version stream'), { code: 'EIO' }));
    await assert.rejects(pending, /CODEX_PREFLIGHT_FAILED/);
    assert.equal(child.killed, true);
  }
});

test('WSL preflight rejects mismatched or missing Linux Codex version', async () => {
  assert.equal(verifyWslCodexVersion('codex-cli 0.157.1\n', '0.157.1'), true);
  assert.equal(verifyWslCodexVersion('codex-cli 0.156.1\n', '0.157.1'), false);
  assert.equal(verifyWslCodexVersion('Windows wrapper failed', '0.157.1'), false);
});

function pair(maxFrameBytes = 256, maxTotalBytes = 1024,
  target: 'wsl-codex-0.157.1' | 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' = 'wsl-codex-0.157.1') {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const exited = new EventEmitter();
  let terminated = false;
  const transport = new CodexJsonlTransport({ input, output, errors, exited, terminate: () => { terminated = true; } },
    { maxFrameBytes, maxTotalBytes, maxNotifications: 20, requestTimeoutMs: 100 }, target);
  return { input, output, errors, exited, transport, get terminated() { return terminated; } };
}

const windowsTarget = 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1';
const winCwd = 'D:\\repo\\source';
const winThread = '11111111-1111-4111-8111-111111111111';
const winTurn = '22222222-2222-4222-8222-222222222222';
const winReply = (changes: Record<string, unknown> = {}) => ({
  thread: { id: winThread, cwd: winCwd }, cwd: winCwd, model: 'gpt-6-sol',
  modelProvider: 'openai', approvalPolicy: 'never', approvalsReviewer: 'user',
  sandbox: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [winCwd],
  activePermissionProfile: { id: 'investigator' }, ...changes,
});

async function boundWindows(maxFrameBytes = 4096, maxTotalBytes = 65536) {
  const p = pair(maxFrameBytes, maxTotalBytes, windowsTarget);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-line test frames are dynamic
  const writes: Record<string, any>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk))));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const start = p.transport.startRestrictedThread({ cwd: winCwd, profileId: 'investigator', model: 'gpt-6-sol' });
  const request = writes.at(-1)!;
  p.output.write(`${JSON.stringify({ id: request.id, result: winReply() })}\n`);
  await start;
  const turn = p.transport.startRestrictedTurn({ threadId: winThread, profileId: 'investigator', text: 'Inspect.' });
  const turnRequest = writes.at(-1)!;
  p.output.write(`${JSON.stringify({ id: turnRequest.id, result: { turn: { id: winTurn, status: 'inProgress', items: [] } } })}\n`);
  await turn;
  return { ...p, writes, threadRequest: request, turnRequest, get terminated() { return p.terminated; } };
}

test('Windows target binds exact cwd/profile and fixed result schema', async () => {
  const p = await boundWindows();
  assert.equal(p.threadRequest.params.cwd, winCwd);
  assert.deepEqual(p.threadRequest.params.runtimeWorkspaceRoots, [winCwd]);
  assert.equal(p.threadRequest.params.permissions, 'investigator');
  assert.equal('sandbox' in p.threadRequest.params, false);
  assert.equal(p.turnRequest.params.cwd, winCwd);
  assert.equal(p.turnRequest.params.outputSchema.properties.kind.enum[0], 'investigation_result_v1');
  p.transport.close({ terminate: false });
  assert.equal(p.terminated, false);
});

test('Windows rejects noncanonical, device, ADS and ambiguous cwd before send', async () => {
  const bad = ['d:\\repo\\source', 'D:/repo/source', 'D:\\', 'D:\\repo\\..\\source',
    'D:\\repo\\.\\source', 'D:\\repo\\x. ', 'D:\\repo\\CON', 'D:\\repo\\NUL.txt',
    'D:\\repo\\x:y', '\\\\server\\share\\repo', '\\\\?\\D:\\repo', 'D:\\repo\\a<',
    'D:\\repo\\a\n'];
  for (const cwd of bad) {
    const p = pair(4096, 65536, windowsTarget);
    const writes: string[] = [];
    p.input.on('data', chunk => writes.push(String(chunk)));
    const init = p.transport.initialize();
    p.output.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    await init;
    const count = writes.length;
    await assert.rejects(p.transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' }), /INVALID_ARGUMENT/);
    assert.equal(writes.length, count, cwd);
    p.transport.close();
  }
  assert.throws(() => pair(4096, 65536, 'future' as never), /INVALID_ARGUMENT/);
});

test('Windows turn wait accepts only one full final agent message for the bound pair', async () => {
  const p = await boundWindows();
  p.output.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: winThread, turnId: winTurn,
    item: { id: 'fake', type: 'agentMessage', text: 'untrusted' } } })}\n`);
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'other',
    turn: { id: winTurn, status: 'completed', items: [] } } })}\n`);
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
    turn: { id: winTurn, status: 'completed', itemsView: 'full', items: [
      { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'ignore' },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '{"kind":"investigation_result_v1"}' },
    ] } } })}\n`);
  assert.deepEqual(await p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 50 }),
    { threadId: winThread, turnId: winTurn, status: 'completed',
      candidate: { itemId: 'answer', text: '{"kind":"investigation_result_v1"}' } });
  p.transport.close();
});

test('Windows turn wait rejects duplicate item IDs, conflicting terminal state and malformed candidate', async () => {
  for (const items of [
    [{ id: 'x', type: 'agentMessage', text: 'a' }, { id: 'x', type: 'agentMessage', text: 'b' }],
    [{ id: 'a', type: 'agentMessage', text: 'a' }, { id: 'b', type: 'agentMessage', text: 'b' }],
    [{ id: 'x', type: 'agentMessage', phase: 'unknown', text: 'a' }],
  ]) {
    const p = await boundWindows();
    const wait = p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 100 });
    p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
      turn: { id: winTurn, status: 'completed', items } } })}\n`);
    await assert.rejects(wait, /PROTOCOL_REJECTED/);
    assert.equal(p.terminated, true);
  }
  const p = await boundWindows();
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
    turn: { id: winTurn, status: 'failed', items: [] } } })}\n`);
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
    turn: { id: winTurn, status: 'interrupted', items: [] } } })}\n`);
  await assert.rejects(p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 50 }), /PROTOCOL_REJECTED/);
});

test('Windows wait timeout and abort leave transport open for interrupt', async () => {
  const p = await boundWindows();
  await assert.rejects(p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 1 }), /PROTOCOL_TIMEOUT/);
  assert.equal(p.terminated, false);
  const controller = new AbortController();
  const wait = p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(wait, /PROTOCOL_ABORTED/);
  assert.equal(p.terminated, false);
  p.transport.close();
});

test('Windows summary, interrupted and async deliveries never produce a candidate', async () => {
  for (const [status, itemsView, items] of [
    ['completed', 'summary', [{ id: 'x', type: 'agentMessage', text: 'summary' }]],
    ['interrupted', 'full', [{ id: 'x', type: 'agentMessage', text: 'partial' }]],
    ['completed', 'full', [{ id: 'x', type: 'agentMessage', text: 'async', delivery: 'async' }]],
    ['completed', 'notLoaded', []],
  ] as const) {
    const p = await boundWindows();
    const event = { method: 'turn/completed', params: { threadId: winThread,
      turn: { id: winTurn, status, itemsView, items } } };
    p.output.write(`${JSON.stringify(event)}\n`);
    p.output.write(`${JSON.stringify(event)}\n`);
    assert.deepEqual(await p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 50 }),
      { threadId: winThread, turnId: winTurn, status, candidate: null });
    p.transport.close();
  }
});

test('Windows rejects widened native sandbox before accepting thread', async () => {
  for (const sandbox of [{ type: 'workspaceWrite' }, { type: 'readOnly', networkAccess: true }]) {
    const p = pair(4096, 65536, windowsTarget);
    const writes: Record<string, unknown>[] = [];
    p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
    const init = p.transport.initialize();
    p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: {} })}\n`);
    await init;
    const start = p.transport.startRestrictedThread({ cwd: winCwd, profileId: 'investigator', model: 'gpt-6-sol' });
    p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: winReply({ sandbox }) })}\n`);
    await assert.rejects(start, /PROTOCOL_REJECTED/);
    assert.equal(p.terminated, true);
  }
});

test('Windows rejects a final candidate larger than 256 KiB', async () => {
  const p = await boundWindows(512 * 1024, 1024 * 1024);
  const wait = p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 100 });
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
    turn: { id: winTurn, status: 'completed', items: [
      { id: 'large', type: 'agentMessage', text: 'x'.repeat(256 * 1024 + 1) },
    ] } } })}\n`);
  await assert.rejects(wait, /PROTOCOL_REJECTED/);
  assert.equal(p.terminated, true);
});

test('active Windows waiter cannot accept a candidate before the same output chunk is validated', async () => {
  const completed = { method: 'turn/completed', params: { threadId: winThread,
    turn: { id: winTurn, status: 'completed', items: [
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'candidate' },
    ] } } };
  for (const trailing of [
    `${JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
      turn: { id: winTurn, status: 'failed', items: [] } } })}\n`,
    '{"broken":\n',
  ]) {
    const p = await boundWindows();
    const wait = p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 100 });
    p.output.write(`${JSON.stringify(completed)}\n${trailing}`);
    await assert.rejects(wait, /PROTOCOL_REJECTED/);
    assert.equal(p.terminated, true);
  }
});

test('active Windows waiter rejects a duplicate terminal with changed excluded content', async () => {
  const p = await boundWindows();
  const wait = p.transport.waitForBoundTurn({ threadId: winThread, turnId: winTurn, timeoutMs: 100 });
  const terminal = (comment: string) => JSON.stringify({ method: 'turn/completed', params: { threadId: winThread,
    turn: { id: winTurn, status: 'completed', items: [
      { id: 'comment', type: 'agentMessage', phase: 'commentary', text: comment },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'candidate' },
    ] } } });
  p.output.write(`${terminal('first')}\n${terminal('changed')}\n`);
  await assert.rejects(wait, /PROTOCOL_REJECTED/);
  assert.equal(p.terminated, true);
});

test('stdio request correlates only a matching structured response and separates notifications', async () => {
  const p = pair();
  const writes: string[] = [];
  p.input.on('data', chunk => writes.push(String(chunk)));
  const pending = p.transport.initialize();
  assert.match(writes[0] ?? '', /"method":"initialize"/);
  assert.match(writes[0] ?? '', /"experimentalApi":false/);
  const id = JSON.parse(writes[0] ?? '{}').id;
  p.output.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: 't', turnId: 'u', item: { type: 'agentMessage', text: 'claim' } } })}\n`);
  p.output.write(`${JSON.stringify({ id, result: { userAgent: 'Codex' } })}\n`);
  assert.deepEqual(await pending, { userAgent: 'Codex' });
  assert.equal(p.transport.notifications().length, 1);
  assert.equal(p.transport.notifications()[0]?.method, 'item/completed');
  p.transport.close();
  assert.equal(p.terminated, true);
});

test('stdio fails closed for unapproved server request, oversized frame and timeout', async () => {
  const a = pair();
  const pending = a.transport.initialize();
  a.output.write('{"id":99,"method":"item/commandExecution/requestApproval","params":{}}\n');
  await assert.rejects(pending, /PROTOCOL_REJECTED/);
  assert.equal(a.terminated, true);

  const b = pair();
  const pending2 = b.transport.initialize();
  b.output.write('x'.repeat(257));
  await assert.rejects(pending2, /PROTOCOL_LIMIT/);
  assert.equal(b.terminated, true);

  const c = pair();
  await assert.rejects(c.transport.initialize(), /PROTOCOL_TIMEOUT/);
  assert.equal(c.terminated, true);
});

test('stdio rejects concurrent initialization and invalid UTF-8', async () => {
  const p = pair();
  const first = p.transport.initialize();
  await assert.rejects(p.transport.initialize(), /PROTOCOL_REJECTED/);
  p.output.write(Buffer.from([0xff, 0x0a]));
  await assert.rejects(first, /PROTOCOL_REJECTED/);
  assert.equal(p.terminated, true);
});

test('model-authored JSON remains notification data, not an adapter receipt', () => {
  const p = pair();
  p.output.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: 't', turnId: 'u', item: { type: 'agentMessage', text: '{"toolReceipt":"fake"}' } } })}\n`);
  assert.deepEqual(p.transport.notifications()[0]?.params, { threadId: 't', turnId: 'u', item: { type: 'agentMessage', text: '{"toolReceipt":"fake"}' } });
  assert.equal('toolReceipt' in (p.transport.notifications()[0] ?? {}), false);
  p.transport.close();
});

test('restricted investigator thread pins profile, model and environment on the native request', async () => {
  const p = pair(512);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
  const request = writes.at(-1)!;
  assert.equal(request.method, 'thread/start');
  assert.deepEqual(request.params, {
    cwd: '/home/fixture/fixture', permissions: 'investigator', model: 'gpt-6-sol',
    allowProviderModelFallback: false, approvalPolicy: 'never',
    dynamicTools: [], environments: [], runtimeWorkspaceRoots: ['/home/fixture/fixture'], ephemeral: false,
  });
  const id = '11111111-1111-4111-8111-111111111111';
  p.output.write(`${JSON.stringify({ id: request.id, result: restrictedThreadResponse(id) })}\n`);
  assert.equal(await start, id);
  p.transport.close();
});

test('investigator thread rejects a missing or wrong native permission profile', async () => {
  for (const activePermissionProfile of [null, { id: 'danger-full-access' }]) {
    const p = pair(512);
    const writes: Record<string, unknown>[] = [];
    p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
    const init = p.transport.initialize();
    p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
    await init;
    const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
    p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: restrictedThreadResponse('11111111-1111-4111-8111-111111111111', { activePermissionProfile }) })}\n`);
    await assert.rejects(start, /PROTOCOL_REJECTED/);
    assert.equal(p.terminated, true);
  }
});

test('native thread identity is observed before rejecting widened permissions', async () => {
  const p = pair(512);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const observed: string[] = [];
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' },
    async id => { observed.push(id); });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id,
    result: restrictedThreadResponse(nativeId, { activePermissionProfile: { id: 'danger-full-access' } }) })}\n`);
  await assert.rejects(start, /PROTOCOL_REJECTED/);
  assert.deepEqual(observed, [nativeId]);
  assert.equal(p.terminated, true);
});

test('failed native identity persistence closes transport and prevents turn start', async () => {
  const p = pair(512);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' },
    () => { throw new Error('STORE_UNAVAILABLE'); });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id,
    result: restrictedThreadResponse('11111111-1111-4111-8111-111111111111') })}\n`);
  await assert.rejects(start, /STORE_UNAVAILABLE/);
  assert.equal(p.terminated, true);
});

test('investigator thread rejects a native response with widened roots, cwd, approvals or sandbox', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const changes of [
    { cwd: '/home/fixture/other' },
    { runtimeWorkspaceRoots: ['/home/fixture/fixture', '/home/fixture/private'] },
    { runtimeWorkspaceRoots: [] },
    { approvalPolicy: 'on-request' },
    { sandbox: { type: 'dangerFullAccess' } },
    { sandbox: {} },
  ]) {
    const p = pair(512);
    const writes: Record<string, unknown>[] = [];
    p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
    const init = p.transport.initialize();
    p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
    await init;
    const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
    p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: restrictedThreadResponse(id, changes) })}\n`);
    await assert.rejects(start, /PROTOCOL_REJECTED/);
    assert.equal(p.terminated, true);
  }
});

test('each investigator turn repeats the permission profile and accepts only native turn identity', async () => {
  const p = pair(512);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const threadId = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' }), /PROTOCOL_REJECTED/);
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: restrictedThreadResponse(threadId) })}\n`);
  await start;
  const pending = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect a synthetic scheduler.' });
  const request = writes.at(-1)!;
  assert.equal(request.method, 'turn/start');
  assert.deepEqual(request.params, { threadId, permissions: 'investigator',
    approvalPolicy: 'never', environments: [], runtimeWorkspaceRoots: ['/home/fixture/fixture'],
    input: [{ type: 'text', text: 'Inspect a synthetic scheduler.' }] });
  const turnId = '22222222-2222-4222-8222-222222222222';
  p.output.write(`${JSON.stringify({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })}\n`);
  assert.equal(await pending, turnId);
  p.transport.close();
});

test('native turn identity is observed before validating turn status', async () => {
  const p = pair(512);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const threadId = '11111111-1111-4111-8111-111111111111';
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: restrictedThreadResponse(threadId) })}\n`);
  await start;
  const observed: string[] = [];
  const turnId = '22222222-2222-4222-8222-222222222222';
  const pending = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' },
    async id => { observed.push(id); });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: { turn: { id: turnId, status: 'unexpected', items: [] } } })}\n`);
  await assert.rejects(pending, /PROTOCOL_REJECTED/);
  assert.deepEqual(observed, [turnId]);
  assert.equal(p.terminated, true);
});

test('interrupt acknowledgment does not claim native turn termination', async () => {
  const p = pair(512, 4096);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const threadId = '11111111-1111-4111-8111-111111111111';
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: restrictedThreadResponse(threadId) })}\n`);
  await start;
  const turnId = '22222222-2222-4222-8222-222222222222';
  const pending = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })}\n`);
  await pending;
  const interrupt = p.transport.interruptBoundTurn(threadId, turnId);
  assert.deepEqual(writes.at(-1)?.params, { threadId, turnId });
  assert.equal(writes.at(-1)?.method, 'turn/interrupt');
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: {} })}\n`);
  assert.deepEqual(await interrupt, { acknowledged: true });
  assert.equal(p.transport.observedBoundTurnTerminal(threadId, turnId), null);
  p.output.write(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId,
    item: { type: 'agentMessage', text: '{"status":"completed"}' } } })}\n`);
  assert.equal(p.transport.observedBoundTurnTerminal(threadId, turnId), null);
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'another-thread',
    turn: { id: turnId, status: 'completed', items: [] } } })}\n`);
  assert.equal(p.transport.observedBoundTurnTerminal(threadId, turnId), null);
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId,
    turn: { id: turnId, status: 'interrupted', items: [] } } })}\n`);
  assert.deepEqual(p.transport.observedBoundTurnTerminal(threadId, turnId), { status: 'interrupted' });
  p.transport.close();
});

test('investigator rejects a question over the UTF-8 byte budget before native send', async () => {
  const p = pair(512);
  const writes: Record<string, unknown>[] = [];
  p.input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: writes[0]?.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const threadId = '11111111-1111-4111-8111-111111111111';
  const start = p.transport.startRestrictedThread({ cwd: '/home/fixture/fixture', profileId: 'investigator', model: 'gpt-6-sol' });
  p.output.write(`${JSON.stringify({ id: writes.at(-1)?.id, result: restrictedThreadResponse(threadId) })}\n`);
  await start;
  const count = writes.length;
  await assert.rejects(p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: '汉'.repeat(6000) }), /PROTOCOL_REJECTED/);
  assert.equal(writes.length, count);
  p.transport.close();
});

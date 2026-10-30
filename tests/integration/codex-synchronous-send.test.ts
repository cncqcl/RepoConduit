import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';
import type { CodexControlSend } from '../../src/adapters/codex/protocol/stdio.js';

const target = 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1';
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const cwd = 'D:\\repo\\source';
const reply = { thread: { id: threadId, cwd }, cwd, model: 'gpt-6-sol', modelProvider: 'openai',
  approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false },
  runtimeWorkspaceRoots: [cwd], activePermissionProfile: { id: 'investigator' } };

function pair(sendNow: (line: string, control?: CodexControlSend) => unknown, maxFrameBytes = 8192) {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const lines: string[] = [], controls: Array<CodexControlSend | undefined> = [];
  let writableWrites = 0, hookCalls = 0, terminated = 0;
  input.on('data', () => { writableWrites++; });
  const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(),
    terminate: () => { terminated++; } },
  { maxFrameBytes, maxTotalBytes: 1024 * 1024, maxNotifications: 100, requestTimeoutMs: 1000 }, target,
  () => { hookCalls++; }, (line, control) => {
    lines.push(line); controls.push(control); return sendNow(line, control);
  });
  const respond = (index: number, result: unknown) => {
    const request = JSON.parse(lines[index]!) as { id: number };
    output.write(`${JSON.stringify({ id: request.id, result })}\n`);
  };
  return { input, output, transport, lines, controls, respond,
    get writableWrites() { return writableWrites; }, get hookCalls() { return hookCalls; },
    get terminated() { return terminated; } };
}

test('selected strategy sends guarded RPC and initialized JSONL with frozen matching control', async () => {
  const p = pair(() => true);
  // A supplied Writable can be unusable without affecting the selected strategy.
  p.input.end();
  const init = p.transport.initialize();
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0]?.endsWith('\n'), true);
  assert.deepEqual(p.controls[0], { kind: 'rpc', method: 'initialize',
    params: { clientInfo: { name: 'repo-conduit', version: '0.1.0' }, capabilities: { experimentalApi: false } } });
  assert.equal(Object.isFrozen(p.controls[0]), true);
  assert.equal(Object.isFrozen((p.controls[0] as Extract<CodexControlSend, {kind:'rpc'}>).params), true);
  assert.equal(Object.isFrozen(((p.controls[0] as Extract<CodexControlSend, {kind:'rpc'}>).params as
    {clientInfo: object}).clientInfo), true);
  p.respond(0, {});
  await init;
  assert.deepEqual(p.controls[1], { kind: 'initialized' });
  assert.equal(p.writableWrites, 0);
  assert.equal(p.hookCalls, 2);
  p.transport.close();
});

test('repo.read success has no control and automatic failure identifies bound pair', async () => {
  const p = pair(() => true);
  p.transport.installRepoReadCapability({ read: async (_call, emit) => {
    emit({ success: true, contentItems: [{ type: 'inputText', text: 'page' }] });
  } });
  const init = p.transport.initialize(); p.respond(0, {}); await init;
  const thread = p.transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' });
  p.respond(2, reply); await thread;
  const turn = p.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'é Inspect.' });
  assert.equal(Buffer.byteLength(p.lines[3]!, 'utf8') > p.lines[3]!.length, true);
  p.respond(3, { turn: { id: turnId, status: 'inProgress', items: [] } }); await turn;
  p.output.write(`${JSON.stringify({ id: 'srv-1', method: 'item/tool/call', params: { threadId, turnId,
    callId: 'call-1', namespace: 'repo', tool: 'read', arguments: { path: 'src/a.ts' } } })}\n`);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(p.controls.at(-1), undefined);
  assert.equal(JSON.parse(p.lines.at(-1)!).result.success, true);
  p.transport.close();

  const q = pair(() => true);
  q.transport.installRepoReadCapability({ read: async () => { throw new Error('internal'); } });
  const qi = q.transport.initialize(); q.respond(0, {}); await qi;
  const qt = q.transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' });
  q.respond(2, reply); await qt;
  const qturn = q.transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' });
  q.respond(3, { turn: { id: turnId, status: 'inProgress', items: [] } }); await qturn;
  q.output.write(`${JSON.stringify({ id: 'srv-2', method: 'item/tool/call', params: { threadId, turnId,
    callId: 'call-2', namespace: 'repo', tool: 'read', arguments: { path: 'src/a.ts' } } })}\n`);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(q.controls.at(-1), { kind: 'repo-read-failure', threadId, turnId });
  q.transport.close();
});

test('complete UTF8 frame including LF is limited before strategy invocation', async () => {
  const initializePayload = JSON.stringify({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'repo-conduit', version: '0.1.0' }, capabilities: { experimentalApi: false } } });
  const exactPayloadOnly = pair(() => true, Buffer.byteLength(initializePayload, 'utf8'));
  await assert.rejects(exactPayloadOnly.transport.initialize(), /PROTOCOL_LIMIT/);
  assert.equal(exactPayloadOnly.lines.length, 0);
  assert.equal(exactPayloadOnly.terminated, 1);

  const p = pair(() => true, 256);
  const init = p.transport.initialize();
  assert.equal(Buffer.byteLength(p.lines[0]!, 'utf8') <= 256, true);
  p.respond(0, {}); await init;
  const before = p.lines.length;
  await assert.rejects(p.transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' }),
    /PROTOCOL_LIMIT/);
  assert.equal(p.lines.length, before);
  p.transport.close();
});

test('false, throw and thenable outcomes fail-stop once without Writable fallback', async () => {
  for (const result of [false, new Error('writer failed'), Promise.resolve(true), { then() {} }]) {
    let sends = 0;
    const p = pair(() => { sends++; if (result instanceof Error) throw result; return result; });
    await assert.rejects(p.transport.initialize(), /PROTOCOL_CLOSED/);
    assert.equal(sends, 1);
    assert.equal(p.terminated, 1);
    assert.equal(p.writableWrites, 0);
    await assert.rejects(p.transport.initialize(), /PROTOCOL_CLOSED|PROTOCOL_REJECTED/);
    assert.equal(sends, 1);
  }
});

test('a rejected native Promise is consumed after immediate fail-stop', () => {
  const script = `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { CodexJsonlTransport } from './src/adapters/codex/protocol/stdio.ts';
    const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
    let sends = 0, writes = 0, terminated = 0;
    input.on('data', () => writes++);
    const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(),
      terminate: () => terminated++ },
      { maxFrameBytes: 8192, maxTotalBytes: 65536, maxNotifications: 10, requestTimeoutMs: 100 },
      'wsl-codex-0.157.1', undefined, () => { sends++; return Promise.reject(new Error('late rejection')); });
    try { await transport.initialize(); process.exitCode = 2; }
    catch (error) { if (error.message !== 'PROTOCOL_CLOSED') process.exitCode = 3; }
    await new Promise(resolve => setTimeout(resolve, 20));
    if (sends !== 1 || writes !== 0 || terminated !== 1) process.exitCode = 4;
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
});

test('strategy closing transport during initialized cannot complete initialize', async () => {
  const p = pair((_line, control) => {
    if (control?.kind === 'initialized') p.transport.close();
    return true;
  });
  const init = p.transport.initialize();
  p.respond(0, {});
  await assert.rejects(init, /PROTOCOL_CLOSED/);
  assert.equal(p.lines.length, 2);
  assert.equal(p.terminated, 1);
  assert.equal(p.writableWrites, 0);
});

test('synchronous RPC reply cannot settle before send confirmation', async () => {
  for (const outcome of ['false', 'throw', 'close'] as const) {
    const p = pair((line, control) => {
      if (control?.kind !== 'rpc' || control.method !== 'thread/read') return true;
      const request = JSON.parse(line) as { id: number };
      p.output.write(`${JSON.stringify({ id: request.id, result: { method: 'thread/read' } })}\n`);
      if (outcome === 'throw') throw new Error('writer failed');
      if (outcome === 'close') p.transport.close();
      return outcome !== 'false';
    });
    const init = p.transport.initialize(); p.respond(0, {}); await init;
    await assert.rejects(p.transport.readThread(threadId), /PROTOCOL_CLOSED/);
    assert.equal(p.terminated, 1);
    assert.equal(p.writableWrites, 0);
  }
});

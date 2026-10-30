import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';

const captured = readFileSync('tests/fixtures/legacy-runtime/initialize-warning.jsonl');
function pair(maxNotifications = 8, maxFrameBytes = 1024, maxTotalBytes = 4096,
  target: 'wsl-codex-0.157.1' | 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' = 'wsl-codex-0.157.1') {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const sent: string[] = []; let terminated = false;
  input.on('data', part => sent.push(part.toString()));
  const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(),
    terminate() { terminated = true; } },
  { maxNotifications, maxFrameBytes, maxTotalBytes, requestTimeoutMs: 100 }, target);
  return { input, output, errors, sent, transport, get terminated() { return terminated; },
    dispose() { transport.close({ terminate: false }); input.destroy(); output.destroy(); errors.destroy(); } };
}

test('synthetic WSL initialize response and warning allow exactly two frames across chunk boundaries', async () => {
  for (const size of [captured.length, 1, 37]) {
    const p = pair();
    try {
      const pending = p.transport.initialize();
      for (let offset = 0; offset < captured.length; offset += size) p.output.write(captured.subarray(offset, offset + size));
      const result = await pending;
      assert.equal((result as { codexHome: string }).codexHome, '/home/investigator/.codex');
      assert.equal(p.sent.length, 2);
      assert.equal(p.sent[1], '{"method":"initialized"}\n');
      assert.deepEqual(p.transport.notifications().map(x => x.method), ['configWarning', 'remoteControl/status/changed']);
      assert.equal(p.terminated, false);
    } finally { p.dispose(); }
  }
});

test('fixed warning schema accepts optional nullable fields and unsigned positions as data', async () => {
  for (const params of [{ summary: '' }, { summary: 'warning', details: null, path: null, range: null },
    { summary: 'warning', details: 'data', path: '/untrusted/path', range: {
      start: { line: 0, column: 1 }, end: { line: 2, column: 3 } } }]) {
    const p = pair();
    try {
      const pending = p.transport.initialize();
      p.output.write(JSON.stringify({ method: 'configWarning', params }) + '\n');
      p.output.write('{"id":1,"result":{}}\n');
      await pending;
      assert.deepEqual(p.transport.notifications()[0], { method: 'configWarning', params });
      assert.equal(p.sent.length, 2);
    } finally { p.dispose(); }
  }
});

test('unknown bare notifications, requests and malformed warning fields stop before initialized', async () => {
  const bad = [null, {}, { summary: 1 }, { summary: 's', extra: true }, { summary: 's', details: {} },
    { summary: 's', path: 1 }, { summary: 's', range: {} },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(line => ({ summary: 's', range: {
      start: { line, column: 1 }, end: { line: 2, column: 3 } } })),
    { summary: 's', range: { start: { line: 1, column: 1, extra: 0 }, end: { line: 2, column: 3 } } }];
  for (const frame of [...bad.map(params => ({ method: 'configWarning', params })),
    { method: 'unknownWarning', params: {} }, { id: 7, method: 'configWarning', params: { summary: 's' } }]) {
    const p = pair();
    try {
      const pending = p.transport.initialize();
      p.output.write(JSON.stringify(frame) + '\n');
      await assert.rejects(pending, /PROTOCOL_REJECTED/);
      assert.equal(p.sent.length, 1); assert.equal(p.terminated, true);
    } finally { p.dispose(); }
  }
});

test('warning compatibility is bound to the fixed WSL target', async () => {
  const p = pair(8, 1024, 4096, 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1');
  try {
    const pending = p.transport.initialize();
    p.output.write('{"method":"configWarning","params":{"summary":"s"}}\n');
    await assert.rejects(pending, /PROTOCOL_REJECTED/); assert.equal(p.sent.length, 1);
  } finally { p.dispose(); }
});

test('recognized warnings still consume notification, frame and total budgets', async () => {
  for (const limits of [[1, 256, 1024], [8, 192, 1024], [8, 256, 256]]) {
    const p = pair(...limits as [number, number, number]);
    try {
      const pending = p.transport.initialize();
      const warning = JSON.stringify({ method: 'configWarning', params: { summary: 's'.repeat(limits[1] === 192 ? 300 : 100) } }) + '\n';
      p.output.write(warning); p.output.write(warning);
      await assert.rejects(pending, /PROTOCOL_REJECTED|PROTOCOL_LIMIT/);
      assert.equal(p.sent.length, 1); assert.equal(p.terminated, true);
    } finally { p.dispose(); }
  }
});

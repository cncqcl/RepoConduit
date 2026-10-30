import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { HostConversationBridge } from '../../src/cli/host-conversation.js';

function fixture(timeoutMs = 1000) {
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      frames.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
    }
  });
  const bridge = new HostConversationBridge(input, output, { timeoutMs });
  const send = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`);
  return { input, output, frames, bridge, send };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const command = { operation: 'conversation.bind', scope: { workspaceId: 'a', collaborationId: 'c' }, payload: {}, idempotencyKey: 'one' };

test('foreground bridge correlates actions while a product command awaits and emits one result', async () => {
  const f = fixture();
  const done = f.bridge.run(async value => {
    assert.deepEqual(value, command);
    return f.bridge.request({ kind: 'observe', target: { workspaceId: 'a', collaborationId: 'c' } });
  });
  f.send({ type: 'command', requestId: 'one', command });
  await tick();
  const action = f.frames[0]!;
  assert.equal(action.type, 'action');
  assert.equal(action.kind, 'observe');
  f.send({ type: 'action_result', actionId: action.actionId, raw: { actual: 'observation' } });
  await tick();
  assert.deepEqual(f.frames[1], { type: 'result', requestId: 'one', result: { actual: 'observation' } });
  f.input.end();
  await done;
});

for (const fault of ['wrong_id', 'extra_field', 'second_command', 'duplicate_result', 'duplicate_command', 'utf8', 'oversize'] as const) {
  test(`foreground bridge fails closed on ${fault}`, async () => {
    const f = fixture();
    let calls = 0;
    const done = f.bridge.run(async () => {
      calls++;
      return f.bridge.request({ kind: 'observe', target: { workspaceId: 'a', collaborationId: 'c' } });
    });
    // Register failure observation before injecting malformed input.
    const rejected = assert.rejects(done, /HOST_BRIDGE_UNAVAILABLE/);
    f.send({ type: 'command', requestId: 'one', command });
    await tick();
    const actionId = f.frames[0]!.actionId;
    if (fault === 'wrong_id') f.send({ type: 'action_result', actionId: 'wrong', raw: {} });
    if (fault === 'extra_field') f.send({ type: 'action_result', actionId, raw: {}, complete: true });
    if (fault === 'second_command') f.send({ type: 'command', requestId: 'two', command });
    if (fault === 'duplicate_result' || fault === 'duplicate_command') {
      f.send({ type: 'action_result', actionId, raw: {} });
      await tick();
      f.send(fault === 'duplicate_result' ? { type: 'action_result', actionId, raw: {} } : { type: 'command', requestId: 'one', command });
    }
    if (fault === 'utf8') f.input.write(Buffer.from([0xff, 10]));
    if (fault === 'oversize') f.input.write('x'.repeat(1_048_577));
    await rejected;
    assert.equal(calls, 1);
    assert.equal(f.frames.filter(frame => frame.type === 'action').length, 1);
  });
}

for (const mode of ['eof', 'timeout', 'output_error', 'input_destroy', 'output_destroy'] as const) {
  test(`foreground bridge ${mode} rejects pending action and drains command without resending`, async () => {
    const f = fixture(mode === 'timeout' ? 15 : 1000);
    let outcome = '';
    const done = f.bridge.run(async () => {
      try { await f.bridge.request({ kind: 'submit', phase: 'commit', target: { workspaceId: 'a', collaborationId: 'c', nativeSessionId: 'chat' }, sendIntentId: 'intent', text: 'synthetic' }); }
      catch { outcome = 'unknown'; }
      return { status: outcome };
    });
    const failure = mode === 'eof' ? done : assert.rejects(done, /HOST_BRIDGE_UNAVAILABLE/);
    f.send({ type: 'command', requestId: 'one', command });
    await tick();
    if (mode === 'eof') f.input.end();
    if (mode === 'output_error') f.output.emit('error', new Error('private detail must not leak'));
    if (mode === 'input_destroy') f.input.destroy();
    if (mode === 'output_destroy') f.output.destroy();
    await failure;
    assert.equal(outcome, 'unknown');
    assert.equal(f.frames.filter(frame => frame.type === 'action').length, 1);
    await assert.rejects(f.bridge.request({ kind: 'observe', target: { workspaceId: 'a', collaborationId: 'c' } }), /HOST_BRIDGE_UNAVAILABLE/);
  });
}

test('foreground bridge refuses identity overrides and arbitrary executor actions', async () => {
  const f = fixture();
  const done = f.bridge.run(async () => ({}));
  const failure = assert.rejects(done, /HOST_BRIDGE_UNAVAILABLE/);
  f.send({ type: 'command', requestId: 'one', command, principal: 'other' });
  await failure;
  assert.deepEqual(f.frames, []);
});

test('close during startup cannot leave the foreground bridge waiting forever', async () => {
  const f = fixture();
  f.bridge.close();
  await f.bridge.run(async () => { throw new Error('must not dispatch'); });
  assert.deepEqual(f.frames, []);
});

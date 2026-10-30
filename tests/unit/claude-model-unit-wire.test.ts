import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { attachClaudeModelUnit } from '../../src/adapters/secondary-investigator/claude-model-supervisor-runner.js';
import { CLAUDE_MODEL_BOOTSTRAP_SHA256 } from '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';

const id = '11111111-1111-4111-8111-111111111111';
const d = { attemptId: `attempt_${id}`, workspaceId: `ws_${id}`, distro: 'Ubuntu-22.04',
  linuxUser: 'fixture', uid: 1000, bootId: id, unitName: `rcac-investigator-${id}.service`,
  launchWorkerEpoch: 1, sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), commandDigest: 'c'.repeat(64) };
const startup = JSON.stringify({ protocol: 'claude_model_startup_v1', kind: 'bootstrap_ready_candidate',
  journal: { protocol: 'claude_model_v1', action: 'claude_model_v1', phase: 'consumed', closed: false,
    attemptId: d.attemptId, workspaceId: d.workspaceId, bootId: id, uid: 1000, unitName: d.unitName,
    launchWorkerEpoch: 1, sourceDigest: d.sourceDigest, profileDigest: d.profileDigest,
    commandDigest: d.commandDigest, invocationId: 'd'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${d.unitName}`,
    enterPid: 200, enterStartTicks: 500 }, bootstrapSha256: CLAUDE_MODEL_BOOTSTRAP_SHA256,
  bwrapInfo: { 'child-pid': 202, 'cgroup-namespace': 1001, 'ipc-namespace': 1002,
    'mnt-namespace': 1003, 'pid-namespace': 1004, 'uts-namespace': 1005 },
  outerCandidate: { hostPid: 202, startTicks: 501, pidNamespace: 'pid:[1004]', nspid: [202, 1] },
  bootstrapReady: { protocol: 'claude_model_bootstrap_v1', kind: 'ready', pid: 2, ppid: 1, startTicks: 502,
    namespaces: { pid: 'pid:[1004]', mnt: 'mnt:[1003]', net: 'net:[1006]', user: 'user:[1007]',
      ipc: 'ipc:[1002]', uts: 'uts:[1005]', cgroup: 'cgroup:[1001]' }, capEff: '0', noNewPrivs: 1 } }) + '\n';
class Bridge extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true; }
  unref() { /* unit bridge only */ }
}

test('unit wire separates fragmented startup and frames one explicit prompt before binary output', async () => {
  const child = new Bridge();
  const writes: Buffer[] = []; child.stdin.on('data', part => writes.push(Buffer.from(part)));
  const handle = attachClaudeModelUnit(child, d, { maxWallSeconds: 10, maxTurns: 3 });
  const bytes = Buffer.from([255, 0, 10]); const hash = createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(handle.writePrompt(bytes, hash));
  child.stdout.write(startup.slice(0, 20)); child.stdout.write(startup.slice(20));
  assert.equal((await handle.ready)?.kind, 'bootstrap_ready_candidate');
  await handle.writePrompt(bytes, hash);
  await assert.rejects(handle.writePrompt(bytes, hash));
  const frame = Buffer.concat(writes); const end = frame.indexOf(10);
  assert.deepEqual(JSON.parse(frame.subarray(0, end).toString()),
    { protocol: 'claude_model_bootstrap_v1', byteLength: 3, sha256: hash });
  assert.deepEqual(frame.subarray(end + 1), bytes);
  child.stdout.write(Buffer.from([254, 0])); child.emit('close', 0);
  const result = await handle.closed;
  assert.deepEqual(result.stdout, Buffer.from([254, 0])); assert.equal(result.uncertain, false);
});

test('unit wire rejects premature output and resolves missing or malformed startup without hanging', async () => {
  for (const output of [startup + 'premature', 'x'.repeat(4096), '{bad}\n', '']) {
    const child = new Bridge(); const handle = attachClaudeModelUnit(child, d, { maxWallSeconds: 10, maxTurns: 3 });
    if (output) child.stdout.write(output); else child.emit('close', 86);
    assert.equal(await handle.ready, null);
    const result = await handle.closed;
    if (output) { assert.equal(result.uncertain, true); assert.equal(child.killed, true); }
    else assert.equal(result.bridgeExitCode, 86);
  }
});

test('failed natural bridge exit after framed delivery remains uncertain', async () => {
  for (const code of [1, null]) {
    const child = new Bridge(); child.stdin.resume();
    const handle = attachClaudeModelUnit(child, d, { maxWallSeconds: 10, maxTurns: 3 });
    child.stdout.write(startup); assert.ok(await handle.ready);
    const prompt = Buffer.from('synthetic');
    await handle.writePrompt(prompt, createHash('sha256').update(prompt).digest('hex'));
    child.stdout.write('partial output'); child.emit('close', code);
    const result = await handle.closed;
    assert.equal(result.uncertain, true);
    assert.equal(result.stdout, null);
    assert.equal(result.bridgeExitCode, null);
  }
});

test('configuration writes once without EOF and READY waits for its delayed callback', async () => {
  const child = new Bridge();
  const writes: Buffer[] = [];
  let finishConfig!: (error?: Error | null) => void;
  const sink = new Writable({ write(part, _encoding, callback) {
    writes.push(Buffer.from(part));
    if (writes.length === 1) finishConfig = callback;
    else callback();
  } });
  Object.assign(child, { stdin: sink });
  const config = Buffer.from('synthetic startup config');
  const handle = attachClaudeModelUnit(child, d, { maxWallSeconds: 10, maxTurns: 3 }, undefined, config);
  config.fill(0);
  assert.equal(sink.writableEnded, false);
  child.stdout.write(startup);
  let ready = false;
  void handle.ready.then(() => { ready = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  const prompt = Buffer.from('synthetic prompt');
  const hash = createHash('sha256').update(prompt).digest('hex');
  await assert.rejects(handle.writePrompt(prompt, hash));
  finishConfig();
  assert.ok(await handle.ready);
  await handle.writePrompt(prompt, hash);
  assert.equal(writes[0]!.toString(), 'synthetic startup config');
  assert.equal(writes.length, 2);
  assert.equal(sink.writableEnded, true);
  child.emit('close', 0);
  assert.equal((await handle.closed).uncertain, false);
});

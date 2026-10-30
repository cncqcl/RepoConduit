import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import type { NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../../src/adapters/secondary-investigator/fixed-zero-model-profile.js';
import { observeSupervisorV2Running, readSupervisorV2RunningChild,
  supervisorV2RunningSpec } from
  '../../src/adapters/secondary-investigator/supervisor-v2-running-observer.js';

const attemptId = `attempt_${randomUUID()}`;
const workspaceId = `ws_${randomUUID()}`;
const unitName = `rcac-investigator-${randomUUID()}.service`;
const bootId = randomUUID();
const invocationId = 'f'.repeat(32);
const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`;
const sourceDigest = 'a'.repeat(64);
const resource: WslResource = { unitName, distro: 'Ubuntu', uid: 1000, bootId,
  invocationId, controlGroup, gate: { protocol: 'attempt_gate_v1',
    linuxUser: 'investigator', root: '/home/investigator/private-gate',
    payloadKind: 'native_supervisor_v2', launch: { workerEpoch: 1, sourceDigest,
      profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST, action: 'fixed_zero_model_v1' } } };
const journal: NativeSupervisorGateState = { protocol: 'native_supervisor_v2', phase: 'entered',
  closed: false, attemptId, workspaceId, bootId, uid: 1000, unitName,
  launchWorkerEpoch: 1, sourceDigest, profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST,
  invocationId, controlGroup, enterPid: 123, enterStartTicks: 456 };
const native = { bootId, uid: 1000, unitName, invocationId, controlGroup,
  loadState: 'loaded', activeState: 'active', subState: 'running',
  mainPid: 123, startTicks: 456, procControlGroup: controlGroup };
const output = (state: object) => ({ exitCode: 0, stdout: JSON.stringify(state) + '\n', stderr: '' });
const expected = { attemptId, workspaceId };

test('running spec fixes WSL Python, systemctl and proc commands with no caller environment', () => {
  const spec = supervisorV2RunningSpec(resource, journal, expected);
  assert.equal(spec.executable.toLowerCase().endsWith('wsl.exe'), true);
  assert.deepEqual(spec.args.slice(0, 11), ['-d', 'Ubuntu', '--user', 'investigator',
    '--cd', '/', '--exec', '/usr/bin/python3', '-I', '-S', '-c']);
  assert.match(spec.args[11]!, /systemctl/);
  assert.match(spec.args[11]!, /\/proc\//);
  assert.equal(spec.args.includes('/bin/sh'), false);
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
  assert.throws(() => supervisorV2RunningSpec({ ...resource, unitName: 'bad' }, journal, expected),
    /INVALID_ARGUMENT/);
});

test('running observer accepts exact active original unit only', async () => {
  let calls = 0;
  const result = await observeSupervisorV2Running(resource, journal, expected, async () => {
    calls++;
    return output(native);
  });
  assert.equal(result.kind, 'original_unit_running');
  assert.equal(calls, 1);
  if (result.kind === 'original_unit_running') {
    assert.deepEqual(result.native, native);
    assert.notStrictEqual(result.resource, resource);
  }
});

test('running observer refuses stale journal and wrong unit/process identities', async () => {
  let calls = 0;
  const runner = async () => { calls++; return output(native); };
  for (const changed of [
    { ...journal, phase: 'released' as const }, { ...journal, closed: true },
    { ...journal, launchWorkerEpoch: 2 }, { ...journal, sourceDigest: 'b'.repeat(64) },
    { ...journal, invocationId: 'e'.repeat(32) },
    { ...journal, attemptId: `attempt_${randomUUID()}` },
    { ...journal, workspaceId: `ws_${randomUUID()}` },
  ]) assert.deepEqual(await observeSupervisorV2Running(resource, changed, expected, runner),
    { kind: 'unconfirmed' });
  assert.equal(calls, 0);
  assert.deepEqual(await observeSupervisorV2Running(resource, { ...journal, enterPid: 124 },
    expected, runner), { kind: 'unconfirmed' });
  for (const changed of [
    { ...native, bootId: randomUUID() }, { ...native, uid: 2000 },
    { ...native, unitName: `rcac-investigator-${randomUUID()}.service` },
    { ...native, invocationId: 'e'.repeat(32) }, { ...native, controlGroup: '/other' },
    { ...native, mainPid: 124 }, { ...native, startTicks: 457 },
    { ...native, procControlGroup: '/other' },
    { ...native, activeState: 'inactive' }, { ...native, subState: 'exited' },
  ]) assert.deepEqual(await observeSupervisorV2Running(resource, journal, expected,
    async () => output(changed)), { kind: 'unconfirmed' });
});

test('running observer rejects nonzero, malformed, widened and oversized output', async () => {
  for (const returned of [
    { ...output(native), exitCode: 1 }, { ...output(native), stdout: 'not json' },
    output({ ...native, extra: true }), { ...output(native), stdout: 'x'.repeat(4097) },
  ]) assert.deepEqual(await observeSupervisorV2Running(resource, journal, expected,
    async () => returned), { kind: 'unconfirmed' });
});

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = 0;
  kill() { this.kills++; return true; }
}

test('running child reader bounds output and time, including missing close after kill', async () => {
  const overflow = new Child();
  const pending = readSupervisorV2RunningChild(overflow, 100);
  overflow.stdout.write('x'.repeat(4097));
  overflow.emit('close', 0);
  assert.equal((await pending).exitCode, null);
  assert.equal(overflow.kills, 1);
  const timed = new Child();
  assert.equal((await readSupervisorV2RunningChild(timed, 10)).exitCode, null);
  assert.equal(timed.kills, 1);
  assert.throws(() => readSupervisorV2RunningChild(new Child(), 7001), /INVALID_ARGUMENT/);
});

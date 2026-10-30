import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { type NativeSupervisorGateDescriptor } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import { readNativeSupervisorGateChild, validateNativeSupervisorGateResult,
  runNativeSupervisorGate } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor-runner.js';

const descriptor: NativeSupervisorGateDescriptor = {
  attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000,
  bootId: '33333333-3333-4333-8333-333333333333',
  unitName: 'rcac-investigator-44444444-4444-4444-8444-444444444444.service',
  launchWorkerEpoch: 2, sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
};
const group = `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}`;
const prepared = { protocol: 'native_supervisor_v2', phase: 'prepared', closed: false,
  attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, bootId: descriptor.bootId,
  uid: descriptor.uid, unitName: descriptor.unitName, launchWorkerEpoch: descriptor.launchWorkerEpoch,
  sourceDigest: descriptor.sourceDigest, profileDigest: descriptor.profileDigest };
const entered = { ...prepared, phase: 'entered', invocationId: 'f'.repeat(32),
  controlGroup: group, enterPid: 100, enterStartTicks: 200 };
const output = (state: object) => ({ exitCode: 0, stdout: JSON.stringify(state) + '\n', stderr: '' });

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = 0;
  kill() { this.kills++; return true; }
}

test('v2 runner validates exact operation phase and keeps legacy journal close-only', () => {
  assert.deepEqual(validateNativeSupervisorGateResult('prepare', descriptor, output(prepared)), prepared);
  assert.equal(validateNativeSupervisorGateResult('prepare', descriptor, output(entered)), null);
  assert.deepEqual(validateNativeSupervisorGateResult('release', descriptor,
    output({ ...entered, phase: 'released' })), { ...entered, phase: 'released' });
  assert.deepEqual(validateNativeSupervisorGateResult('release', descriptor,
    output({ ...entered, phase: 'consumed' })), { ...entered, phase: 'consumed' });
  assert.equal(validateNativeSupervisorGateResult('release', descriptor, output(entered)), null);
  assert.equal(validateNativeSupervisorGateResult('enter', descriptor,
    output({ ...entered, phase: 'released' })), null);
  assert.deepEqual(validateNativeSupervisorGateResult('enter', descriptor,
    output({ ...entered, phase: 'consumed' })), { ...entered, phase: 'consumed' });
  assert.equal(validateNativeSupervisorGateResult('close', descriptor, output(prepared)), null);
  assert.deepEqual(validateNativeSupervisorGateResult('close', descriptor,
    output({ ...prepared, closed: true })), { ...prepared, closed: true });
  const legacy = { protocol: 'native_supervisor_v1', kind: 'closed_unreleased',
    attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
    bootId: descriptor.bootId, uid: descriptor.uid, unitName: descriptor.unitName };
  assert.equal(validateNativeSupervisorGateResult('prepare', descriptor, output(legacy)), null);
  assert.equal(validateNativeSupervisorGateResult('release', descriptor, output(legacy)), null);
  assert.deepEqual(validateNativeSupervisorGateResult('close', descriptor, output(legacy)), legacy);
  assert.deepEqual(validateNativeSupervisorGateResult('status', descriptor, output(legacy)), legacy);
});

test('v2 runner rejects wrong identity, nonzero exit, excess output and invalid operation', () => {
  assert.equal(validateNativeSupervisorGateResult('prepare', descriptor,
    output({ ...prepared, launchWorkerEpoch: 3 })), null);
  assert.equal(validateNativeSupervisorGateResult('prepare', descriptor,
    { ...output(prepared), exitCode: 1 }), null);
  assert.equal(validateNativeSupervisorGateResult('prepare', descriptor,
    { ...output(prepared), stderr: 'x'.repeat(4096) }), null);
  assert.equal(validateNativeSupervisorGateResult('launch' as never, descriptor,
    output(prepared)), null);
});

test('child reader bounds combined output and kills on overflow, timeout and abort', async () => {
  const overflow = new Child();
  const over = readNativeSupervisorGateChild(overflow, 100);
  overflow.stdout.write('x'.repeat(4097));
  overflow.emit('close', 0);
  assert.equal((await over).exitCode, null);
  assert.equal(overflow.kills, 1);

  const timed = new Child();
  const waiting = readNativeSupervisorGateChild(timed, 10);
  assert.equal((await waiting).exitCode, null);
  assert.equal(timed.kills, 1);

  const controller = new AbortController();
  const aborted = new Child();
  const pending = readNativeSupervisorGateChild(aborted, 100, controller.signal);
  controller.abort();
  aborted.emit('close', 0);
  assert.equal((await pending).exitCode, null);
  assert.equal(aborted.kills, 1);
  assert.throws(() => readNativeSupervisorGateChild(new Child(), 9001), /INVALID_ARGUMENT/);
});

test('runner refuses invalid operation, invalid release observation and pre-aborted signal', async () => {
  const root = '/home/fixture/gates';
  await assert.rejects(runNativeSupervisorGate('launch' as never, descriptor, root), /INVALID_ARGUMENT/);
  await assert.rejects(runNativeSupervisorGate('release', descriptor, root), /INVALID_ARGUMENT/);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await runNativeSupervisorGate('prepare', descriptor, root, undefined,
    controller.signal), null);
});

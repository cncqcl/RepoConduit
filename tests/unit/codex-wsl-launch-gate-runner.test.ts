import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  readWslLaunchGateChild, runWslLaunchGate, validateWslLaunchGateResult,
} from '../../src/adapters/codex/investigator/launch-gate-runner.js';
import type { WslLaunchGateDescriptor } from '../../src/adapters/codex/investigator/launch-gate.js';

const descriptor: WslLaunchGateDescriptor = {
  attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  distro: 'Ubuntu', linuxUser: 'rcac_test', uid: 1001,
  bootId: '33333333-3333-4333-8333-333333333333',
  unitName: 'rcac-investigator-44444444-4444-4444-8444-444444444444.service',
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  throwOnKill = false;
  kill(): boolean {
    this.killed = true;
    if (this.throwOnKill) throw new Error('kill failed');
    return true;
  }
  close(code: number): void { this.stdout.end(); this.stderr.end(); this.emit('close', code); }
}

function state(kind: 'open' | 'closed_unconsumed' | 'closed_consumed'): string {
  const base = { kind, attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
    bootId: descriptor.bootId, uid: descriptor.uid, unitName: descriptor.unitName };
  return JSON.stringify(kind === 'closed_consumed' ? { ...base,
    invocationId: 'a'.repeat(32),
    controlGroup: `/user.slice/user-1001.slice/user@1001.service/app.slice/${descriptor.unitName}` } : base) + '\n';
}

test('bounded gate reader captures success and rejects combined output overflow', async () => {
  const success = new FakeChild();
  const pending = readWslLaunchGateChild(success, 100);
  success.stdout.write(state('open'));
  success.close(0);
  assert.deepEqual(await pending, { exitCode: 0, stdout: state('open'), stderr: '' });

  const overflow = new FakeChild();
  const oversized = readWslLaunchGateChild(overflow, 100);
  overflow.stdout.write('a'.repeat(3000));
  overflow.stderr.write('b'.repeat(1100));
  overflow.close(0);
  assert.equal((await oversized).exitCode, null);
  assert.equal(overflow.killed, true);
});

test('bounded gate reader rejects timeout and child error even after close zero', async () => {
  const timed = new FakeChild();
  const pending = readWslLaunchGateChild(timed, 15);
  const result = await pending;
  assert.equal(result.exitCode, null);
  assert.equal(timed.killed, true);

  const errored = new FakeChild();
  const failed = readWslLaunchGateChild(errored, 100);
  errored.emit('error', new Error('spawn failed'));
  errored.close(0);
  assert.equal((await failed).exitCode, null);
});

test('bounded gate reader resolves failure when kill throws', async () => {
  const child = new FakeChild();
  child.throwOnKill = true;
  const pending = readWslLaunchGateChild(child, 100);
  assert.doesNotThrow(() => child.emit('error', new Error('bridge failed')));
  child.close(0);
  assert.equal((await pending).exitCode, null);
  assert.equal(child.killed, true);
});

test('gate bridge abort is bounded and cannot validate a later success', async () => {
  const controller = new AbortController();
  const child = new FakeChild();
  const pending = readWslLaunchGateChild(child, 6000, controller.signal);
  controller.abort();
  assert.equal((await pending).exitCode, null);
  assert.equal(child.killed, true);
  child.stdout.write(state('open'));
  child.close(0);

  const already = new AbortController();
  already.abort();
  assert.equal(await runWslLaunchGate('close', descriptor, '/home/rcac_test/private', already.signal), null);
});

test('gate result accepts only matching operation, identity, exit and bounded streams', () => {
  const output = (stdout: string, exitCode: number | null = 0, stderr = '') =>
    ({ stdout, stderr, exitCode });
  assert.equal(validateWslLaunchGateResult('prepare', descriptor, output(state('open')))?.kind, 'open');
  assert.equal(validateWslLaunchGateResult('status', descriptor, output(state('open')))?.kind, 'open');
  assert.equal(validateWslLaunchGateResult('status', descriptor, output(state('closed_consumed')))?.kind, 'closed_consumed');
  assert.equal(validateWslLaunchGateResult('close', descriptor, output(state('closed_unconsumed')))?.kind, 'closed_unconsumed');
  assert.equal(validateWslLaunchGateResult('close', descriptor, output(state('closed_consumed')))?.kind, 'closed_consumed');
  assert.equal(validateWslLaunchGateResult('prepare', descriptor, output(state('closed_unconsumed'))), null);
  assert.equal(validateWslLaunchGateResult('close', descriptor, output(state('open'))), null);
  assert.equal(validateWslLaunchGateResult('prepare', descriptor, output(state('open'), 1)), null);
  assert.equal(validateWslLaunchGateResult('prepare', descriptor, output(state('open').replace(descriptor.bootId, 'wrong'))), null);
  assert.equal(validateWslLaunchGateResult('prepare', descriptor, output('{')), null);
  assert.equal(validateWslLaunchGateResult('prepare', descriptor, output(state('open'), 0, 'x'.repeat(4097))), null);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  readWslSourceViewChild, runWslSourceView, validateWslSourceViewResult,
} from '../../src/adapters/codex/investigator/source-view-runner.js';
import type { SourceViewDescriptor } from '../../src/adapters/codex/investigator/source-view.js';

const descriptor: SourceViewDescriptor = {
  distro: 'Ubuntu', linuxUser: 'rcac_test', uid: 1001,
  attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  workerEpoch: 3, sourceDigest: 'a'.repeat(64),
  bootId: '33333333-3333-4333-8333-333333333333',
};
const state = (kind: 'ready' | 'closed') => JSON.stringify({
  attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
  uid: descriptor.uid, workerEpoch: descriptor.workerEpoch,
  bootId: descriptor.bootId, digest: descriptor.sourceDigest, kind,
}) + '\n';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  close(code: number): void { this.stdout.end(); this.stderr.end(); this.emit('close', code); }
}

test('source view reader writes exact stdin and bounds output', async () => {
  const child = new FakeChild();
  const received: Buffer[] = [];
  child.stdin.on('data', (part: Buffer) => received.push(part));
  const pending = readWslSourceViewChild(child, '{"plan":1}', 100);
  child.stdout.write(state('ready'));
  await new Promise<void>(resolve => child.stdin.on('finish', resolve));
  child.close(0);
  assert.deepEqual(await pending, { exitCode: 0, stdout: state('ready'), stderrPresent: false });
  assert.equal(Buffer.concat(received).toString('utf8'), '{"plan":1}');

  const overflow = new FakeChild();
  const over = readWslSourceViewChild(overflow, '', 100);
  overflow.stdout.write('x'.repeat(4097));
  overflow.close(0);
  assert.equal((await over).exitCode, null);
  assert.equal(overflow.killed, true);
});

test('source view reader fails closed on timeout, child error and stdin error', async () => {
  const timed = new FakeChild();
  assert.equal((await readWslSourceViewChild(timed, '', 10)).exitCode, null);
  assert.equal(timed.killed, true);

  const errored = new FakeChild();
  const childFailure = readWslSourceViewChild(errored, '', 100);
  errored.emit('error', new Error('spawn failed'));
  errored.close(0);
  assert.equal((await childFailure).exitCode, null);

  const inputError = new FakeChild();
  const stdinFailure = readWslSourceViewChild(inputError, 'input', 100);
  inputError.stdin.emit('error', new Error('broken pipe'));
  inputError.close(0);
  assert.equal((await stdinFailure).exitCode, null);
});

test('source view bridge abort is bounded and leaves operation unconfirmed', async () => {
  const controller = new AbortController();
  const child = new FakeChild();
  const pending = readWslSourceViewChild(child, '{}', 120_000, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { exitCode: null, stdout: '', stderrPresent: false });
  assert.equal(child.killed, true);
  child.close(0);

  const already = new AbortController();
  already.abort();
  assert.equal(await runWslSourceView('status', descriptor, '/home/rcac_test/private', undefined, already.signal), null);
});

test('source view reader never returns bounded WSL stderr and rejects nonzero exit', async () => {
  const child = new FakeChild();
  const pending = readWslSourceViewChild(child, '', 100);
  child.stderr.write('SECRET_CANARY');
  await new Promise<void>(resolve => child.stdin.on('finish', resolve));
  child.close(0);
  const result = await pending;
  assert.deepEqual(result, { exitCode: 0, stdout: '', stderrPresent: true });
  assert.equal(JSON.stringify(result).includes('SECRET_CANARY'), false);

  const nonzero = new FakeChild();
  const failed = readWslSourceViewChild(nonzero, '', 100);
  await new Promise<void>(resolve => nonzero.stdin.on('finish', resolve));
  nonzero.close(1);
  assert.deepEqual(await failed, { exitCode: null, stdout: '', stderrPresent: false });
});

test('source view results require exact operation, exit, stream and identity', () => {
  const output = (stdout: string, exitCode: number | null = 0, stderrPresent = false) =>
    ({ stdout, stderrPresent, exitCode });
  assert.equal(validateWslSourceViewResult('materialize', descriptor, output(state('ready')))?.kind, 'ready');
  assert.equal(validateWslSourceViewResult('close', descriptor, output(state('closed')))?.kind, 'closed');
  assert.equal(validateWslSourceViewResult('status', descriptor, output('null\n')), null);
  assert.equal(validateWslSourceViewResult('close', descriptor, output(state('ready'))), null);
  assert.equal(validateWslSourceViewResult('materialize', descriptor, output(state('closed'))), null);
  assert.equal(validateWslSourceViewResult('status', descriptor, output(state('ready').replace(descriptor.bootId, 'wrong'))), null);
  assert.equal(validateWslSourceViewResult('close', descriptor, output(state('closed'), 1)), null);
  assert.equal(validateWslSourceViewResult('close', descriptor, output(state('closed'), 0, true))?.kind, 'closed');
  assert.equal(validateWslSourceViewResult('close', descriptor, output(state('closed') + 'extra')), null);
});

test('runner rejects missing materialization plan before launch', async () => {
  await assert.rejects(
    runWslSourceView('materialize', descriptor, '/home/rcac_test/private'),
    /INVALID_ARGUMENT/,
  );
});

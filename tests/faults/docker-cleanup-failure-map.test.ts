import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cleanupPersistedContainer } from '../../src/adapters/investigator/docker-worker.js';

const id = 'a'.repeat(64);
const name = `rcac-investigator-${randomUUID()}`;
const expected = 'ISOLATION_TERMINATION_UNCONFIRMED';
const outcomes = [
  { code: 0, stdout: `${id} ${name}\n`, stderr: '' },
  { code: 0, stdout: '', stderr: '' },
  { code: 0, stdout: '', stderr: '' },
  { code: 0, stdout: '', stderr: '' },
];

test('Docker cleanup maps every Docker operation failure to termination unconfirmed', async () => {
  for (const step of [0, 1, 2, 3]) {
    for (const failure of [new Error('TIME_LIMIT_EXCEEDED'), new Error('OUTPUT_LIMIT_EXCEEDED'),
      new Error('spawn ENOENT'), { code: 1, stdout: '', stderr: 'daemon unavailable' }]) {
      const calls: string[][] = [];
      let persisted = 0;
      await assert.rejects(cleanupPersistedContainer(name, null, () => { persisted++; }, async args => {
        calls.push(args);
        if (calls.length - 1 === step) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return outcomes[calls.length - 1]!;
      }), { message: expected }, `step ${step}: ${String(failure)}`);
      assert.equal(calls.length, step + 1, `step ${step} must stop on failure`);
      assert.equal(persisted, step === 0 ? 0 : 1);
    }
  }
});

test('Docker cleanup persists observed ID before rm and confirms exact identity removal', async () => {
  const calls: string[][] = [];
  let persisted = '';
  const removed = await cleanupPersistedContainer(name, null, observed => { persisted = observed; }, async args => {
    calls.push(args);
    if (calls.length === 2) assert.equal(persisted, id);
    return outcomes[calls.length - 1]!;
  });
  assert.equal(removed, id);
  assert.equal(persisted, id);
  assert.deepEqual(calls.map(args => args[0]), ['ps', 'rm', 'ps', 'ps']);
  assert.equal(calls[1]?.[2], id);
});

test('Docker cleanup preserves callback errors and does not rm after failed persistence', async () => {
  const callbackError = new Error('DB_WRITE_FAILED');
  for (const persistObserved of [() => { throw callbackError; }, async () => { throw callbackError; }]) {
    const calls: string[][] = [];
    await assert.rejects(cleanupPersistedContainer(name, null, persistObserved, async args => {
      calls.push(args);
      return outcomes[0]!;
    }), error => error === callbackError);
    assert.deepEqual(calls.map(args => args[0]), ['ps']);
  }
});

test('Docker cleanup preserves invalid argument errors before any Docker call', async () => {
  let calls = 0;
  await assert.rejects(cleanupPersistedContainer('bad-name', null, () => {}, async () => {
    calls++;
    return outcomes[0]!;
  }), { message: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
});

test('Docker cleanup reconciles an already persisted ID without trusting an empty name lookup', async () => {
  const calls: string[][] = [];
  const removed = await cleanupPersistedContainer(name, id, () => {
    throw new Error('persist must not be called again');
  }, async args => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.equal(removed, id);
  assert.deepEqual(calls.map(args => args[0]), ['ps', 'ps', 'ps']);
  assert.equal(calls[1]?.find(arg => arg === `id=${id}`), `id=${id}`);
});

test('Docker cleanup refuses a name lookup that conflicts with its persisted ID', async () => {
  const calls: string[][] = [];
  await assert.rejects(cleanupPersistedContainer(name, 'b'.repeat(64), () => {}, async args => {
    calls.push(args);
    return outcomes[0]!;
  }), { message: expected });
  assert.deepEqual(calls.map(args => args[0]), ['ps']);
});

test('Docker cleanup preserves asynchronous persistence rejection and does not rm', async () => {
  const callbackError = new Error('DB_COMMIT_REJECTED');
  const calls: string[][] = [];
  await assert.rejects(cleanupPersistedContainer(name, null, async () => {
    await Promise.resolve();
    throw callbackError;
  }, async args => {
    calls.push(args);
    return outcomes[0]!;
  }), error => error === callbackError);
  assert.deepEqual(calls.map(args => args[0]), ['ps']);
});

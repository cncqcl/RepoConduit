import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';

test('same bundle actions serialize while independent bundles progress', async () => {
  const locks = new BundleLocks();
  const order: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const first = locks.withBundleLock('a', async () => { order.push('a1-start'); await hold; order.push('a1-end'); });
  const second = locks.withBundleLock('a', async () => { order.push('a2'); });
  const other = locks.withBundleLock('b', async () => { order.push('b'); });
  await other;
  assert.deepEqual(order, ['a1-start', 'b']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1-start', 'b', 'a1-end', 'a2']);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { readSnapshot, readSnapshotOriginal } from '../../src/adapters/repository/queries.js';

test('original file query preserves binary bytes and complete snapshot provenance', () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
  const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'assets/raw.bin': bytes });
  const original = readSnapshotOriginal(snapshot, { principal: 'reader', scopePaths: ['assets/'] }, { path: 'assets/raw.bin' });
  assert.ok(Buffer.from(original.data, 'base64').equals(bytes));
  assert.equal(original.contentHash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(original.byteLength, bytes.length);
  assert.equal(original.snapshotId, snapshot.id);
  assert.equal(original.completeness, 'complete');
  assert.throws(() => readSnapshot(snapshot, { principal: 'reader', scopePaths: ['assets/'] }, { path: 'assets/raw.bin' }), /UNSUPPORTED/);
});

test('original file reads do not weaken scopes, paths or whole-file limits', () => {
  const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'a.bin': Buffer.from([0, 1, 2]), 'private.bin': Buffer.from([3, 4]) });
  const context = { principal: 'reader', scopePaths: ['a.bin'] };
  assert.throws(() => readSnapshotOriginal(snapshot, context, { path: 'private.bin' }), /NOT_AVAILABLE/);
  assert.throws(() => readSnapshotOriginal(snapshot, context, { path: '../a.bin' }), /NOT_AVAILABLE/);
  assert.throws(() => readSnapshotOriginal(snapshot, context, { path: 'a.bin', maxBytes: 2 }), /LIMIT/);
  assert.throws(() => readSnapshotOriginal(snapshot, context, { path: 'a.bin', maxBytes: 33 * 1024 * 1024 }), /LIMIT/);
  assert.throws(() => readSnapshotOriginal(snapshot, { ...context, principal: '' }, { path: 'a.bin' }), /NOT_AVAILABLE/);
});

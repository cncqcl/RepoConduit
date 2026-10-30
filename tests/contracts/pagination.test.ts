import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotFromFiles, RepositorySnapshot } from '../../src/adapters/repository/snapshots.ts';
import { readSnapshot, searchSnapshot, diffSnapshots } from '../../src/adapters/repository/queries.ts';

const context = { principal: 'alice', scopePaths: ['src/large.ts'] };

test('read enforces byte budget even for a long first line and reaches later lines', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('x'.repeat(300) + '\nfunction key() {}\n') });
  let cursor: string | undefined;
  let maxSeen = 0;
  let found = false;
  for (let i = 0; i < 20; i++) {
    const page = readSnapshot(snapshot, context, { path: 'src/large.ts', maxBytes: 64, maxLines: 2, cursor });
    maxSeen = Math.max(maxSeen, Buffer.byteLength(page.content));
    found ||= page.content.includes('function key');
    cursor = page.continuation;
    if (!cursor) break;
  }
  assert.ok(maxSeen <= 64);
  assert.equal(found, true);
});

test('cursor is bound to principal, scope, query, and snapshot', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('abc\ndef\n') });
  assert.equal(snapshot.sourceConsistency, 'best_effort_capture');
  const page = readSnapshot(snapshot, context, { path: 'src/large.ts', maxBytes: 4 });
  assert.ok(page.continuation);
  assert.throws(() => readSnapshot(snapshot, { ...context, principal: 'bob' }, { path: 'src/large.ts', maxBytes: 4, cursor: page.continuation }), /STALE_CURSOR/);
  assert.throws(() => readSnapshot(snapshot, { ...context, scopePaths: ['src/large.ts', 'other.ts'] }, { path: 'src/large.ts', maxBytes: 4, cursor: page.continuation }), /STALE_CURSOR/);
  assert.throws(() => readSnapshot(snapshot, context, { path: 'src/large.ts', maxBytes: 5, cursor: page.continuation }), /STALE_CURSOR/);
  const other = createSnapshotFromFiles('wc_a', 'commit-b', { 'src/large.ts': Buffer.from('abc\ndef\n') });
  assert.throws(() => readSnapshot(other, context, { path: 'src/large.ts', maxBytes: 4, cursor: page.continuation }), /STALE_CURSOR/);
});

test('bounded search reports truncation and never claims whole scope absence', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('one\ntwo\nneedle\n') });
  const first = searchSnapshot(snapshot, context, { term: 'needle', maxBytes: 6, maxMatches: 1 });
  assert.deepEqual(first.matches, []);
  assert.equal(first.completeness, 'partial');
  assert.ok(first.continuation);
  const second = searchSnapshot(snapshot, context, { term: 'needle', maxBytes: 64, maxMatches: 1, cursor: first.continuation });
  assert.equal(second.matches[0]?.line, 3);
  assert.equal(second.matches[0]?.contentHash, readSnapshot(snapshot, context, { path: 'src/large.ts' }).contentHash);
});

test('search rejects a byte window shorter than its UTF-8 term', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('prefix 中文 key') });
  assert.throws(() => searchSnapshot(snapshot, context, { term: '中文', maxBytes: 3 }), /LIMIT_EXCEEDED/);
  let cursor: string | undefined;
  let found: number | undefined;
  for (let i = 0; i < 12; i++) {
    const page = searchSnapshot(snapshot, context, { term: '中文', maxBytes: 6, cursor });
    found = page.matches[0]?.byteOffset;
    if (found !== undefined || !page.continuation) break;
    assert.notEqual(page.continuation, cursor);
    cursor = page.continuation;
  }
  assert.equal(found, 7);
});

test('fixed snapshot diff reports changed content hashes', () => {
  const before = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('old') });
  const after = createSnapshotFromFiles('wc_a', 'commit-b', { 'src/large.ts': Buffer.from('new') });
  const result = diffSnapshots(before, after, context);
  assert.equal(result.changes[0]?.state, 'modified');
  assert.equal(result.changes[0]?.beforeHash, before.manifest[0]?.sha256);
  assert.equal(result.changes[0]?.afterHash, after.manifest[0]?.sha256);
});

test('search continuation retains later matches when the match cap is reached', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('hit\nhit\nhit\n') });
  const one = searchSnapshot(snapshot, context, { term: 'hit', maxMatches: 1 });
  const two = searchSnapshot(snapshot, context, { term: 'hit', maxMatches: 1, cursor: one.continuation });
  assert.equal(one.matches[0]?.line, 1);
  assert.equal(two.matches[0]?.line, 2);
});

test('persisted snapshot verifies content hash and preserves cursor key', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/large.ts': Buffer.from('abc\ndef\n') });
  const page = readSnapshot(snapshot, context, { path: 'src/large.ts', maxBytes: 4 });
  const persisted = snapshot.toPersisted();
  const restored = RepositorySnapshot.fromPersisted(persisted);
  assert.equal(readSnapshot(restored, context, { path: 'src/large.ts', maxBytes: 4, cursor: page.continuation }).content, 'def\n');
  persisted.files['src/large.ts'] = Buffer.from('tampered').toString('base64');
  assert.throws(() => RepositorySnapshot.fromPersisted(persisted), /INTEGRITY_ERROR/);
});

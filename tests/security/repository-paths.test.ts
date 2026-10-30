import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelativePath } from '../../src/adapters/repository/path-policy.ts';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.ts';
import { readSnapshot } from '../../src/adapters/repository/queries.ts';

test('unsafe and sensitive paths are denied', () => {
  for (const path of ['../secret', '/etc/passwd', 'C:/secret', '\\\\server\\share', 'src/../x', '.git/config', '.env', 'CON', 'foo. ', 'a\0b']) {
    assert.throws(() => validateRelativePath(path));
  }
});

test('scope denial does not reveal whether a path is present', () => {
  const snapshot = createSnapshotFromFiles('wc_a', 'commit-a', { 'src/private.ts': Buffer.from('secret') });
  const context = { principal: 'alice', scopePaths: ['src/public.ts'] };
  assert.throws(() => readSnapshot(snapshot, context, { path: 'src/private.ts' }), /NOT_AVAILABLE/);
  assert.throws(() => readSnapshot(snapshot, context, { path: 'src/missing.ts' }), /NOT_AVAILABLE/);
});

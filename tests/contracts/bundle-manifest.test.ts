import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeArtifactPath, validateArtifactPaths } from '../../src/core/artifact/paths.js';

test('artifact paths reject traversal, device names, and ambiguous spellings', () => {
  for (const path of ['../x', '/root', 'C:/x', '\\\\server\\share', 'a/../b', 'CON.txt', 'a. ', 'a\\b', 'a\0b', '\ud800.txt', '\ud801.txt']) {
    assert.throws(() => normalizeArtifactPath(path), /Invalid artifact path|NFC/, path);
  }
  assert.equal(normalizeArtifactPath('dir/report.md'), 'dir/report.md');
  assert.throws(() => validateArtifactPaths(['Readme.md', 'README.md']));
  assert.throws(() => validateArtifactPaths(['café.md', 'cafe\u0301.md']));
  assert.throws(() => validateArtifactPaths(['a', 'a/b']), /conflict/i);
  assert.throws(() => validateArtifactPaths(['A/B', 'a']), /conflict/i);
  assert.throws(() => validateArtifactPaths(['a', 'a-variant', 'a/b']), /conflict/i);
  assert.throws(() => validateArtifactPaths(['Report/one.txt', 'report/two.txt']), /conflict/i);
});

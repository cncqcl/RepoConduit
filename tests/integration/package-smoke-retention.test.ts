import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('package smoke rejects invalid retention arguments before running npm or overwriting files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-smoke-retain-'));
  const existing = join(root, 'existing.tgz');
  const original = Buffer.from('retain this existing file');
  writeFileSync(existing, original);
  try {
    for (const args of [['--unknown'], ['--retain-archive'], ['--retain-archive', 'relative.tgz'],
      ['--retain-archive', existing], ['--retain-archive', join(root, 'missing', 'candidate.tgz')]]) {
      const result = spawnSync(process.execPath, [resolve('tools/package-smoke.mjs'), ...args],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, npm_execpath: undefined } });
      assert.notEqual(result.status, 0);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /PACKAGE_SMOKE_RETENTION_UNSAFE/);
      assert.deepEqual(readFileSync(existing), original);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

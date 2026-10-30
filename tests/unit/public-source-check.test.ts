import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

test('public source check rejects a credential still staged after the working file is cleaned', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'rcac-public-source-check-'));
  const script = resolve('tools/check-public-source.mjs');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const check = () => spawnSync(process.execPath, [script], { cwd: fixture, encoding: 'utf8' });
  try {
    git('init');
    writeFileSync(join(fixture, 'README.md'), 's' + 'k-' + 'x'.repeat(60));
    git('add', 'README.md');
    writeFileSync(join(fixture, 'README.md'), '# Public text\n');
    const rejected = check();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /possible credential/);
    assert.equal(rejected.stderr.includes('x'.repeat(60)), false);
    git('add', 'README.md');
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /"findings":0/);
  } finally {
    assert.equal(resolve(dirname(fixture)), resolve(tmpdir()));
    assert.ok(fixture.startsWith(join(resolve(tmpdir()), 'rcac-public-source-check-')));
    rmSync(fixture, { recursive: true, force: true });
  }
});

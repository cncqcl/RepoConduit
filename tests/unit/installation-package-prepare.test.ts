import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('explicit package preparation ships the matching lock and refuses a changed root or overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-package-prepare-'));
  let passed = false;
  try {
    const pkg = { name: 'repo-conduit', version: '0.1.1', bin: { rcac: 'dist/src/cli/main.js' },
      dependencies: { semver: '7.8.5' }, devDependencies: {} };
    const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
      packages: { '': pkg } };
    const bytes = JSON.stringify(lock);
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'package-lock.json'), bytes);
    const run = () => {
      const result = spawnSync(process.execPath, [resolve('tools/prepare-installation-package.mjs'), root],
        { encoding: 'utf8', timeout: 5_000 });
      if (result.error) throw result.error;
      return result;
    };
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'), bytes);
    assert.equal(run().status, 1);
    assert.equal(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'), bytes);
    rmSync(join(root, 'npm-shrinkwrap.json'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, version: '0.1.2' }));
    assert.equal(run().status, 1);
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true });
  }
});

test('check is read-only and sync repairs only an ordinary derived lock without changing source', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-package-lock-sync-'));
  try {
    const pkg = { name: 'repo-conduit', version: '0.1.0', bin: { rcac: 'dist/src/cli/main.js' },
      dependencies: {}, devDependencies: {} };
    const bytes = Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version,
      lockfileVersion: 3, requires: true, packages: { '': pkg } }) + '\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'package-lock.json'), bytes);
    const run = (mode: string) => spawnSync(process.execPath,
      [resolve('tools/prepare-installation-package.mjs'), mode, root],
      { encoding: 'utf8', timeout: 5_000 });
    assert.equal(run('--check').status, 1);
    assert.equal(existsSync(join(root, 'npm-shrinkwrap.json')), false);
    assert.equal(run('--sync').status, 0);
    assert.deepEqual(readFileSync(join(root, 'npm-shrinkwrap.json')), bytes);
    assert.equal(run('--check').status, 0);
    assert.equal(spawnSync(process.execPath,
      [resolve('tools/prepare-installation-package.mjs'), '--check'],
      { cwd: root, encoding: 'utf8', timeout: 5_000 }).status, 0);
    assert.deepEqual(readFileSync(join(root, 'package-lock.json')), bytes);
    writeFileSync(join(root, 'npm-shrinkwrap.json'), Buffer.from('drift'));
    assert.equal(run('--check').status, 1);
    assert.equal(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'), 'drift');
    assert.equal(run('--sync').status, 0);
    assert.deepEqual(readFileSync(join(root, 'npm-shrinkwrap.json')), bytes);
    assert.equal(run('--check').status, 0);
    assert.deepEqual(readFileSync(join(root, 'package-lock.json')), bytes);
    assert.deepEqual(readdirSync(root).sort(), ['npm-shrinkwrap.json', 'package-lock.json', 'package.json'].sort());
    assert.equal(run('--unknown').status, 1);
    const target = join(root, 'npm-shrinkwrap.json');
    const secondLink = join(root, 'second-link.json');
    linkSync(target, secondLink);
    assert.equal(run('--sync').status, 1, 'a hardlinked target must not be replaced');
    assert.deepEqual(readFileSync(target), bytes);
    assert.deepEqual(readFileSync(secondLink), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

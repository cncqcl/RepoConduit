import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// Explicit staging operation, never an npm lifecycle script. npm publishes
// npm-shrinkwrap.json but omits package-lock.json from packed dependencies.
try {
  assert.ok(process.argv.length === 3 || process.argv.length === 4);
  const mode = process.argv.length === 3 && !process.argv[2].startsWith('--') ? '--create' : process.argv[2];
  assert.ok(['--create', '--check', '--sync'].includes(mode));
  const root = process.argv.length === 3 && mode !== '--create' ? process.cwd() : process.argv.at(-1);
  assert.ok(isAbsolute(root) && resolve(root) === root);
  const read = name => {
    const file = join(root, name);
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 2 * 1024 * 1024);
    return readFileSync(file);
  };
  const pkg = JSON.parse(read('package.json').toString('utf8'));
  const bytes = read('package-lock.json');
  const lock = JSON.parse(bytes.toString('utf8'));
  assert.equal(pkg.name, 'repo-conduit');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.requires, true);
  const entry = lock.packages[''];
  for (const key of ['name', 'version', 'bin', 'dependencies', 'devDependencies']) {
    assert.deepEqual(entry[key], pkg[key]);
  }
  const target = join(root, 'npm-shrinkwrap.json');
  if (mode === '--create') {
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  } else if (mode === '--check') {
    assert.deepEqual(read('npm-shrinkwrap.json'), bytes);
  } else {
    try { read('npm-shrinkwrap.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(root, `.npm-shrinkwrap-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      assert.deepEqual(read('package-lock.json'), bytes);
      renameSync(temporary, target);
      assert.deepEqual(read('npm-shrinkwrap.json'), bytes);
      assert.deepEqual(read('package-lock.json'), bytes);
    } finally { rmSync(temporary, { force: true }); }
  }
  process.stdout.write(JSON.stringify({ prepared: mode !== '--check', checked: true,
    packageVersion: pkg.version }) + '\n');
} catch {
  process.stderr.write('INSTALLATION_PACKAGE_PREPARATION_FAILED\n');
  process.exitCode = 1;
}

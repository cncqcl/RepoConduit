import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { inspectInstallationPackageArchive } from '../dist/src/runtime/installation-package-preflight.js';

const base = mkdtempSync(join(tmpdir(), 'rcac-upgrade-package-canary-'));
let passed = false;
try {
  const staging = join(base, 'candidate'); mkdirSync(staging);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  // A real alternate package version built from this controlled local source.
  pkg.version = '0.1.1'; lock.version = pkg.version; lock.packages[''].version = pkg.version;
  pkg.files = ['npm-shrinkwrap.json', 'dist/src', 'dist/contracts'];
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(staging, 'package-lock.json'), JSON.stringify(lock, null, 2));
  cpSync(resolve('dist'), join(staging, 'dist'), { recursive: true });
  const run = (args, cwd) => {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr.slice(0, 512));
    return result.stdout;
  };
  console.log('upgrade package canary: preparing matching publication lock');
  run([resolve('tools/prepare-installation-package.mjs'), staging], resolve('.'));
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  console.log('upgrade package canary: actual npm pack of version 0.1.1');
  const packed = JSON.parse(run([npm, 'pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', base], staging));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, 'repo-conduit-0.1.1.tgz');
  const bytes = readFileSync(join(base, packed[0].filename));
  const checked = inspectInstallationPackageArchive(bytes);
  assert.equal(checked.packageVersion, '0.1.1');
  console.log(JSON.stringify({ case: 'actual_alternate_version_archive_preflight', passed: true,
    packageVersion: checked.packageVersion, sha256: checked.sha256,
    npmIntegrity: packed[0].integrity, bytes: bytes.length,
    installed: false, migrated: false, activated: false }));
  passed = true;
} finally {
  if (passed) {
    assert.match(relative(resolve(tmpdir()), resolve(base)), /^rcac-upgrade-package-canary-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true });
  } else console.error('Failed or uncertain synthetic package fixture retained:', base);
}

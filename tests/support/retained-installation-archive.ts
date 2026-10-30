import assert from 'node:assert/strict';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { inspectInstallationPackageArchive } from '../../src/runtime/installation-package-preflight.js';

/** Explicit installed-test input, never a substitute for the default build/pack path. */
export function pinRetainedInstallationArchive(archive: string, fixture: string,
  version: '0.1.0' | '0.1.1'): string {
  assert.ok(version === '0.1.0' || version === '0.1.1');
  assert.ok(isAbsolute(archive) && resolve(archive) === archive);
  const stat = lstatSync(archive);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024);
  const bytes = readFileSync(archive);
  const inspected = inspectInstallationPackageArchive(bytes);
  assert.equal(inspected.packageVersion, version);
  const pinned = join(fixture, `retained-${version}.tgz`);
  writeFileSync(pinned, bytes, { flag: 'wx', mode: 0o600 });
  console.log('retained-installation-archive', JSON.stringify({ version, bytes: bytes.length,
    sha256: inspected.sha256 }));
  return pinned;
}

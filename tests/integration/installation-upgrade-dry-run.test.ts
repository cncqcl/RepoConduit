import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance, acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { dryRunInstallationUpgrade } from '../../src/runtime/installation-upgrade.js';

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}
function archive(version: string): Buffer {
  const pkg = { name: 'repo-conduit', version, type: 'module',
    bin: { rcac: 'dist/src/cli/main.js' } };
  const lock = { name: 'repo-conduit', version, lockfileVersion: 3, requires: true,
    packages: { '': { name: 'repo-conduit', version, bin: { rcac: 'dist/src/cli/main.js' } } } };
  const entries = [
    ['package/package.json', JSON.stringify(pkg)],
    ['package/npm-shrinkwrap.json', JSON.stringify(lock)],
    ['package/dist/src/cli/main.js', 'main'],
    ['package/dist/src/cli/migrate-installation.js', 'migrate']
  ] as const;
  const blocks: Buffer[] = [];
  for (const [path, text] of entries) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(path, 0, 'utf8');
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(body.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function refusal(action: () => unknown, expected: RegExp): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  if (caught instanceof AggregateError) throw caught;
  assert.ok(caught instanceof Error, 'dry-run unexpectedly succeeded');
  assert.match(caught.message, expected);
}

test('managed upgrade dry-run checks only package, paths and maintenance without changing installation', () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-upgrade-dry-'));
  let failed: unknown;
  try {
    protectNewDataDirectory(base);
    const root = join(base, 'installation');
    createManagedInstallation(root);
    const before = readFileSync(join(root, 'managed.json'));
    const generation = (JSON.parse(before.toString('utf8')) as { activeGeneration: string }).activeGeneration;
    const data = join(root, 'generations', generation, 'data');
    const state = join(data, 'state.sqlite');
    writeFileSync(state, 'deliberately invalid database header');
    writeFileSync(`${state}-wal`, 'existing activity, not examined by dry-run');
    const fileBefore = readFileSync(state);
    const walBefore = readFileSync(`${state}-wal`);
    const rootBefore = readdirSync(root);
    const generationsBefore = readdirSync(join(root, 'generations'));
    const dataBefore = readdirSync(data);
    const good = archive('0.1.1');
    const packagePath = join(base, 'candidate.tgz');
    writeFileSync(packagePath, good);
    const backup = join(base, 'fresh-backup');
    const report = dryRunInstallationUpgrade(root, packagePath, backup);
    assert.deepEqual(report, {
      dryRun: true, status: 'preflight_passed', scope: 'package_version_paths_and_maintenance',
      fromVersion: '0.1.0', packageVersion: '0.1.1',
      archiveSha256: createHash('sha256').update(good).digest('hex'), sourceGeneration: generation,
      notChecked: ['registered_workspace_overlap', 'dataset_backup_and_integrity',
        'offline_dependency_availability', 'migration_and_activation']
    });
    assert.equal(existsSync(backup), false);
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
    assert.deepEqual(readFileSync(state), fileBefore);
    assert.deepEqual(readFileSync(`${state}-wal`), walBefore);
    assert.deepEqual(readdirSync(root), rootBefore);
    assert.deepEqual(readdirSync(join(root, 'generations')), generationsBefore);
    assert.deepEqual(readdirSync(data), dataBefore);
    const owner = acquireInstallationMaintenance(root); owner.release();

    const runtime = acquireInstallationRuntime(root);
    try { refusal(() => dryRunInstallationUpgrade(root, packagePath, backup), /MAINTENANCE_GATE_BUSY/); }
    finally { runtime.release(); }
    const bad = join(base, 'invalid.tgz'); writeFileSync(bad, 'not an archive');
    refusal(() => dryRunInstallationUpgrade(root, bad, backup), /Invalid upgrade package archive/);
    const wrong = join(base, 'unsupported.tgz'); writeFileSync(wrong, archive('0.1.2'));
    refusal(() => dryRunInstallationUpgrade(root, wrong, backup), /INSTALLATION_UPGRADE_UNSAFE/);
    refusal(() => dryRunInstallationUpgrade(root, packagePath, 'relative-backup'), /INSTALLATION_UPGRADE_UNSAFE|INSTALLATION_UNSAFE/);
    refusal(() => dryRunInstallationUpgrade(root, packagePath, join(root, 'nested-backup')),
      /INSTALLATION_UPGRADE_UNSAFE|INSTALLATION_UNSAFE/);
    refusal(() => dryRunInstallationUpgrade(root, packagePath, base), /INSTALLATION_UPGRADE_UNSAFE|INSTALLATION_UNSAFE/);
    const existing = join(base, 'existing'); mkdirSync(existing);
    refusal(() => dryRunInstallationUpgrade(root, packagePath, existing), /INSTALLATION_UPGRADE_UNSAFE|INSTALLATION_UNSAFE/);
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
    assert.deepEqual(readFileSync(state), fileBefore);
    assert.deepEqual(readFileSync(`${state}-wal`), walBefore);
    assert.equal(existsSync(backup), false);
    const finalOwner = acquireInstallationMaintenance(root); finalOwner.release();
  } catch (error) { failed = error; }
  if (failed !== undefined) throw failed;
  assert.match(relative(resolve(parent), resolve(base)), /^rcac-upgrade-dry-[A-Za-z0-9_-]{6}$/);
  rmSync(base, { recursive: true, force: true });
});

import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance, type InstallationMaintenance } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { inventoryInstallationData } from '../../src/runtime/installation-data-files.js';

test('maintenance inventory preserves empty directories and ordinary locks; refuses links and bounded overflow', () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-data-files-'));
  let owner: InstallationMaintenance | undefined;
  let primary: unknown;
  try {
    protectNewDataDirectory(base);
    const root = join(base, 'installation');
    createManagedInstallation(root);
    owner = acquireInstallationMaintenance(root);
    const data = owner.dataDirectory;
    mkdirSync(join(data, 'empty'));
    writeFileSync(join(data, 'ordinary.lock'), Buffer.from([0, 255, 128]));
    const inventory = inventoryInstallationData(owner);
    assert.ok(inventory.entries.some(entry => entry.relativePath === 'empty' && entry.kind === 'directory'));
    assert.ok(inventory.entries.some(entry => entry.relativePath === 'ordinary.lock' && entry.kind === 'file' && entry.size === 3));
    assert.ok(inventory.entries.some(entry => entry.relativePath === 'state.sqlite'));
    assert.ok(Object.isFrozen(inventory) && Object.isFrozen(inventory.entries));
    assert.throws(() => inventoryInstallationData(owner!, { maxEntries: 1 }), /INSTALLATION_DATA_LIMIT/);
    assert.throws(() => inventoryInstallationData(owner!, { maxBytes: 1 }), /INSTALLATION_DATA_LIMIT/);
    assert.throws(() => inventoryInstallationData(owner!, { maxEntries: 10_001 }), /INSTALLATION_DATA_LIMIT/);
    const hardlink = join(data, 'hardlink');
    linkSync(join(data, 'ordinary.lock'), hardlink);
    assert.throws(() => inventoryInstallationData(owner!), /INSTALLATION_DATA_UNSAFE/);
    rmSync(hardlink);
    const external = join(base, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'never-read'), 'synthetic');
    const alias = join(data, 'alias');
    symlinkSync(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inventoryInstallationData(owner!), /INSTALLATION_DATA_UNSAFE/);
    rmSync(alias);
    assert.equal(existsSync(join(external, 'never-read')), true);
    owner.release();
    assert.throws(() => inventoryInstallationData(owner!), /INSTALLATION_UNSAFE/);
  } catch (error) { primary = error; }
  let cleanup: unknown;
  try {
    owner?.release();
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-data-files-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Inventory test and cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
});

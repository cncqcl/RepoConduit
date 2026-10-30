import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const generation = 'gen_01234567-89ab-4cde-8f01-234567890abc';
const inactive = 'gen_12345678-9abc-4def-8012-3456789abcde';

function directory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  protectNewDataDirectory(path);
}

function flatState(path: string): void {
  directory(path);
  const store = new SqliteStore(join(path, 'state.sqlite'));
  store.close();
}

async function fixture(run: (root: string, managed: string) => Promise<void>): Promise<void> {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-descendant-'));
  let primary: unknown;
  try {
    protectNewDataDirectory(root);
    const managed = join(root, 'managed');
    directory(managed);
    initializeMaintenanceGate(managed);
    await run(root, managed);
  } catch (error) { primary = error; }
  let cleanup: unknown;
  try {
    assert.match(relative(resolve(base), resolve(root)), /^rcac-descendant-[A-Za-z0-9_-]{6}$/);
    rmSync(root, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Descendant test and cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

function assertDescendant(path: string): void {
  assert.throws(() => acquireInstallationRuntime(path), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'INSTALLATION_UNSAFE');
    assert.deepEqual(error.cause, { component: 'installation_runtime', stage: 'managed_descendant' });
    return true;
  });
}

test('active generation data is refused as a managed descendant', async () => {
  await fixture(async (_root, managed) => {
    const generations = join(managed, 'generations');
    directory(generations);
    directory(join(generations, generation));
    const data = join(generations, generation, 'data');
    flatState(data);
    writeFileSync(join(managed, 'managed.json'), '{}');
    assertDescendant(data);
  });
});

test('inactive generation and nested flat directories remain descendants', async () => {
  await fixture(async (_root, managed) => {
    const generations = join(managed, 'generations');
    directory(generations);
    directory(join(generations, inactive));
    const inactiveData = join(generations, inactive, 'data');
    flatState(inactiveData);
    const scratch = join(managed, 'scratch');
    directory(scratch);
    const nested = join(scratch, 'nested');
    flatState(nested);
    assertDescendant(inactiveData);
    assertDescendant(nested);
  });
});

test('a single malformed marker, including a directory, bars flat descendants', async () => {
  await fixture(async (root) => {
    const malformedManifest = join(root, 'malformed-manifest');
    directory(malformedManifest);
    directory(join(malformedManifest, 'managed.json'));
    const underManifest = join(malformedManifest, 'data');
    flatState(underManifest);
    assertDescendant(underManifest);

    const malformedGate = join(root, 'malformed-gate');
    directory(malformedGate);
    writeFileSync(join(malformedGate, 'lifecycle.sqlite'), 'not a gate');
    const underGate = join(malformedGate, 'data');
    flatState(underGate);
    assertDescendant(underGate);
  });
});

test('canonical ancestry catches a real junction alias into managed data', async (t) => {
  await fixture(async (root, managed) => {
    const generations = join(managed, 'generations');
    directory(generations);
    directory(join(generations, generation));
    const data = join(generations, generation, 'data');
    flatState(data);
    const alias = join(root, 'alias');
    try { symlinkSync(data, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
        t.skip(`directory link unsupported: ${String(error.code)}`);
        return;
      }
      throw error;
    }
    assertDescendant(alias);
  });
});

test('an independent flat installation remains admissible', async () => {
  await fixture(async (root) => {
    const independent = join(root, 'independent');
    flatState(independent);
    const runtime = acquireInstallationRuntime(independent);
    try {
      assert.equal(runtime.kind, 'flat');
      assert.equal(runtime.maintenanceEligible, false);
    } finally { runtime.release(); }
  });
});

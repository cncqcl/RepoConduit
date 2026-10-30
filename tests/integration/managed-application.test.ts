import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication, openApplicationWithinInstallation } from '../../src/runtime/application.js';
import { initializeMaintenanceGate, acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { acquireInstallationRuntime, currentInstallationPackageVersion } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const generation = 'gen_01234567-89ab-4cde-8f01-234567890abc';
async function fixture(run: (root: string, data: string, manifest: Record<string, unknown>) => Promise<void>) {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-managed-app-'));
  let primary: unknown;
  try {
    protectNewDataDirectory(root);
    initializeMaintenanceGate(root);
    const directories = [join(root, 'generations'), join(root, 'generations', generation),
      join(root, 'generations', generation, 'data')];
    for (const directory of directories) { mkdirSync(directory, { mode: 0o700 }); protectNewDataDirectory(directory); }
    const data = directories[2]!;
    const store = new SqliteStore(join(data, 'state.sqlite'));
    store.close();
    const manifest = { schemaVersion: 1, activeGeneration: generation,
      packageVersion: currentInstallationPackageVersion(), dataFormatVersion: 1 };
    writeFileSync(join(root, 'managed.json'), JSON.stringify(manifest), { mode: 0o600 });
    await run(root, data, manifest);
  } catch (error) { primary = error; }
  const child = relative(resolve(base), resolve(root));
  assert.ok(child.startsWith('rcac-managed-app-') && !child.includes('..') && !child.includes('\\'));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { if (primary) throw new AggregateError([primary, error], 'Fixture and cleanup failed', { cause: error }); throw error; }
  if (primary) throw primary;
}

test('managed application owns runtime gate until admitted work and stores close', async () => {
  await fixture(async (root, data) => {
    const app = openApplication(root);
    await app.ready;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(done => { release = done; });
    const started = new Promise<void>(done => { entered = done; });
    const request = app.dispatch.dispatch({ principal: 'none', audience: 'local', recipient: 'none',
      surface: 'local_cli', now: new Date(), assertFreshAuthority: async () => { entered(); await paused; } },
    { operation: 'collab.list', scope: { workspaceId: 'none' }, payload: {} });
    const settled = request.catch(() => undefined);
    await started;
    const closing = app.close();
    try {
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
      release();
      await settled;
      await closing;
      const exclusive = acquireExclusiveMaintenanceGate(root);
      exclusive.release();
      const db = new SqliteStore(join(data, 'state.sqlite'));
      db.close();
    } finally { release(); await settled; await app.close(); }
  });
});

test('managed markers and incompatible manifests fail before state mutation without flat fallback', async () => {
  await fixture(async (root, data, manifest) => {
    const stateBefore = readFileSync(join(data, 'state.sqlite'));
    for (const patch of [{ packageVersion: '999.0.0' }, { dataFormatVersion: 2 },
      { activeGeneration: '../data' }, { executable: 'arbitrary' }]) {
      writeFileSync(join(root, 'managed.json'), JSON.stringify({ ...manifest, ...patch }));
      assert.throws(() => acquireInstallationRuntime(root), /INSTALLATION_UNSAFE/);
      assert.deepEqual(readFileSync(join(data, 'state.sqlite')), stateBefore);
      const exclusive = acquireExclusiveMaintenanceGate(root);
      exclusive.release();
    }
    rmSync(join(root, 'managed.json'));
    assert.throws(() => acquireInstallationRuntime(root), /INSTALLATION_UNSAFE/);
  });
});

test('borrowed application cannot release its outer installation owner or accept a forged handle', async () => {
  await fixture(async root => {
    const runtime = acquireInstallationRuntime(root);
    const app = openApplicationWithinInstallation(runtime);
    try { await app.ready; await app.close();
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
      assert.throws(() => openApplicationWithinInstallation({ ...runtime }), /INSTALLATION_UNSAFE/);
    } finally { await app.close(); runtime.release(); }
    runtime.release();
    assert.throws(() => openApplicationWithinInstallation(runtime), /INSTALLATION_UNSAFE/);
    const exclusive = acquireExclusiveMaintenanceGate(root);
    exclusive.release();
  });
});

test('managed startup schema failure closes its database and releases the owned gate', async () => {
  await fixture(async (root, data) => {
    const state = join(data, 'state.sqlite');
    const db = new DatabaseSync(state);
    try {
      db.exec('DROP TABLE collaborations; CREATE TABLE collaborations(id TEXT PRIMARY KEY);');
    } finally { db.close(); }
    assert.throws(() => openApplication(root), /no such column: workspace_id/);
    const exclusive = acquireExclusiveMaintenanceGate(root);
    exclusive.release();
    // On Windows an unclosed SQLite connection prevents renaming its database.
    const renamed = join(data, 'failed-state.sqlite');
    renameSync(state, renamed);
    renameSync(renamed, state);
  });
});

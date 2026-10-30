import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationRuntime, currentInstallationPackageVersion } from '../../src/runtime/installation.js';
import { initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

async function fixture(run: (base: string, retain: () => void) => Promise<void>): Promise<void> {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-managed-init-'));
  let primary: unknown;
  let retained = false;
  try { protectNewDataDirectory(base); await run(base, () => { retained = true; }); }
  catch (error) { primary = error; }
  if (retained) {
    if (primary !== undefined) throw primary;
    throw new Error('Managed init fixture retained after unconfirmed child close');
  }
  let cleanup: unknown;
  try {
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-managed-init-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Init assertion and cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

test('fresh managed init creates the four real stores and publishes manifest last', async () => {
  await fixture(async base => {
    const root = join(base, 'new-installation');
    assert.deepEqual(createManagedInstallation(root),
      { initialized: true, mode: 'managed', schemaVersion: 1, dataFormatVersion: 1 });
    const manifest = JSON.parse(readFileSync(join(root, 'managed.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(manifest).sort(),
      ['activeGeneration', 'dataFormatVersion', 'packageVersion', 'schemaVersion']);
    assert.equal(manifest.packageVersion, currentInstallationPackageVersion());
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.dataFormatVersion, 1);
    const data = join(root, 'generations', String(manifest.activeGeneration), 'data');
    assert.equal(existsSync(join(root, 'state.sqlite')), false);
    assert.equal(existsSync(join(root, 'package')), false);
    assert.equal(existsSync(join(root, 'backups')), false);
    const state = join(data, 'state.sqlite');
    const db = new DatabaseSync(state, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('grants', 'context_revisions', 'session_control', 'investigation_requests') ORDER BY name")
        .all() as { name: string }[];
      assert.deepEqual(tables.map(row => row.name),
        ['context_revisions', 'grants', 'investigation_requests', 'session_control']);
      const grants = db.prepare('SELECT id, audience, workspace_id, permissions_json FROM grants').all() as
        { id: string; audience: string; workspace_id: string; permissions_json: string }[];
      assert.equal(grants.length, 1);
      assert.match(grants[0]!.id, /^gr_[0-9a-f-]{36}$/);
      assert.equal(grants[0]!.audience, 'local-os');
      assert.equal(grants[0]!.workspace_id, 'management');
      assert.deepEqual(JSON.parse(grants[0]!.permissions_json),
        ['admin.workspace', 'admin.grant', 'admin.revoke', 'admin.profile']);
    } finally { db.close(); }
    const runtime = acquireInstallationRuntime(root);
    try { assert.equal(runtime.kind, 'managed'); assert.equal(runtime.dataDirectory, data); }
    finally { runtime.release(); }
  });
});

test('repeat, flat and partial destinations remain byte-for-byte unchanged', async () => {
  await fixture(async base => {
    const managed = join(base, 'managed');
    createManagedInstallation(managed);
    const manifest = join(managed, 'managed.json');
    const priorManifest = readFileSync(manifest);
    assert.throws(() => createManagedInstallation(managed), /INSTALLATION_UNSAFE/);
    assert.deepEqual(readFileSync(manifest), priorManifest);

    const flat = join(base, 'flat');
    mkdirSync(flat, { mode: 0o700 });
    protectNewDataDirectory(flat);
    const flatState = join(flat, 'state.sqlite');
    const db = new SqliteStore(flatState);
    db.close();
    const priorFlat = readFileSync(flatState);
    assert.throws(() => createManagedInstallation(flat), /INSTALLATION_UNSAFE/);
    assert.deepEqual(readFileSync(flatState), priorFlat);
    assert.equal(existsSync(join(flat, 'lifecycle.sqlite')), false);

    const partial = join(base, 'partial');
    mkdirSync(partial, { mode: 0o700 });
    protectNewDataDirectory(partial);
    const sentinel = join(partial, 'sentinel');
    writeFileSync(sentinel, 'partial-data');
    assert.throws(() => createManagedInstallation(partial), /INSTALLATION_UNSAFE/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'partial-data');
    assert.equal(existsSync(join(partial, 'lifecycle.sqlite')), false);
  });
});

test('managed lexical and canonical parent chains refuse a new child before mkdir', async (t) => {
  await fixture(async base => {
    const managed = join(base, 'managed');
    mkdirSync(managed, { mode: 0o700 });
    protectNewDataDirectory(managed);
    initializeMaintenanceGate(managed);
    const direct = join(managed, 'child');
    assert.throws(() => createManagedInstallation(direct), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'INSTALLATION_UNSAFE');
      assert.deepEqual(error.cause, { component: 'installation_runtime', stage: 'managed_descendant' });
      return true;
    });
    assert.equal(existsSync(direct), false);

    const alias = join(base, 'alias');
    try { symlinkSync(managed, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
        t.skip(`directory link unsupported: ${String(error.code)}`);
        return;
      }
      throw error;
    }
    assert.throws(() => createManagedInstallation(join(alias, 'child')), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'INSTALLATION_UNSAFE');
      assert.deepEqual(error.cause, { component: 'installation_runtime', stage: 'managed_descendant' });
      return true;
    });
    assert.equal(existsSync(direct), false);
  });
});

test('malformed single ancestor marker and missing parent refuse initialization', async () => {
  await fixture(async base => {
    const malformed = join(base, 'malformed');
    mkdirSync(malformed, { mode: 0o700 });
    protectNewDataDirectory(malformed);
    mkdirSync(join(malformed, 'managed.json'));
    assert.throws(() => createManagedInstallation(join(malformed, 'new')), /INSTALLATION_UNSAFE/);
    assert.equal(existsSync(join(malformed, 'new')), false);
    const missingParent = join(base, 'missing-parent', 'child');
    assert.throws(() => createManagedInstallation(missingParent), /INSTALLATION_UNSAFE/);
    assert.equal(existsSync(join(base, 'missing-parent')), false);
  });
});

test('owned source CLI interrupted after gate creation leaves partial bytes and rejects retry', { timeout: 40_000 }, async () => {
  await fixture(async (base, retain) => {
    const root = join(base, 'interrupted');
    const args = ['--import', 'tsx', 'src/cli/main.ts', '--data-dir', root, 'init-managed'];
    const child = spawn(process.execPath, args, { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClosed => {
      child.once('close', (code, signal) => resolveClosed({ code, signal }));
    });
    let spawnError: unknown;
    child.once('error', error => { spawnError = error; });
    let primary: unknown;
    const gateFile = join(root, 'lifecycle.sqlite');
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(gateFile) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await delay(10);
      }
      assert.equal(spawnError, undefined);
      assert.equal(existsSync(gateFile), true, 'CLI exited or timed out before gate creation');
      assert.equal(existsSync(join(root, 'managed.json')), false, 'CLI reached publication before interruption');
      assert.equal(child.kill(), true, 'owned child already exited before interruption');
    } catch (error) { primary = error; }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      terminal = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('init child close unconfirmed')), 5_000);
      })]);
    } catch (error) {
      retain();
      child.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      primary = primary === undefined ? error : new AggregateError([primary, error], 'Init interruption and child close failed');
    } finally { if (timeout) clearTimeout(timeout); }
    if (primary !== undefined) throw primary;
    assert.ok(terminal);
    assert.notEqual(terminal.code, 0);
    assert.equal(existsSync(join(root, 'managed.json')), false);
    const before = readFileSync(gateFile);
    const retry = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8', timeout: 20_000 });
    assert.equal(retry.error, undefined);
    assert.notEqual(retry.status, 0);
    assert.deepEqual(readFileSync(gateFile), before);
    assert.equal(existsSync(join(root, 'managed.json')), false);
  });
});

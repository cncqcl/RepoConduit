import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance, acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { backupInstallation, restoreInstallation } from '../../src/runtime/installation-backup.js';
import { acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

function releaseConfirmed(owner: { release(): void }): void {
  try { owner.release(); }
  catch (error) { throw new AggregateError([error], 'Fault fixture lease close unconfirmed', { cause: error }); }
}

test('real restore process interrupted before publication preserves partial output and refuses retry', { timeout: 90_000 }, async () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-restore-fault-'));
  let primary: unknown;
  let retained = false;
  try {
    protectNewDataDirectory(base);
    const source = join(base, 'source');
    createManagedInstallation(source);
    const runtime = acquireInstallationRuntime(source);
    try { writeFileSync(join(runtime.dataDirectory, 'original.lock'), Buffer.from([0, 255, 128])); }
    finally { releaseConfirmed(runtime); }
    const backup = join(base, 'backup');
    await backupInstallation(source, backup);
    const backupManifest = readFileSync(join(backup, 'backup.json'));
    const restored = join(base, 'interrupted');
    const code = `import { restoreInstallation } from './src/runtime/installation-backup.ts'; await restoreInstallation(process.argv[1], process.argv[2]);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, backup, restored],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClosed => {
      child.once('close', (code, signal) => resolveClosed({ code, signal }));
    });
    let spawnError: unknown;
    child.once('error', error => { spawnError = error; });
    let interruption: unknown;
    try {
      const deadline = Date.now() + 40_000;
      while (!existsSync(join(restored, 'generations')) && child.exitCode === null &&
          child.signalCode === null && Date.now() < deadline) await delay(5);
      assert.equal(spawnError, undefined);
      assert.equal(existsSync(join(restored, 'generations')), true, 'product did not reach owned generation creation');
      assert.equal(existsSync(join(restored, 'managed.json')), false, 'publication happened before interruption');
      assert.equal(child.kill(), true);
    } catch (error) { interruption = error; }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timer: NodeJS.Timeout | undefined;
    let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      terminal = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned restore child close unconfirmed')), 5_000);
      })]);
    } catch (error) {
      retained = true;
      child.unref(); child.stdout?.destroy(); child.stderr?.destroy();
      interruption = interruption === undefined ? error : new AggregateError([interruption, error], 'Restore interruption and close failed');
    } finally { if (timer) clearTimeout(timer); }
    if (interruption !== undefined) throw interruption;
    assert.ok(terminal);
    assert.notEqual(terminal.code, 0);
    assert.equal(existsSync(join(restored, 'managed.json')), false);
    assert.throws(() => acquireInstallationRuntime(restored));
    // Confirm actual child termination released its SQLite lock before inspecting/retrying.
    releaseConfirmed(acquireExclusiveMaintenanceGate(restored));
    const gateBytes = readFileSync(join(restored, 'lifecycle.sqlite'));
    await assert.rejects(restoreInstallation(backup, restored), /INSTALLATION_UNSAFE/);
    assert.deepEqual(readFileSync(join(restored, 'lifecycle.sqlite')), gateBytes);
    assert.deepEqual(readFileSync(join(backup, 'backup.json')), backupManifest);
    assert.equal(existsSync(join(restored, 'managed.json')), false);
    releaseConfirmed(acquireInstallationMaintenance(source));
  } catch (error) { primary = error; }
  if (primary instanceof AggregateError) retained = true;
  if (!retained) {
    try {
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-restore-fault-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    } catch (error) { primary = primary === undefined ? error : new AggregateError([primary, error], 'Restore fault fixture cleanup failed'); }
  }
  if (primary !== undefined) throw primary;
  if (retained) throw new Error('Restore fault fixture retained after uncertain resource closure');
});

test('restore refuses a destination parent alias into its completed backup before modifying source', async () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-restore-alias-'));
  let primary: unknown;
  try {
    protectNewDataDirectory(base);
    const source = join(base, 'source'); createManagedInstallation(source);
    const backup = join(base, 'backup'); await backupInstallation(source, backup);
    const manifest = readFileSync(join(backup, 'backup.json'));
    const state = readFileSync(join(backup, 'data', 'state.sqlite'));
    const alias = join(base, 'alias');
    symlinkSync(join(backup, 'data'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const target = join(alias, 'forbidden-child');
    await assert.rejects(restoreInstallation(backup, target));
    assert.equal(existsSync(join(backup, 'data', 'forbidden-child')), false,
      'restore changed completed backup before rejecting aliased destination');
    assert.deepEqual(readFileSync(join(backup, 'backup.json')), manifest);
    assert.deepEqual(readFileSync(join(backup, 'data', 'state.sqlite')), state);
    releaseConfirmed(acquireInstallationMaintenance(source));
  } catch (error) { primary = error; }
  if (!(primary instanceof AggregateError)) {
    try {
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-restore-alias-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    } catch (error) { primary = primary === undefined ? error : new AggregateError([primary, error], 'Alias fixture cleanup failed'); }
  }
  if (primary !== undefined) throw primary;
});

test('backup rejects linked invalid database before SQLite can parse its body', async () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-backup-link-'));
  let primary: unknown;
  let state: string | undefined;
  let moved: string | undefined;
  try {
    protectNewDataDirectory(base);
    const source = join(base, 'source'); createManagedInstallation(source);
    const runtime = acquireInstallationRuntime(source);
    try { state = join(runtime.dataDirectory, 'state.sqlite'); }
    finally { releaseConfirmed(runtime); }
    moved = join(base, 'original.sqlite'); renameSync(state, moved);
    const external = join(base, 'not-a-database');
    const sentinel = Buffer.from('This is a protected non-database sentinel.');
    writeFileSync(external, sentinel);
    linkSync(external, state);
    const destination = join(base, 'backup');
    await assert.rejects(backupInstallation(source, destination), /INSTALLATION_DATA_UNSAFE/);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readFileSync(external), sentinel);
    rmSync(state); renameSync(moved, state); moved = undefined;
    releaseConfirmed(acquireInstallationMaintenance(source));
  } catch (error) { primary = error; }
  if (!(primary instanceof AggregateError)) {
    try {
      if (moved && state) { rmSync(state, { force: true }); renameSync(moved, state); }
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-backup-link-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    } catch (error) { primary = primary === undefined ? error : new AggregateError([primary, error], 'Database link fixture cleanup failed'); }
  }
  if (primary !== undefined) throw primary;
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createManagedInstallation } from '../../src/cli/install.js';
import { assertFreshInactiveGenerationDestination, backupInstallationWithinMaintenance, copyInstallationBackupIntoGeneration,
  inspectInstallationGenerationWithinMaintenance } from '../../src/runtime/installation-backup.js';
import { acquireInstallationMaintenance, retainInstallationMaintenance } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';

function expectRefusal(action: () => unknown): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  if (caught instanceof AggregateError) throw caught;
  assert.ok(caught instanceof Error, 'Unsafe candidate copy unexpectedly succeeded');
}

test('owned upgrade copy preserves old active generation and grants without publishing or reseeding', async () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-upgrade-copy-'));
  let failure: unknown;
  try {
    protectNewDataDirectory(base);
    const root = join(base, 'source'); createManagedInstallation(root);
    const manifest = readFileSync(join(root, 'managed.json'));
    const owner = acquireInstallationMaintenance(root);
    let primary: unknown;
    try {
      const backup = join(base, 'backup');
      await backupInstallationWithinMaintenance(owner, backup);
      const generation = 'gen_11111111-2222-3333-4444-555555555555';
      const candidate = join(root, 'generations', generation);
      assert.equal(assertFreshInactiveGenerationDestination(owner, generation), candidate);
      mkdirSync(candidate); protectNewDataDirectory(candidate);
      expectRefusal(() => assertFreshInactiveGenerationDestination(owner, generation));
      const copied = copyInstallationBackupIntoGeneration(owner, backup, generation);
      const db = new DatabaseSync(join(copied.dataDirectory, 'state.sqlite'), { readOnly: true });
      const old = new DatabaseSync(join(owner.dataDirectory, 'state.sqlite'), { readOnly: true });
      let checkError: unknown;
      try {
        assert.deepEqual(db.prepare('SELECT * FROM grants').all(), old.prepare('SELECT * FROM grants').all());
        assert.equal(db.prepare('SELECT count(*) AS count FROM grants').get()!.count, 1);
      } catch (error) { checkError = error; }
      const errors: unknown[] = [];
      try { db.close(); } catch (error) { errors.push(error); }
      try { old.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(checkError === undefined ? errors : [checkError, ...errors],
        'Copy fixture database close unconfirmed', { cause: errors[0] });
      if (checkError !== undefined) throw checkError;
      const state = join(copied.dataDirectory, 'state.sqlite');
      const writer = new DatabaseSync(state);
      let modeError: unknown;
      try { assert.equal(writer.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode, 'wal'); }
      catch (error) { modeError = error; }
      try { writer.close(); } catch (error) {
        throw new AggregateError(modeError === undefined ? [error] : [modeError, error], 'WAL fixture close unconfirmed', { cause: error });
      }
      if (modeError !== undefined) throw modeError;
      assert.equal(existsSync(`${state}-wal`), false);
      assert.equal(existsSync(`${state}-shm`), false);
      const quietBytes = readFileSync(state);
      inspectInstallationGenerationWithinMaintenance(owner, generation);
      assert.equal(existsSync(`${state}-wal`), false, 'Final candidate inspection must not create WAL');
      assert.equal(existsSync(`${state}-shm`), false, 'Final candidate inspection must not create SHM');
      assert.deepEqual(readFileSync(state), quietBytes);
      const syntheticWal = Buffer.from('owned synthetic WAL refusal marker');
      writeFileSync(`${state}-wal`, syntheticWal);
      expectRefusal(() => inspectInstallationGenerationWithinMaintenance(owner, generation));
      assert.deepEqual(readFileSync(`${state}-wal`), syntheticWal, 'Rejected sidecar must be preserved');
      assert.deepEqual(readFileSync(state), quietBytes);
      assert.deepEqual(readFileSync(join(root, 'managed.json')), manifest);
      expectRefusal(() => copyInstallationBackupIntoGeneration(owner, backup, generation));
      const active = JSON.parse(manifest.toString('utf8')) as { activeGeneration: string };
      expectRefusal(() => copyInstallationBackupIntoGeneration(owner, backup, active.activeGeneration));
      expectRefusal(() => copyInstallationBackupIntoGeneration({} as typeof owner, backup, generation));
    } catch (error) { primary = error; }
    if (primary instanceof AggregateError) { retainInstallationMaintenance(owner); throw primary; }
    try { owner.release(); }
    catch (error) {
      retainInstallationMaintenance(owner);
      throw new AggregateError(primary === undefined ? [error] : [primary, error], 'Copy fixture close unconfirmed', { cause: error });
    }
    if (primary !== undefined) throw primary;
  } catch (error) { failure = error; }
  if (failure !== undefined) throw failure; // retain failed or uncertain fixture
  assert.match(relative(resolve(parent), resolve(base)), /^rcac-upgrade-copy-[A-Za-z0-9_-]{6}$/);
  rmSync(base, { recursive: true, force: true });
});

test('candidate path excludes registered source roots before creating any generation', () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-upgrade-copy-'));
  protectNewDataDirectory(base);
  const root = join(base, 'source'); createManagedInstallation(root);
  const owner = acquireInstallationMaintenance(root);
  let primary: unknown;
  try {
    const store = new SqliteStore(join(owner.dataDirectory, 'state.sqlite'));
    let setup: unknown;
    try { store.insertWorkspace({ id: 'ws-overlap', name: 'source root', canonicalRoot: root, registeredBy: 'owner' }); }
    catch (error) { setup = error; }
    try { store.close(); } catch (error) {
      throw new AggregateError(setup === undefined ? [error] : [setup, error], 'Fixture close unconfirmed', { cause: error });
    }
    if (setup !== undefined) throw setup;
    const generation = 'gen_11111111-2222-3333-4444-555555555555';
    expectRefusal(() => assertFreshInactiveGenerationDestination(owner, generation));
    assert.equal(existsSync(join(root, 'generations', generation)), false);
  } catch (error) { primary = error; }
  if (primary instanceof AggregateError) { retainInstallationMaintenance(owner); throw primary; }
  try { owner.release(); } catch (error) {
    retainInstallationMaintenance(owner);
    throw new AggregateError(primary === undefined ? [error] : [primary, error], 'Fixture owner close unconfirmed', { cause: error });
  }
  if (primary !== undefined) throw primary;
  assert.match(relative(resolve(parent), resolve(base)), /^rcac-upgrade-copy-[A-Za-z0-9_-]{6}$/);
  rmSync(base, { recursive: true, force: true });
});

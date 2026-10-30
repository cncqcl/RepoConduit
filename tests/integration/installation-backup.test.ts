import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance, acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { backupInstallation, restoreInstallation } from '../../src/runtime/installation-backup.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('actual managed backup restores original grants and binary files into a fresh generation without reseeding', async () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-backup-restore-'));
  let primary: unknown;
  try {
    protectNewDataDirectory(base);
    const root = join(base, 'source');
    createManagedInstallation(root);
    const runtime = acquireInstallationRuntime(root);
    let grantId: string;
    try {
      mkdirSync(join(runtime.dataDirectory, 'empty'));
      writeFileSync(join(runtime.dataDirectory, 'ordinary.lock'), Buffer.from([0, 255, 128, 13, 10]));
      const db = new DatabaseSync(join(runtime.dataDirectory, 'state.sqlite'), { readOnly: true });
      try { grantId = String(db.prepare('SELECT id FROM grants').get()!.id); }
      finally { db.close(); }
      await assert.rejects(backupInstallation(root, join(base, 'busy')), /MAINTENANCE_GATE_BUSY/);
    } finally { runtime.release(); }
    const destination = join(base, 'backup');
    const backed = await backupInstallation(root, destination);
    assert.equal(backed.completed, true);
    assert.equal(existsSync(join(destination, 'backup.json')), true);
    await assert.rejects(backupInstallation(root, destination));
    const restored = join(base, 'restored');
    assert.equal((await restoreInstallation(destination, restored)).restored, true);
    const next = acquireInstallationRuntime(restored);
    try {
      assert.deepEqual(readFileSync(join(next.dataDirectory, 'ordinary.lock')), Buffer.from([0, 255, 128, 13, 10]));
      assert.equal(existsSync(join(next.dataDirectory, 'empty')), true);
      const db = new DatabaseSync(join(next.dataDirectory, 'state.sqlite'), { readOnly: true });
      try {
        const rows = db.prepare('SELECT id FROM grants').all();
        assert.deepEqual(rows.map(row => row.id), [grantId!]);
        assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      } finally { db.close(); }
    } finally { next.release(); }
    await assert.rejects(restoreInstallation(destination, restored));
    // Completed backups must still reject altered bytes and undeclared SQLite sidecars.
    const ordinary = join(destination, 'data', 'ordinary.lock');
    const originalBytes = readFileSync(ordinary);
    writeFileSync(ordinary, Buffer.from([1, 255, 128, 13, 10]));
    const corruptedTarget = join(base, 'corrupted-target');
    await assert.rejects(restoreInstallation(destination, corruptedTarget), /INSTALLATION_BACKUP_UNSAFE/);
    assert.equal(existsSync(corruptedTarget), false);
    writeFileSync(ordinary, originalBytes);
    const sidecar = join(destination, 'data', 'state.sqlite-wal');
    writeFileSync(sidecar, 'undeclared sidecar');
    const sidecarTarget = join(base, 'sidecar-target');
    await assert.rejects(restoreInstallation(destination, sidecarTarget), /INSTALLATION_BACKUP_UNSAFE/);
    assert.equal(existsSync(sidecarTarget), false);
    rmSync(sidecar);
    const manifestPath = join(destination, 'backup.json');
    const originalManifest = readFileSync(manifestPath);
    const invalidManifest = JSON.parse(originalManifest.toString('utf8')) as { entries: { path: string }[] };
    invalidManifest.entries[0]!.path = '../outside';
    writeFileSync(manifestPath, JSON.stringify(invalidManifest));
    const traversalTarget = join(base, 'traversal-target');
    await assert.rejects(restoreInstallation(destination, traversalTarget));
    assert.equal(existsSync(traversalTarget), false);
    writeFileSync(manifestPath, originalManifest);
    const incomplete = join(base, 'incomplete');
    mkdirSync(incomplete);
    await assert.rejects(restoreInstallation(incomplete, join(base, 'forbidden')));
    assert.equal(existsSync(join(base, 'forbidden')), false);
  } catch (error) { primary = error; }
  // Preserve failed fixtures, including ordinary native close/release errors.
  if (primary !== undefined) throw primary;
  let cleanup: unknown;
  try {
    for (const name of ['source', 'restored']) {
      const installation = join(base, name);
      if (existsSync(join(installation, 'managed.json'))) acquireInstallationMaintenance(installation).release();
    }
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-backup-restore-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (cleanup !== undefined) throw cleanup;
});

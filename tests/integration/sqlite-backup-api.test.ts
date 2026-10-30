import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('actual installed SQLite backup includes committed WAL data and binary bytes', async () => {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(parent, 'rcac-backup-api-'));
  let source: DatabaseSync | undefined;
  let target: DatabaseSync | undefined;
  let rawMain: DatabaseSync | undefined;
  let primary: unknown;
  try {
    protectNewDataDirectory(root);
    const sourcePath = join(root, 'source.sqlite');
    const targetPath = join(root, 'backup.sqlite');
    source = new DatabaseSync(sourcePath);
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)');
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = Buffer.from([0, 255, 13, 10, 128, 1]);
    source.prepare('INSERT INTO payload VALUES (?, ?)').run(1, bytes);
    assert.equal(existsSync(`${sourcePath}-wal`), true);
    // Observe the raw main-file control before using the logical backup API.
    const rawPath = join(root, 'raw-main.sqlite');
    copyFileSync(sourcePath, rawPath);
    rawMain = new DatabaseSync(rawPath, { readOnly: true });
    assert.equal(rawMain.prepare('SELECT COUNT(*) AS count FROM payload').get()?.count, 0);
    assert.equal(existsSync(targetPath), false);
    const pages = await backup(source, targetPath, { rate: 1 });
    assert.ok(pages > 0);
    target = new DatabaseSync(targetPath, { readOnly: true });
    assert.equal(target.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const row = target.prepare('SELECT bytes FROM payload WHERE id = 1').get();
    assert.ok(row);
    assert.deepEqual(Buffer.from(row.bytes as Uint8Array), bytes);
  } catch (error) { primary = error; }
  const failures: unknown[] = [];
  for (const db of [rawMain, target, source]) {
    try { db?.close(); } catch (error) { failures.push(error); }
  }
  // Unconfirmed database close retains the owned fixture instead of deleting it.
  if (failures.length === 0) {
    try {
      assert.match(relative(resolve(parent), resolve(root)), /^rcac-backup-api-[A-Za-z0-9_-]{6}$/);
      rmSync(root, { recursive: true, force: true });
    } catch (error) { failures.push(error); }
  }
  if (primary !== undefined) failures.unshift(primary);
  if (failures.length > 1) throw new AggregateError(failures, 'SQLite backup API verification or cleanup failed');
  if (failures.length === 1) throw failures[0];
});

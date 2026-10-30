import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';

for (const { name, seedSql, failure, open } of [
  { name: 'SqliteStore', seedSql: 'CREATE VIEW workspaces AS SELECT 1 AS invalid_schema',
    failure: /foreign key mismatch/, open: (file: string) => new SqliteStore(file) },
  { name: 'ContextDecisionSqlite',
    seedSql: 'CREATE TABLE blocker(id INTEGER); CREATE INDEX context_proposals ON blocker(id)',
    failure: /already exists|index named context_proposals/,
    open: (file: string) => new ContextDecisionSqlite(file) },
  { name: 'SqliteInvestigationStore', seedSql: 'CREATE VIEW investigation_requests AS SELECT 1 AS invalid_schema',
    failure: /Unsupported investigation schema/,
    open: (file: string) => new SqliteInvestigationStore(file) },
  { name: 'SessionControlSqlite', seedSql: 'CREATE VIEW session_control AS SELECT 1 AS invalid_schema',
    failure: /views may not be indexed/,
    open: (file: string) => new SessionControlSqlite(file) },
]) {
  test(`${name} closes its opened SQLite connection after malformed schema rejects construction`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-constructor-cleanup-'));
    const file = join(dir, 'state.sqlite');
    const moved = join(dir, 'moved.sqlite');
    let safeToRemove = false;
    try {
      const seed = new DatabaseSync(file);
      try { seed.exec(seedSql); }
      finally { seed.close(); }
      assert.throws(() => open(file), failure);
      // On Windows an open SQLite handle refuses this move; do not depend on GC.
      renameSync(file, moved);
      const reopened = new DatabaseSync(moved);
      try { reopened.exec('BEGIN EXCLUSIVE; ROLLBACK;'); }
      finally { reopened.close(); }
      safeToRemove = true;
    } finally {
      if (safeToRemove) {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
        assert.match(basename(dir), /^rcac-constructor-cleanup-[A-Za-z0-9_-]{6}$/);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

for (const { name, open } of [
  { name: 'SqliteStore', open: (file: string) => new SqliteStore(file) },
  { name: 'ContextDecisionSqlite', open: (file: string) => new ContextDecisionSqlite(file) },
  { name: 'SqliteInvestigationStore', open: (file: string) => new SqliteInvestigationStore(file) },
  { name: 'SessionControlSqlite', open: (file: string) => new SessionControlSqlite(file) },
]) {
  test(`${name} closes its opened SQLite connection after early invalid database rejection`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-constructor-cleanup-'));
    const file = join(dir, 'state.sqlite');
    const moved = join(dir, 'moved.sqlite');
    let safeToRemove = false;
    try {
      writeFileSync(file, Buffer.alloc(128, 0x58));
      assert.throws(() => open(file), /file is not a database/);
      renameSync(file, moved);
      const reopened = new DatabaseSync(moved);
      try { assert.throws(() => reopened.exec('BEGIN EXCLUSIVE'), /file is not a database/); }
      finally { reopened.close(); }
      safeToRemove = true;
    } finally {
      if (safeToRemove) {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
        assert.match(basename(dir), /^rcac-constructor-cleanup-[A-Za-z0-9_-]{6}$/);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

test('constructor preserves initialization and close failures behind a fixed public message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-constructor-cleanup-'));
  const file = join(dir, 'state.sqlite');
  const moved = join(dir, 'moved.sqlite');
  const nativeClose = DatabaseSync.prototype.close;
  const closeFault = new Error('synthetic close fault');
  let safeToRemove = false;
  try {
    writeFileSync(file, Buffer.alloc(128, 0x58));
    DatabaseSync.prototype.close = function(this: DatabaseSync) {
      nativeClose.call(this);
      throw closeFault;
    };
    assert.throws(() => new ContextDecisionSqlite(file), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'SQLite constructor cleanup uncertain');
      assert.match((error.errors[0] as Error).message, /file is not a database/);
      assert.strictEqual(error.errors[1], closeFault);
      assert.strictEqual(error.cause, closeFault);
      return true;
    });
    DatabaseSync.prototype.close = nativeClose;
    renameSync(file, moved);
    safeToRemove = true;
  } finally {
    DatabaseSync.prototype.close = nativeClose;
    if (safeToRemove) {
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      assert.match(basename(dir), /^rcac-constructor-cleanup-[A-Za-z0-9_-]{6}$/);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

for (const { name, seedSql, initialFailure } of [
  { name: 'first', seedSql: `CREATE TABLE bundles (
      id TEXT PRIMARY KEY, workspace_id TEXT, collaboration_id TEXT)`,
    initialFailure: /no such column: manifest_json/i },
  { name: 'second', seedSql: 'CREATE VIEW workspaces AS SELECT 1 AS invalid_schema',
    initialFailure: /foreign key mismatch/i },
]) {
  test(`SqliteStore ${name} constructor migration preserves the initial error when rollback fails`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-constructor-cleanup-'));
    const file = join(dir, 'state.sqlite');
    const moved = join(dir, 'moved.sqlite');
    const nativeExec = DatabaseSync.prototype.exec;
    const rollbackFault = new Error('synthetic rollback fault');
    let safeToRemove = false;
    try {
      const seed = new DatabaseSync(file);
      try { seed.exec(seedSql); }
      finally { seed.close(); }
      DatabaseSync.prototype.exec = function(this: DatabaseSync, sql: string) {
        if (sql === 'ROLLBACK') {
          nativeExec.call(this, sql);
          throw rollbackFault;
        }
        return nativeExec.call(this, sql);
      };
      assert.throws(() => new SqliteStore(file), (error: unknown) => {
        assert.ok(error instanceof AggregateError, String(error));
        assert.equal(error.message, 'SQLite constructor rollback failed');
        assert.match((error.errors[0] as Error).message, initialFailure);
        assert.strictEqual(error.errors[1], rollbackFault);
        assert.strictEqual(error.cause, rollbackFault);
        return true;
      });
      DatabaseSync.prototype.exec = nativeExec;
      renameSync(file, moved);
      safeToRemove = true;
    } finally {
      DatabaseSync.prototype.exec = nativeExec;
      if (safeToRemove) {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
        assert.match(basename(dir), /^rcac-constructor-cleanup-[A-Za-z0-9_-]{6}$/);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

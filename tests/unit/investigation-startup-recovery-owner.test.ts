import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { startInvestigationRecovery } from '../../src/runtime/investigation-recovery.js';

type Store = Parameters<typeof startInvestigationRecovery>[0];

function fixture(t: TestContext, nonempty = false) {
  const events: string[] = [];
  let tick: (() => void) | undefined;
  let timers = 0;
  t.mock.method(globalThis, 'setInterval', ((callback: () => void) => {
    tick = callback;
    timers++;
    return { unref() {} };
  }) as unknown as typeof setInterval);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const store = {
    recoverStartupAttempts() { events.push('startup'); },
    recoverCodexOwnedSessions() { events.push('codex'); },
    recoverExpiredGenericAttempts() { events.push('generic'); },
    listUnsettled() { return nonempty ? [{}] : []; },
    settleExpiredUnreservedAttempt() { events.push('settle'); return true; },
  } as unknown as Store;
  return { store, events, timerCount: () => timers, tick: () => { assert.ok(tick); tick(); } };
}

test('startup recovery runs even with no claims before creating its periodic timer', async t => {
  const f = fixture(t);
  const recovery = startInvestigationRecovery(f.store);
  try {
    await recovery.ready;
    assert.deepEqual(f.events, ['startup']);
    assert.equal(f.timerCount(), 1);
  } finally { await recovery.close(); }
});

test('initial cleanup does not repeat startup reconciliation; periodic cleanup retains both ordinary recoveries', async t => {
  const f = fixture(t, true);
  const recovery = startInvestigationRecovery(f.store);
  try {
    await recovery.ready;
    assert.deepEqual(f.events, ['startup', 'settle']);
    f.tick();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(f.events, ['startup', 'settle', 'codex', 'generic', 'settle']);
  } finally { await recovery.close(); }
});

test('startup recovery failure propagates before creating a timer or admitting cleanup', t => {
  const f = fixture(t, true);
  const failure = new Error('startup recovery failed');
  (f.store as Store & { recoverStartupAttempts(): void }).recoverStartupAttempts = () => { throw failure; };
  assert.throws(() => startInvestigationRecovery(f.store), error => error === failure);
  assert.equal(f.timerCount(), 0);
  assert.deepEqual(f.events, []);
});

for (const fault of ['primary', 'restore', 'both'] as const) {
  test(`startup recovery preserves ${fault} failure without swallowing restoration errors`, t => {
    const root = mkdtempSync(join(tmpdir(), 'rcac-recovery-restore-'));
    const file = join(root, 'state.sqlite');
    new SqliteStore(file).close();
    const store = new SqliteInvestigationStore(file);
    const db = (store as unknown as { db: DatabaseSync }).db;
    const originalExec = db.exec.bind(db);
    const primary = new Error('synthetic recovery failure');
    const restore = new Error('synthetic timeout restoration failure');
    const undo: Array<() => void> = [];
    let failure: unknown;
    let cleanupFailure: unknown;
    try {
      if (fault !== 'restore') {
        const mocked = t.mock.method(store, 'recoverCodexOwnedSessions', () => { throw primary; });
        undo.push(() => mocked.mock.restore());
      }
      if (fault !== 'primary') {
        const mocked = t.mock.method(db, 'exec', (sql: string) => {
          if (sql === 'PRAGMA busy_timeout=0') throw restore;
          return originalExec(sql);
        });
        undo.push(() => mocked.mock.restore());
      }
      assert.throws(() => store.recoverStartupAttempts(), error => {
        if (fault === 'primary') return error === primary;
        if (fault === 'restore') return error === restore;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], primary);
        assert.equal(error.errors[1], restore);
        assert.equal(error.cause, restore);
        return true;
      });
      if (fault === 'primary') {
        assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 0);
      }
    } catch (error) { failure = error; }
    try {
      for (const restoreMock of undo.reverse()) restoreMock();
      originalExec('PRAGMA busy_timeout=0');
      store.close();
    } catch (error) { cleanupFailure = error; }
    if (failure === undefined && cleanupFailure === undefined) rmSync(root, { recursive: true, force: true });
    else console.error('retained-startup-restoration-fixture', root);
    if (failure !== undefined && cleanupFailure !== undefined)
      throw new AggregateError([failure, cleanupFailure], 'Startup restoration assertion and cleanup failed');
    if (failure !== undefined) throw failure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  });
}

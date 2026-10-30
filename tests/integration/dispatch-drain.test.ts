import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { DispatchService } from '../../src/application/dispatch.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function finishFixture(store: SqliteStore, dir: string, prefix: string, primary: unknown): void {
  let cleanup: unknown;
  try { store.close(); } catch (error) { cleanup = error; }
  if (cleanup === undefined) {
    try {
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      assert.match(basename(dir), new RegExp(`^${prefix}[A-Za-z0-9_-]{6}$`));
      rmSync(dir, { recursive: true, force: true });
    } catch (error) { cleanup = error; }
  }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup],
    'Dispatch assertion and fixture cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

test('drain rejects new requests immediately and waits for two admitted dispatches through disclosure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-drain-'));
  const store = new SqliteStore(join(dir, 'state.sqlite'));
  const entryGate = deferred(), disclosureGate = deferred();
  const pending: Promise<unknown>[] = [];
  let primary: unknown;
  try {
    const scope = { workspaceId: 'workspace-a' };
    store.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    store.insertGrant({ id: 'grant-a', principal: 'owner', audience: 'host', recipient: 'owner',
      workspaceId: scope.workspaceId, permissions: ['collab.read'], expiresAt: null, revokedAt: null });
    let grantReads = 0, rejectedGrantReads = 0;
    const dispatch = new DispatchService(store, (context) => {
      grantReads++;
      if (context.principal === 'rejected') rejectedGrantReads++;
      return store.grantsFor(context.principal, context.audience);
    });
    let firstChecks = 0, secondChecks = 0, rejectedChecks = 0;
    const base = { principal: 'owner', audience: 'host', recipient: 'owner',
      surface: 'local_host' as const, now: new Date() };
    const command = { operation: 'collab.list', scope, payload: {} };
    const first = dispatch.dispatch({ ...base, assertFreshAuthority: async () => {
      firstChecks++;
      if (firstChecks === 1) await entryGate.promise;
    } }, command);
    const second = dispatch.dispatch({ ...base, assertFreshAuthority: async () => {
      secondChecks++;
      if (secondChecks === 2) {
        await disclosureGate.promise;
        throw new Error('disclosure refused');
      }
    } }, command);
    pending.push(first, second);
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    let drainSettled = false;
    const drained = dispatch.drain().then(() => { drainSettled = true; });
    assert.strictEqual(dispatch.drain(), dispatch.drain());
    await assert.rejects(dispatch.dispatch({ ...base, principal: 'rejected', assertFreshAuthority: async () => {
      rejectedChecks++;
    } }, command), (error: { code?: string; message?: string }) =>
      error.code === 'UNSUPPORTED_CAPABILITY' && error.message === 'Dispatcher is closed');
    assert.equal(rejectedChecks, 0);
    assert.equal(rejectedGrantReads, 0);
    await Promise.resolve();
    assert.equal(drainSettled, false);
    entryGate.resolve();
    assert.deepEqual(await first, []);
    assert.equal(drainSettled, false);
    disclosureGate.resolve();
    await assert.rejects(second, /disclosure refused/);
    await drained;
    assert.equal(drainSettled, true);
    const readsAfterDrain = grantReads;
    await assert.rejects(dispatch.dispatch({ ...base, principal: 'rejected' }, command), (error: { code?: string }) =>
      error.code === 'UNSUPPORTED_CAPABILITY');
    assert.equal(grantReads, readsAfterDrain);
    assert.equal(rejectedGrantReads, 0);
  } catch (error) { primary = error; } finally {
    entryGate.resolve();
    disclosureGate.resolve();
    await Promise.allSettled(pending);
    finishFixture(store, dir, 'rcac-dispatch-drain-', primary);
  }
});

test('stopAccepting synchronously closes admission while leaving admitted work for drain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-stop-'));
  const store = new SqliteStore(join(dir, 'state.sqlite'));
  const gate = deferred();
  let pending: Promise<unknown> | undefined;
  let primary: unknown;
  try {
    const scope = { workspaceId: 'workspace-a' };
    store.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    store.insertGrant({ id: 'grant-a', principal: 'owner', audience: 'host', recipient: 'owner',
      workspaceId: scope.workspaceId, permissions: ['collab.read'], expiresAt: null, revokedAt: null });
    let authorityCalls = 0, grantReads = 0;
    const dispatch = new DispatchService(store, (context) => {
      grantReads++;
      return store.grantsFor(context.principal, context.audience);
    });
    const base = { principal: 'owner', audience: 'host', recipient: 'owner',
      surface: 'local_host' as const, now: new Date() };
    const command = { operation: 'collab.list', scope, payload: {} };
    pending = dispatch.dispatch({ ...base, assertFreshAuthority: async () => {
      authorityCalls++;
      if (authorityCalls === 1) await gate.promise;
    } }, command);
    assert.equal(dispatch.hasInFlightRequests, true);
    dispatch.stopAccepting();
    dispatch.stopAccepting();
    await assert.rejects(dispatch.dispatch(base, command), (error: { code?: string }) =>
      error.code === 'UNSUPPORTED_CAPABILITY');
    assert.equal(authorityCalls, 1);
    assert.equal(grantReads, 0);
    const drained = dispatch.drain();
    assert.strictEqual(dispatch.drain(), drained);
    gate.resolve();
    assert.deepEqual(await pending, []);
    await drained;
    assert.equal(dispatch.hasInFlightRequests, false);
    assert.equal(grantReads, 2);
  } catch (error) { primary = error; } finally {
    gate.resolve();
    if (pending) await Promise.allSettled([pending]);
    finishFixture(store, dir, 'rcac-dispatch-stop-', primary);
  }
});

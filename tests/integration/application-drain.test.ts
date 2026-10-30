import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const workspaceId = 'ws_01234567-89ab-4cde-8f01-234567890abc';

function deferred() {
  let complete!: () => void;
  const promise = new Promise<void>(done => { complete = done; });
  return { promise, complete };
}

async function fixture(run: (root: string) => Promise<void>) {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-app-drain-'));
  let primary: unknown;
  try {
    protectNewDataDirectory(root);
    const db = new SqliteStore(join(root, 'state.sqlite'));
    try {
      db.insertWorkspace({ id: workspaceId, name: 'Drain', canonicalRoot: root, registeredBy: 'owner' });
      db.insertGrant({ id: 'gr_drain', principal: 'owner', audience: 'local', recipient: 'owner',
        workspaceId, permissions: ['collab.create', 'collab.read'],
        expiresAt: null, revokedAt: null });
    } finally { db.close(); }
    await run(root);
  } catch (error) { primary = error; }
  const child = relative(resolve(base), resolve(root));
  assert.ok(child.startsWith('rcac-app-drain-') && !child.includes('..') && !child.includes('\\'));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { if (primary) throw new AggregateError([primary, error], 'Test and cleanup failed', { cause: error }); throw error; }
  if (primary) throw primary;
}

for (const fail of [false, true]) {
  test(`application close drains an admitted request before closing stores (${fail ? 'failure' : 'success'})`, async () => {
    await fixture(async root => {
      const app = openApplication(root);
      await app.ready;
      const entered = deferred(), release = deferred();
      const original = new Error('Synthetic authority failure');
      let authorityCalls = 0;
      const context = { principal: 'owner', audience: 'local', recipient: 'owner',
        surface: 'local_cli' as const, now: new Date(), assertFreshAuthority: async () => {
          authorityCalls++;
          if (authorityCalls === 1) {
            entered.complete();
            await release.promise;
            if (fail) throw original;
          }
        } };
      const command = { operation: 'collab.open', scope: { workspaceId },
        idempotencyKey: 'drain-open', payload: { purpose: 'Close safely' } };
      const request = app.dispatch.dispatch(context, command);
      // Observe rejection immediately; shutdown must not turn it into an unhandled promise.
      const observed = request.then(value => ({ value }), error => ({ error }));
      await entered.promise;
      let finished = false;
      const closeHandle = app.close();
      assert.equal(app.close(), closeHandle, 'pending close must reuse the same promise');
      const close = Promise.resolve(closeHandle).then(() => { finished = true; });
      try {
        await Promise.resolve();
        assert.equal(finished, false, 'close must wait for the admitted request');
        await assert.rejects(app.dispatch.dispatch(context, { ...command, idempotencyKey: 'late' }), /closed/i);
        assert.equal(authorityCalls, 1, 'late request cannot run authority or store access');
        release.complete();
        const result = await observed;
        if (fail) assert.equal('error' in result && result.error, original);
        else {
          if ('error' in result) throw result.error;
          assert.ok((result.value as { id: string }).id);
        }
        await close;
        await app.close();
        const reopened = new SqliteStore(join(root, 'state.sqlite'));
        try { assert.equal(reopened.listCollaborations(workspaceId).length, fail ? 0 : 1); }
        finally { reopened.close(); }
      } finally {
        release.complete();
        await observed;
        await close;
      }
    });
  });
}

test('idle application close remains synchronous and idempotent', async () => {
  await fixture(async root => {
    const app = openApplication(root);
    await app.ready;
    assert.equal(app.close(), undefined);
    assert.equal(app.close(), undefined);
    let checks = 0;
    await assert.rejects(app.dispatch.dispatch({ principal: 'owner', audience: 'local', recipient: 'owner',
      surface: 'local_cli', now: new Date(), assertFreshAuthority: async () => { checks++; } },
    { operation: 'collab.list', scope: { workspaceId }, payload: {} }), /closed/i);
    assert.equal(checks, 0);
    const reopened = openApplication(root);
    try { await reopened.ready; }
    finally { await reopened.close(); }
  });
});

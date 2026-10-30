import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

for (const change of ['none', 'revoke', 'handoff', 'duplicate'] as const) {
  test(`application checkpoint immediately before releasing submit handles ${change}`, async () => {
    const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-submit-checkpoint-'));
    const dir = join(outer, 'data');
    mkdirSync(dir, { mode: 0o700 });
    protectNewDataDirectory(dir);
    const seed = new SqliteStore(join(dir, 'state.sqlite'));
    const scope = { workspaceId: 'a', collaborationId: 'c' };
    seed.insertWorkspace({ id: 'a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    seed.insertCollaboration({ id: 'c', workspaceId: 'a', openedBy: 'owner', purpose: 'synthetic', hostThreadId: null, state: 'open' });
    seed.insertGrant({ id: 'grant', principal: 'owner', audience: 'host', recipient: 'owner', ...scope,
      permissions: ['conversation.control'], expiresAt: null, revokedAt: null });
    const context = { principal: 'owner', audience: 'host', recipient: 'owner', surface: 'local_host' as const, now: new Date() };
    let commits = 0;
    const app = openApplication(dir, {
      conversation: { observeBinding: async observedScope => {
        assert.deepEqual(observedScope, scope);
        return { providerId: 'synthetic', accountId: 'account', nativeSessionId: 'chat', cursor: 'baseline' };
      } },
      conversationPort: {
        syncDelta: async state => ({ providerId: state.providerId, accountId: state.accountId,
          nativeSessionId: state.nativeSessionId, fromCursor: state.cursor, nextCursor: state.cursor,
          complete: true, generating: false, historyChanged: false, messages: [] }),
        send: async (state, text, hooks) => {
          assert.ok(hooks);
          if (change === 'revoke') seed.revokeGrant('grant', new Date().toISOString());
          if (change === 'handoff') await app.dispatch.dispatch(context, { operation: 'conversation.handoff', scope,
            idempotencyKey: 'handoff', payload: { bindingId: state.bindingId, expectedEpoch: 0 } });
          await hooks.onBeforeSubmit();
          assert.equal(text, 'synthetic question');
          commits++;
          if (change === 'duplicate') await assert.rejects(hooks.onBeforeSubmit());
          return { status: 'unknown' };
        },
      },
    });
    try {
      const state = await app.dispatch.dispatch(context, { operation: 'conversation.bind', scope, idempotencyKey: 'bind', payload: {} }) as { bindingId: string };
      const sending = app.dispatch.dispatch(context, { operation: 'conversation.send', scope, idempotencyKey: 'send',
        payload: { bindingId: state.bindingId, expectedEpoch: 0, text: 'synthetic question' } });
      // The dispatcher also prevents result disclosure after revocation; the durable intent remains unknown.
      if (change === 'revoke') await assert.rejects(sending, /not available/);
      else assert.equal((await sending as { status: string }).status, 'unknown');
      assert.equal(commits, change === 'none' || change === 'duplicate' ? 1 : 0);
      const store = new SessionControlSqlite(join(dir, 'state.sqlite'));
      try {
        assert.equal(store.get(state.bindingId)?.control, 'reconcile_required');
        assert.equal(store.get(state.bindingId)?.sendIntent?.status, 'unknown');
      } finally { store.close(); }
    } finally {
      await app.close(); seed.close();
      assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
        /^rcac-submit-checkpoint-[A-Za-z0-9_-]{6}$/);
      rmSync(outer, { recursive: true, force: true });
    }
  });
}

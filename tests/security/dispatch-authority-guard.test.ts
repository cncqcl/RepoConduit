import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { DispatchService } from '../../src/application/dispatch.js';

test('trusted transport revocation guard blocks a mutation before local grant use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-guard-'));
  const store = new SqliteStore(join(dir, 'state.sqlite'));
  const workspaceId = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  try {
    store.insertWorkspace({ id: workspaceId, name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
    store.insertGrant({ id: 'gr-a', principal: 'external', audience: 'resource', recipient: 'external',
      workspaceId, permissions: ['collab.create'], expiresAt: null, revokedAt: null });
    let checks = 0;
    const context = { principal: 'external', audience: 'resource', recipient: 'external',
      surface: 'external_mcp' as const, now: new Date(), async assertFreshAuthority() {
        checks++;
        throw new Error('token revoked');
      } };
    await assert.rejects(new DispatchService(store).dispatch(context, {
      operation: 'collab.open', scope: { workspaceId },
      payload: { purpose: 'should not exist' }, idempotencyKey: 'open-1',
    }), /token revoked/);
    assert.ok(checks >= 1);
    assert.deepEqual(store.listCollaborations(workspaceId), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

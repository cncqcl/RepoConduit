import assert from 'node:assert/strict';
import test from 'node:test';
import { authorize, operationPolicy, PolicyError, type Grant, type RequestContext } from '../../src/core/policy/authorize.js';

const scope = { workspaceId: 'ws', collaborationId: 'col' };
const context: RequestContext = { principal: 'owner', audience: 'local-os', recipient: 'owner', surface: 'local_cli', now: new Date() };
const grant: Grant = { id: 'original', principal: 'owner', audience: 'local-os', recipient: 'owner', ...scope,
  permissions: ['artifact.collect'], expiresAt: null, revokedAt: null };

test('browser collection contract is local-only and requires artifact.collect', () => {
  const policy = operationPolicy('artifact.collect_browser');
  assert.deepEqual(policy.surfaces, ['local_host', 'local_cli']);
  assert.equal(policy.effect, 'artifact_transfer');
  assert.equal(policy.requiredGrant, 'artifact.collect');
  assert.equal(policy.idempotencyRequired, true);
  assert.equal(authorize(context, 'artifact.collect_browser', scope, [grant]).grantId, 'original');
});

for (const fault of ['external', 'admin', 'wrong_workspace', 'wrong_collaboration', 'wrong_recipient', 'revoked', 'expired', 'submit_only'] as const) {
  test(`browser collector authority rejects ${fault}`, () => {
    const changed = { ...context }, g = { ...grant }, binding = { ...scope };
    if (fault === 'external') changed.surface = 'external_mcp';
    if (fault === 'admin') changed.surface = 'local_admin';
    if (fault === 'wrong_workspace') binding.workspaceId = 'other';
    if (fault === 'wrong_collaboration') binding.collaborationId = 'other';
    if (fault === 'wrong_recipient') changed.recipient = 'other';
    if (fault === 'revoked') g.revokedAt = new Date().toISOString();
    if (fault === 'expired') g.expiresAt = '2020-01-01T00:00:00Z';
    if (fault === 'submit_only') g.permissions = ['artifact.submit'];
    assert.throws(() => authorize(changed, 'artifact.collect_browser', binding, [g]), PolicyError);
  });
}

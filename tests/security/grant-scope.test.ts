import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize, isDataPathPermitted, PolicyError, type Grant } from '../../src/core/policy/authorize.js';

const base: Grant = {
  id: 'gr_test', principal: 'external-a', audience: 'mcp-a', workspaceId: 'ws_a',
  collaborationId: 'col_a', recipient: 'external-a', permissions: ['data.read'],
  dataPaths: ['src/allowed.ts', 'docs/'],
  expiresAt: '2030-01-01T00:00:00.000Z', revokedAt: null,
};

const ctx = {
  principal: 'external-a', audience: 'mcp-a', surface: 'external_mcp' as const,
  recipient: 'external-a', now: new Date('2026-09-26T00:00:00.000Z'),
};

test('a grant is scoped to principal, audience, workspace, collaboration and recipient', () => {
  const permit = authorize(ctx, 'repo.read', { workspaceId: 'ws_a', collaborationId: 'col_a' }, [base]);
  assert.equal(permit.grantId, base.id);
  assert.deepEqual(permit.dataPaths, ['src/allowed.ts', 'docs/']);
  for (const scope of [
    { workspaceId: 'ws_b', collaborationId: 'col_a' },
    { workspaceId: 'ws_a', collaborationId: 'col_b' },
  ]) {
    assert.throws(() => authorize(ctx, 'repo.read', scope, [base]), PolicyError);
  }
  assert.throws(() => authorize({ ...ctx, audience: 'mcp-b' }, 'repo.read', { workspaceId: 'ws_a', collaborationId: 'col_a' }, [base]), PolicyError);
  assert.throws(() => authorize({ ...ctx, recipient: 'external-b' }, 'repo.read', { workspaceId: 'ws_a', collaborationId: 'col_a' }, [base]), PolicyError);
});

test('data read requires a nonempty explicit file or directory scope', () => {
  const scope = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  for (const paths of [undefined, [], [''], ['/absolute'], ['../escape'], ['src/../escape'], ['src\\escape'], ['src//escape'], ['.'], ['src/.'], ['src/..']]) {
    const grant: Grant = paths === undefined ? { ...base } : { ...base, dataPaths: paths };
    if (paths === undefined) delete grant.dataPaths;
    assert.throws(() => authorize(ctx, 'repo.read', scope, [grant]), PolicyError);
  }
  const paths = ['src/allowed.ts'];
  const permit = authorize(ctx, 'repo.read', scope, [{ ...base, dataPaths: paths }]);
  paths.push('secrets/');
  assert.deepEqual(permit.dataPaths, ['src/allowed.ts']);
});

test('file grants are exact and directory grants match only descendants', () => {
  const allowed = ['src/allowed.ts', 'docs/'];
  for (const path of ['src/allowed.ts', 'docs/readme.md', 'docs/deep/page.md']) {
    assert.equal(isDataPathPermitted(path, allowed), true);
  }
  for (const path of ['src/allowed.ts.bak', 'src/other.ts', 'docsecret/file.md', 'docs-old/file.md',
    'docs', 'docs/../secret', '/docs/readme.md', 'docs\\readme.md']) {
    assert.equal(isDataPathPermitted(path, allowed), false);
  }
});

test('multiple data grants combine explicit paths independently of grant order', () => {
  const scope = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  const a = { ...base, id: 'gr_a', dataPaths: ['src/a.ts'] };
  const b = { ...base, id: 'gr_b', dataPaths: ['src/b.ts'] };
  for (const grants of [[a, b], [b, a]]) {
    const permit = authorize(ctx, 'repo.read', scope, grants);
    assert.deepEqual(new Set(permit.dataPaths), new Set(['src/a.ts', 'src/b.ts']));
  }
  assert.deepEqual(authorize(ctx, 'repo.read', scope, [{ ...a, revokedAt: ctx.now.toISOString() }, b]).dataPaths, ['src/b.ts']);
});

test('revocation and expiry are checked again on result disclosure', () => {
  const scope = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  assert.throws(() => authorize(ctx, 'repo.read', scope, [{ ...base, revokedAt: '2026-09-25T00:00:00.000Z' }]), PolicyError);
  assert.throws(() => authorize(ctx, 'repo.read', scope, [{ ...base, expiresAt: '2026-09-25T00:00:00.000Z' }]), PolicyError);
});

test('external transport cannot call local operations even with forged grants', () => {
  const forged = { ...base, permissions: ['admin.workspace', 'snapshot.create'] };
  assert.throws(() => authorize(ctx, 'admin.register_workspace', { workspaceId: 'ws_a' }, [forged]), PolicyError);
  assert.throws(() => authorize(ctx, 'snapshot.capture', { workspaceId: 'ws_a' }, [forged]), PolicyError);
});

test('external recipient binding cannot be an implicit wildcard', () => {
  const scope = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  assert.throws(() => authorize(ctx, 'repo.read', scope, [{ ...base, recipient: '' }]), PolicyError);
  const withoutRecipient: Grant = { ...base };
  delete withoutRecipient.recipient;
  assert.throws(() => authorize(ctx, 'repo.read', scope, [withoutRecipient]), PolicyError);
});

test('a delegated permission can narrow but never expand persisted grants', () => {
  const scope = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  assert.equal(authorize({ ...ctx, delegatedPermissions: ['data.read'] }, 'repo.read', scope, [base]).operation, 'repo.read');
  assert.throws(() => authorize({ ...ctx, delegatedPermissions: [] }, 'repo.read', scope, [base]), PolicyError);
  assert.throws(() => authorize({ ...ctx, delegatedPermissions: ['artifact.submit'] }, 'repo.read', scope, [base]), PolicyError);
  assert.throws(() => authorize({ ...ctx, delegatedPermissions: ['data.read', 'artifact.submit'] },
    'artifact.begin', scope, [base]), PolicyError);
});

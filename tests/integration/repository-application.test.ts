import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { RepositoryApplication, type SnapshotReceipt, type SnapshotRecord } from '../../src/application/repository.js';
import type { Permit, RequestContext } from '../../src/core/policy/authorize.js';

const context: RequestContext = { principal: 'alice', audience: 'external', surface: 'external_mcp', recipient: 'alice', now: new Date() };
const binding = { workspaceId: 'ws_a', collaborationId: 'col_a', workingCopyId: 'wc_a' };
function receipt(record: SnapshotRecord): SnapshotReceipt {
  return { snapshotId: record.snapshot.id, workspaceId: record.workspaceId,
    collaborationId: record.collaborationId, workingCopyId: record.workingCopyId,
    baseCommit: record.snapshot.baseCommit, sourceConsistency: record.snapshot.sourceConsistency,
    excludedCategories: [...new Set(record.snapshot.exclusions.map(item => item.reason))] };
}

function fixture() {
  const records = new Map<string, SnapshotRecord>();
  const calls: string[] = [];
  const persistenceScopes: string[] = [];
  const app = new RepositoryApplication({
    authorize(request) {
      calls.push(request.operation);
      const permit: Permit = {
        grantId: 'gr_1', operation: request.operation, effect: request.operation === 'snapshot.capture' ? 'state_write' : 'read',
        scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId },
        principal: request.context.principal, recipient: request.context.recipient, dataPaths: ['src/main.ts'],
      };
      return permit;
    },
    async getWorkingCopy(workspaceId, workingCopyId) {
      return workspaceId === 'ws_a' && workingCopyId === 'wc_a' ? { canonicalRoot: 'D:/fixture' } : null;
    },
    async collaborationBelongsToWorkspace(workspaceId, collaborationId) {
      return workspaceId === 'ws_a' && collaborationId === 'col_a';
    },
    lookupCapture() { return null; },
    async saveSnapshot(record, _input, key, principal, audience) { persistenceScopes.push(`${key}:${principal}:${audience}`); records.set(record.snapshot.id, structuredClone(record)); return receipt(record); },
    async getSnapshot(id, workspaceId, collaborationId) { return workspaceId === 'ws_a' && collaborationId === 'col_a' ? records.get(id) ?? null : null; },
    async captureTree() { return createSnapshotFromFiles('wc_a', 'commit-a', { 'src/main.ts': Buffer.from('alpha\nbeta\n'), 'src/hidden.ts': Buffer.from('private') }); },
  });
  return { app, calls, records, persistenceScopes };
}

test('capture persists full private snapshot but returns secret-free metadata', async () => {
  const { app, calls, records, persistenceScopes } = fixture();
  const captured = await app.capture({ context: { ...context, surface: 'local_cli' }, ...binding, idempotencyKey: 'capture-1' });
  assert.equal(calls[0], 'snapshot.capture');
  assert.deepEqual(persistenceScopes, ['capture-1:alice:external']);
  assert.ok(records.get(captured.snapshotId)?.snapshot.cursorKey);
  assert.ok(!JSON.stringify(captured).includes('cursorKey'));
  assert.ok(!JSON.stringify(captured).includes('private'));
  assert.equal(captured.sourceConsistency, 'best_effort_capture');
  assert.equal(captured.workspaceId, 'ws_a');
  assert.equal(captured.collaborationId, 'col_a');
});

test('read requires exact workspace and collaboration binding and authorized path scope', async () => {
  const { app, calls } = fixture();
  const captured = await app.capture({ context: { ...context, surface: 'local_cli' }, ...binding, idempotencyKey: 'capture-1' });
  const result = await app.read({ context, ...binding, snapshotId: captured.snapshotId, path: 'src/main.ts', maxBytes: 6 });
  assert.equal(result.content, 'alpha\n');
  assert.ok(result.continuation);
  assert.equal(calls.at(-1), 'repo.read');
  await assert.rejects(app.read({ context, ...binding, workspaceId: 'ws_b', snapshotId: captured.snapshotId, path: 'src/main.ts' }), /NOT_AVAILABLE/);
  await assert.rejects(app.read({ context, ...binding, collaborationId: 'col_b', snapshotId: captured.snapshotId, path: 'src/main.ts' }), /NOT_AVAILABLE/);
  await assert.rejects(app.read({ context, ...binding, snapshotId: captured.snapshotId, path: 'src/hidden.ts' }), /NOT_AVAILABLE/);
});

test('invalid permit cannot be substituted for a different operation or principal', async () => {
  const { app } = fixture();
  const captured = await app.capture({ context: { ...context, surface: 'local_cli' }, ...binding, idempotencyKey: 'capture-1' });
  const wrong = new RepositoryApplication({
    authorize(request) { return { grantId: 'gr_1', operation: 'repo.list', effect: 'read', scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId }, principal: 'bob', recipient: 'alice', dataPaths: ['src/main.ts'] }; },
    async getWorkingCopy() { return { canonicalRoot: 'D:/fixture' }; },
    async collaborationBelongsToWorkspace() { return true; },
    lookupCapture() { return null; },
    async saveSnapshot() { throw new Error('unexpected save'); },
    async getSnapshot() { return null; },
  });
  await assert.rejects(wrong.read({ context, ...binding, snapshotId: captured.snapshotId, path: 'src/main.ts' }), /NOT_AVAILABLE/);
});

test('revocation before result disclosure rejects the response', async () => {
  const { app, records } = fixture();
  const captured = await app.capture({ context: { ...context, surface: 'local_cli' }, ...binding, idempotencyKey: 'capture-1' });
  let checks = 0;
  const guarded = new RepositoryApplication({
    authorize(request) {
      if (++checks > 1) throw new Error('NOT_AVAILABLE');
      return { grantId: 'gr_1', operation: request.operation, effect: 'read', scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId }, principal: 'alice', recipient: 'alice', dataPaths: ['src/main.ts'] };
    },
    async getWorkingCopy() { return null; },
    async collaborationBelongsToWorkspace() { return false; },
    lookupCapture() { return null; },
    async saveSnapshot() { throw new Error('unexpected save'); },
    async getSnapshot(id, workspaceId, collaborationId) { return workspaceId === 'ws_a' && collaborationId === 'col_a' ? records.get(id) ?? null : null; },
  });
  await assert.rejects(guarded.read({ context, ...binding, snapshotId: captured.snapshotId, path: 'src/main.ts' }), /NOT_AVAILABLE/);
  assert.equal(checks, 2);
});

test('identical snapshot ID can be bound independently to two collaborations', async () => {
  const records = new Map<string, SnapshotRecord>();
  const app = new RepositoryApplication({
    authorize(request) {
      return { grantId: 'gr_1', operation: request.operation, effect: request.operation === 'snapshot.capture' ? 'state_write' : 'read', scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId }, principal: request.context.principal, recipient: request.context.recipient, dataPaths: ['src/main.ts'] };
    },
    async getWorkingCopy() { return { canonicalRoot: 'D:/fixture' }; },
    async collaborationBelongsToWorkspace(workspaceId, collaborationId) { return workspaceId === 'ws_a' && ['col_a', 'col_b'].includes(collaborationId); },
    lookupCapture() { return null; },
    async saveSnapshot(record) { records.set(`${record.snapshot.id}:${record.workspaceId}:${record.collaborationId}`, record); return receipt(record); },
    async getSnapshot(id, workspaceId, collaborationId) { return records.get(`${id}:${workspaceId}:${collaborationId}`) ?? null; },
    async captureTree() { return createSnapshotFromFiles('wc_a', 'commit-a', { 'src/main.ts': Buffer.from('same bytes') }); },
  });
  const local = { ...context, surface: 'local_cli' as const };
  const a = await app.capture({ context: local, ...binding, idempotencyKey: 'a' });
  const b = await app.capture({ context: local, ...binding, collaborationId: 'col_b', idempotencyKey: 'b' });
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal((await app.read({ context, ...binding, snapshotId: a.snapshotId, path: 'src/main.ts' })).content, 'same bytes');
  assert.equal((await app.read({ context, ...binding, collaborationId: 'col_b', snapshotId: b.snapshotId, path: 'src/main.ts' })).content, 'same bytes');
  await assert.rejects(app.read({ context, ...binding, collaborationId: 'col_c', snapshotId: a.snapshotId, path: 'src/main.ts' }), /NOT_AVAILABLE/);
});

test('diff requires authorization for both fixed snapshots', async () => {
  const old = createSnapshotFromFiles('wc_a', 'commit-old', { 'src/large.ts': Buffer.from('private') }).toPersisted();
  const current = createSnapshotFromFiles('wc_a', 'commit-new', { 'src/large.ts': Buffer.from('public') }).toPersisted();
  const authorizedIds: string[] = [];
  const app = new RepositoryApplication({
    authorize(request) {
      authorizedIds.push(request.snapshotId ?? 'none');
      if (request.snapshotId === old.id) throw new Error('NOT_AVAILABLE');
      return { grantId: 'gr_1', operation: request.operation, effect: 'read',
        scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId },
        principal: request.context.principal, recipient: request.context.recipient, dataPaths: ['src/large.ts'] };
    },
    async getWorkingCopy() { return null; },
    async collaborationBelongsToWorkspace() { return true; },
    lookupCapture() { return null; },
    async saveSnapshot() { throw new Error('unexpected save'); },
    async getSnapshot(id) { return id === old.id ? { ...binding, snapshot: old } : id === current.id ? { ...binding, snapshot: current } : null; },
  });
  await assert.rejects(app.diff({ context, ...binding, snapshotId: current.id, beforeSnapshotId: old.id }), /NOT_AVAILABLE/);
  assert.deepEqual(authorizedIds, [current.id, old.id]);
});

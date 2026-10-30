import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DispatchService } from '../../src/application/dispatch.js';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('one dispatcher routes artifact commands without a database transaction across file I/O', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-dispatch-art-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_a', col = 'col_a', bundleId = 'bun_a';
  const context = { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
  const objects = new ArtifactObjects(join(dir, 'objects'));
  const locks = new BundleLocks();
  try {
    db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'bundle', hostThreadId: null, state: 'open' });
    db.insertGrant({ id: 'grant', principal: 'external', audience: 'mcp', recipient: 'external', workspaceId: ws,
      collaborationId: col, permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
    const { snapshotId } = await seedBundleProvenance(db, join(dir, 'state.sqlite'), {
      workspaceId: ws, collaborationId: col, workingCopyId: 'copy-a', root: dir,
      revisionIds: ['ctx_1'],
    });
    const artifact = new ArtifactApplication({ objects,
      validateBundleReferences: (input) => db.validateBundleReferences(input),
      authorize: ({ context: ctx, operation, workspaceId, collaborationId }) => authorize(ctx, operation,
        { workspaceId, collaborationId }, db.grantsFor(ctx.principal, ctx.audience)),
      collaborationBelongsToWorkspace: (workspaceId, collaborationId) => db.collaborationBelongsToWorkspace(workspaceId, collaborationId),
      getBundle: (id) => db.getBundle(id), saveBundle: (record) => db.saveBundle(record),
      publishBundle: (manifest) => db.publishBundle(manifest),
      abortBundle: (id, state) => db.abortBundle(id, state),
      lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
      withBundleLock: (id, action) => locks.withBundleLock(id, action),
      runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
    });
    const dispatch = new DispatchService(db, undefined, undefined, { artifact });
    const scope = { workspaceId: ws, collaborationId: col };
    const begin = { operation: 'artifact.begin', scope, idempotencyKey: 'begin',
      payload: { bundleId, contextRevision: 'ctx_1', snapshotRefs: [snapshotId], expectedPaths: ['plan.md', 'data.bin'] } };
    await dispatch.dispatch(context, begin);
    await dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: 'put',
      payload: { bundleId, path: 'plan.md', text: '# plan', mediaType: 'text/markdown' } });
    const imported = await dispatch.dispatch(context, { operation: 'artifact.import_reference', scope,
      idempotencyKey: 'import', payload: { bundleId, path: 'data.bin' } },
    { referenceIdentity: 'file-1', mediaType: 'application/octet-stream',
      async acquireBytes() { return Buffer.from([0, 1, 2, 255]); } });
    assert.equal((imported as { actualSizeBytes: number }).actualSizeBytes, 4);
    const first = await dispatch.dispatch(context, { operation: 'artifact.finalize', scope, idempotencyKey: 'finish', payload: { bundleId } });
    const replay = await dispatch.dispatch(context, { operation: 'artifact.finalize', scope, idempotencyKey: 'finish', payload: { bundleId } });
    assert.deepEqual(first, replay);
    assert.equal(db.getBundle(bundleId)?.manifest?.files.length, 2);
    await dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
      idempotencyKey: 'late-finalize', payload: { bundleId } });
    await dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: 'begin-next',
      payload: { bundleId: 'bun_b', contextRevision: 'ctx_1', snapshotRefs: [snapshotId], expectedPaths: ['next.md'] } });
    await dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: 'put-next',
      payload: { bundleId: 'bun_b', path: 'next.md', text: '# next', mediaType: 'text/markdown' } });
    await assert.rejects(dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
      idempotencyKey: 'late-finalize', payload: { bundleId: 'bun_b' } }),
    (error: { code?: string }) => error.code === 'CONFLICT');
    assert.equal(db.getBundle('bun_b')?.manifest, undefined);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-dispatch-art-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('DB-published bundle recovers after crash loses the staging marker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-marker-'));
  const dbPath = join(dir, 'state.sqlite');
  const db = new SqliteStore(dbPath);
  const objectRoot = join(dir, 'artifact-objects');
  const objects = new ArtifactObjects(objectRoot);
  const locks = new BundleLocks();
  const workspaceId = 'ws', collaborationId = 'col', bundleId = 'bundle';
  const context = { principal: 'external', audience: 'mcp', recipient: 'external',
    surface: 'external_mcp' as const, now: new Date() };
  const app = new ArtifactApplication({ objects,
    validateBundleReferences: (input) => db.validateBundleReferences(input),
    authorize: ({ context: ctx, operation, workspaceId: ws, collaborationId: col }) =>
      authorize(ctx, operation, { workspaceId: ws, collaborationId: col }, db.grantsFor(ctx.principal, ctx.audience)),
    collaborationBelongsToWorkspace: (ws, col) => db.collaborationBelongsToWorkspace(ws, col),
    getBundle: (id) => db.getBundle(id), saveBundle: (record) => db.saveBundle(record),
    publishBundle: (manifest) => db.publishBundle(manifest),
    abortBundle: (id, state) => db.abortBundle(id, state),
    lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
    withBundleLock: (id, action) => locks.withBundleLock(id, action),
    runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
  });
  try {
    db.insertWorkspace({ id: workspaceId, name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner', purpose: 'delivery', hostThreadId: null, state: 'open' });
    db.insertGrant({ id: 'grant', principal: context.principal, audience: context.audience,
      recipient: context.recipient, workspaceId, collaborationId,
      permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
    const { snapshotId } = await seedBundleProvenance(db, dbPath, {
      workspaceId, collaborationId, workingCopyId: 'copy', root: dir, revisionIds: ['ctx', 'ctx2'],
    });
    const binding = { context, workspaceId, collaborationId, bundleId };
    await app.begin({ ...binding, contextRevision: 'ctx', snapshotRefs: [snapshotId],
      expectedPaths: ['plan.md'], idempotencyKey: 'begin' });
    await app.putText({ ...binding, idempotencyKey: 'put', path: 'plan.md', text: '# delivered',
      mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    assert.throws(() => objects.finalize(bundleId, (manifest) => {
      db.publishBundle(manifest);
      throw new Error('crash after database commit');
    }), /crash after database commit/);
    assert.ok(db.getBundle(bundleId)?.manifest);
    unlinkSync(join(objectRoot, 'staging', `${bundleId}.json`));

    assert.equal((await app.readFile({ ...binding, path: 'plan.md' })).toString(), '# delivered');
    assert.equal((await app.status(binding)).state, 'published');
    await t.test('finalize retry returns the committed manifest', async () => {
      const committed = db.getBundle(bundleId)!.manifest!;
      assert.deepEqual(await app.finalize({ ...binding, idempotencyKey: 'retry-finalize' }), committed);
      assert.deepEqual(db.getBundle(bundleId)!.manifest, committed);
    });
    await t.test('a child version can begin from the committed parent', async () => {
      unlinkSync(join(objectRoot, 'staging', `${bundleId}.json`));
      const child = { ...binding, bundleId: 'child' };
      const state = await app.begin({ ...child, parentBundleId: bundleId, contextRevision: 'ctx2',
        snapshotRefs: [snapshotId], expectedPaths: ['next.md'], idempotencyKey: 'begin-child' });
      assert.equal(state.state, 'staging');
      assert.deepEqual(state.missingPaths, ['next.md']);
    });
    await t.test('malformed or conflicting existing markers fail closed', async () => {
      const markerPath = join(objectRoot, 'staging', `${bundleId}.json`);
      const original = readFileSync(markerPath, 'utf8');
      try {
        writeFileSync(markerPath, '{invalid json');
        await assert.rejects(app.status(binding));
        await assert.rejects(app.finalize({ ...binding, idempotencyKey: 'retry-malformed' }));
        const conflicting = JSON.parse(original) as { input: { workspaceId: string } };
        conflicting.input.workspaceId = 'another-workspace';
        writeFileSync(markerPath, JSON.stringify(conflicting));
        await assert.rejects(app.finalize({ ...binding, idempotencyKey: 'retry-conflict' }), /input conflict/);
      } finally { writeFileSync(markerPath, original); }
    });
    await t.test('missing or corrupt content remains unavailable', async () => {
      const file = db.getBundle(bundleId)!.manifest!.files[0]!;
      const objectPath = objects.objectPath(file.sha256);
      unlinkSync(join(objectRoot, 'staging', `${bundleId}.json`));
      unlinkSync(objectPath);
      assert.equal((await app.status(binding)).integrityStatus, 'missing');
      await assert.rejects(app.readFile({ ...binding, path: 'plan.md' }), /integrity_error/);
      await assert.rejects(app.finalize({ ...binding, idempotencyKey: 'retry-missing' }), /missing object/);
      writeFileSync(objectPath, 'corrupt');
      assert.equal((await app.status(binding)).integrityStatus, 'corrupt');
      await assert.rejects(app.readFile({ ...binding, path: 'plan.md' }), /integrity_error/);
      await assert.rejects(app.finalize({ ...binding, idempotencyKey: 'retry-corrupt' }), /corrupt object/);
    });
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-bundle-marker-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

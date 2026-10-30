import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('abort persists a terminal tombstone and receipt across restart and refuses further writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-abort-'));
  const dbPath = join(dir, 'state.sqlite');
  const objectRoot = join(dir, 'objects');
  let db = new SqliteStore(dbPath);
  const context = { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
  const scope = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  const bundleId = 'bun_a';
  const markerPath = join(objectRoot, 'staging', `${bundleId}.json`);
  const build = () => {
    const objects = new ArtifactObjects(objectRoot);
    const locks = new BundleLocks();
    const artifact = new ArtifactApplication({ objects,
      authorize: ({ context: ctx, operation, workspaceId, collaborationId }) => authorize(ctx, operation,
        { workspaceId, collaborationId }, db.grantsFor(ctx.principal, ctx.audience)),
      collaborationBelongsToWorkspace: (ws, col) => db.collaborationBelongsToWorkspace(ws, col),
      validateBundleReferences: (input) => db.validateBundleReferences(input),
      getBundle: (id) => db.getBundle(id), saveBundle: (record) => db.saveBundle(record),
      publishBundle: (manifest) => db.publishBundle(manifest),
      abortBundle: (id, state) => db.abortBundle(id, state),
      lookupIdempotent: (idemScope, payload) => db.lookupIdempotent(idemScope, payload),
      runIdempotent: (idemScope, payload, mutation) => db.runIdempotent(idemScope, payload, mutation),
      withBundleLock: (id, action) => locks.withBundleLock(id, action),
    });
    return new DispatchService(db, undefined, undefined, { artifact });
  };
  try {
    db.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner', purpose: 'bundle', hostThreadId: null, state: 'open' });
    db.insertGrant({ id: 'grant', principal: 'external', audience: 'mcp', recipient: 'external', ...scope,
      permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
    const { snapshotId } = await seedBundleProvenance(db, dbPath, {
      ...scope, workingCopyId: 'copy-a', root: dir, revisionIds: ['ctx_1'],
    });
    let dispatch = build();
    const begin = { operation: 'artifact.begin', scope, idempotencyKey: 'begin', payload: {
      bundleId, contextRevision: 'ctx_1', snapshotRefs: [snapshotId], expectedPaths: ['plan.md'],
    } };
    await dispatch.dispatch(context, begin);
    const abort = { operation: 'artifact.abort', scope, idempotencyKey: 'abort', payload: { bundleId } };
    assert.equal((await dispatch.dispatch(context, abort) as { state: string }).state, 'aborted');
    assert.equal((await dispatch.dispatch(context, abort) as { state: string }).state, 'aborted');
    assert.equal(db.getBundle(bundleId)?.abortedState?.state, 'aborted');
    assert.equal((await dispatch.dispatch(context, { operation: 'artifact.status', scope, payload: { bundleId } }) as { state: string }).state, 'aborted');
    db.close();
    db = new SqliteStore(dbPath);
    dispatch = build();
    assert.equal((await dispatch.dispatch(context, { operation: 'artifact.status', scope, payload: { bundleId } }) as { state: string }).state, 'aborted');
    for (const command of [begin, { ...begin, idempotencyKey: 'new-begin' },
      { operation: 'artifact.put_text', scope, idempotencyKey: 'put', payload: { bundleId, path: 'plan.md', text: 'x', mediaType: 'text/markdown' } },
      { operation: 'artifact.finalize', scope, idempotencyKey: 'finalize', payload: { bundleId } }]) {
      await assert.rejects(dispatch.dispatch(context, command));
    }
    assert.equal((await dispatch.dispatch(context, abort) as { state: string }).state, 'aborted');
    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8') as string).state, 'aborted');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('published bundle cannot abort even if the marker is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-abort-published-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  try {
    db.insertWorkspace({ id: 'ws', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'bundle', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(db, join(dir, 'state.sqlite'), {
      workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', root: dir, revisionIds: ['ctx'],
    });
    const objects = new ArtifactObjects(join(dir, 'objects'));
    const input = { bundleId: 'published', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'ctx', snapshotRefs: [snapshotId] };
    objects.begin(input);
    db.saveBundle({ input });
    objects.putText('published', 'plan.md', 'plan', 'text/markdown', 'text_set_mcp');
    objects.finalize('published', (manifest) => db.publishBundle(manifest));
    rmSync(join(dir, 'objects', 'staging', 'published.json'));
    assert.equal(existsSync(join(dir, 'objects', 'staging', 'published.json')), false);
    assert.throws(() => db.abortBundle('published', { state: 'aborted', files: [], missingPaths: [] }));
    assert.ok(db.getBundle('published')?.manifest);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('aborted marker cannot publish while database still says staging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-abort-marker-'));
  try {
    const objects = new ArtifactObjects(dir);
    objects.begin({ bundleId: 'bundle', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'ctx', snapshotRefs: [] });
    objects.putText('bundle', 'plan.md', 'plan', 'text/markdown', 'text_set_mcp');
    const markerPath = join(dir, 'staging', 'bundle.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { state: string };
    writeFileSync(markerPath, JSON.stringify({ ...marker, state: 'aborted' }));
    assert.throws(() => objects.finalize('bundle', () => { throw new Error('unexpected DB publication'); }), /immutable|CONFLICT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('conflicting published and aborted database state fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-abort-dual-state-'));
  const dbPath = join(dir, 'state.sqlite');
  const db = new SqliteStore(dbPath);
  try {
    db.insertWorkspace({ id: 'ws', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'bundle', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(db, dbPath, {
      workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', root: dir, revisionIds: ['ctx'],
    });
    const objects = new ArtifactObjects(join(dir, 'objects'));
    objects.begin({ bundleId: 'bundle', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'ctx', snapshotRefs: [snapshotId] });
    db.saveBundle({ input: { bundleId: 'bundle', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'ctx', snapshotRefs: [snapshotId] } });
    objects.putText('bundle', 'plan.md', 'plan', 'text/markdown', 'text_set_mcp');
    objects.finalize('bundle', (manifest) => db.publishBundle(manifest));
    const injected = new DatabaseSync(dbPath);
    try {
      injected.prepare('UPDATE bundles SET aborted_state_json=? WHERE id=?')
        .run(JSON.stringify({ state: 'aborted', files: [], missingPaths: [] }), 'bundle');
    } finally { injected.close(); }
    assert.throws(() => db.getBundle('bundle'), /CONFLICT|integrity/i);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

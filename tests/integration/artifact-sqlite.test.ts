import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { authorize, type Grant } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('published bundle v1 and v2 remain readable after coordinator restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-art-db-'));
  const file = join(dir, 'state.sqlite');
  let db = new SqliteStore(file);
  const objects = new ArtifactObjects(join(dir, 'objects-data'));
  const locks = new BundleLocks();
  const ws = 'ws_a', col = 'col_a';
  const ctx = { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
  const grant: Grant = { id: 'gr_submit', principal: 'external', audience: 'mcp', recipient: 'external',
    workspaceId: ws, collaborationId: col, permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null };
  const app = () => new ArtifactApplication({
    objects,
    validateBundleReferences: (input) => db.validateBundleReferences(input),
    authorize: ({ context, operation, workspaceId, collaborationId }) => authorize(context, operation,
      { workspaceId, collaborationId }, db.grantsFor(context.principal, context.audience)),
    collaborationBelongsToWorkspace: (workspaceId, collaborationId) => db.collaborationBelongsToWorkspace(workspaceId, collaborationId),
    getBundle: (id) => db.getBundle(id),
    saveBundle: (record) => db.saveBundle(record),
    publishBundle: (manifest) => db.publishBundle(manifest),
    abortBundle: (id, state) => db.abortBundle(id, state),
    lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
    withBundleLock: (id, action) => locks.withBundleLock(id, action),
    runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
  });
  try {
    db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    db.insertGrant(grant);
    const { snapshotId } = await seedBundleProvenance(db, file, { workspaceId: ws,
      collaborationId: col, workingCopyId: 'copy_a', root: dir,
      revisionIds: ['ctx_1', 'ctx_2', 'ctx_3', 'ctx_4'] });
    await app().begin({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1',
      idempotencyKey: 'begin-1', contextRevision: 'ctx_1', snapshotRefs: [snapshotId], expectedPaths: ['plan.md', 'assets/pixel.png'] });
    await app().putText({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1',
      idempotencyKey: 'put-1', path: 'plan.md', text: '# v1', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    const rawReference = 'synthetic-raw-file-id-canary';
    const signedUrl = 'https://fixture.example.test/file?secret=canary';
    const imported = await app().importReference({ context: ctx, workspaceId: ws, collaborationId: col,
      bundleId: 'bun_1', idempotencyKey: 'import-pixel', path: 'assets/pixel.png',
      referenceIdentity: rawReference, mediaType: 'application/octet-stream',
      acquireBytes: async () => { assert.match(signedUrl, /secret=canary/); return Buffer.from([0, 1, 255]); } });
    assert.equal(imported.sourceIdentity, createHash('sha256').update(rawReference).digest('hex'));
    assert.equal(readFileSync(join(dir, 'objects-data', 'staging', 'bun_1.json'), 'utf8').includes(rawReference), false);
    assert.equal(readFileSync(join(dir, 'objects-data', 'staging', 'bun_1.json'), 'utf8').includes(signedUrl), false);
    assert.equal((await app().status({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1' })).state, 'staging');
    await app().finalize({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1', idempotencyKey: 'final-1' });
    const inspection = new DatabaseSync(file);
    try {
      const row = inspection.prepare('SELECT source_identity FROM bundle_files WHERE bundle_id=? AND path=?')
        .get('bun_1', 'assets/pixel.png') as { source_identity: string };
      assert.equal(row.source_identity, imported.sourceIdentity);
      const stored = inspection.prepare('SELECT manifest_json FROM bundles WHERE id=?').get('bun_1') as { manifest_json: string };
      assert.equal(stored.manifest_json.includes(rawReference), false);
      assert.equal(stored.manifest_json.includes(signedUrl), false);
      const replay = inspection.prepare('SELECT result_json FROM idempotency_records WHERE idempotency_key=?')
        .get('import-pixel') as { result_json: string };
      assert.equal(replay.result_json.includes(rawReference), false);
      assert.equal(replay.result_json.includes(signedUrl), false);
    } finally { inspection.close(); }
    db.close();
    db = new SqliteStore(file);
    assert.equal((await app().status({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1' })).integrityStatus, 'ok');
    assert.equal((await app().readFile({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1', path: 'plan.md' })).toString(), '# v1');
    await app().begin({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_2', parentBundleId: 'bun_1',
      idempotencyKey: 'begin-2', contextRevision: 'ctx_2', snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] });
    await app().putText({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_2',
      idempotencyKey: 'put-2', path: 'plan.md', text: '# v2', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    await app().finalize({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_2', idempotencyKey: 'final-2' });
    assert.equal((await app().readFile({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1', path: 'plan.md' })).toString(), '# v1');
    assert.equal((await app().readFile({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_2', path: 'plan.md' })).toString(), '# v2');
    await app().begin({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_3',
      idempotencyKey: 'begin-3', contextRevision: 'ctx_3', snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] });
    await app().putText({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_3',
      idempotencyKey: 'put-3', path: 'plan.md', text: '# v3', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    assert.throws(() => objects.finalize('bun_3', (manifest) => {
      db.publishBundle(manifest);
      throw new Error('crash after database commit');
    }), /crash after database commit/);
    db.close();
    db = new SqliteStore(file);
    assert.equal((await app().status({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_3' })).state, 'published');
    await app().begin({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_4', parentBundleId: 'bun_3',
      idempotencyKey: 'begin-4', contextRevision: 'ctx_4', snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] });
    const malformed = structuredClone(db.getBundle('bun_1')!.manifest!);
    malformed.files[0]!.normalizedRelativePath = 'plan.md/child';
    const malformedBytes = Buffer.from(JSON.stringify(malformed));
    const malformedHash = createHash('sha256').update(malformedBytes).digest('hex');
    const malformedObject = objects.objectPath(malformedHash);
    mkdirSync(dirname(malformedObject), { recursive: true });
    writeFileSync(malformedObject, malformedBytes);
    const tamper = new DatabaseSync(file);
    try { tamper.prepare('UPDATE bundles SET manifest_json=? WHERE id=?').run(JSON.stringify(malformed), 'bun_1'); }
    finally { tamper.close(); }
    assert.equal((await app().status({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_1' })).integrityStatus, 'corrupt');
    await assert.rejects(app().readFile({ context: ctx, workspaceId: ws, collaborationId: col,
      bundleId: 'bun_1', path: 'plan.md' }), /integrity_error/);
    const incomplete = structuredClone(db.getBundle('bun_2')!.manifest!);
    incomplete.files = [];
    const incompleteBytes = Buffer.from(JSON.stringify(incomplete));
    const incompleteObject = objects.objectPath(createHash('sha256').update(incompleteBytes).digest('hex'));
    mkdirSync(dirname(incompleteObject), { recursive: true });
    writeFileSync(incompleteObject, incompleteBytes);
    const tamperIncomplete = new DatabaseSync(file);
    try { tamperIncomplete.prepare('UPDATE bundles SET manifest_json=? WHERE id=?').run(JSON.stringify(incomplete), 'bun_2'); }
    finally { tamperIncomplete.close(); }
    assert.equal((await app().status({ context: ctx, workspaceId: ws, collaborationId: col, bundleId: 'bun_2' })).integrityStatus, 'corrupt');
    await assert.rejects(app().readFile({ context: ctx, workspaceId: ws, collaborationId: col,
      bundleId: 'bun_2', path: 'plan.md' }), /integrity_error/);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-art-db-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

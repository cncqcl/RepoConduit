import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { LocalArtifactSource, readBoundedLocalFile } from '../../src/adapters/transfers/local-source.js';
import { ArtifactApplication, type ArtifactDependencies } from '../../src/application/artifacts.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

function emptyZip(): Buffer {
  const name = Buffer.from('nested/report.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}

test('local collector preserves binary and ZIP bytes; export is private, complete, and repeatable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-local-art-'));
  const data = join(root, 'data');
  const workspace = join(root, 'workspace');
  let db = new SqliteStore(join(root, 'state.sqlite'));
  const ws = 'ws_a', col = 'col_a', bundleId = 'bun_a';
  const context = { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli' as const, now: new Date() };
  let crashAfterExportRename = false;
  try {
    mkdirSync(data); mkdirSync(workspace);
    db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: workspace, registeredBy: 'local' });
    db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'local', purpose: 'bundle', hostThreadId: null, state: 'open' });
    db.insertGrant({ id: 'grant', principal: 'local', audience: 'local-os', recipient: 'local', workspaceId: ws,
      collaborationId: col, permissions: ['artifact.submit', 'artifact.read', 'artifact.collect', 'artifact.export'], expiresAt: null, revokedAt: null });
    const { snapshotId } = await seedBundleProvenance(db, join(root, 'state.sqlite'), {
      workspaceId: ws, collaborationId: col, workingCopyId: 'copy-a', root: workspace, revisionIds: ['ctx_1'],
    });
    const objects = new ArtifactObjects(join(data, 'objects'));
    const locks = new BundleLocks();
    const dependencies: ArtifactDependencies = { objects,
      validateBundleReferences: input => db.validateBundleReferences(input),
      authorize: ({ context: ctx, operation, workspaceId, collaborationId }) => authorize(ctx, operation,
        { workspaceId, collaborationId }, db.grantsFor(ctx.principal, ctx.audience)),
      collaborationBelongsToWorkspace: (workspaceId, collaborationId) => db.collaborationBelongsToWorkspace(workspaceId, collaborationId),
      getBundle: id => db.getBundle(id), saveBundle: record => db.saveBundle(record), publishBundle: manifest => db.publishBundle(manifest),
      abortBundle: (id, state) => db.abortBundle(id, state),
      lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
      withBundleLock: (id, action) => locks.withBundleLock(id, action),
      runIdempotent: (scope, payload, mutation) => {
        if (scope.operation === 'artifact.export' && crashAfterExportRename) {
          crashAfterExportRename = false;
          throw new Error('synthetic receipt crash');
        }
        return db.runIdempotent(scope, payload, mutation);
      },
      exportRoot: join(data, 'exports'), forbiddenSourceRoots: () => [data, ...db.localSourceExclusionRoots()],
      registeredRoots: () => db.localSourceExclusionRoots(),
    };
    const artifact = new ArtifactApplication(dependencies);
    let dispatch = new DispatchService(db, undefined, undefined, { artifact });
    const scope = { workspaceId: ws, collaborationId: col };
    await dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: 'begin',
      payload: { bundleId, contextRevision: 'ctx_1', snapshotRefs: [snapshotId], expectedPaths: ['raw.bin', 'archive.zip'] } });
    const sourcePath = join(root, 'selected.bin');
    const bytes = Buffer.from([0, 255, 1, 128]);
    writeFileSync(sourcePath, bytes);
    const collect = { operation: 'artifact.collect_local', scope, idempotencyKey: 'collect',
      payload: { bundleId, path: 'raw.bin', mediaType: 'application/octet-stream' } };
    await assert.rejects(dispatch.dispatch(context, { ...collect, payload: { ...collect.payload, sourcePath } }), /Unknown payload field/);
    await assert.rejects(dispatch.dispatch({ ...context, surface: 'external_mcp' }, collect), /available/i);
    const source = new LocalArtifactSource(sourcePath);
    await assert.rejects(dispatch.dispatch({ ...context, principal: 'stranger' }, collect, undefined,
      new LocalArtifactSource(join(root, 'missing.bin'))), /available/i);
    const revokingSource = new (class extends LocalArtifactSource {
      override read(roots: readonly string[]) {
        const result = super.read(roots);
        db.revokeGrant('grant', new Date().toISOString());
        return result;
      }
    })(sourcePath);
    await assert.rejects(dispatch.dispatch(context, collect, undefined, revokingSource), /available/i);
    assert.equal(objects.status(bundleId).files.length, 0);
    db.insertGrant({ id: 'grant2', principal: 'local', audience: 'local-os', recipient: 'local', workspaceId: ws,
      collaborationId: col, permissions: ['artifact.submit', 'artifact.read', 'artifact.collect', 'artifact.export'], expiresAt: null, revokedAt: null });
    await assert.rejects(dispatch.dispatch(context, collect, { referenceIdentity: 'forged', mediaType: 'application/octet-stream',
      async acquireBytes() { return bytes; } }, source), /Local file selection unavailable/);
    const file = await dispatch.dispatch(context, collect, undefined, source) as { sha256: string; sourceReceipt: string };
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.sourceReceipt, 'manual_import');
    assert.deepEqual(await dispatch.dispatch(context, collect, undefined, source), file);
    writeFileSync(sourcePath, Buffer.from('changed'));
    await assert.rejects(dispatch.dispatch(context, collect, undefined, source), (error: { code?: string }) => error.code === 'CONFLICT');
    const zipPath = join(root, 'selected.zip'); const zip = emptyZip(); writeFileSync(zipPath, zip);
    await dispatch.dispatch(context, { ...collect, idempotencyKey: 'zip', payload: { bundleId, path: 'archive.zip', mediaType: 'application/zip' } },
      undefined, new LocalArtifactSource(zipPath));
    writeFileSync(sourcePath, bytes);
    await dispatch.dispatch(context, { operation: 'artifact.finalize', scope, idempotencyKey: 'finalize', payload: { bundleId } });
    assert.deepEqual(await dispatch.dispatch(context, collect, undefined, source), file);
    const manifest = db.getBundle(bundleId)!.manifest!;
    const expectedManifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const exportCommand = { operation: 'artifact.export', scope, idempotencyKey: 'export',
      payload: { bundleId, expectedManifestHash, exportName: 'review-v1' } };
    await assert.rejects(dispatch.dispatch(context, { ...exportCommand, payload: { ...exportCommand.payload, exportName: '../escape' } }), /Invalid artifact path|INVALID_ARGUMENT/);
    await assert.rejects(dispatch.dispatch(context, { ...exportCommand, payload: { ...exportCommand.payload, expectedManifestHash: '0'.repeat(64) } }), /BASELINE_MISMATCH/);
    const receipt = await dispatch.dispatch(context, exportCommand) as { path: string };
    assert.deepEqual(readFileSync(join(receipt.path, 'raw.bin')), bytes);
    assert.deepEqual(readFileSync(join(receipt.path, 'archive.zip')), zip);
    assert.deepEqual(await dispatch.dispatch(context, exportCommand), receipt);
    mkdirSync(join(data, 'exports', 'occupied'));
    await assert.rejects(dispatch.dispatch(context, { ...exportCommand, idempotencyKey: 'occupied',
      payload: { ...exportCommand.payload, exportName: 'occupied' } }), /CONFLICT/);
    crashAfterExportRename = true;
    const crashCommand = { ...exportCommand, idempotencyKey: 'crash-export',
      payload: { ...exportCommand.payload, exportName: 'review-recovered' } };
    await assert.rejects(dispatch.dispatch(context, crashCommand), /synthetic receipt crash/);
    db.close();
    db = new SqliteStore(join(root, 'state.sqlite'));
    dispatch = new DispatchService(db, undefined, undefined, { artifact });
    const recovered = await dispatch.dispatch(context, crashCommand) as { path: string };
    assert.deepEqual(readFileSync(join(recovered.path, 'archive.zip')), zip);
    truncateSync(join(recovered.path, 'raw.bin'), 32 * 1024 * 1024 + 1);
    await assert.rejects(dispatch.dispatch(context, crashCommand), /integrity_error/);
    writeFileSync(join(recovered.path, 'raw.bin'), bytes);
    mkdirSync(join(recovered.path, 'unexpected'));
    await assert.rejects(dispatch.dispatch(context, crashCommand), /integrity_error/);
    for (const [unsafeBundle, files] of [
      ['case-parent', [['Docs/a.txt', 'child', 'text/plain'], ['docs', 'parent', 'text/plain']]],
      ['case-directory', [['Docs/a.txt', 'first', 'text/plain'], ['docs/b.txt', 'second', 'text/plain']]],
    ] as const) {
      await assert.rejects(dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: `begin-${unsafeBundle}`,
        payload: { bundleId: unsafeBundle, contextRevision: 'ctx_1', snapshotRefs: [snapshotId],
          expectedPaths: files.map(([path]) => path) } }), /artifact path conflict/i);
      assert.equal(db.getBundle(unsafeBundle), null);
    }
    const receiptBundle = 'case-receipt';
    await dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: `begin-${receiptBundle}`,
      payload: { bundleId: receiptBundle, contextRevision: 'ctx_1', snapshotRefs: [snapshotId],
        expectedPaths: ['.RCAC-EXPORT-RECEIPT.JSON'] } });
    await dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: `put-${receiptBundle}`,
      payload: { bundleId: receiptBundle, path: '.RCAC-EXPORT-RECEIPT.JSON', text: '{}', mediaType: 'application/json' } });
    const receiptManifest = await dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
      idempotencyKey: `finalize-${receiptBundle}`, payload: { bundleId: receiptBundle } });
    await assert.rejects(dispatch.dispatch(context, { operation: 'artifact.export', scope,
      idempotencyKey: `export-${receiptBundle}`, payload: { bundleId: receiptBundle,
        expectedManifestHash: createHash('sha256').update(JSON.stringify(receiptManifest)).digest('hex'),
        exportName: receiptBundle } }), /Artifact path conflict/);
    const collisionName = 'collision-review';
    const collisionBundle = `export-${createHash('sha256').update(collisionName).digest('hex')}`;
    await dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: 'collision-begin',
      payload: { bundleId: collisionBundle, contextRevision: 'ctx_1', snapshotRefs: [snapshotId], expectedPaths: ['note.txt'] } });
    await dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: 'collision-put',
      payload: { bundleId: collisionBundle, path: 'note.txt', text: 'review', mediaType: 'text/plain' } });
    const collisionManifest = await dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
      idempotencyKey: 'collision-finalize', payload: { bundleId: collisionBundle } });
    const collisionExport = await dispatch.dispatch(context, { operation: 'artifact.export', scope,
      idempotencyKey: 'collision-export', payload: { bundleId: collisionBundle,
        expectedManifestHash: createHash('sha256').update(JSON.stringify(collisionManifest)).digest('hex'),
        exportName: collisionName } }) as { path: string };
    assert.equal(readFileSync(join(collisionExport.path, 'note.txt'), 'utf8'), 'review');
    writeFileSync(join(receipt.path, 'raw.bin'), 'tampered');
    await assert.rejects(dispatch.dispatch(context, exportCommand), /integrity_error/);
    db.insertWorkspace({ id: 'ws_nested', name: 'Nested', canonicalRoot: root, registeredBy: 'local' });
    const nestedExport = { ...exportCommand, idempotencyKey: 'nested-export',
      payload: { ...exportCommand.payload, exportName: 'inside-registered-root' } };
    await assert.rejects(dispatch.dispatch(context, nestedExport), /NOT_AVAILABLE/);
    assert.equal(existsSync(join(data, 'exports', 'inside-registered-root')), false);
    const unopenedExportRoot = join(data, 'unopened-exports');
    const unopenedArtifact = new ArtifactApplication({ ...dependencies, exportRoot: unopenedExportRoot });
    const unopenedDispatch = new DispatchService(db, undefined, undefined, { artifact: unopenedArtifact });
    await assert.rejects(unopenedDispatch.dispatch(context, { ...nestedExport, idempotencyKey: 'nested-unopened' }), /NOT_AVAILABLE/);
    assert.equal(existsSync(unopenedExportRoot), false);
    const hardlink = join(root, 'selected-hardlink'); linkSync(sourcePath, hardlink);
    assert.throws(() => new LocalArtifactSource(hardlink).read([data, workspace]), /source|file|link/i);
    const symlink = join(root, 'selected-link');
    try { symlinkSync(sourcePath, symlink); assert.throws(() => new LocalArtifactSource(symlink).read([data, workspace]), /source|file|link/i); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('local source rejects protected roots and oversized or nonregular selections', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-local-source-'));
  try {
    const protectedRoot = join(root, 'workspace');
    mkdirSync(protectedRoot);
    const privateFile = join(protectedRoot, 'private.bin'); writeFileSync(privateFile, 'private');
    assert.throws(() => new LocalArtifactSource(privateFile).read([protectedRoot]), /protected root/);
    assert.throws(() => new LocalArtifactSource(protectedRoot).read([]), /regular file/);
    const large = join(root, 'large.bin');
    writeFileSync(large, ''); truncateSync(large, 32 * 1024 * 1024 + 1);
    assert.throws(() => new LocalArtifactSource(large).read([]), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local byte acquisition stops at the first byte over budget if a source grows during reading', () => {
  const max = 32 * 1024 * 1024;
  let supplied = 0;
  let maximumRequested = 0;
  assert.throws(() => readBoundedLocalFile(123, (_fd, chunk, offset, length) => {
    maximumRequested = Math.max(maximumRequested, length);
    chunk.fill(0x4a, offset, offset + length);
    supplied += length;
    return length;
  }), /File budget exceeded/);
  assert.equal(supplied, max + 1);
  assert.ok(maximumRequested <= 64 * 1024);
});

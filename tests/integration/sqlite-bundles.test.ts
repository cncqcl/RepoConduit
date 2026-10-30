import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { BundleInput, BundleManifest } from '../../src/core/artifact/types.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('bundle publication is immutable and parent remains accessible after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-db-'));
  const file = join(dir, 'state.sqlite');
  let db = new SqliteStore(file);
  try {
    db.insertWorkspace({ id: 'ws_a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col_a', workspaceId: 'ws_a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(db, file, { workspaceId: 'ws_a',
      collaborationId: 'col_a', workingCopyId: 'copy_a', root: dir, revisionIds: ['ctx_a'] });
    const input: BundleInput = { bundleId: 'bun_1', workspaceId: 'ws_a', collaborationId: 'col_a',
      contextRevision: 'ctx_a', snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] };
    const manifest: BundleManifest = { ...input, expectedSetBasis: 'producer_declared', semanticStatus: 'not_reviewed',
      files: [{ normalizedRelativePath: 'plan.md', actualSizeBytes: 3, sha256: 'a'.repeat(64), mediaType: 'text/markdown', sourceReceipt: 'platform_file_reference', sourceIdentity: 'opaque-source-1' }] };
    db.saveBundle({ input });
    db.publishBundle(manifest);
    db.close();
    db = new SqliteStore(file);
    assert.deepEqual(db.getBundle('bun_1')?.manifest, manifest);
    assert.equal(db.getBundle('bun_1')?.manifest?.files[0]?.sourceIdentity, 'opaque-source-1');
    const inspection = new DatabaseSync(file);
    try {
      const row = inspection.prepare('SELECT source_identity FROM bundle_files WHERE bundle_id=? AND path=?')
        .get('bun_1', 'plan.md') as { source_identity: string };
      assert.equal(row.source_identity, 'opaque-source-1');
    } finally { inspection.close(); }
    assert.doesNotThrow(() => db.publishBundle(manifest));
    assert.throws(() => db.publishBundle({ ...manifest, contextRevision: 'ctx_other' }), /CONFLICT/);
    db.saveBundle({ input: { ...input, bundleId: 'bun_2', parentBundleId: 'bun_1' } });
    assert.equal(db.getBundle('bun_2')?.input.parentBundleId, 'bun_1');
    assert.throws(() => db.saveBundle({ input: { ...input, bundleId: 'bun_3', parentBundleId: 'missing' } }));
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-bundle-db-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy published bundle survives nullable source identity migration without manifest rewrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-migrate-'));
  const file = join(dir, 'state.sqlite');
  try {
    let db = new SqliteStore(file);
    db.insertWorkspace({ id: 'ws_old', name: 'Old', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col_old', workspaceId: 'ws_old', openedBy: 'owner', purpose: 'archive', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(db, file, { workspaceId: 'ws_old',
      collaborationId: 'col_old', workingCopyId: 'copy_old', root: dir, revisionIds: ['ctx_old'] });
    const input: BundleInput = { bundleId: 'bun_old', workspaceId: 'ws_old', collaborationId: 'col_old',
      contextRevision: 'ctx_old', snapshotRefs: [snapshotId], expectedPaths: ['old.txt'] };
    const oldManifest: BundleManifest = { ...input, expectedSetBasis: 'producer_declared', semanticStatus: 'not_reviewed',
      files: [{ normalizedRelativePath: 'old.txt', actualSizeBytes: 3, sha256: 'b'.repeat(64),
        mediaType: 'text/plain', sourceReceipt: 'text_set_mcp' }] };
    db.saveBundle({ input });
    db.publishBundle(oldManifest);
    db.close();
    const legacy = new DatabaseSync(file);
    const original = (legacy.prepare('SELECT manifest_json FROM bundles WHERE id=?').get('bun_old') as { manifest_json: string }).manifest_json;
    legacy.exec('ALTER TABLE bundle_files DROP COLUMN source_identity');
    legacy.close();
    db = new SqliteStore(file);
    assert.deepEqual(db.getBundle('bun_old')?.manifest, oldManifest);
    db.close();
    const inspect = new DatabaseSync(file);
    try {
      const columns = inspect.prepare('PRAGMA table_info(bundle_files)').all() as { name: string }[];
      assert.ok(columns.some(column => column.name === 'source_identity'));
      assert.equal((inspect.prepare('SELECT manifest_json FROM bundles WHERE id=?').get('bun_old') as { manifest_json: string }).manifest_json, original);
      assert.equal((inspect.prepare('SELECT source_identity FROM bundle_files WHERE bundle_id=?').get('bun_old') as { source_identity: string | null }).source_identity, null);
    } finally { inspect.close(); }
  } finally {
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-bundle-migrate-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

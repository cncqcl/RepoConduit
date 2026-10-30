import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';

test('declared multi-file bundle remains staging until complete and preserves v1/v2 bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-'));
  try {
    const store = new ArtifactObjects(root);
    store.begin({ bundleId: 'v1', workspaceId: 'w', collaborationId: 'c', contextRevision: 'ctx1', snapshotRefs: ['s1'], expectedPaths: ['plan.md', 'assets/chart.png'] });
    store.putText('v1', 'plan.md', '# Plan', 'text/markdown', 'text_set_mcp');
    assert.deepEqual(store.status('v1').missingPaths, ['assets/chart.png']);
    assert.throws(() => store.finalize('v1', () => {}), /missing/i);
    const binary = Buffer.from([0, 1, 255, 42]);
    store.putBytes('v1', 'assets/chart.png', binary, 'application/octet-stream', 'native_file_reference');
    let published = 0;
    const first = store.finalize('v1', () => { published++; });
    assert.equal(published, 1);
    assert.equal(first.files.length, 2);
    assert.deepEqual(readFileSync(store.objectPath(first.files[0]!.sha256)).length > 0, true);
    assert.deepEqual(store.readFile('v1', 'assets/chart.png'), binary);
    store.begin({ bundleId: 'v2', workspaceId: 'w', collaborationId: 'c', contextRevision: 'ctx2', snapshotRefs: ['s1'], parentBundleId: 'v1', expectedPaths: ['plan.md'] });
    store.putText('v2', 'plan.md', '# Revised', 'text/markdown', 'text_set_mcp');
    const second = store.finalize('v2', () => { published++; });
    assert.equal(second.parentBundleId, 'v1');
    assert.equal(published, 2);
    assert.equal(store.readFile('v1', 'plan.md').toString(), '# Plan');
    assert.equal(store.readFile('v2', 'plan.md').toString(), '# Revised');
    assert.throws(() => store.putText('v1', 'plan.md', 'changed', 'text/markdown', 'text_set_mcp'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same path retries are idempotent only for identical bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-'));
  try {
    const store = new ArtifactObjects(root);
    store.begin({ bundleId: 'b', workspaceId: 'w', collaborationId: 'c', contextRevision: 'ctx', snapshotRefs: [], expectedPaths: ['a.md'] });
    const first = store.putText('b', 'a.md', 'one', 'text/markdown', 'text_set_mcp');
    assert.deepEqual(store.putText('b', 'a.md', 'one', 'text/markdown', 'text_set_mcp'), first);
    assert.throws(() => store.putText('b', 'a.md', 'two', 'text/markdown', 'text_set_mcp'), /conflict/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

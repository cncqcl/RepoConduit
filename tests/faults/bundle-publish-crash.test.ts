import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';

test('failed publication callback leaves complete staging recoverable and unpublished', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-'));
  try {
    const store = new ArtifactObjects(root);
    store.begin({ bundleId: 'b', workspaceId: 'w', collaborationId: 'c', contextRevision: 'ctx', snapshotRefs: [], expectedPaths: ['a.md'] });
    store.putText('b', 'a.md', 'hello', 'text/markdown', 'text_set_mcp');
    assert.throws(() => store.finalize('b', () => { throw new Error('database crash'); }), /database crash/);
    const recovered = new ArtifactObjects(root);
    assert.equal(recovered.status('b').state, 'staging');
    assert.equal(recovered.status('b').missingPaths.length, 0);
    recovered.finalize('b', () => {});
    assert.equal(recovered.status('b').state, 'published');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

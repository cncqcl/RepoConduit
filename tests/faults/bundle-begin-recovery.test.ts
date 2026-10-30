import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';

test('begin recovers exact filesystem orphan without accepting changed identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-artifacts-'));
  const input = { bundleId: 'b1', workspaceId: 'ws_a', collaborationId: 'col_a', contextRevision: 'ctx_a', snapshotRefs: ['snp_a'], expectedPaths: ['plan.md'] };
  try {
    new ArtifactObjects(dir).begin(input); // crash before SQLite saveBundle
    const recovered = new ArtifactObjects(dir);
    assert.equal(recovered.begin(input).state, 'staging');
    assert.throws(() => recovered.begin({ ...input, collaborationId: 'col_b' }), /conflict/i);
  } finally {
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-artifacts-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

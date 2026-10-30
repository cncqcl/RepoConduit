import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { ArtifactApplication, type ArtifactDependencies, type ArtifactRecord } from '../../src/application/artifacts.js';
import type { RequestContext } from '../../src/core/policy/authorize.js';

const context: RequestContext = { principal: 'alice', audience: 'external', surface: 'external_mcp', recipient: 'alice', now: new Date() };

test('failed DB publication stays staging; published corruption retains state and reports integrity error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-recovery-'));
  try {
    const objects = new ArtifactObjects(root);
    const records = new Map<string, ArtifactRecord>();
    let fail = true;
    let commitThenThrow = false;
    const deps: ArtifactDependencies = {
      objects,
      authorize({ context: ctx, operation, workspaceId, collaborationId }) { return { grantId: 'g', operation, effect: operation === 'artifact.status' ? 'read' : 'artifact_write', scope: { workspaceId, collaborationId }, principal: ctx.principal, recipient: ctx.recipient }; },
      collaborationBelongsToWorkspace() { return true; },
      validateBundleReferences(input) {
        if (input.workspaceId !== 'ws' || input.collaborationId !== 'col' || input.contextRevision !== 'ctx' ||
          input.snapshotRefs.length !== 1 || input.snapshotRefs[0] !== 's') throw new Error('NOT_AVAILABLE');
      },
      getBundle(id) { return records.get(id) ?? null; },
      saveBundle(record) { records.set(record.input.bundleId, record); },
      publishBundle(manifest) { if (fail) throw new Error('database crash'); const record = records.get(manifest.bundleId)!; records.set(manifest.bundleId, { ...record, manifest, integrityStatus: 'ok' }); if (commitThenThrow) throw new Error('marker crash'); },
      abortBundle(id, state) { const record = records.get(id)!; records.set(id, { ...record, abortedState: state }); },
      lookupIdempotent<T>(): T | null { return null; },
      withBundleLock(_id, action) { return action(); },
      runIdempotent(_scope, _payload, mutation) { return mutation(); },
    };
    const app = new ArtifactApplication(deps);
    const bound = { context, workspaceId: 'ws', collaborationId: 'col', bundleId: 'b' };
    await app.begin({ ...bound, contextRevision: 'ctx', snapshotRefs: ['s'], expectedPaths: ['a.md'], idempotencyKey: 'begin' });
    const file = await app.putText({ ...bound, idempotencyKey: 'put', path: 'a.md', text: 'hello', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    await assert.rejects(app.finalize({ ...bound, idempotencyKey: 'finish' }), /database crash/);
    assert.equal(objects.status('b').state, 'staging');
    fail = false;
    commitThenThrow = true;
    await assert.rejects(app.finalize({ ...bound, idempotencyKey: 'finish' }), /marker crash/);
    assert.equal(objects.status('b').state, 'staging');
    commitThenThrow = false;
    assert.equal((await app.status(bound)).state, 'published');
    assert.equal(objects.status('b').state, 'staging');
    assert.equal((await app.readFile({ ...bound, path: 'a.md' })).toString(), 'hello');
    const committed = records.get('b');
    unlinkSync(objects.objectPath(file.sha256));
    const status = await app.status(bound);
    assert.equal(status.state, 'published');
    assert.equal(status.integrityStatus, 'missing');
    assert.equal(records.get('b'), committed);
    await assert.rejects(app.readFile({ ...bound, path: 'a.md' }), /integrity_error/);
    writeFileSync(objects.objectPath(file.sha256), 'wrong');
    assert.equal((await app.status(bound)).integrityStatus, 'corrupt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('begin recovers after staging file landed but DB transaction failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-orphan-'));
  try {
    const objects = new ArtifactObjects(root);
    let failSave = true;
    let record: ArtifactRecord | null = null;
    const deps: ArtifactDependencies = {
      objects,
      authorize({ context: ctx, operation, workspaceId, collaborationId }) { return { grantId: 'g', operation, effect: operation === 'artifact.status' ? 'read' : 'artifact_write', scope: { workspaceId, collaborationId }, principal: ctx.principal, recipient: ctx.recipient }; },
      collaborationBelongsToWorkspace() { return true; },
      validateBundleReferences(input) {
        if (input.workspaceId !== 'ws' || input.collaborationId !== 'col' || input.contextRevision !== 'ctx' ||
          input.snapshotRefs.length !== 1 || input.snapshotRefs[0] !== 's') throw new Error('NOT_AVAILABLE');
      },
      getBundle() { return record; },
      saveBundle(value) { if (failSave) throw new Error('database crash'); record = value; },
      publishBundle() {},
      abortBundle(_id, state) { record = record ? { ...record, abortedState: state } : null; },
      lookupIdempotent<T>(): T | null { return null; },
      withBundleLock(_id, action) { return action(); },
      runIdempotent(_scope, _payload, mutation) { return mutation(); },
    };
    const app = new ArtifactApplication(deps);
    const request = { context, workspaceId: 'ws', collaborationId: 'col', bundleId: 'orphan', contextRevision: 'ctx', snapshotRefs: ['s'], expectedPaths: ['a.md'], idempotencyKey: 'begin' };
    await assert.rejects(app.begin(request), /database crash/);
    assert.equal(objects.status('orphan').state, 'staging');
    failSave = false;
    assert.equal((await app.begin(request)).state, 'staging');
    assert.ok(record);
    await assert.rejects(app.begin({ ...request, expectedPaths: ['other.md'] }), /CONFLICT|different/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

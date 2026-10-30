import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { ArtifactApplication, type ArtifactDependencies, type ArtifactRecord } from '../../src/application/artifacts.js';
import type { Permit, RequestContext } from '../../src/core/policy/authorize.js';

const context: RequestContext = { principal: 'alice', audience: 'external', surface: 'external_mcp', recipient: 'alice', now: new Date() };
const binding = { workspaceId: 'ws', collaborationId: 'col' };
const input = { bundleId: 'v1', ...binding, contextRevision: 'ctx', snapshotRefs: ['s'], expectedPaths: ['plan.md'] };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-app-'));
  const records = new Map<string, ArtifactRecord>();
  const calls: string[] = [];
  const idem = new Map<string, { payload: string; result: unknown }>();
  let revoked = false;
  let referencesValid = true;
  let validatedReferences = 0;
  let publishCount = 0;
  const objects = new ArtifactObjects(root);
  const deps: ArtifactDependencies = {
    objects,
    authorize(request) {
      calls.push(request.operation);
      if (revoked) throw new Error('NOT_AVAILABLE');
      const permit: Permit = { grantId: 'g', operation: request.operation, effect: request.operation === 'artifact.status' ? 'read' : 'artifact_write', scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId }, principal: request.context.principal, recipient: request.context.recipient };
      return permit;
    },
    async collaborationBelongsToWorkspace(ws, col) { return ws === 'ws' && col === 'col'; },
    validateBundleReferences(value) {
      validatedReferences++;
      if (!referencesValid || value.workspaceId !== 'ws' || value.collaborationId !== 'col' ||
        value.contextRevision !== 'ctx' || value.snapshotRefs.length !== 1 || value.snapshotRefs[0] !== 's') throw new Error('NOT_AVAILABLE');
    },
    getBundle(id) { return records.get(id) ?? null; },
    saveBundle(record) { if (records.has(record.input.bundleId)) throw new Error('CONFLICT'); records.set(record.input.bundleId, structuredClone(record)); },
    publishBundle(manifest) { publishCount++; const record = records.get(manifest.bundleId)!; records.set(manifest.bundleId, { ...record, manifest, integrityStatus: 'ok' }); },
    abortBundle(id, state) { const record = records.get(id)!; records.set(id, { ...record, abortedState: state }); },
    lookupIdempotent<T>(scope: Parameters<ArtifactDependencies['lookupIdempotent']>[0], payload: unknown): T | null {
      const key = [scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey].join(':');
      const prior = idem.get(key);
      if (!prior) return null;
      if (prior.payload !== JSON.stringify(payload)) throw new Error('CONFLICT');
      return prior.result as T;
    },
    withBundleLock(_id, action) { return action(); },
    runIdempotent(scope, payload, mutation) {
      const key = [scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey].join(':');
      const encoded = JSON.stringify(payload);
      const prior = idem.get(key);
      if (prior) { if (prior.payload !== encoded) throw new Error('CONFLICT'); return prior.result as ReturnType<typeof mutation>; }
      const result = mutation();
      idem.set(key, { payload: encoded, result });
      return result;
    },
  };
  return { app: new ArtifactApplication(deps), deps, objects, records, calls, cleanup: () => rmSync(root, { recursive: true, force: true }), revoke: () => { revoked = true; }, invalidateReferences: () => { referencesValid = false; }, get validatedReferences() { return validatedReferences; }, get publishCount() { return publishCount; } };
}

test('begin validates context and snapshot references before creating staging', async () => {
  const f = fixture();
  try {
    f.invalidateReferences();
    await assert.rejects(f.app.begin({ context, ...input, idempotencyKey: 'begin' }), /NOT_AVAILABLE/);
    assert.equal(f.records.size, 0);
    assert.throws(() => f.objects.status('v1'), /Unknown bundle/);
    assert.equal(f.validatedReferences, 1);
  } finally { f.cleanup(); }
});

test('finalize revalidates persisted references before publishing a preexisting staging bundle', async () => {
  const f = fixture();
  try {
    const request = { context, ...input, idempotencyKey: 'begin' };
    await f.app.begin(request);
    await f.app.putText({ context, ...binding, bundleId: 'v1', idempotencyKey: 'put', path: 'plan.md',
      text: '# plan', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    f.invalidateReferences();
    await assert.rejects(f.app.finalize({ context, ...binding, bundleId: 'v1', idempotencyKey: 'finalize' }), /NOT_AVAILABLE/);
    assert.equal(f.publishCount, 0);
    assert.equal(f.objects.status('v1').state, 'staging');
    assert.equal(f.validatedReferences, 2);
  } finally { f.cleanup(); }
});

test('begin, put, finalize bind every action and retain immutable manifest on idempotent retry', async () => {
  const f = fixture();
  try {
    const begin = { context, ...input, idempotencyKey: 'begin' };
    assert.equal((await f.app.begin(begin)).state, 'staging');
    assert.equal((await f.app.begin(begin)).state, 'staging');
    await assert.rejects(f.app.begin({ ...begin, expectedPaths: ['different.md'] }), /CONFLICT/);
    const put = { context, ...binding, bundleId: 'v1', idempotencyKey: 'put', path: 'plan.md', text: '# plan', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' };
    const file = await f.app.putText(put);
    assert.deepEqual(await f.app.putText(put), file);
    await assert.rejects(f.app.putText({ ...put, text: '# changed' }), /CONFLICT/);
    const finalize = { context, ...binding, bundleId: 'v1', idempotencyKey: 'finalize' };
    const first = await f.app.finalize(finalize);
    assert.equal(first.semanticStatus, 'not_reviewed');
    assert.deepEqual(await f.app.finalize(finalize), first);
    assert.equal(f.publishCount, 1);
    assert.equal((await f.app.status({ context, ...binding, bundleId: 'v1' })).integrityStatus, 'ok');
    assert.deepEqual(f.objects.readFile('v1', 'plan.md'), Buffer.from('# plan'));
  } finally { f.cleanup(); }
});

test('revocation while waiting for a bundle lock prevents publication', async () => {
  const f = fixture();
  try {
    await f.app.begin({ context, ...input, idempotencyKey: 'begin' });
    await f.app.putText({ context, ...binding, bundleId: 'v1', idempotencyKey: 'put',
      path: 'plan.md', text: '# plan', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = new ArtifactApplication({ ...f.deps, withBundleLock: async (_id, action) => {
      entered();
      await gate;
      return action();
    } });
    const publication = app.finalize({ context, ...binding, bundleId: 'v1', idempotencyKey: 'finalize' });
    await waiting;
    f.revoke();
    release();
    await assert.rejects(publication, /NOT_AVAILABLE/);
    assert.equal(f.publishCount, 0);
    assert.equal(f.objects.status('v1').state, 'staging');
  } finally { f.cleanup(); }
});

test('cross collaboration access and revoked replay disclose nothing', async () => {
  const f = fixture();
  try {
    await f.app.begin({ context, ...input, idempotencyKey: 'begin' });
    await assert.rejects(f.app.status({ context, workspaceId: 'ws', collaborationId: 'other', bundleId: 'v1' }), /NOT_AVAILABLE/);
    await assert.rejects(f.app.putText({ context, workspaceId: 'ws', collaborationId: 'other', bundleId: 'v1', idempotencyKey: 'put', path: 'plan.md', text: 'x', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' }), /NOT_AVAILABLE/);
    f.revoke();
    await assert.rejects(f.app.begin({ context, ...input, idempotencyKey: 'begin' }), /NOT_AVAILABLE/);
    await assert.rejects(f.app.status({ context, ...binding, bundleId: 'v1' }), /NOT_AVAILABLE/);
  } finally { f.cleanup(); }
});

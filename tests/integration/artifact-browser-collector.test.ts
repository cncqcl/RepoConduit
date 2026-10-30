import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactApplication, type ArtifactDependencies, type ArtifactRecord } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import type { RequestContext } from '../../src/core/policy/authorize.js';

const bytes = Buffer.from('receiver expected exact bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const context: RequestContext = { principal: 'local-user', audience: 'local-os', recipient: 'local-user', surface: 'local_cli', now: new Date() };
const request = { context, workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', path: 'result.txt',
  nativeSessionId: '11111111-1111-4111-8111-111111111111', nativeMessageId: '00000000-0000-4000-8000-000000000101',
  filename: 'result.txt', expectedSha256: hash, expectedSize: bytes.length, idempotencyKey: 'collect' };

function fixture(expectedPaths: string[] | null = ['result.txt']) {
  const directory = mkdtempSync(join(tmpdir(), 'rcac-browser-app-'));
  const objects = new ArtifactObjects(directory);
  const input = { workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', contextRevision: 'ctx', snapshotRefs: ['snapshot'], ...(expectedPaths ? { expectedPaths } : {}) };
  objects.begin(input);
  const record: ArtifactRecord = { input };
  const results = new Map<string, { payload: string; result: unknown }>();
  let grant = 'original', captures = 0, reads = 0, onCapture = () => {}, corrupt = false;
  const dependencies: ArtifactDependencies = {
    objects, authorize(r) { reads++; if (grant === 'revoked') throw new Error('NOT_AVAILABLE');
      return { grantId: grant, operation: r.operation, effect: 'artifact_transfer', scope: r,
        principal: r.context.principal, recipient: r.context.recipient }; },
    collaborationBelongsToWorkspace: () => true,
    validateBundleReferences: () => {}, getBundle: id => id === 'bundle' ? record : null,
    saveBundle: () => {}, publishBundle: () => {}, abortBundle: () => {},
    withBundleLock: (_id, action) => action(),
    lookupIdempotent<T>(scope: Parameters<ArtifactDependencies['lookupIdempotent']>[0], payload: unknown): T | null {
      const prior = results.get(scope.idempotencyKey);
      if (prior && prior.payload !== JSON.stringify(payload)) throw new Error('CONFLICT');
      return prior?.result as T ?? null;
    },
    runIdempotent(scope, payload, mutation) {
      const result = mutation(); results.set(scope.idempotencyKey, { payload: JSON.stringify(payload), result }); return result;
    },
    browserCollector: { async capture(r) {
      if (r.retryOfCaptureId && r.requireExistingCapture) throw new Error('CONFLICT');
      captures++; await r.assertAuthority(); onCapture();
      return { bytes: corrupt ? Buffer.from('wrong') : bytes, sha256: hash, sourceIdentity: hash };
    } },
  };
  return { app: new ArtifactApplication(dependencies), objects, record, dependencies,
    get captures() { return captures; }, get reads() { return reads; },
    setGrant(value: string) { grant = value; }, setCapture(action: () => void) { onCapture = action; },
    corrupt() { corrupt = true; }, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('browser collector stages exact bytes through shared objects and retry does not click again', async () => {
  const f = fixture();
  try {
    const first = await f.app.collectBrowser(request);
    assert.equal(first.sourceReceipt, 'authorized_local_collector');
    assert.equal(first.sha256, hash);
    assert.deepEqual(await f.app.collectBrowser(request), first);
    assert.equal(f.captures, 1);
    assert.ok(f.reads >= 7);
  } finally { f.close(); }
});

test('attachment index reaches collector and binds application idempotency', async () => {
  const f = fixture();
  try {
    const original = f.dependencies.browserCollector!.capture;
    let observed: unknown;
    f.dependencies.browserCollector!.capture = r => { observed = (r as { attachmentIndex?: number }).attachmentIndex; return original(r); };
    await f.app.collectBrowser({ ...request, attachmentIndex: 7 });
    assert.equal(observed, 7);
    await assert.rejects(f.app.collectBrowser({ ...request, attachmentIndex: 2 }), /CONFLICT/);
    assert.equal(f.captures, 1);
  } finally { f.close(); }
});

for (const attachmentIndex of [-1, 64, 0.5, NaN, undefined]) {
  test(`invalid explicit attachment index ${attachmentIndex} refuses before collector`, async () => {
    const f = fixture();
    try {
      await assert.rejects(f.app.collectBrowser({ ...request, attachmentIndex } as Parameters<ArtifactApplication['collectBrowser']>[0]), /NOT_AVAILABLE/);
      assert.equal(f.captures, 0);
    } finally { f.close(); }
  });
}

test('retry refuses occupied staging path and synchronous fence prevents late publication', async () => {
  const f = fixture();
  try {
    const retry = { ...request, idempotencyKey: 'retry', retryOfCaptureId: 'a'.repeat(64) };
    f.dependencies.browserCollector!.assertCaptureWritable = () => { throw new Error('CONFLICT'); };
    await assert.rejects(f.app.collectBrowser(retry), /CONFLICT/);
    assert.deepEqual(f.objects.status('bundle').missingPaths, ['result.txt']);
    assert.equal(f.captures, 1);
    f.dependencies.browserCollector!.assertCaptureWritable = () => {};
    await f.app.collectBrowser(request);
    await assert.rejects(f.app.collectBrowser(retry), /NOT_AVAILABLE/);
    assert.equal(f.captures, 2);
  } finally { f.close(); }
});

test('reconcile-only requires a current local grant before any collector call', async () => {
  const f = fixture();
  const reconcileOnly = { ...request, idempotencyKey: 'reconcile-new-key',
    reconcileOnly: { captureIntentId: 'a'.repeat(64) } };
  try {
    await assert.rejects(f.app.collectBrowser({ ...reconcileOnly,
      context: { ...context, surface: 'external_mcp' } }), /NOT_AVAILABLE/);
    f.setGrant('revoked');
    await assert.rejects(f.app.collectBrowser(reconcileOnly), /NOT_AVAILABLE/);
    f.setGrant('original');
    await assert.rejects(f.app.collectBrowser({ ...reconcileOnly, retryOfCaptureId: 'b'.repeat(64) }), /NOT_AVAILABLE/);
    await assert.rejects(f.app.collectBrowser({ ...reconcileOnly,
      reconcileOnly: { captureIntentId: 'bad' } }), /NOT_AVAILABLE/);
    assert.equal(f.captures, 0);
    assert.deepEqual(f.objects.status('bundle').missingPaths, ['result.txt']);
  } finally { f.close(); }
});

for (const change of ['external', 'missing_collector', 'bad_hash', 'bad_size', 'bad_path', 'wrong_binding'] as const) {
  test(`browser collector rejects ${change} before any capture`, async () => {
    const f = fixture();
    try {
      const changed = { ...request, context: { ...context } };
      if (change === 'external') changed.context.surface = 'external_mcp';
      if (change === 'missing_collector') delete f.dependencies.browserCollector;
      if (change === 'bad_hash') changed.expectedSha256 = 'fake';
      if (change === 'bad_size') changed.expectedSize = 32 * 1024 * 1024 + 1;
      if (change === 'bad_path') changed.path = '../outside';
      if (change === 'wrong_binding') changed.collaborationId = 'other';
      await assert.rejects(f.app.collectBrowser(changed));
      assert.equal(f.captures, 0);
    } finally { f.close(); }
  });
}

for (const change of ['revoked', 'replacement'] as const) {
  test(`browser collector ${change} grant after acquisition cannot stage`, async () => {
    const f = fixture();
    try {
      f.setCapture(() => f.setGrant(change));
      await assert.rejects(f.app.collectBrowser(request), /NOT_AVAILABLE/);
      assert.deepEqual(f.objects.status('bundle').missingPaths, ['result.txt']);
    } finally { f.close(); }
  });
}

test('completed collection cannot replay under a replacement grant or changed destination', async () => {
  const f = fixture();
  try {
    await f.app.collectBrowser(request);
    await assert.rejects(f.app.collectBrowser({ ...request, path: 'other.txt' }), /CONFLICT/);
    f.setGrant('replacement');
    await assert.rejects(f.app.collectBrowser(request), /CONFLICT/);
    assert.equal(f.captures, 1);
  } finally { f.close(); }
});

test('collector supplied wrong bytes are rejected before staging', async () => {
  const f = fixture();
  try { f.corrupt(); await assert.rejects(f.app.collectBrowser(request), /NOT_AVAILABLE/);
    assert.deepEqual(f.objects.status('bundle').missingPaths, ['result.txt']);
  } finally { f.close(); }
});

test('published bundle cannot initiate a new browser capture', async () => {
  const f = fixture();
  try { f.record.manifest = {} as NonNullable<ArtifactRecord['manifest']>;
    await assert.rejects(f.app.collectBrowser(request), /immutable/); assert.equal(f.captures, 0);
  } finally { f.close(); }
});

test('missing artifact receipt cannot change stable capture identity when grant or payload changes', async () => {
  const f = fixture();
  const ids: string[] = [];
  try {
    const original = f.dependencies.browserCollector!.capture;
    f.dependencies.browserCollector!.capture = async r => { ids.push(r.id); return original(r); };
    f.dependencies.runIdempotent = () => { throw new Error('receipt unavailable'); };
    await assert.rejects(f.app.collectBrowser(request), /receipt unavailable/);
    f.setGrant('replacement');
    await assert.rejects(f.app.collectBrowser({ ...request, filename: 'other.txt' }), /receipt unavailable/);
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  } finally { f.close(); }
});

test('undeclared browser destination is rejected before capture', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.app.collectBrowser({ ...request, path: 'other.txt' }), /declared/);
    assert.equal(f.captures, 0);
  } finally { f.close(); }
});

for (const path of ['result.txt/child.txt', 'RESULT.TXT', 'directory']) {
  test(`known browser destination conflict ${path} is rejected before capture`, async () => {
    const f = fixture(null);
    try {
      f.objects.putText('bundle', path === 'directory' ? 'directory/child.txt' : 'result.txt', 'existing', 'text/plain', 'manual_import');
      await assert.rejects(f.app.collectBrowser({ ...request, path }));
      assert.equal(f.captures, 0);
    } finally { f.close(); }
  });
}

test('existing different bytes cannot start a browser capture', async () => {
  const f = fixture();
  try {
    f.objects.putText('bundle', 'result.txt', 'existing', 'text/plain', 'manual_import');
    await assert.rejects(f.app.collectBrowser(request), /conflict/i);
    assert.equal(f.captures, 0);
  } finally { f.close(); }
});

test('staged original browser file can recover its missing application receipt', async () => {
  const f = fixture();
  try {
    f.objects.putBytes('bundle', 'result.txt', bytes, 'application/octet-stream', 'authorized_local_collector', hash);
    const file = await f.app.collectBrowser(request);
    assert.equal(file.sha256, hash);
    assert.equal(f.captures, 1);
    await f.app.collectBrowser(request);
    assert.equal(f.captures, 1);
  } finally { f.close(); }
});

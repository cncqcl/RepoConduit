import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { ArtifactApplication, type ArtifactDependencies, type ArtifactRecord } from '../../src/application/artifacts.js';
import type { Permit, RequestContext } from '../../src/core/policy/authorize.js';

const context: RequestContext = { principal: 'alice', audience: 'external', surface: 'external_mcp', recipient: 'alice', now: new Date() };
const binding = { workspaceId: 'ws', collaborationId: 'col', bundleId: 'v1' };
const binary = Buffer.from([0, 255, 19, 0, 128]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rcac-reference-'));
  const records = new Map<string, ArtifactRecord>();
  const idem = new Map<string, { payload: string; result: unknown }>();
  const objects = new ArtifactObjects(root);
  let revoked = false;
  let downloads = 0;
  const deps: ArtifactDependencies = {
    objects,
    async authorize(request) {
      await request.context.assertFreshAuthority?.();
      if (revoked) throw new Error('NOT_AVAILABLE');
      const permit: Permit = { grantId: 'g', operation: request.operation, effect: request.operation === 'artifact.import_reference' ? 'artifact_transfer' : 'artifact_write', scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId }, principal: request.context.principal, recipient: request.context.recipient };
      return permit;
    },
    collaborationBelongsToWorkspace: () => true,
    validateBundleReferences(input) {
      if (input.workspaceId !== 'ws' || input.collaborationId !== 'col' || input.contextRevision !== 'ctx' ||
        input.snapshotRefs.length !== 1 || input.snapshotRefs[0] !== 's') throw new Error('NOT_AVAILABLE');
    },
    getBundle: (id) => records.get(id) ?? null,
    saveBundle: (record) => { records.set(record.input.bundleId, structuredClone(record)); },
    publishBundle: (manifest) => { const record = records.get(manifest.bundleId)!; records.set(manifest.bundleId, { ...record, manifest }); },
    abortBundle: (id, state) => { const record = records.get(id)!; records.set(id, { ...record, abortedState: state }); },
    lookupIdempotent<T>(scope: Parameters<ArtifactDependencies['lookupIdempotent']>[0], payload: unknown): T | null {
      const key = [scope.operation, scope.idempotencyKey].join(':');
      const prior = idem.get(key);
      if (!prior) return null;
      if (prior.payload !== JSON.stringify(payload)) throw new Error('CONFLICT');
      return prior.result as T;
    },
    withBundleLock: (_id, action) => action(),
    runIdempotent(scope, payload, mutation) {
      const key = [scope.operation, scope.idempotencyKey].join(':');
      const encoded = JSON.stringify(payload);
      const prior = idem.get(key);
      if (prior) { if (prior.payload !== encoded) throw new Error('CONFLICT'); return prior.result as ReturnType<typeof mutation>; }
      const result = mutation();
      idem.set(key, { payload: encoded, result });
      return result;
    },
  };
  return { app: new ArtifactApplication(deps), deps, objects, idem, records, get downloads() { return downloads; }, countDownload: () => { downloads++; }, revoke: () => { revoked = true; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function transfer(f: ReturnType<typeof fixture>, acquire: (maxBytes: number) => Promise<Buffer>, referenceIdentity = 'platform-file-1') {
  return { referenceIdentity, mediaType: 'application/octet-stream', acquireBytes: async (maxBytes: number) => { f.countDownload(); return acquire(maxBytes); } };
}

async function begin(f: ReturnType<typeof fixture>, bundleId = 'v1') {
  await f.app.begin({ context, ...binding, bundleId, contextRevision: 'ctx', snapshotRefs: ['s'], expectedPaths: ['raw.bin'], idempotencyKey: `begin-${bundleId}` });
}

test('platform reference preserves original bytes and URL renewal replays without downloading', async () => {
  const f = fixture();
  try {
    await begin(f);
    const signedUrl = 'https://files.example.test/private?secret=first';
    const request = { context, ...binding, idempotencyKey: 'import', path: 'raw.bin',
      ...transfer(f, async (limit) => { assert.equal(limit, 32 * 1024 * 1024); assert.match(signedUrl, /secret=first/); return binary; }) };
    const first = await f.app.importReference(request);
    assert.equal(first.sha256, createHash('sha256').update(binary).digest('hex'));
    assert.equal(first.sourceReceipt, 'platform_file_reference');
    const opaqueIdentity = createHash('sha256').update('platform-file-1').digest('hex');
    assert.equal(first.sourceIdentity, opaqueIdentity);
    const renewedUrl = 'https://files.example.test/private?secret=renewed';
    assert.deepEqual(await f.app.importReference({ ...request, ...transfer(f, async () => { assert.match(renewedUrl, /secret=renewed/); return binary; }) }), first);
    assert.equal(f.downloads, 1);
    await assert.rejects(f.app.importReference({ ...request, ...transfer(f, async () => binary, 'different-file') }), /CONFLICT/);
    assert.equal(f.downloads, 1);
    await assert.rejects(f.app.importReference({ ...request, idempotencyKey: 'changed-origin',
      ...transfer(f, async () => binary, 'different-file') }), /Artifact path conflict/);
    assert.equal(f.downloads, 2);
    assert.equal(JSON.stringify([...f.idem.values()]).includes('secret='), false);
    assert.equal(JSON.stringify([...f.records.values()]).includes('secret='), false);
    const manifest = await f.app.finalize({ context, ...binding, idempotencyKey: 'finalize' });
    assert.equal(manifest.files[0]?.sourceIdentity, opaqueIdentity);
    assert.equal(JSON.stringify([...f.records.values()]).includes('platform-file-1'), false);
    assert.deepEqual(f.objects.readFile('v1', 'raw.bin'), binary);
  } finally { f.cleanup(); }
});

test('missing MIME is inferred from original bytes without changing the idempotency payload', async () => {
  const f = fixture();
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  try {
    await begin(f);
    const request = { context, ...binding, idempotencyKey: 'infer', path: 'raw.bin',
      ...transfer(f, async () => png), mediaType: null };
    const first = await f.app.importReference(request);
    assert.equal(first.mediaType, 'image/png');
    assert.equal(first.sha256, createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(await f.app.importReference({ ...request, acquireBytes: async () => {
      throw new Error('replay must not download');
    } }), first);
    await assert.rejects(f.app.importReference({ ...request, mediaType: 'image/png' }), /CONFLICT/);
    assert.equal(f.downloads, 1);
    await f.app.finalize({ context, ...binding, idempotencyKey: 'finalize-infer' });
    assert.deepEqual(f.objects.readFile('v1', 'raw.bin'), png);
  } finally { f.cleanup(); }
});

test('missing MIME recognizes supported formats and falls back only for unknown binary', async () => {
  const pythonZip = Buffer.from('UEsDBBQAAAAIAIQbPV20N7uzEgAAABAAAAARAAAAbmVzdGVkL3JlcG9ydC50eHQrrswryUgtyUxWKEotyC8qAQBQSwECFAAUAAAACACEGz1dtDe7sxIAAAAQAAAAEQAAAAAAAAAAAAAAgAEAAAAAbmVzdGVkL3JlcG9ydC50eHRQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');
  const cases: Array<[Buffer, string]> = [
    [Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex'), 'image/png'],
    [Buffer.from('ffd8ffe000104a464946000101', 'hex'), 'image/jpeg'],
    [Buffer.from('GIF89a00000000', 'ascii'), 'image/gif'],
    [Buffer.from('%PDF-1.7\nsynthetic', 'ascii'), 'application/pdf'],
    [pythonZip, 'application/zip'],
    [binary, 'application/octet-stream'],
  ];
  for (const [bytes, expectedType] of cases) {
    const f = fixture();
    try {
      await begin(f);
      const imported = await f.app.importReference({ context, ...binding, idempotencyKey: 'infer', path: 'raw.bin',
        ...transfer(f, async () => bytes), mediaType: null });
      assert.equal(imported.mediaType, expectedType);
      assert.equal(imported.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(f.downloads, 1);
    } finally { f.cleanup(); }
  }
});

test('an explicit wrong MIME is rejected without staging', async () => {
  const f = fixture();
  try {
    await begin(f);
    await assert.rejects(f.app.importReference({ context, ...binding, idempotencyKey: 'wrong', path: 'raw.bin',
      ...transfer(f, async () => Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')) }), /media type mismatch/);
    assert.equal(f.objects.status('v1').files.length, 0);
    assert.equal(f.idem.size, 1); // artifact.begin only
  } finally { f.cleanup(); }
});

test('missing transfer capability and cross-collaboration requests cannot download', async () => {
  const f = fixture();
  try {
    await begin(f);
    const request = { context, ...binding, idempotencyKey: 'import', path: 'raw.bin',
      ...transfer(f, async () => binary) };
    await assert.rejects(f.app.importReference({ ...request, collaborationId: 'other' }), /NOT_AVAILABLE/);
    await assert.rejects(f.app.importReference({ ...request, acquireBytes: undefined as unknown as (maxBytes: number) => Promise<Buffer> }), /UNSUPPORTED_CAPABILITY/);
    assert.equal(f.objects.status('v1').files.length, 0);
  } finally { f.cleanup(); }
});

test('remote bearer revoked during byte acquisition prevents staging side effect', async () => {
  const f = fixture();
  let valid = true;
  let release!: (bytes: Buffer) => void;
  let entered!: () => void;
  const held = new Promise<Buffer>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const remoteContext: RequestContext = { ...context, async assertFreshAuthority() {
    if (!valid) throw new Error('token revoked');
  } };
  try {
    await f.app.begin({ context: remoteContext, ...binding, contextRevision: 'ctx',
      snapshotRefs: ['s'], expectedPaths: ['raw.bin'], idempotencyKey: 'begin-remote' });
    const pending = f.app.importReference({ context: remoteContext, ...binding,
      idempotencyKey: 'import-remote', path: 'raw.bin',
      ...transfer(f, async () => { entered(); return held; }) });
    await started;
    valid = false;
    release(binary);
    await assert.rejects(pending, /token revoked/);
    assert.equal(f.objects.status('v1').files.length, 0);
    assert.equal(f.idem.has('artifact.import_reference:import-remote'), false);
  } finally { f.cleanup(); }
});

test('artifact write permit does not authorize platform transfer', async () => {
  const f = fixture();
  try {
    await begin(f);
    const wrongPermit = new ArtifactApplication({ ...f.deps, async authorize(request) {
      const permit = await f.deps.authorize(request);
      return { ...permit, effect: 'artifact_write' };
    } });
    await assert.rejects(wrongPermit.importReference({ context, ...binding, idempotencyKey: 'import', path: 'raw.bin',
      ...transfer(f, async () => binary) }), /NOT_AVAILABLE/);
    assert.equal(f.downloads, 0);
  } finally { f.cleanup(); }
});

test('oversized downloader result and revocation during download leave staging unchanged', async () => {
  const huge = fixture();
  try {
    await begin(huge);
    await assert.rejects(huge.app.importReference({ context, ...binding, idempotencyKey: 'large', path: 'raw.bin',
      ...transfer(huge, async () => Buffer.alloc(32 * 1024 * 1024 + 1)) }), /budget|limit|large/i);
    assert.equal(huge.objects.status('v1').files.length, 0);
  } finally { huge.cleanup(); }

  let release!: (bytes: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => { release = resolve; });
  const f = fixture();
  try {
    await begin(f);
    const importing = f.app.importReference({ context, ...binding, idempotencyKey: 'revoked', path: 'raw.bin',
      ...transfer(f, async () => pending) });
    while (f.downloads === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    f.revoke();
    release(binary);
    await assert.rejects(importing, /NOT_AVAILABLE/);
    assert.equal(f.objects.status('v1').files.length, 0);
  } finally { f.cleanup(); }
});

test('same idempotency key across bundles serializes download before any second staging side effect', async () => {
  let release!: (bytes: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => { release = resolve; });
  const f = fixture();
  const scope = { principal: context.principal, audience: context.audience, workspaceId: binding.workspaceId,
    operation: 'artifact.import_reference', idempotencyKey: 'shared-import' };
  const collidingBundleId = `idem_${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
  try {
    await begin(f);
    await begin(f, collidingBundleId);
    const first = f.app.importReference({ context, ...binding, idempotencyKey: 'shared-import', path: 'raw.bin',
      ...transfer(f, async () => pending) });
    while (f.downloads === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = f.app.importReference({ context, ...binding, bundleId: collidingBundleId,
      idempotencyKey: 'shared-import', path: 'raw.bin', ...transfer(f, async () => pending) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release(binary);
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, 'rejected');
    assert.match(String((results[1] as PromiseRejectedResult).reason), /CONFLICT/);
    assert.equal(f.downloads, 1);
    assert.equal(f.objects.status('v1').files.length, 1);
    assert.equal(f.objects.status(collidingBundleId).files.length, 0);
  } finally { f.cleanup(); }
});

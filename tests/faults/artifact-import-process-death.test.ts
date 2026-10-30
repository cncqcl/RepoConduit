import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

const context = { principal: 'external', audience: 'mcp', recipient: 'external',
  surface: 'external_mcp' as const, now: new Date() };
const binding = { context, workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle' };
const request = { ...binding, idempotencyKey: 'import', path: 'assets/raw.bin',
  referenceIdentity: 'synthetic-platform-file', mediaType: 'application/octet-stream' };

function application(db: SqliteStore, objects: ArtifactObjects): ArtifactApplication {
  const locks = new BundleLocks();
  return new ArtifactApplication({
    objects,
    validateBundleReferences: (input) => db.validateBundleReferences(input),
    authorize: ({ context: ctx, operation, workspaceId, collaborationId }) =>
      authorize(ctx, operation, { workspaceId, collaborationId }, db.grantsFor(ctx.principal, ctx.audience)),
    collaborationBelongsToWorkspace: (workspaceId, collaborationId) => db.collaborationBelongsToWorkspace(workspaceId, collaborationId),
    getBundle: (id) => db.getBundle(id), saveBundle: (record) => db.saveBundle(record),
    publishBundle: (manifest) => db.publishBundle(manifest),
    abortBundle: (id, state) => db.abortBundle(id, state),
    lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
    withBundleLock: (id, action) => locks.withBundleLock(id, action),
    runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
  });
}

function waitForAcquisition(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let output = '';
    let errors = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onErrorText);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ACQUIRING\n')) { cleanup(); resolveReady(); }
    };
    const onErrorText = (chunk: Buffer) => { errors += chunk.toString().slice(0, 1024); };
    const onExit = (code: number | null) => { cleanup(); rejectReady(new Error(`Import child exited ${code}: ${errors}`)); };
    const onError = (error: Error) => { cleanup(); rejectReady(error); };
    const timer = setTimeout(() => { cleanup(); rejectReady(new Error(`Import child did not acquire: ${errors}`)); }, 10_000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onErrorText);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

test('death during importReference acquisition releases locks and same-key retry publishes once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-art-import-death-'));
  const dbPath = join(dir, 'state.sqlite');
  const objectRoot = join(dir, 'artifact-objects');
  let db = new SqliteStore(dbPath);
  let dbClosed = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    db.insertWorkspace({ id: 'ws', name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'delivery', hostThreadId: null, state: 'open' });
    db.insertGrant({ id: 'grant', principal: context.principal, audience: context.audience,
      recipient: context.recipient, workspaceId: 'ws', collaborationId: 'col',
      permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
    const { snapshotId } = await seedBundleProvenance(db, dbPath, {
      workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', root: dir, revisionIds: ['ctx'],
    });
    await application(db, new ArtifactObjects(objectRoot)).begin({ ...binding, contextRevision: 'ctx',
      snapshotRefs: [snapshotId], expectedPaths: ['assets/raw.bin'], idempotencyKey: 'begin' });
    assert.equal(db.getBundle('bundle')?.input.bundleId, 'bundle');
    db.close();
    dbClosed = true;

    const appUrl = pathToFileURL(resolve('src/application/artifacts.ts')).href;
    const objectsUrl = pathToFileURL(resolve('src/adapters/storage/objects.ts')).href;
    const dbUrl = pathToFileURL(resolve('src/adapters/storage/sqlite.ts')).href;
    const locksUrl = pathToFileURL(resolve('src/runtime/bundle-locks.ts')).href;
    const policyUrl = pathToFileURL(resolve('src/core/policy/authorize.ts')).href;
    const code = `
      import { ArtifactApplication } from ${JSON.stringify(appUrl)};
      import { ArtifactObjects } from ${JSON.stringify(objectsUrl)};
      import { SqliteStore } from ${JSON.stringify(dbUrl)};
      import { BundleLocks } from ${JSON.stringify(locksUrl)};
      import { authorize } from ${JSON.stringify(policyUrl)};
      const [dbPath, objectRoot] = process.argv.slice(1);
      const db = new SqliteStore(dbPath);
      const objects = new ArtifactObjects(objectRoot);
      const locks = new BundleLocks();
      const app = new ArtifactApplication({
        objects,
        validateBundleReferences: input => db.validateBundleReferences(input),
        authorize: ({ context, operation, workspaceId, collaborationId }) => authorize(context, operation,
          { workspaceId, collaborationId }, db.grantsFor(context.principal, context.audience)),
        collaborationBelongsToWorkspace: (ws, col) => db.collaborationBelongsToWorkspace(ws, col),
        getBundle: id => db.getBundle(id), saveBundle: record => db.saveBundle(record),
        publishBundle: manifest => db.publishBundle(manifest), abortBundle: (id, state) => db.abortBundle(id, state),
        lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
        withBundleLock: (id, action) => locks.withBundleLock(id, action),
        runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
      });
      await app.importReference({
        context: { principal: 'external', audience: 'mcp', recipient: 'external',
          surface: 'external_mcp', now: new Date() },
        workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle',
        idempotencyKey: 'import', path: 'assets/raw.bin', referenceIdentity: 'synthetic-platform-file',
        mediaType: 'application/octet-stream',
        acquireBytes: async () => {
          process.stdout.write('ACQUIRING\\n');
          return await new Promise(() => { setInterval(() => {}, 1000); });
        },
      });
    `;
    child = spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code, dbPath, objectRoot],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForAcquisition(child);
    const exited = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    await exited;

    db = new SqliteStore(dbPath);
    dbClosed = false;
    const objects = new ArtifactObjects(objectRoot);
    const app = application(db, objects);
    assert.equal((await app.status(binding)).state, 'staging');
    const beforeRetry = new DatabaseSync(dbPath);
    try {
      const rows = beforeRetry.prepare(`SELECT count(*) AS count FROM idempotency_records
        WHERE operation=? AND idempotency_key=?`).get('artifact.import_reference', 'import') as { count: number };
      assert.equal(rows.count, 0);
    } finally { beforeRetry.close(); }
    const bytes = Buffer.from([0, 1, 2, 255]);
    let acquisitions = 0;
    const imported = await app.importReference({ ...request,
      acquireBytes: async () => { acquisitions++; return bytes; } });
    assert.equal(imported.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(imported.sourceReceipt, 'platform_file_reference');
    assert.deepEqual(await app.importReference({ ...request,
      acquireBytes: async () => { acquisitions++; throw new Error('replay downloaded again'); } }), imported);
    assert.equal(acquisitions, 1);
    const manifest = await app.finalize({ ...binding, idempotencyKey: 'finalize' });
    assert.deepEqual(manifest.files, [imported]);
    assert.equal((await app.status(binding)).state, 'published');
    assert.deepEqual(await app.readFile({ ...binding, path: 'assets/raw.bin' }), bytes);
    assert.equal(JSON.parse(readFileSync(join(objectRoot, 'staging', 'bundle.json'), 'utf8')).state, 'published');
    const inspect = new DatabaseSync(dbPath);
    try {
      const importRows = inspect.prepare(`SELECT result_json FROM idempotency_records
        WHERE principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`)
        .all('external', 'mcp', 'ws', 'artifact.import_reference', 'import') as { result_json: string }[];
      const fileRows = inspect.prepare('SELECT count(*) AS count FROM bundle_files WHERE bundle_id=? AND path=?')
        .get('bundle', 'assets/raw.bin') as { count: number };
      assert.equal(importRows.length, 1);
      assert.deepEqual(JSON.parse(importRows[0]!.result_json), imported);
      assert.equal(fileRows.count, 1);
    } finally { inspect.close(); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    if (!dbClosed) db.close();
    const safe = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(safe.startsWith('rcac-art-import-death-') && !safe.includes('..') && !safe.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

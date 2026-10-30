import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

const context = { principal: 'external', audience: 'mcp', recipient: 'external',
  surface: 'external_mcp' as const, now: new Date() };
const binding = { context, workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle' };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-abort-fault-'));
  const dbPath = join(dir, 'state.sqlite');
  const objectRoot = join(dir, 'artifact-objects');
  let db = new SqliteStore(dbPath);
  let objects = new ArtifactObjects(objectRoot);
  const locks = new BundleLocks();
  const app = () => new ArtifactApplication({
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
  const restart = () => {
    db.close();
    db = new SqliteStore(dbPath);
    objects = new ArtifactObjects(objectRoot);
  };
  const cleanup = () => {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-abort-fault-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  };
  db.insertWorkspace({ id: 'ws', name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
  db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'delivery', hostThreadId: null, state: 'open' });
  db.insertGrant({ id: 'grant', principal: context.principal, audience: context.audience,
    recipient: context.recipient, workspaceId: 'ws', collaborationId: 'col',
    permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
  const { snapshotId } = await seedBundleProvenance(db, dbPath, {
    workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', root: dir, revisionIds: ['ctx'],
  });
  await app().begin({ ...binding, contextRevision: 'ctx', snapshotRefs: [snapshotId],
    expectedPaths: ['plan.md'], idempotencyKey: 'begin' });
  await app().putText({ ...binding, idempotencyKey: 'put', path: 'plan.md', text: '# delivered',
    mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
  return { dir, dbPath, objectRoot, app, get db() { return db; }, get objects() { return objects; }, restart, cleanup };
}

test('abort DB commit survives marker write failure and retry repairs marker after restart', async () => {
  const f = await fixture();
  try {
    const originalAbort = f.objects.abort.bind(f.objects);
    f.objects.abort = () => { throw new Error('injected marker write failure'); };
    await assert.rejects(f.app().abort({ ...binding, idempotencyKey: 'abort' }), /injected marker write failure/);
    assert.equal(f.db.getBundle('bundle')?.abortedState?.state, 'aborted');
    assert.equal(JSON.parse(readFileSync(join(f.objectRoot, 'staging', 'bundle.json'), 'utf8')).state, 'staging');
    f.objects.abort = originalAbort;
    f.restart();
    assert.equal((await f.app().status(binding)).state, 'aborted');
    const receipt = await f.app().abort({ ...binding, idempotencyKey: 'abort' });
    assert.equal(receipt.state, 'aborted');
    assert.equal(f.objects.status('bundle').state, 'aborted');
    await assert.rejects(f.app().finalize({ ...binding, idempotencyKey: 'finalize-after-abort' }),
      /aborted|CONFLICT|immutable/i);
    await assert.rejects(f.app().putText({ ...binding, idempotencyKey: 'put-after-abort', path: 'plan.md',
      text: '# changed', mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' }),
    /aborted|CONFLICT|immutable/i);
  } finally { f.cleanup(); }
});

test('published DB record wins over abort when marker is lost', async () => {
  const f = await fixture();
  try {
    const manifest = await f.app().finalize({ ...binding, idempotencyKey: 'finalize' });
    unlinkSync(join(f.objectRoot, 'staging', 'bundle.json'));
    f.restart();
    await assert.rejects(f.app().abort({ ...binding, idempotencyKey: 'abort-after-publish' }),
      /CONFLICT|immutable|published/i);
    assert.equal((await f.app().status(binding)).state, 'published');
    assert.deepEqual(f.db.getBundle('bundle')?.manifest, manifest);
    assert.equal((await f.app().readFile({ ...binding, path: 'plan.md' })).toString(), '# delivered');
    assert.deepEqual(await f.app().finalize({ ...binding, idempotencyKey: 'finalize-retry' }), manifest);
    assert.equal(f.objects.status('bundle').state, 'published');
  } finally { f.cleanup(); }
});

test('two independent coordinators serialize finalize versus abort to one durable terminal state', async () => {
  const f = await fixture();
  try {
    // Each child opens its own SQLite connection and object adapter.
    const appUrl = pathToFileURL(resolve('src/application/artifacts.ts')).href;
    const objectsUrl = pathToFileURL(resolve('src/adapters/storage/objects.ts')).href;
    const dbUrl = pathToFileURL(resolve('src/adapters/storage/sqlite.ts')).href;
    const locksUrl = pathToFileURL(resolve('src/runtime/bundle-locks.ts')).href;
    const policyUrl = pathToFileURL(resolve('src/core/policy/authorize.ts')).href;
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { ArtifactApplication } from ${JSON.stringify(appUrl)};
      import { ArtifactObjects } from ${JSON.stringify(objectsUrl)};
      import { SqliteStore } from ${JSON.stringify(dbUrl)};
      import { BundleLocks } from ${JSON.stringify(locksUrl)};
      import { authorize } from ${JSON.stringify(policyUrl)};
      const [dbPath, objectRoot, gate, ready, operation] = process.argv.slice(1);
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
      writeFileSync(ready, 'ready');
      const deadline = Date.now() + 10_000;
      while (!existsSync(gate) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (!existsSync(gate)) throw new Error('race gate timed out');
      try {
        const result = await app[operation]({
          context: { principal: 'external', audience: 'mcp', recipient: 'external',
            surface: 'external_mcp', now: new Date() },
          workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', idempotencyKey: operation,
        });
        process.stdout.write(JSON.stringify({ operation, outcome: 'ok', state: result.state ?? 'published' }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ operation, outcome: 'rejected', error: String(error) }));
      } finally { db.close(); }
    `;
    const gate = join(f.dir, 'race-gate');
    const run = (operation: 'finalize' | 'abort') => new Promise<{ operation: string; outcome: string; state?: string; error?: string }>((resolveRun, reject) => {
      const ready = join(f.dir, `ready-${operation}`);
      const child = spawn(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code, f.dbPath, f.objectRoot, gate, ready, operation],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', (exitCode) => {
        if (exitCode !== 0) reject(new Error(`${operation} child exited ${exitCode}: ${stderr}`));
        else { try { resolveRun(JSON.parse(stdout) as { operation: string; outcome: string; state?: string; error?: string }); }
          catch { reject(new Error(`${operation} child gave invalid result: ${stdout} ${stderr}`)); } }
      });
    });
    const waitReady = (operation: 'finalize' | 'abort', result: ReturnType<typeof run>) => {
      const ready = join(f.dir, `ready-${operation}`);
      const poll = async () => {
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        assert.ok(existsSync(ready), `${operation} child reached the gate`);
      };
      return Promise.race([poll(), result.then(() => { throw new Error(`${operation} child exited before gate`); })]);
    };
    // SqliteStore performs a startup migration. Finish that initialization in one child
    // before starting the other; both independent processes then race at the same gate.
    const finalize = run('finalize');
    await waitReady('finalize', finalize);
    const abort = run('abort');
    await waitReady('abort', abort);
    writeFileSync(gate, 'go');
    const outcomes = await Promise.all([finalize, abort]);
    assert.equal(outcomes.filter((result) => result.outcome === 'ok').length, 1, JSON.stringify(outcomes));
    const loser = outcomes.find((result) => result.outcome === 'rejected')!;
    assert.match(loser.error ?? '', /CONFLICT|immutable|published|aborted/i, JSON.stringify(outcomes));
    f.restart();
    const state = (await f.app().status(binding)).state;
    assert.ok(state === 'published' || state === 'aborted');
    const winner = outcomes.find((result) => result.outcome === 'ok')!;
    assert.equal(state, winner.operation === 'finalize' ? 'published' : 'aborted');
    assert.equal(f.objects.status('bundle').state, state);
    assert.equal(Boolean(f.db.getBundle('bundle')?.manifest), state === 'published');
    if (state === 'published') assert.equal((await f.app().readFile({ ...binding, path: 'plan.md' })).toString(), '# delivered');
  } finally { f.cleanup(); }
});

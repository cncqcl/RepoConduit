import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ArtifactApplication } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { recordDecision } from '../../src/core/collaboration/decision.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { BundleLocks } from '../../src/runtime/bundle-locks.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

const context = { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp' as const, now: new Date() };
const bind = (bundleId: string) => ({ context, workspaceId: 'ws', collaborationId: 'col', bundleId });
const bytesV1 = 'version one';
const bytesV2 = 'version two';
type Phase = 'staging_write' | 'object_fsync' | 'object_rename' | 'verify_read' | 'manifest_rename';

function application(db: SqliteStore, objects: ArtifactObjects): ArtifactApplication {
  const locks = new BundleLocks();
  return new ArtifactApplication({
    objects,
    validateBundleReferences: input => db.validateBundleReferences(input),
    authorize: ({ context: ctx, operation, workspaceId, collaborationId }) => authorize(ctx, operation,
      { workspaceId, collaborationId }, db.grantsFor(ctx.principal, ctx.audience)),
    collaborationBelongsToWorkspace: (ws, col) => db.collaborationBelongsToWorkspace(ws, col),
    getBundle: id => db.getBundle(id), saveBundle: record => db.saveBundle(record),
    publishBundle: manifest => db.publishBundle(manifest), abortBundle: (id, state) => db.abortBundle(id, state),
    lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
    withBundleLock: (id, action) => locks.withBundleLock(id, action),
    runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
  });
}

function ready(child: ChildProcessWithoutNullStreams, phase: Phase): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = '', stderr = '';
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.stderr.off('data', onErrorText);
      child.off('exit', onExit); child.off('error', onError); };
    const onData = (chunk: Buffer) => { stdout += chunk.toString();
      if (stdout.includes(`READY:${phase}\n`)) { cleanup(); resolveReady(); } };
    const onErrorText = (chunk: Buffer) => { stderr += chunk.toString().slice(0, 2048); };
    const onExit = (code: number | null) => { cleanup(); rejectReady(new Error(`${phase} child exited ${code}: ${stdout} ${stderr}`)); };
    const onError = (error: Error) => { cleanup(); rejectReady(error); };
    const timer = setTimeout(() => { cleanup(); rejectReady(new Error(`${phase} READY timeout: ${stdout} ${stderr}`)); }, 10_000);
    child.stdout.on('data', onData); child.stderr.on('data', onErrorText); child.once('exit', onExit); child.once('error', onError);
  });
}

async function killOwnedChild(child: ChildProcessWithoutNullStreams, phase: Phase): Promise<unknown[]> {
  const exited = once(child, 'exit');
  if (!child.kill('SIGKILL')) throw new Error(`${phase} SIGKILL was not sent to owned child`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} kill timeout`)), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

for (const phase of ['staging_write', 'object_fsync', 'object_rename', 'verify_read', 'manifest_rename'] as Phase[]) {
  test(`AC14 SIGKILL at ${phase} leaves v1 and recovers one v2`, { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), `rcac-ac14-${phase}-`));
    const dbPath = join(dir, 'state.sqlite');
    const objectRoot = join(dir, 'artifact-objects');
    let db = new SqliteStore(dbPath);
    let dbClosed = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let success = false;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      db.insertWorkspace({ id: 'ws', name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
      db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'delivery', hostThreadId: null, state: 'open' });
      db.insertGrant({ id: 'grant', principal: context.principal, audience: context.audience,
        recipient: context.recipient, workspaceId: 'ws', collaborationId: 'col',
        permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
      const { snapshotId } = await seedBundleProvenance(db, dbPath, { workspaceId: 'ws', collaborationId: 'col',
        workingCopyId: 'copy', root: dir, revisionIds: ['ctx'] });
      let objects = new ArtifactObjects(objectRoot);
      let app = application(db, objects);
      await app.begin({ ...bind('v1'), contextRevision: 'ctx', snapshotRefs: [snapshotId],
        expectedPaths: ['v1.md'], idempotencyKey: 'begin-v1' });
      await app.putText({ ...bind('v1'), path: 'v1.md', text: bytesV1, mediaType: 'text/markdown',
        sourceReceipt: 'text_set_mcp', idempotencyKey: 'put-v1' });
      const v1Manifest = await app.finalize({ ...bind('v1'), idempotencyKey: 'finish-v1' });
      const v1Marker = readFileSync(join(objectRoot, 'staging', 'v1.json'));
      const decisions = new ContextDecisionSqlite(dbPath);
      const permit = (operation: string) => ({ grantId: 'local-fixture', operation, effect: 'state_write' as const,
        scope: { workspaceId: 'ws', collaborationId: 'col' }, principal: 'owner', recipient: 'owner' });
      let recordedDecision;
      try {
        const manifestHash = decisions.getPublishedBundleHash('ws', 'col', 'v1');
        const review = decisions.insertBaselineReview({ id: 'review-v1', workspaceId: 'ws', collaborationId: 'col',
          bundleId: 'v1', bundleManifestHash: manifestHash, snapshotId, contextRevisionId: 'ctx', reviewedBy: 'owner' },
        permit('decision.review'), 'local_host');
        recordedDecision = decisions.insertDecision(recordDecision({ id: 'decision-v1', workspaceId: 'ws',
          collaborationId: 'col', bundleId: 'v1', bundleManifestHash: manifestHash, snapshotId,
          contextRevisionId: 'ctx', reviewId: review.id, outcome: 'accept', reason: 'Fixture reviewed', decidedBy: 'owner' },
        permit('decision.record'), 'local_host'), permit('decision.record'), 'local_host');
      } finally { decisions.close(); }
      await app.begin({ ...bind('v2'), parentBundleId: 'v1', contextRevision: 'ctx', snapshotRefs: [snapshotId],
        expectedPaths: ['v2.md'], idempotencyKey: 'begin-v2' });
      if (phase === 'verify_read' || phase === 'manifest_rename') await app.putText({ ...bind('v2'),
        path: 'v2.md', text: bytesV2, mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp', idempotencyKey: 'put-v2' });
      db.close();
      dbClosed = true;

      child = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'tests/support/artifact-durable-crash-child.mjs'),
        phase, dbPath, objectRoot, snapshotId], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      await ready(child, phase);
      const [exitCode, signal] = await killOwnedChild(child, phase);
      assert.equal(exitCode, null);
      assert.equal(signal, 'SIGKILL');

      db = new SqliteStore(dbPath);
      dbClosed = false;
      objects = new ArtifactObjects(objectRoot);
      app = application(db, objects);
      assert.equal(db.getBundle('v2')?.manifest, undefined);
      assert.equal((await app.status(bind('v2'))).state, 'staging');
      await assert.rejects(app.readFile({ ...bind('v2'), path: 'v2.md' }), /NOT_AVAILABLE/);
      assert.deepEqual(db.getBundle('v1')?.manifest, v1Manifest);
      const reopenedDecisions = new ContextDecisionSqlite(dbPath);
      try { assert.deepEqual(reopenedDecisions.getDecision('ws', 'col', 'decision-v1'), recordedDecision); }
      finally { reopenedDecisions.close(); }
      assert.deepEqual(readFileSync(join(objectRoot, 'staging', 'v1.json')), v1Marker);
      assert.equal((await app.readFile({ ...bind('v1'), path: 'v1.md' })).toString(), bytesV1);
      assert.equal(existsSync(objects.objectPath(v1Manifest.files[0]!.sha256)), true);
      const staged = objects.status('v2');
      if (phase === 'staging_write' || phase === 'object_fsync' || phase === 'object_rename') {
        assert.equal(staged.files.length, 0);
        if (phase === 'staging_write') {
          const temp = readdirSync(join(objectRoot, 'staging')).find(name => name.startsWith('v2.json.') && name.endsWith('.tmp'));
          assert.ok(temp);
          const partial = readFileSync(join(objectRoot, 'staging', temp), 'utf8');
          assert.ok(partial.length > 0 && partial.startsWith('{"input":'));
          assert.throws(() => JSON.parse(partial), SyntaxError);
        }
      } else assert.equal(staged.files.length, 1);
      const put = await app.putText({ ...bind('v2'), path: 'v2.md', text: bytesV2,
        mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp', idempotencyKey: 'put-v2' });
      assert.equal(put.sha256, createHash('sha256').update(bytesV2).digest('hex'));
      const manifest = await app.finalize({ ...bind('v2'), idempotencyKey: 'finish-v2' });
      assert.deepEqual(await app.finalize({ ...bind('v2'), idempotencyKey: 'finish-v2' }), manifest);
      assert.equal((await app.status(bind('v2'))).state, 'published');
      assert.equal((await app.readFile({ ...bind('v2'), path: 'v2.md' })).toString(), bytesV2);
      assert.equal((await app.readFile({ ...bind('v1'), path: 'v1.md' })).toString(), bytesV1);
      assert.deepEqual(db.getBundle('v1')?.manifest, v1Manifest);
      assert.deepEqual(readFileSync(join(objectRoot, 'staging', 'v1.json')), v1Marker);
      const afterRetryDecisions = new ContextDecisionSqlite(dbPath);
      try { assert.deepEqual(afterRetryDecisions.getDecision('ws', 'col', 'decision-v1'), recordedDecision); }
      finally { afterRetryDecisions.close(); }
      const inspect = new DatabaseSync(dbPath);
      try {
        assert.equal((inspect.prepare('SELECT count(*) AS n FROM bundle_files WHERE bundle_id=?').get('v2') as { n: number }).n, 1);
        assert.equal((inspect.prepare('SELECT count(*) AS n FROM idempotency_records WHERE operation=? AND idempotency_key=?')
          .get('artifact.finalize', 'finish-v2') as { n: number }).n, 1);
        assert.equal((inspect.prepare('SELECT count(*) AS n FROM bundles WHERE id=? AND manifest_json IS NOT NULL').get('v2') as { n: number }).n, 1);
      } finally { inspect.close(); }
      success = true;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { await killOwnedChild(child, phase); }
        catch (error) { cleanupError = error; }
      }
      if (!dbClosed) {
        try { db.close(); }
        catch (error) { cleanupError ??= error; }
      }
      if (success && !cleanupError) {
        const safe = relative(resolve(tmpdir()), resolve(dir));
        assert.ok(safe.startsWith(`rcac-ac14-${phase}-`) && !safe.includes('..') && !safe.includes('\\'));
        rmSync(dir, { recursive: true, force: true });
      } else process.stderr.write(`AC14 retained failure fixture: ${dir}\n`);
      if (cleanupError) {
        if (primaryError) process.stderr.write(`AC14 cleanup issue after primary error: ${String(cleanupError)}\n`);
      }
    }
    if (cleanupError) throw cleanupError;
  });
}

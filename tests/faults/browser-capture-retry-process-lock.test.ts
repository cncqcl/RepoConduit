import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { BrowserCaptureSqlite, type BrowserCaptureInput } from '../../src/adapters/storage/browser-capture-sqlite.js';
import { establishBrowserDownloadBaseline } from '../../src/adapters/transfers/browser-download.js';

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('synthetic browser retry process race\n');
const browserId = { browserId: 'browser2', originalTabId: 'tab10', retryTabId: 'tab12' };
const objectsUrl = pathToFileURL(resolve('src/adapters/storage/objects.ts')).href;
const storeUrl = pathToFileURL(resolve('src/adapters/storage/browser-capture-sqlite.ts')).href;
const appUrl = pathToFileURL(resolve('src/application/artifacts.ts')).href;

type Role = 'old' | 'retry';
type Order = 'old-first' | 'retry-first';
type FixtureConfig = {
  root: string; events: string; database: string; objectRoot: string; release: string;
  oldInput: BrowserCaptureInput; retryInput: BrowserCaptureInput; bytes: string;
};

// The child uses the real application lock, shared object marker, and capture SQLite database.
// The fake collector supplies only the browser's already received bytes and a counted retry click.
const childSource = `
  import { appendFileSync, existsSync, readFileSync } from 'node:fs';
  import { ArtifactObjects } from ${JSON.stringify(objectsUrl)};
  import { BrowserCaptureSqlite } from ${JSON.stringify(storeUrl)};
  import { ArtifactApplication } from ${JSON.stringify(appUrl)};
  const [configPath, order, role] = process.argv.slice(1);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const events = config.events;
  const emit = value => appendFileSync(events, value + '\\n');
  const objects = new ArtifactObjects(config.objectRoot);
  const store = new BrowserCaptureSqlite(config.database);
  const bytes = Buffer.from(config.bytes, 'base64');
  const input = role === 'old' ? config.oldInput : config.retryInput;
  const context = { principal: 'local-user', audience: 'local-os', recipient: 'local-user',
    surface: 'local_cli', now: new Date() };
  const request = { context, workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle',
    path: 'result.txt', nativeSessionId: input.nativeSessionId, nativeMessageId: input.nativeMessageId,
    filename: input.filename, expectedSha256: input.expectedSha256, expectedSize: input.expectedSize,
    idempotencyKey: role === 'old' ? 'original' : 'successor',
    ...(role === 'retry' ? { retryOfCaptureId: config.oldInput.id } : {}) };
  const record = { input: { bundleId: 'bundle', workspaceId: 'ws', collaborationId: 'col',
    contextRevision: 'ctx', snapshotRefs: ['snapshot'], expectedPaths: ['result.txt'] } };
  const app = new ArtifactApplication({
    objects, collaborationBelongsToWorkspace: () => true, validateBundleReferences: () => {},
    getBundle: id => id === 'bundle' ? record : null, saveBundle: () => {}, publishBundle: () => {},
    abortBundle: () => {}, withBundleLock: (_id, action) => action(),
    lookupIdempotent: () => null, runIdempotent: (_scope, _payload, mutation) => mutation(),
    authorize: r => ({ grantId: role === 'old' ? 'old-grant' : 'new-grant',
      operation: r.operation, effect: 'artifact_transfer', scope: r,
      principal: r.context.principal, recipient: r.context.recipient }),
    browserCollector: {
      assertCaptureWritable: id => store.assertCaptureWritable(id),
      assertRetryRecovery: (id, predecessorId) => {
        const relation = store.getRetry(id);
        const capture = store.get(id);
        if (!relation || relation.predecessorId !== predecessorId || capture?.state !== 'verified_candidate')
          throw new Error('CONFLICT');
      },
      async capture(capture) {
        emit('capture:' + role);
        if (role === 'retry') {
          store.prepareRetry(config.retryInput, config.oldInput.id,
            { browserId: 'browser2', originalTabId: 'tab10', retryTabId: 'tab12' });
          emit('claim:retry');
          store.transition(config.retryInput.id, 'prepared', 'capturing');
          emit('download:retry');
          store.transition(config.retryInput.id, 'capturing', 'verified_candidate',
            '${sha('candidate')}');
        }
        if ((order === 'old-first' && role === 'old') ||
            (order === 'retry-first' && role === 'retry')) {
          emit('holding:' + role);
          const deadline = Date.now() + 8_000;
          while (!existsSync(config.release)) {
            if (Date.now() > deadline) throw new Error('release_timeout');
            await new Promise(done => setTimeout(done, 20));
          }
        }
        await capture.assertAuthority();
        return { bytes, sha256: input.expectedSha256, sourceIdentity: '${sha('source')}' };
      },
    },
  });
  emit('started:' + role);
  try {
    await app.collectBrowser(request);
    emit('result:' + role + ':ok');
    if (order === 'old-first' ? role !== 'old' : role !== 'retry') throw new Error('unexpected_success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('result:' + role + ':' + message);
    if (order === 'old-first' ? role === 'old' : role === 'retry') throw error;
    if (!/CONFLICT|Artifact path conflict/.test(message)) throw error;
  } finally { store.close(); }
`;

type Child = { process: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; stderr: string }> };
function start(configPath: string, order: Order, role: Role): Child {
  const child = spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', childSource, configPath, order, role],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 2048); });
  const done = new Promise<{ code: number | null; stderr: string }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolveExit({ code, stderr }));
  });
  return { process: child, done };
}
function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}
async function waitFor(file: string, marker: string, child: Child): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!lines(file).includes(marker)) {
    if (child.process.exitCode !== null) throw new Error(`Child exited before ${marker}`);
    if (Date.now() > deadline) throw new Error(`Missing ${marker}; events=${lines(file).join(',')}`);
    await new Promise(done => setTimeout(done, 20));
  }
}
function inputHash(file: string, id: string): unknown {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT input_json,input_hash,state,candidate_fingerprint FROM browser_capture_intents WHERE id=?').get(id); }
  finally { db.close(); }
}
async function stop(child: Child | undefined): Promise<void> {
  if (!child) return;
  if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
  await child.done;
}

for (const order of ['old-first', 'retry-first'] as const) {
  test(`two processes serialize original download and explicit retry: ${order}`, { timeout: 35_000 }, async () => {
    // SQLite lock journals must not depend on the source checkout's directory depth.
    const parent = tmpdir();
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'rcac-browser-retry-process-'));
    const configPath = join(root, 'config.json');
    const config: FixtureConfig = { root, events: join(root, 'events.log'), database: join(root, 'state.sqlite'),
      objectRoot: join(root, 'objects-root'), release: join(root, 'release'),
      oldInput: null as unknown as BrowserCaptureInput, retryInput: null as unknown as BrowserCaptureInput,
      bytes: bytes.toString('base64') };
    let first: Child | undefined, second: Child | undefined;
    let checksPassed = false;
    try {
      const downloadRoot = join(root, 'downloads');
      mkdirSync(downloadRoot);
      const objects = new ArtifactObjects(config.objectRoot);
      objects.begin({ bundleId: 'bundle', workspaceId: 'ws', collaborationId: 'col',
        contextRevision: 'ctx', snapshotRefs: ['snapshot'], expectedPaths: ['result.txt'] });
      const id = (key: string) => sha(JSON.stringify({ principal: 'local-user', audience: 'local-os',
        workspaceId: 'ws', operation: 'artifact.collect_browser', idempotencyKey: key }));
      const oldInput: BrowserCaptureInput = { id: id('original'), workspaceId: 'ws', collaborationId: 'col',
        bundleId: 'bundle', path: 'result.txt', principal: 'local-user', audience: 'local-os',
        recipient: 'local-user', grantId: 'old-grant', accountKey: 'hacc_11111111-1111-4111-8111-111111111111',
        nativeSessionId: '22222222-2222-4222-8222-222222222222',
        nativeMessageId: '33333333-3333-4333-8333-333333333333', filename: 'result.txt',
        sourceFingerprint: sha('native-message'), expectedSha256: sha(bytes), expectedSize: bytes.length,
        bindingFingerprint: null, baseline: establishBrowserDownloadBaseline(downloadRoot, 'result.txt', []) };
      config.oldInput = oldInput;
      config.retryInput = { ...oldInput, id: id('successor'), grantId: 'new-grant' };
      const store = new BrowserCaptureSqlite(config.database);
      store.prepare(oldInput);
      store.transition(oldInput.id, 'prepared', 'capturing');
      store.transition(oldInput.id, 'capturing', 'reconcile_required');
      store.close();
      const before = inputHash(config.database, oldInput.id);
      writeFileSync(configPath, JSON.stringify(config));
      const firstRole: Role = order === 'old-first' ? 'old' : 'retry';
      const secondRole: Role = order === 'old-first' ? 'retry' : 'old';
      first = start(configPath, order, firstRole);
      await waitFor(config.events, `holding:${firstRole}`, first);
      second = start(configPath, order, secondRole);
      await waitFor(config.events, `started:${secondRole}`, second);
      assert.equal(lines(config.events).includes(`result:${firstRole}:ok`), false);
      writeFileSync(config.release, 'release');
      const exits = await Promise.all([first.done, second.done]);
      for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
      const events = lines(config.events);
      assert.equal(events.filter(value => value === 'capture:old').length, 1);
      assert.equal(events.filter(value => value === 'download:retry').length, order === 'old-first' ? 0 : 1);
      assert.equal(events.filter(value => value === 'claim:retry').length, order === 'old-first' ? 0 : 1);
      assert.equal(events.filter(value => value === 'result:old:ok').length, order === 'old-first' ? 1 : 0);
      assert.equal(events.filter(value => value === 'result:retry:ok').length, order === 'retry-first' ? 1 : 0);
      assert.equal(events.filter(value => value === (order === 'old-first' ?
        'result:retry:CONFLICT' : 'result:old:CONFLICT')).length, 1);
      const staged = objects.status('bundle');
      assert.equal(staged.state, 'staging');
      assert.deepEqual(staged.missingPaths, []);
      assert.equal(staged.files.length, 1);
      assert.equal(staged.files[0]?.sha256, sha(bytes));
      assert.equal(staged.files[0]?.sourceIdentity, sha('source'));
      assert.deepEqual(inputHash(config.database, oldInput.id), before);
      const finalStore = new BrowserCaptureSqlite(config.database);
      try {
        assert.equal(finalStore.get(oldInput.id)?.state, 'reconcile_required');
        if (order === 'old-first') assert.equal(finalStore.getRetry(config.retryInput.id), null);
        else {
          assert.deepEqual(finalStore.getRetry(config.retryInput.id),
            { predecessorId: oldInput.id, successorId: config.retryInput.id, ...browserId });
          assert.throws(() => finalStore.assertCaptureWritable(oldInput.id), /CONFLICT/);
        }
      } finally { finalStore.close(); }
      checksPassed = true;
    } finally {
      let childrenStopped = false;
      try { await Promise.all([stop(first), stop(second)]); childrenStopped = true; }
      finally {
        const safe = relative(parent, resolve(root));
        assert.ok(safe.startsWith('rcac-browser-retry-process-') && !safe.includes('..') && !safe.includes('\\'));
        if (checksPassed && childrenStopped) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        else process.stderr.write(`Retained synthetic failure fixture: ${root}\n`);
      }
    }
  });
}

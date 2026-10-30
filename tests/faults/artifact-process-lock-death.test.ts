import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';

const objectsUrl = pathToFileURL(resolve('src/adapters/storage/objects.ts')).href;
const idempotencyHash = 'a'.repeat(64);
const holder = `
  import { ArtifactObjects } from ${JSON.stringify(objectsUrl)};
  const objects = new ArtifactObjects(process.argv[1]);
  await objects.withIdempotencyLock('${'a'.repeat(64)}', () =>
    objects.withProcessLock('bundle', async () => {
      process.stdout.write('LOCKED\\n');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }));
`;

function waitForLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = '';
    let errorText = '';
    const timer = setTimeout(() => reject(new Error(`Lock holder did not start: ${errorText}`)), 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('LOCKED\n')) { clearTimeout(timer); resolveReady(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { errorText += chunk.toString().slice(0, 1024); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Lock holder exited ${code}: ${errorText}`)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('a killed coordinator releases its idempotency and bundle locks for a reopened process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-lock-death-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', holder, root],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForLock(child);
    const exited = new Promise<void>((resolveExit) => child!.once('exit', () => resolveExit()));
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    const reopened = new ArtifactObjects(root);
    let entered = false;
    await reopened.withIdempotencyLock(idempotencyHash, () =>
      reopened.withProcessLock('bundle', async () => { entered = true; }));
    assert.equal(entered, true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child!.once('exit', () => resolveExit()));
      child.kill('SIGKILL');
      await exited;
    }
    const safe = relative(resolve(tmpdir()), resolve(root));
    assert.ok(safe.startsWith('rcac-artifact-lock-death-') && !safe.includes('..') && !safe.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live holder keeps the same bundle key while a waiting caller can enter after release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-lock-death-'));
  try {
    const objects = new ArtifactObjects(root);
    let release!: () => void;
    let entered = false;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const first = objects.withProcessLock('bundle', () => held);
    const second = objects.withProcessLock('bundle', async () => { entered = true; });
    try {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
      assert.equal(entered, false);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    assert.equal(entered, true);
  } finally {
    const safe = relative(resolve(tmpdir()), resolve(root));
    assert.ok(safe.startsWith('rcac-artifact-lock-death-') && !safe.includes('..') && !safe.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old directory lock remains untouched and blocks the new holder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-lock-death-'));
  try {
    const objects = new ArtifactObjects(root);
    const legacy = join(root, 'staging', 'bundle.lock');
    mkdirSync(legacy);
    let entered = false;
    await assert.rejects(objects.withProcessLock('bundle', async () => { entered = true; }),
      /locked|recovery|directory/i);
    assert.equal(entered, false);
    assert.equal(existsSync(legacy), true);
  } finally {
    const safe = relative(resolve(tmpdir()), resolve(root));
    assert.ok(safe.startsWith('rcac-artifact-lock-death-') && !safe.includes('..') && !safe.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new persistent lock file excludes an old mkdir holder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-artifact-lock-death-'));
  try {
    const objects = new ArtifactObjects(root);
    const lockPath = join(root, 'staging', 'bundle.lock');
    await objects.withProcessLock('bundle', async () => {
      assert.equal(statSync(lockPath).isFile(), true);
      assert.throws(() => mkdirSync(lockPath), { code: 'EEXIST' });
    });
    assert.equal(statSync(lockPath).isFile(), true);
  } finally {
    const safe = relative(resolve(tmpdir()), resolve(root));
    assert.ok(safe.startsWith('rcac-artifact-lock-death-') && !safe.includes('..') && !safe.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
});

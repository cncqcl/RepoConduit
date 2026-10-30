import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

function emptyZip(): Buffer {
  const name = Buffer.from('nested/report.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}

const CLI_TIMEOUT_MS = 60_000;

function runCli(script: string, root: string, action: string, caseName: string, seq: number,
  input?: unknown, rawInput?: string) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--data-dir', root, action],
    { input: rawInput ?? (input === undefined ? undefined : JSON.stringify(input)),
      encoding: 'utf8', cwd: resolve('.'), timeout: CLI_TIMEOUT_MS });
  if (result.status === null || result.signal !== null || result.error !== undefined) {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? null;
    process.stderr.write(`${JSON.stringify({ case: caseName, action, seq, status: result.status,
      signal: result.signal, pid: result.pid ?? null, errorCode, elapsedMs })}\n`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('local CLI derives identity from the OS and persists an issue across processes', () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-cli-'));
  process.stderr.write(`${JSON.stringify({ case: 'identity', stage: 'fixture.created', root: dir })}\n`);
  const root = join(dir, 'data');
  const source = join(dir, 'source');
  mkdirSync(source);
  const script = resolve('src/cli/main.ts');
  let seq = 0;
  const run = (action: 'init' | 'request', input?: unknown) => {
    return runCli(script, root, action, 'identity', ++seq, input);
  };
  let completed = false;
  try {
    const init = run('init');
    assert.equal(init.status, 0, init.stderr);
    const principal = (JSON.parse(init.stdout) as { principal: string }).principal;
    assert.ok(principal.includes('\\'));
    if (process.platform === 'win32') {
      const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$a=[System.IO.Directory]::GetAccessControl($env:RCAC_TEST_PATH); $a.AreAccessRulesProtected'],
      { env: { ...process.env, RCAC_TEST_PATH: root }, encoding: 'utf8', timeout: 15_000 });
      assert.equal(acl.status, 0, acl.stderr);
      assert.equal(acl.stdout.trim(), 'True');
    }
    assert.equal(run('init').status, 1);
    assert.equal(run('request', { operation: 'admin.register_workspace', scope: { workspaceId: 'management' },
      idempotencyKey: 'ws-overlap', payload: { name: 'Unsafe', root: dir } }).status, 1);
    const register = run('request', { operation: 'admin.register_workspace', scope: { workspaceId: 'management' },
      idempotencyKey: 'ws-a', payload: { name: 'A', root: source } });
    assert.equal(register.status, 0, register.stderr);
    const ws = (JSON.parse(register.stdout) as { id: string }).id;
    const registerCopy = run('request', { operation: 'admin.register_working_copy', scope: { workspaceId: 'management' },
      idempotencyKey: 'copy-a', payload: { workspaceId: ws, root: source } });
    assert.equal(registerCopy.status, 0, registerCopy.stderr);
    assert.equal(run('request', { operation: 'admin.register_working_copy', scope: { workspaceId: 'management' },
      idempotencyKey: 'copy-overlap', payload: { workspaceId: ws, root } }).status, 1);
    const copy = (JSON.parse(registerCopy.stdout) as { id: string; workspaceId: string }).id;
    assert.ok(copy.startsWith('wc_'));
    const grant = run('request', { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'grant-a', payload: { principal, audience: 'local-os', workspaceId: ws,
        recipient: principal, permissions: ['collab.create', 'collab.read'], expiresAt: null } });
    assert.equal(grant.status, 0, grant.stderr);
    const open = run('request', { operation: 'collab.open', scope: { workspaceId: ws },
      idempotencyKey: 'issue-a', payload: { purpose: 'Review one issue' } });
    assert.equal(open.status, 0, open.stderr);
    const issue = (JSON.parse(open.stdout) as { id: string }).id;
    const get = run('request', { operation: 'collab.get', scope: { workspaceId: ws, collaborationId: issue }, payload: {} });
    assert.equal(get.status, 0, get.stderr);
    assert.equal((JSON.parse(get.stdout) as { id: string }).id, issue);
    const forged = run('request', { operation: 'collab.get', scope: { workspaceId: ws, collaborationId: issue },
      payload: {}, principal: 'other' });
    assert.equal(forged.status, 1);
    const marker = 'SYNTHETIC_PRIVATE_BODY_4f7a';
    const malformed = runCli(script, root, 'request', 'identity', ++seq, undefined, `{"body":"${marker}",`);
    assert.equal(malformed.status, 1);
    assert.doesNotMatch(malformed.stderr, /SYNTHETIC_PRIVATE_BODY_4f7a/);
    assert.doesNotMatch(malformed.stderr, /rcac-cli-/);
    completed = true;
  } finally {
    if (completed) {
      const child = relative(resolve(fixtureRoot), resolve(dir));
      assert.ok(child.startsWith('rcac-cli-') && !child.includes('..') && !child.includes('\\'));
      rmSync(dir, { recursive: true, force: true });
    } else {
      process.stderr.write(`${JSON.stringify({ case: 'identity', stage: 'fixture.retained', root: dir })}\n`);
    }
  }
});

test('collect-local-set publishes an explicit binary and ZIP set once and resumes partial staging', async () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-cli-set-'));
  process.stderr.write(`${JSON.stringify({ case: 'collect-local-set', stage: 'fixture.created', root: dir })}\n`);
  const root = join(dir, 'data');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  let db: SqliteStore | undefined;
  const script = resolve('src/cli/main.ts');
  let seq = 0;
  const run = (action: string, input?: unknown) => {
    return runCli(script, root, action, 'collect-local-set', ++seq, input);
  };
  let completed = false;
  try {
    const initialized = run('init');
    assert.equal(initialized.status, 0, initialized.stderr);
    const principal = (JSON.parse(initialized.stdout) as { principal: string }).principal;
    db = new SqliteStore(join(root, 'state.sqlite'));
    const scope = { workspaceId: 'ws_set', collaborationId: 'col_set' };
    db.insertWorkspace({ id: scope.workspaceId, name: 'Set', canonicalRoot: workspace, registeredBy: principal });
    db.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId,
      openedBy: principal, purpose: 'set', hostThreadId: null, state: 'open' });
    db.insertGrant({ id: 'grant-set', principal, audience: 'local-os', recipient: principal,
      ...scope, permissions: ['artifact.submit', 'artifact.collect', 'artifact.read'], expiresAt: null, revokedAt: null });
    const { snapshotId } = await seedBundleProvenance(db, join(root, 'state.sqlite'), {
      ...scope, workingCopyId: 'copy-set', root: workspace, revisionIds: ['ctx-set'],
    });
    const raw = join(dir, 'selected.bin');
    const archive = join(dir, 'selected.zip');
    const missing = join(dir, 'later.bin');
    const rawBytes = Buffer.from([0, 255, 1, 128]);
    const zipBytes = emptyZip();
    writeFileSync(raw, rawBytes); writeFileSync(archive, zipBytes);
    const files = [
      { sourcePath: raw, path: 'assets/raw.bin', mediaType: 'application/octet-stream' },
      { sourcePath: archive, path: 'archives/package.zip', mediaType: 'application/zip' },
    ];
    const manifest = { scope, bundleId: 'bun_set', contextRevision: 'ctx-set', snapshotRefs: [snapshotId], files };
    const first = run('collect-local-set', manifest);
    assert.equal(first.status, 0, first.stderr);
    const published = JSON.parse(first.stdout) as { files: Array<{ normalizedRelativePath: string; sourceReceipt: string; sha256: string }> };
    assert.deepEqual(published.files.map(file => file.normalizedRelativePath).sort(), ['archives/package.zip', 'assets/raw.bin']);
    assert.ok(published.files.every(file => file.sourceReceipt === 'manual_import'));
    const replay = run('collect-local-set', { ...manifest, files: [...files].reverse() });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), published);
    const objects = new ArtifactObjects(join(root, 'artifact-objects'));
    assert.deepEqual(objects.readFile('bun_set', 'assets/raw.bin'), rawBytes);
    assert.deepEqual(objects.readFile('bun_set', 'archives/package.zip'), zipBytes);
    const stored = db.getBundle('bun_set');
    assert.ok(stored?.manifest);
    const listed = run('request', { operation: 'artifact.list', scope, payload: { limit: 10 } });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual((JSON.parse(listed.stdout) as { bundles: { bundleId: string }[] }).bundles
      .map((bundle) => bundle.bundleId), ['bun_set']);
    const inspected = run('request', { operation: 'artifact.inspect', scope, payload: { bundleId: 'bun_set' } });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal((JSON.parse(inspected.stdout) as { ready: boolean; manifest: { bundleId: string } }).ready, true);
    assert.equal((JSON.parse(inspected.stdout) as { manifest: { bundleId: string } }).manifest.bundleId, 'bun_set');
    assert.equal(run('collect-local-set', { ...manifest, files: [...files, files[0]] }).status, 1);
    assert.equal(run('collect-local-set', { ...manifest, files: [{ ...files[0], path: 'ASSETS/RAW.bin' }, files[0]] }).status, 1);
    assert.equal(run('collect-local-set', { ...manifest, files: Array.from({ length: 257 }, (_, i) => ({ ...files[0], path: `f${i}.bin` })) }).status, 1);
    assert.equal(run('collect-local-set', { ...manifest, files: [{ ...files[0], sourcePath: 'relative.bin' }] }).status, 1);
    assert.equal(run('collect-local-set', { ...manifest, files: [{ ...files[0], path: '../escape.bin' }] }).status, 1);
    assert.equal(run('collect-local-set', { ...manifest, files: [] }).status, 1);
    assert.equal(run('collect-local-set', { ...manifest, files: [{ ...files[0], operation: 'artifact.finalize' }] }).status, 1);
    writeFileSync(raw, Buffer.from([9, 8, 7]));
    assert.equal(run('collect-local-set', manifest).status, 1);
    writeFileSync(raw, rawBytes);
    const partial = { ...manifest, bundleId: 'bun_partial', files: [...files,
      { sourcePath: missing, path: 'z-last/later.zip', mediaType: 'application/zip' }] };
    const failed = run('collect-local-set', partial);
    assert.equal(failed.status, 1);
    assert.equal(db.getBundle(partial.bundleId)?.manifest, undefined);
    const staged = objects.status('bun_partial');
    assert.deepEqual(staged.files.map(file => file.normalizedRelativePath).sort(),
      ['archives/package.zip', 'assets/raw.bin']);
    assert.deepEqual(staged.missingPaths, ['z-last/later.zip']);
    writeFileSync(missing, zipBytes);
    const recovered = run('collect-local-set', partial);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.ok(db.getBundle(partial.bundleId)?.manifest);
    assert.deepEqual(objects.readFile('bun_partial', 'assets/raw.bin'), rawBytes);
    assert.deepEqual(objects.readFile('bun_partial', 'z-last/later.zip'), zipBytes);
    completed = true;
  } finally {
    let dbClosed = false;
    try {
      db?.close();
      dbClosed = true;
    } finally {
      if (completed && dbClosed) {
        const child = relative(resolve(fixtureRoot), resolve(dir));
        assert.ok(child.startsWith('rcac-cli-set-') && !child.includes('..') && !child.includes('\\'));
        rmSync(dir, { recursive: true, force: true });
      } else {
        process.stderr.write(`${JSON.stringify({ case: 'collect-local-set', stage: 'fixture.retained', root: dir })}\n`);
      }
    }
  }
});

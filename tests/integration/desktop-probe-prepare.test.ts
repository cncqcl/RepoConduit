import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';

const script = resolve('tools/prepare-windows-desktop-probe.mjs');
function cleanup(root: string): void {
  assert.equal(resolve(root), root);
  assert.equal(resolve(root, '..').toLowerCase(), resolve(homedir()).toLowerCase());
  assert.match(root.split(/[\\/]/).at(-1) ?? '', /^rcac-desktop-probe-(?:existing|test)-/);
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  assert.equal(realpathSync(root).toLowerCase(), root.toLowerCase());
  rmSync(root, { recursive: true, force: true });
}

test('desktop probe preparation refuses an existing HOME child without changing it', { skip: process.platform !== 'win32' }, () => {
  const existing = mkdtempSync(join(homedir(), 'rcac-desktop-probe-existing-'));
  try {
    const result = spawnSync(process.execPath, [script, existing], { cwd: resolve('.'), encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(existing, 'manifest.json')), false);
    assert.equal(existsSync(join(existing, 'data')), false);
  } finally { cleanup(existing); }
});

test('desktop probe preparation installs and binds only collaboration read in a new HOME child',
  { skip: process.platform !== 'win32', timeout: 590_000 }, async () => {
    const root = join(homedir(), `rcac-desktop-probe-test-${crypto.randomUUID()}`);
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const cache = spawnSync(process.execPath, [npmCli, 'config', 'get', 'cache'],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 10_000 });
    assert.equal(cache.status, 0);
    const cachedPackages = cache.stdout.trim();
    assert.ok(existsSync(cachedPackages));
    let prepared = false;
    try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveDone, rejectDone) => {
      const child = spawn(process.execPath, [script, root], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RCAC_PROBE_TEST_OFFLINE_CACHE: cachedPackages } });
      let stdout = ''; let stderr = '';
      const deadline = setTimeout(() => child.kill(), 580_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (chunk.startsWith('Desktop probe:')) process.stderr.write(chunk);
      });
      child.once('error', error => { clearTimeout(deadline); rejectDone(error); });
      child.once('close', status => { clearTimeout(deadline); resolveDone({ status, stdout, stderr }); });
    });
    assert.equal(result.status, 0, result.stderr);
    prepared = true;
    assert.match(result.stderr, /Desktop probe: build completed/);
    assert.match(result.stderr, /Desktop probe: pack completed/);
    assert.match(result.stderr, /Desktop probe: install completed/);
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
      root: string; node: string; cli: string; data: string; workspace: string;
      workspaceId: string; collaborationId: string; nonce: string;
      packageIntegrity: string; npmVersion: string; productVersion: string;
      sourceCommit: string; sourceDirty: boolean; sourceLockSha256: string;
      installedLockSha256: string; installedCliSha256: string;
      external: { principal: string; audience: string; recipient: string };
    };
    assert.equal(manifest.root, root);
    assert.equal(manifest.node, process.execPath);
    assert.ok(existsSync(manifest.cli));
    assert.ok(existsSync(manifest.data));
    assert.ok(existsSync(manifest.workspace));
    assert.match(manifest.workspaceId, /^ws_/);
    assert.match(manifest.collaborationId, /^col_/);
    assert.match(manifest.nonce, /^[a-f0-9]{32}$/);
    assert.match(manifest.packageIntegrity, /^sha512-/);
    assert.ok(manifest.npmVersion);
    assert.ok(manifest.productVersion);
    assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
    assert.equal(typeof manifest.sourceDirty, 'boolean');
    assert.match(manifest.sourceLockSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.installedLockSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.installedCliSha256, /^[a-f0-9]{64}$/);
    const binding = JSON.parse(readFileSync(join(manifest.data, 'mcp-binding.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(binding.visibleOperations, ['collab.get']);
    assert.equal(binding.collaborationId, manifest.collaborationId);
    assert.equal(binding.principal, manifest.external.principal);
    const store = new SqliteStore(join(manifest.data, 'state.sqlite'));
    try {
      const grants = store.grantsFor(manifest.external.principal, manifest.external.audience);
      assert.equal(grants.length, 1);
      const grant = grants[0];
      assert.ok(grant);
      assert.deepEqual(grant.permissions, ['collab.read']);
      assert.equal(grant.workspaceId, manifest.workspaceId);
      assert.equal(grant.collaborationId, manifest.collaborationId);
      assert.match(store.getCollaboration(manifest.collaborationId, manifest.workspaceId)?.purpose ?? '',
        new RegExp(manifest.nonce));
    } finally { store.close(); }
    } finally { if (prepared && existsSync(root)) cleanup(root); }
  });

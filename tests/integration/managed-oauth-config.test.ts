import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { configureOAuth, configureOAuthWithinInstallation,
  configureFileOrigins, configureFileOriginsWithinInstallation } from '../../src/cli/oauth.js';
import { acquireExclusiveMaintenanceGate, initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { acquireInstallationRuntime, currentInstallationPackageVersion } from '../../src/runtime/installation.js';
import {startSelfHostedOAuthHttpWithinInstallation} from '../../src/runtime/self-hosted-oauth-http.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const generation = 'gen_01234567-89ab-4cde-8f01-234567890abc';
const issuer = 'https://issuer.example.test', resource = 'https://mcp.example.test/api/mcp';
const clientId = 'approved-chatgpt', subject = 'operator';
const config = { issuer, resource, clientId, redirectUris: ['https://chatgpt.example.test/callback'],
  scopes: ['collab.read'], operator: { subject, password: 'fixture-password-12345' },
  binding: { issuer, clientId, subject, principal: 'external', recipient: clientId,
    workspaceId: 'workspace-a', collaborationId: 'issue-a', scopes: { 'collab.read': {
      delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'] } } } };

async function fixture(run: (root: string, data: string, retain: () => void) => Promise<void>): Promise<void> {
  const base = process.env.RCAC_TEST_FIXTURE_ROOT??(process.platform === 'win32' ? homedir() : tmpdir());
  const root = mkdtempSync(join(base, 'rcac-managed-oauth-'));
  let primary: unknown;
  let retained = false;
  try {
    protectNewDataDirectory(root);
    initializeMaintenanceGate(root);
    const directories = [join(root, 'generations'), join(root, 'generations', generation),
      join(root, 'generations', generation, 'data')];
    for (const directory of directories) { mkdirSync(directory, { mode: 0o700 }); protectNewDataDirectory(directory); }
    const data = directories[2]!;
    const store = new SqliteStore(join(data, 'state.sqlite'));
    try {
      store.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: data, registeredBy: 'owner' });
      store.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner',
        purpose: 'oauth fixture', hostThreadId: null, state: 'open' });
      const account = userInfo(), local = `${hostname()}\\${account.username}`;
      store.insertGrant({ id: 'admin', principal: local, audience: 'local-os', recipient: local,
        workspaceId: 'management', permissions: ['admin.grant'], expiresAt: null, revokedAt: null });
      store.insertGrant({ id: 'external', principal: 'external', audience: resource,
        recipient: clientId, workspaceId: 'workspace-a', collaborationId: 'issue-a',
        permissions: ['collab.read'], expiresAt: null, revokedAt: null });
    } finally { store.close(); }
    writeFileSync(join(root, 'managed.json'), JSON.stringify({ schemaVersion: 1, activeGeneration: generation,
      packageVersion: currentInstallationPackageVersion(), dataFormatVersion: 1 }), { mode: 0o600 });
    await run(root, data, () => { retained = true; });
  } catch (error) { primary = error; }
  if (retained) {
    process.stderr.write(`Retained managed OAuth fixture: ${root}\n`);
    if (primary !== undefined) throw primary;
    throw new Error('Managed OAuth fixture retained after unconfirmed child shutdown');
  }
  if (primary !== undefined) {
    process.stderr.write(`Retained managed OAuth fixture: ${root}\n`);
    throw primary;
  }
  let cleanup: unknown;
  try { const exclusive = acquireExclusiveMaintenanceGate(root); exclusive.release(); }
  catch (error) { cleanup = error; }
  if (cleanup === undefined) {
    try {
      assert.match(relative(resolve(base), resolve(root)), /^rcac-managed-oauth-[A-Za-z0-9_-]{6}$/);
      rmSync(root, { recursive: true, force: true });
    } catch (error) { cleanup = error; }
  }
  if (cleanup !== undefined) throw cleanup;
}

test('managed OAuth rejects malformed Codex switch before issuer side effects',async()=>{
 await fixture(async(root,data)=>{
  const runtime=acquireInstallationRuntime(root);
  try{
   for(const codexManaged of ['true',1,true]){
    await assert.rejects(startSelfHostedOAuthHttpWithinInstallation(runtime,{
     issuer:{} as never,bindings:[],codexManaged:codexManaged as never,
    }),/NOT_AVAILABLE/);
    assert.equal(existsSync(join(data,'issuer.sqlite')),false);
   }
  }finally{runtime.release();}
 });
});

test('maintenance excludes public OAuth configuration before issuer or config file creation', async () => {
  await fixture(async (root, data) => {
    const exclusive = acquireExclusiveMaintenanceGate(root);
    try {
      await assert.rejects(configureOAuth(root, config), /MAINTENANCE_GATE_BUSY/);
      assert.throws(() => configureFileOrigins(root, { allowedFileOrigins: [],
        expectedAllowedFileOrigins: [] }), /MAINTENANCE_GATE_BUSY/);
      assert.equal(existsSync(join(data, 'oauth-config.json')), false);
      assert.equal(existsSync(join(data, 'issuer.sqlite')), false);
    } finally { exclusive.release(); }
  });
});

test('borrowed managed OAuth writes active generation and never releases its owner', async () => {
  await fixture(async (root, data) => {
    const runtime = acquireInstallationRuntime(root);
    try {
      await assert.rejects(configureOAuthWithinInstallation({ ...runtime }, config), /INSTALLATION_UNSAFE/);
      assert.throws(() => configureFileOriginsWithinInstallation({ ...runtime }, {}), /INSTALLATION_UNSAFE/);
      assert.equal((await configureOAuthWithinInstallation(runtime, config)).configured, true);
      const path = join(data, 'oauth-config.json');
      assert.equal(existsSync(path), true);
      const before = readFileSync(path, 'utf8');
      assert.equal(before.includes(config.operator.password), false);
      assert.deepEqual(configureFileOriginsWithinInstallation(runtime, { allowedFileOrigins: ['https://files.example.test'],
        expectedAllowedFileOrigins: [] }).allowedFileOrigins, ['https://files.example.test']);
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
      assert.equal(existsSync(join(root, 'oauth-config.json')), false);
    } finally { runtime.release(); }
    await assert.rejects(configureOAuthWithinInstallation(runtime, config), /INSTALLATION_UNSAFE/);
    assert.throws(() => configureFileOriginsWithinInstallation(runtime, {}), /INSTALLATION_UNSAFE/);
  });
});

test('borrowed OAuth cannot write after its owner releases during key generation', async () => {
  await fixture(async (root, data) => {
    const runtime = acquireInstallationRuntime(root);
    const pending = configureOAuthWithinInstallation(runtime, config);
    runtime.release();
    await assert.rejects(pending, /INSTALLATION_UNSAFE/);
    assert.equal(existsSync(join(data, 'oauth-config.json')), false);
  });
});

test('public conflicts release gate; source CLI runtime serves HTTP then closes', { timeout: 180_000 },
  async t => fixture(async (root, data, retain) => {
    t.signal.throwIfAborted();
    t.diagnostic('managed OAuth public fixture ready');
    await assert.rejects(configureOAuth(root, { ...config, issuer: 'http://issuer.example.test' }), /configuration/i);
    t.signal.throwIfAborted();
    assert.equal((await configureOAuth(root, config)).configured, true);
    t.signal.throwIfAborted();
    await assert.rejects(configureOAuth(root, config), /EEXIST|exists/i);
    t.signal.throwIfAborted();
    assert.throws(() => configureFileOrigins(root, { allowedFileOrigins: ['https://files.example.test'],
      expectedAllowedFileOrigins: ['https://stale.example.test'] }), /CONFLICT/);
    assert.deepEqual(configureFileOrigins(root, { allowedFileOrigins: ['https://files.example.test'],
      expectedAllowedFileOrigins: [] }).allowedFileOrigins, ['https://files.example.test']);
    t.signal.throwIfAborted();
    t.diagnostic('managed OAuth public configuration ready');
    const moduleUrl = new URL('../../src/cli/oauth.ts', import.meta.url).href;
    const script = `import { serveOAuthHttp } from ${JSON.stringify(moduleUrl)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); });
      await serveOAuthHttp(${JSON.stringify(root)});
      process.disconnect?.();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', stderr = '';
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const closed = new Promise<void>((resolveClosed) => { child.once('close', () => resolveClosed()); });
    const terminal = new Promise<void>((resolve, reject) => {
      child.once('close', (code) => { if (code === 0) resolve(); else reject(new Error(`serve-http exited ${code}: ${stderr.slice(0, 512)}`)); });
      child.once('error', reject);
    });
    void terminal.catch(() => undefined);
    let graceful = false;
    let primary: unknown;
    try {
      let startupTimer: NodeJS.Timeout | undefined;
      const started = await Promise.race([new Promise<{ issuerUrl: string; mcpUrl: string }>((resolveStarted) => {
        const inspect = () => { const line = output.split('\n')[0];
          if (line) try { resolveStarted(JSON.parse(line) as { issuerUrl: string; mcpUrl: string }); }
          catch { /* Wait for a complete line. */ }
        };
        child.stdout!.on('data', inspect); inspect();
      }), new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error('serve-http startup timeout')), 30_000);
      })]).finally(() => { if (startupTimer) clearTimeout(startupTimer); });
      t.signal.throwIfAborted();
      t.diagnostic('managed OAuth source HTTP ready');
      assert.equal((await fetch(new URL('/.well-known/oauth-authorization-server', started.issuerUrl),
        { signal: t.signal })).status, 200);
      assert.equal(existsSync(join(data, 'issuer.sqlite')), true);
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
      child.send('stop');
      let shutdownTimer: NodeJS.Timeout | undefined;
      await Promise.race([terminal, new Promise<never>((_resolve, reject) =>
        { shutdownTimer = setTimeout(() => reject(new Error('serve-http shutdown timeout')), 10_000); })])
        .finally(() => { if (shutdownTimer) clearTimeout(shutdownTimer); });
      graceful = true;
    } catch (error) { primary = error; }
    let cleanup: unknown;
    if (!graceful) {
      try { child.kill(); }
      catch (error) { cleanup = error; }
      let cleanupTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('serve-http child close unconfirmed')), 5_000);
        })]);
      } catch (error) {
        cleanup = cleanup === undefined ? error : new AggregateError([cleanup, error], 'Child cleanup failed');
        retain();
      } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
    }
    if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup],
      'Source HTTP assertion and child cleanup failed');
    if (primary !== undefined) throw primary;
    if (cleanup !== undefined) throw cleanup;
    t.signal.throwIfAborted();
    t.diagnostic('managed OAuth source HTTP closed');
  }));

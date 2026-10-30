import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { exportJWK, generateKeyPair } from 'jose';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { initializeMaintenanceGate, acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { acquireInstallationRuntime, currentInstallationPackageVersion } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { startProductExternalHttp, startProductExternalHttpWithinInstallation } from '../../src/runtime/external-http.js';
import { startSelfHostedOAuthHttp, startSelfHostedOAuthHttpWithinInstallation } from '../../src/runtime/self-hosted-oauth-http.js';

const generation = 'gen_01234567-89ab-4cde-8f01-234567890abc';
const audience = 'https://mcp.example.test/api/mcp';
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-managed-http-'));
  let primary: unknown;
  try {
    protectNewDataDirectory(root);
    initializeMaintenanceGate(root);
    const directories = [join(root, 'generations'), join(root, 'generations', generation),
      join(root, 'generations', generation, 'data')];
    for (const directory of directories) { mkdirSync(directory, { mode: 0o700 }); protectNewDataDirectory(directory); }
    const store = new SqliteStore(join(directories[2]!, 'state.sqlite'));
    store.close();
    writeFileSync(join(root, 'managed.json'), JSON.stringify({ schemaVersion: 1, activeGeneration: generation,
      packageVersion: currentInstallationPackageVersion(), dataFormatVersion: 1 }), { mode: 0o600 });
    await run(root);
  } catch (error) { primary = error; }
  let cleanupError: unknown;
  try { const exclusive = acquireExclusiveMaintenanceGate(root); exclusive.release(); }
  catch (error) { cleanupError = error; }
  if (cleanupError === undefined) {
    try {
      const child = relative(resolve(base), resolve(root));
      assert.match(child, /^rcac-managed-http-[A-Za-z0-9_-]{6}$/);
      rmSync(root, { recursive: true, force: true });
    } catch (error) { cleanupError = error; }
  }
  if (primary !== undefined && cleanupError !== undefined) throw new AggregateError([primary, cleanupError],
    'Managed HTTP assertion and fixture cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanupError !== undefined) throw cleanupError;
}

const product = { expectedAudience: audience, async verifyBearer() { return undefined; } };
async function oauthOptions() {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const salt = randomBytes(16);
  const issuer = 'https://issuer.example.test', clientId = 'approved-chatgpt', subject = 'operator';
  return { issuer: { issuer, resource: audience, clientId,
    redirectUris: ['https://chatgpt.example.test/callback'], scopes: ['collab.read'],
    operator: { subject, saltHex: salt.toString('hex'),
      hashHex: scryptSync('fixture-secret', salt, 64).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')],
    jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] } },
    bindings: [{ issuer, clientId, subject, principal: 'external', recipient: clientId,
      workspaceId: 'workspace-a', scopes: { 'collab.read': { delegatedPermissions: ['collab.read'],
        visibleOperations: ['collab.get'] } } }] };
}

test('managed public HTTP owners are excluded by maintenance and release only after close', async () => {
  await fixture(async root => {
    const options = await oauthOptions();
    const exclusive = acquireExclusiveMaintenanceGate(root);
    try {
      await assert.rejects(startProductExternalHttp(root, product), /MAINTENANCE_GATE_BUSY/);
      await assert.rejects(startSelfHostedOAuthHttp(root, options), /MAINTENANCE_GATE_BUSY/);
      assert.equal(existsSync(join(root, 'generations', generation, 'data', 'issuer.sqlite')), false);
    } finally { exclusive.release(); }
    const productHttp = await startProductExternalHttp(root, product);
    try { assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/); }
    finally { await productHttp.close(); }
    assert.strictEqual(productHttp.close(), productHttp.close());
    const issuerHttp = await startSelfHostedOAuthHttp(root, options);
    try {
      assert.equal((await fetch(new URL('/.well-known/oauth-authorization-server', issuerHttp.issuerUrl))).status, 200);
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
    } finally { await issuerHttp.close(); }
    assert.strictEqual(issuerHttp.close(), issuerHttp.close());
  });
});

test('borrowed HTTP handles retain the outer owner and reject forged or released handles', async () => {
  await fixture(async root => {
    const options = await oauthOptions();
    const runtime = acquireInstallationRuntime(root);
    try {
      await assert.rejects(startProductExternalHttpWithinInstallation({ ...runtime }, product), /INSTALLATION_UNSAFE/);
      await assert.rejects(startSelfHostedOAuthHttpWithinInstallation({ ...runtime }, options), /INSTALLATION_UNSAFE/);
      const productHttp = await startProductExternalHttpWithinInstallation(runtime, product);
      await productHttp.close();
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
      const issuerHttp = await startSelfHostedOAuthHttpWithinInstallation(runtime, options);
      await issuerHttp.close();
      assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
    } finally { runtime.release(); }
    await assert.rejects(startProductExternalHttpWithinInstallation(runtime, product), /INSTALLATION_UNSAFE/);
    await assert.rejects(startSelfHostedOAuthHttpWithinInstallation(runtime, options), /INSTALLATION_UNSAFE/);
  });
});

test('failed binding and occupied ports release public managed HTTP ownership', async () => {
  await fixture(async root => {
    const options = await oauthOptions();
    await assert.rejects(startSelfHostedOAuthHttp(root, { ...options, bindings: [] }), /binding mismatch/);
    assert.equal(existsSync(join(root, 'generations', generation, 'data', 'issuer.sqlite')), false);
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await assert.rejects(startProductExternalHttp(root, { ...product, port: address.port }), /EADDRINUSE/);
      await assert.rejects(startSelfHostedOAuthHttp(root, { ...options,
        issuer: { ...options.issuer, port: address.port } }), /EADDRINUSE/);
      await assert.rejects(startSelfHostedOAuthHttp(root, { ...options,
        mcpPort: address.port }), /EADDRINUSE/);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
});

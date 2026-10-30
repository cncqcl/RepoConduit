import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair } from 'jose';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { startSelfHostedOAuthHttp } from '../../src/runtime/self-hosted-oauth-http.js';

test('local issuer token reaches only its persisted workspace grant through product MCP', async () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-oauth-product-'));
  protectNewDataDirectory(root);
  const state = new SqliteStore(join(root, 'state.sqlite'));
  const issuer = 'https://issuer.example.test';
  const resource = 'https://mcp.example.test/api/mcp';
  const clientId = 'approved-chatgpt';
  const subject = 'operator-1';
  const workspaceId = 'ws-a';
  const collaborationId = 'col-a';
  const salt = randomBytes(16);
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  mkdirSync(join(root, 'project-b'));
  state.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: root, registeredBy: 'owner' });
  state.insertWorkspace({ id: 'ws-b', name: 'B', canonicalRoot: join(root, 'project-b'), registeredBy: 'owner' });
  state.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
    purpose: 'OAuth product fixture', hostThreadId: null, state: 'open' });
  state.insertGrant({ id: 'gr-a', principal: 'external-operator', audience: resource,
    recipient: clientId, workspaceId, collaborationId, permissions: ['collab.read'],
    expiresAt: null, revokedAt: null });
  state.close();
  const configuration = {
    issuer: { issuer, resource, clientId, redirectUris: ['https://chatgpt.example.test/callback'],
      scopes: ['collab.read'], operator: { subject, saltHex: salt.toString('hex'),
        hashHex: scryptSync('fixture-secret', salt, 64).toString('hex') },
      cookieKeys: [randomBytes(32).toString('hex')],
      jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] } },
    bindings: [{ issuer, clientId, subject, principal: 'external-operator', recipient: clientId,
      workspaceId, collaborationId, scopes: { 'collab.read': {
        delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'] } } }],
  };
  await assert.rejects(startSelfHostedOAuthHttp(root, { ...configuration,
    issuer: { ...configuration.issuer, scopes: ['collab.read', 'repo.read'] } }),
  /binding mismatch/);
  const handle = await startSelfHostedOAuthHttp(root, configuration);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, 'issuer.sqlite')).mode & 0o077, 0);
  }
  const client = await handle.provider.Client.find(clientId);
  assert.ok(client);
  const grant = new handle.provider.Grant({ accountId: subject, clientId });
  grant.addResourceScope(resource, 'collab.read');
  const grantId = await grant.save();
  const token = await new handle.provider.AccessToken({ accountId: subject, client, grantId,
    gty: 'authorization_code', scope: 'collab.read', aud: resource }).save();
  const mcp = new Client({ name: 'self-hosted-oauth-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(handle.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    assert.equal((await fetch(`${handle.issuerUrl}/.well-known/oauth-authorization-server`)).status, 200);
    await mcp.connect(transport);
    assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name), ['collab.get']);
    assert.equal((await mcp.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId, collaborationId }, payload: {} } })).isError, undefined);
    const other = await mcp.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-b', collaborationId }, payload: {} } });
    assert.equal(other.isError, true);
    const revoker = new SqliteStore(join(root, 'state.sqlite'));
    try { revoker.revokeGrant('gr-a', new Date().toISOString()); }
    finally { revoker.close(); }
    assert.equal((await mcp.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId, collaborationId }, payload: {} } })).isError, true);
    await handle.provider.AccessToken.revokeByGrantId(grantId);
    const response = await fetch(handle.mcpUrl, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(response.status, 401);
    await handle.close();
    const issuerFile = join(root, 'issuer.sqlite');
    if (process.platform === 'win32') {
      const script = String.raw`$ErrorActionPreference='Stop';
        $acl=[System.IO.File]::GetAccessControl($env:RCAC_TEST_FILE);
        $sid=New-Object System.Security.Principal.SecurityIdentifier 'S-1-1-0';
        $rights=[System.Security.AccessControl.FileSystemRights]::Read;
        $kind=[System.Security.AccessControl.AccessControlType]::Allow;
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$rights,$kind)));
        [System.IO.File]::SetAccessControl($env:RCAC_TEST_FILE,$acl)`;
      const altered = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15_000,
          env: { ...process.env, RCAC_TEST_FILE: issuerFile } });
      assert.equal(altered.status, 0, altered.stderr);
    } else chmodSync(issuerFile, 0o644);
    await assert.rejects(startSelfHostedOAuthHttp(root, configuration),
      /Data directory permissions unavailable or unsafe|Binding file is not private/);
  } finally {
    await mcp.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

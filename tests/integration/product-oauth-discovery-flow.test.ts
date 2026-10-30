import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair } from 'jose';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { startSelfHostedOAuthHttp } from '../../src/runtime/self-hosted-oauth-http.js';

test('resource discovery leads through local PKCE consent to scoped product MCP and revocation', async () => {
  const root = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-oauth-flow-'));
  protectNewDataDirectory(root);
  const issuer = 'https://issuer.example.test';
  const resource = 'https://mcp.example.test/mcp';
  const clientId = 'fixture-public-client';
  const redirectUri = 'https://client.example.test/callback';
  const subject = 'fixture-operator';
  const password = 'fixture-password';
  const workspaceId = 'ws-fixture-a';
  const collaborationId = 'col-fixture-a';
  const state = new SqliteStore(join(root, 'state.sqlite'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  state.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: join(root, 'a'), registeredBy: 'owner' });
  state.insertWorkspace({ id: 'ws-fixture-b', name: 'B', canonicalRoot: join(root, 'b'), registeredBy: 'owner' });
  state.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
    purpose: 'synthetic OAuth flow', hostThreadId: null, state: 'open' });
  state.insertCollaboration({ id: 'col-fixture-b', workspaceId: 'ws-fixture-b', openedBy: 'owner',
    purpose: 'cross-workspace denial', hostThreadId: null, state: 'open' });
  state.insertGrant({ id: 'gr-fixture-a', principal: 'fixture-external', audience: resource,
    recipient: clientId, workspaceId, collaborationId, permissions: ['collab.read'],
    expiresAt: null, revokedAt: null });
  state.close();
  const salt = randomBytes(16);
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const handle = await startSelfHostedOAuthHttp(root, {
    issuer: { issuer, resource, clientId, redirectUris: [redirectUri], scopes: ['collab.read'],
      operator: { subject, saltHex: salt.toString('hex'),
        hashHex: scryptSync(password, salt, 64).toString('hex') },
      cookieKeys: [randomBytes(32).toString('hex')],
      jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] } },
    bindings: [{ issuer, clientId, subject, principal: 'fixture-external', recipient: clientId,
      workspaceId, collaborationId, scopes: { 'collab.read': {
        delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'] } } }],
  });
  const mcp = new Client({ name: 'oauth-flow-fixture', version: '1' });
  try {
    const unauthorized = await fetch(handle.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(unauthorized.status, 401);
    const challenge = unauthorized.headers.get('www-authenticate') ?? '';
    const metadataUrl = /^Bearer resource_metadata="([^"]+)"$/.exec(challenge)?.[1];
    assert.equal(metadataUrl, 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
    const resourceDocument = await fetch(new URL(new URL(metadataUrl).pathname, handle.mcpUrl));
    assert.equal(resourceDocument.status, 200);
    const protectedResource = await resourceDocument.json() as {
      resource: string; authorization_servers: string[]; scopes_supported: string[] };
    assert.equal(protectedResource.resource, resource);
    assert.deepEqual(protectedResource.authorization_servers, [issuer]);
    assert.deepEqual(protectedResource.scopes_supported, ['collab.read']);
    const issuerDocument = await fetch(new URL('/.well-known/oauth-authorization-server', handle.issuerUrl));
    assert.equal(issuerDocument.status, 200);
    const authorizationServer = await issuerDocument.json() as {
      issuer: string; authorization_endpoint: string; token_endpoint: string;
      revocation_endpoint: string; code_challenge_methods_supported: string[];
      authorization_response_iss_parameter_supported: boolean };
    assert.equal(authorizationServer.issuer, issuer);
    assert.deepEqual(authorizationServer.code_challenge_methods_supported, ['S256']);
    assert.equal(authorizationServer.authorization_response_iss_parameter_supported, true);
    assert.equal(new URL(authorizationServer.authorization_endpoint).origin, issuer);
    assert.equal(new URL(authorizationServer.token_endpoint).origin, issuer);
    assert.equal(new URL(authorizationServer.revocation_endpoint).origin, issuer);

    // The browser fixture follows the public issuer's paths on the loopback listener.
    const cookies = new Map<string, string>();
    const issuerRequest = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
      const publicUrl = new URL(url);
      assert.equal(publicUrl.origin, issuer);
      const localUrl = new URL(`${publicUrl.pathname}${publicUrl.search}`, handle.issuerUrl);
      const headers = new Headers(init.headers);
      if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      const response = await fetch(localUrl, { ...init, headers, redirect: 'manual' });
      for (const item of response.headers.getSetCookie()) {
        const pair = item.split(';')[0]!;
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    };
    const verifier = randomBytes(32).toString('base64url');
    const authorization = new URL(authorizationServer.authorization_endpoint);
    authorization.search = new URLSearchParams({ response_type: 'code', client_id: clientId,
      redirect_uri: redirectUri, scope: 'collab.read', resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state: 'fixture-state' }).toString();
    const missingPkce = new URL(authorization);
    missingPkce.searchParams.delete('code_challenge');
    const refused = await issuerRequest(missingPkce);
    assert.equal(refused.status, 303);
    const refusedCallback = new URL(refused.headers.get('location')!);
    assert.equal(refusedCallback.searchParams.get('iss'), issuer);
    assert.ok(refusedCallback.searchParams.has('error'));
    const start = await issuerRequest(authorization);
    assert.equal(start.status, 303);
    const loginPath = start.headers.get('location');
    assert.match(loginPath ?? '', /^\/interaction\//);
    const loginPage = await issuerRequest(new URL(loginPath!, issuer));
    assert.equal(loginPage.status, 200);
    const loginCsrf = /name="csrf" value="([^"]+)"/.exec(await loginPage.text())?.[1];
    assert.ok(loginCsrf);
    const logged = await issuerRequest(new URL(loginPath!, issuer), { method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: loginCsrf, password }) });
    assert.equal(logged.status, 303);
    const resumed = await issuerRequest(new URL(logged.headers.get('location')!, issuer));
    assert.equal(resumed.status, 303);
    const consentPath = resumed.headers.get('location');
    assert.match(consentPath ?? '', /^\/interaction\//);
    const consentPage = await issuerRequest(new URL(consentPath!, issuer));
    assert.equal(consentPage.status, 200);
    const consentCsrf = /name="csrf" value="([^"]+)"/.exec(await consentPage.text())?.[1];
    assert.ok(consentCsrf);
    const approved = await issuerRequest(new URL(consentPath!, issuer), { method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: consentCsrf, approve: 'yes' }) });
    assert.equal(approved.status, 303);
    const completed = await issuerRequest(new URL(approved.headers.get('location')!, issuer));
    assert.equal(completed.status, 303);
    const callback = new URL(completed.headers.get('location')!);
    assert.equal(callback.origin, new URL(redirectUri).origin);
    assert.equal(callback.pathname, new URL(redirectUri).pathname);
    assert.equal(callback.searchParams.get('iss'), issuer);
    assert.equal(callback.searchParams.get('state'), 'fixture-state');
    const code = callback.searchParams.get('code');
    assert.ok(code);
    const tokenResponse = await issuerRequest(authorizationServer.token_endpoint, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId,
        redirect_uri: redirectUri, code_verifier: verifier, resource }) });
    assert.equal(tokenResponse.status, 200);
    const tokenDocument = await tokenResponse.json() as { access_token?: string; token_type?: string; scope?: string };
    assert.equal(tokenDocument.token_type, 'Bearer');
    assert.equal(tokenDocument.scope, 'collab.read');
    assert.ok(tokenDocument.access_token);

    await mcp.connect(new StreamableHTTPClientTransport(new URL(handle.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${tokenDocument.access_token}` } },
    }));
    assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name), ['collab.get']);
    const own = { scope: { workspaceId, collaborationId }, payload: {} };
    const found = await mcp.callTool({ name: 'collab.get', arguments: own });
    assert.equal(found.isError, undefined);
    assert.equal((JSON.parse((found.content[0] as { text: string }).text) as { id: string }).id, collaborationId);
    const other = await mcp.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-fixture-b', collaborationId: 'col-fixture-b' }, payload: {} } });
    assert.equal(other.isError, true);
    assert.equal((other.content[0] as { text: string }).text, 'Request failed or resource unavailable');

    const revoker = new SqliteStore(join(root, 'state.sqlite'));
    try { revoker.revokeGrant('gr-fixture-a', new Date().toISOString()); }
    finally { revoker.close(); }
    assert.equal((await mcp.callTool({ name: 'collab.get', arguments: own })).isError, true);
    const replacement = new SqliteStore(join(root, 'state.sqlite'));
    try { replacement.insertGrant({ id: 'gr-fixture-a-replacement', principal: 'fixture-external',
      audience: resource, recipient: clientId, workspaceId, collaborationId,
      permissions: ['collab.read'], expiresAt: null, revokedAt: null }); }
    finally { replacement.close(); }
    assert.equal((await mcp.callTool({ name: 'collab.get', arguments: own })).isError, undefined);
    const revoked = await issuerRequest(authorizationServer.revocation_endpoint, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenDocument.access_token, client_id: clientId }) });
    assert.equal(revoked.status, 200);
    const rejected = await fetch(handle.mcpUrl, { method: 'POST', headers: {
      authorization: `Bearer ${tokenDocument.access_token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    assert.equal(rejected.status, 401);
  } finally {
    await mcp.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

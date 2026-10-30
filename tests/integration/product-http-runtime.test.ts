import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createLocalJwksBearerVerifier } from '../../src/adapters/mcp/oauth-jwt.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { startProductExternalHttp } from '../../src/runtime/external-http.js';

function fixtureEvent(caseName: string, stage: string, fixture: string, error?: unknown): void {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const operations = ['protect', 'verify_data', 'verify_installation'];
  const reasons = ['timeout', 'output_limit', 'spawn_missing', 'spawn_denied', 'helper_rejected', 'unknown'];
  const safeCause = cause && typeof cause === 'object' && 'component' in cause &&
    cause.component === 'private_directory' ? {
      component: 'private_directory',
      operation: 'operation' in cause && typeof cause.operation === 'string' &&
        operations.includes(cause.operation) ? cause.operation : null,
      reason: 'reason' in cause && typeof cause.reason === 'string' &&
        reasons.includes(cause.reason) ? cause.reason : null,
    } : undefined;
  process.stderr.write(`${JSON.stringify({ case: caseName, stage, fixture, cause: safeCause })}\n`);
}

function removeSuccessfulFixture(base: string, container: string, prefix: string): void {
  const child = relative(resolve(base), resolve(container));
  assert.ok(child.startsWith(prefix) && !child.includes('..') && !child.includes('\\'));
  rmSync(container, { recursive: true, force: true });
}

test('product HTTP uses persisted grants and revocation through one dispatcher', async () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const container = mkdtempSync(join(base, 'rcac-http-product-'));
  const dir = join(container, 'data');
  fixtureEvent('product-http', 'fixture.created', container);
  const file = join(dir, 'state.sqlite');
  const workspaceId = 'ws-http', collaborationId = 'col-http';
  let store: SqliteStore | undefined;
  let handle: Awaited<ReturnType<typeof startProductExternalHttp>> | undefined;
  let client: Client | undefined;
  let stage = 'fixture.created';
  let failure: unknown;
  let completed = false;
  try {
    stage = 'data.protect';
    mkdirSync(dir, { mode: 0o700 });
    protectNewDataDirectory(dir);
    stage = 'database.seed';
    store = new SqliteStore(file);
    store.insertWorkspace({ id: workspaceId, name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
    store.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
      purpose: 'http fixture', hostThreadId: null, state: 'open' });
    store.insertGrant({ id: 'gr-http', principal: 'external', audience: 'resource-fixture',
      recipient: 'external', workspaceId, collaborationId, permissions: ['collab.read'],
      expiresAt: null, revokedAt: null });
    store.close();
    store = undefined;
    stage = 'http.start';
    handle = await startProductExternalHttp(dir, { expectedAudience: 'resource-fixture',
      async verifyBearer(token) { return token === 'synthetic' ? {
        principal: 'external', audience: 'resource-fixture', recipient: 'external',
        expiresAt: Date.now() + 60_000, delegatedPermissions: ['collab.read'],
        visibleOperations: ['collab.get'], allowedWorkspaceId: workspaceId,
        allowedCollaborationId: collaborationId,
      } : undefined; },
    });
    client = new Client({ name: 'product-http-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { authorization: 'Bearer synthetic' } },
    });
    stage = 'http.assert';
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['collab.get']);
    const args = { scope: { workspaceId, collaborationId }, payload: {} };
    const found = await client.callTool({ name: 'collab.get', arguments: args });
    assert.equal(found.isError, undefined);
    const revoker = new SqliteStore(file);
    try { revoker.revokeGrant('gr-http', new Date().toISOString()); }
    finally { revoker.close(); }
    const rejected = await client.callTool({ name: 'collab.get', arguments: args });
    assert.equal(rejected.isError, true);
    completed = true;
  } catch (error) {
    failure = error;
  } finally {
    try { await client?.close(); } catch (error) { failure ??= error; }
    try { await handle?.close(); } catch (error) { failure ??= error; }
    try { store?.close(); } catch (error) { failure ??= error; }
    if (completed && failure === undefined) removeSuccessfulFixture(base, container, 'rcac-http-product-');
    else fixtureEvent('product-http', `${stage}.retained`, container, failure);
  }
  if (failure !== undefined) throw failure;
});

test('signed JWT reaches persisted HTTP grants; later grant and verifier denials fail closed', async () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const container = mkdtempSync(join(base, 'rcac-http-jwt-'));
  const dir = join(container, 'data');
  fixtureEvent('signed-jwt', 'fixture.created', container);
  const file = join(dir, 'state.sqlite');
  const workspaceId = 'ws-jwt', collaborationId = 'col-jwt';
  const issuer = 'https://issuer.example.test';
  const audience = 'https://resource.example.test';
  let store: SqliteStore | undefined;
  let handle: Awaited<ReturnType<typeof startProductExternalHttp>> | undefined;
  let client: Client | undefined;
  let stage = 'fixture.created';
  let failure: unknown;
  let completed = false;
  let active = true;
  try {
    stage = 'data.protect';
    mkdirSync(dir, { mode: 0o700 });
    protectNewDataDirectory(dir);
    stage = 'jwt.prepare';
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...await exportJWK(publicKey), kid: 'local-test', alg: 'RS256', use: 'sig' };
    const token = await new SignJWT({ client_id: 'approved-client', scope: 'collab.read' })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'local-test' })
      .setIssuer(issuer).setAudience(audience).setSubject('external-subject')
      .setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(privateKey);
    stage = 'database.seed';
    store = new SqliteStore(file);
    store.insertWorkspace({ id: workspaceId, name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
    store.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
      purpose: 'signed jwt fixture', hostThreadId: null, state: 'open' });
    store.insertGrant({ id: 'gr-jwt', principal: 'external-jwt', audience,
      recipient: 'approved-client', workspaceId, collaborationId, permissions: ['collab.read'],
      expiresAt: null, revokedAt: null });
    store.close();
    store = undefined;
    const verifyBearer = createLocalJwksBearerVerifier({ issuer, audience,
      jwks: { keys: [jwk] }, algorithms: ['RS256'],
      bindings: [{ issuer, subject: 'external-subject', clientId: 'approved-client',
        principal: 'external-jwt', recipient: 'approved-client', allowedWorkspaceId: workspaceId,
        allowedCollaborationId: collaborationId,
        scopes: { 'collab.read': { delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'] } } }],
      isActive: async () => active,
    });
    stage = 'http.start';
    handle = await startProductExternalHttp(dir, { expectedAudience: audience, verifyBearer,
      resourceMetadata: { resource: audience, authorizationServer: issuer, scopes: ['collab.read'] } });
    client = new Client({ name: 'product-jwt-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    stage = 'http.assert';
    const metadata = await fetch(`${handle.url.replace('/mcp', '')}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { resource: audience,
      authorization_servers: [issuer], scopes_supported: ['collab.read'] });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['collab.get']);
    const command = { scope: { workspaceId, collaborationId }, payload: {} };
    assert.equal((await client.callTool({ name: 'collab.get', arguments: command })).isError, undefined);
    const revoker = new SqliteStore(file);
    try { revoker.revokeGrant('gr-jwt', new Date().toISOString()); }
    finally { revoker.close(); }
    assert.equal((await client.callTool({ name: 'collab.get', arguments: command })).isError, true);
    active = false;
    const unauthorized = await fetch(handle.url, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata/);
    completed = true;
  } catch (error) {
    failure = error;
  } finally {
    try { await client?.close(); } catch (error) { failure ??= error; }
    try { await handle?.close(); } catch (error) { failure ??= error; }
    try { store?.close(); } catch (error) { failure ??= error; }
    if (completed && failure === undefined) removeSuccessfulFixture(base, container, 'rcac-http-jwt-');
    else fixtureEvent('signed-jwt', `${stage}.retained`, container, failure);
  }
  if (failure !== undefined) throw failure;
});

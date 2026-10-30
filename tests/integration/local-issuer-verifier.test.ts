import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair } from 'jose';
import { startLocalIssuer } from '../../src/adapters/auth/issuer.js';
import { createLocalIntrospectionVerifier } from '../../src/adapters/auth/introspection-verifier.js';

test('trusted verifier accepts only live issuer tokens with exact operator binding and scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-verifier-'));
  const db = new DatabaseSync(join(root, 'issuer.sqlite'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const salt = randomBytes(16);
  const issuer = 'https://issuer.example.test';
  const resource = 'https://mcp.example.test/mcp';
  const clientId = 'approved-chatgpt';
  const subject = 'operator-1';
  const server = await startLocalIssuer({ issuer, resource, clientId,
    redirectUris: ['https://chatgpt.example.test/callback'], scopes: ['repo.read', 'artifact.write'],
    operator: { subject, saltHex: salt.toString('hex'),
      hashHex: scryptSync('fixture-password', salt, 64).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')],
    jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] }, db });
  try {
    const verify = await createLocalIntrospectionVerifier({ loopbackUrl: server.url, expectedIssuer: issuer,
      expectedResource: resource, expectedClientId: clientId,
      bindings: [{ issuer, clientId, subject, principal: 'chatgpt-operator', recipient: 'external',
        workspaceId: 'ws_1', collaborationId: 'col_1',
        scopes: { 'repo.read': { delegatedPermissions: ['repo.read'], visibleOperations: ['repo.get'] },
          'artifact.write': { delegatedPermissions: ['artifact.submit'], visibleOperations: ['artifact.submit'] } } }] });
    const grant = new server.provider.Grant({ accountId: subject, clientId });
    grant.addResourceScope(resource, 'repo.read artifact.write');
    const grantId = await grant.save();
    const client = await server.provider.Client.find(clientId);
    assert.ok(client);
    const issue = async (overrides: Record<string, unknown> = {}) =>
      new server.provider.AccessToken({ accountId: subject, client, grantId, gty: 'authorization_code',
        scope: 'repo.read artifact.write', aud: resource, ...overrides }).save();
    const token = await issue();
    const inspect = async (value: string) => {
      const response = await fetch(new URL('/token/introspection', server.url), { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: value, client_id: clientId }) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ active?: boolean }>;
    };
    const identity = await verify(token);
    assert.deepEqual(identity, { principal: 'chatgpt-operator', recipient: 'external', audience: resource,
      expiresAt: identity?.expiresAt, allowedWorkspaceId: 'ws_1', allowedCollaborationId: 'col_1',
      delegatedPermissions: ['artifact.submit', 'repo.read'], visibleOperations: ['artifact.submit', 'repo.get'] });
    assert.ok(identity!.expiresAt > Date.now());
    const readOnly = await issue({ scope: 'repo.read' });
    assert.deepEqual((await verify(readOnly))?.delegatedPermissions, ['repo.read']);
    assert.deepEqual((await verify(readOnly))?.visibleOperations, ['repo.get']);
    assert.equal(await verify('unknown-token'), undefined);
    const otherResource = await issue({ scope: 'repo.read', aud: 'https://other.example.test' });
    assert.equal((await inspect(otherResource)).active, true);
    assert.equal(await verify(otherResource), undefined);
    const originAudience = await issue({ scope: 'repo.read', aud: 'https://mcp.example.test' });
    assert.equal((await inspect(originAudience)).active, true);
    assert.equal(await verify(originAudience), undefined);
    const wrongClientVerifier = await createLocalIntrospectionVerifier({ loopbackUrl: server.url,
      expectedIssuer: issuer, expectedResource: resource, expectedClientId: 'other-client',
      bindings: [{ issuer, clientId: 'other-client', subject, principal: 'wrong-client', recipient: 'external',
        workspaceId: 'ws_1', scopes: { 'repo.read': { delegatedPermissions: ['repo.read'],
          visibleOperations: ['repo.get'] } } }] });
    assert.equal(await wrongClientVerifier(token), undefined);
    const otherGrant = new server.provider.Grant({ accountId: 'other-operator', clientId });
    otherGrant.addResourceScope(resource, 'repo.read');
    const otherSubject = await issue({ scope: 'repo.read', accountId: 'other-operator',
      grantId: await otherGrant.save() });
    assert.equal((await inspect(otherSubject)).active, true);
    assert.equal(await verify(otherSubject), undefined);
    const unknownScope = await issue({ scope: 'repo.read unknown.scope' });
    assert.equal((await inspect(unknownScope)).active, true);
    assert.equal(await verify(unknownScope), undefined);
    const expired = await issue({ scope: 'repo.read', exp: Math.floor(Date.now() / 1000) - 1 });
    assert.equal(await verify(expired), undefined);
    await server.provider.AccessToken.revokeByGrantId(grantId);
    assert.equal(await verify(token), undefined);
  } finally { await server.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('verifier rejects untrusted endpoint and discovery issuer mismatch', async () => {
  const base = { expectedIssuer: 'https://issuer.example.test', expectedResource: 'https://mcp.example.test',
    expectedClientId: 'approved-chatgpt', bindings: [] };
  await assert.rejects(createLocalIntrospectionVerifier({ ...base,
    loopbackUrl: 'https://attacker.example.test' }), /loopback/i);
  await assert.rejects(createLocalIntrospectionVerifier({ ...base,
    loopbackUrl: 'http://127.0.0.1:1' }), /discovery|issuer|fetch/i);
  const misleading = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      issuer: 'https://other-issuer.example.test',
      introspection_endpoint: `${base.expectedIssuer}/token/introspection`,
    }));
  });
  misleading.listen(0, '127.0.0.1');
  await once(misleading, 'listening');
  const address = misleading.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(createLocalIntrospectionVerifier({ ...base,
      loopbackUrl: `http://127.0.0.1:${address.port}` }), /discovery mismatch/i);
  } finally {
    misleading.close();
    await once(misleading, 'close');
  }
});

test('oversized introspection and slow local issuer fail closed', async () => {
  const issuer = 'https://issuer.example.test';
  let mode: 'oversize' | 'slow' = 'oversize';
  const listener = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/oauth-authorization-server') {
      response.end(JSON.stringify({ issuer, introspection_endpoint: `${issuer}/token/introspection` }));
      return;
    }
    if (mode === 'oversize') response.end(JSON.stringify({ active: true, padding: 'x'.repeat(9000) }));
    else setTimeout(() => response.end(JSON.stringify({ active: false })), 200);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const verify = await createLocalIntrospectionVerifier({ loopbackUrl: `http://127.0.0.1:${address.port}`,
      expectedIssuer: issuer, expectedResource: 'https://mcp.example.test', expectedClientId: 'approved-chatgpt',
      timeoutMs: 100, bindings: [{ issuer, clientId: 'approved-chatgpt', subject: 'operator-1',
        principal: 'external', recipient: 'external', workspaceId: 'ws_1',
        scopes: { 'repo.read': { delegatedPermissions: ['repo.read'], visibleOperations: ['repo.get'] } } }] });
    assert.equal(await verify('opaque-token'), undefined);
    mode = 'slow';
    assert.equal(await verify('opaque-token'), undefined);
  } finally { listener.closeAllConnections(); listener.close(); await once(listener, 'close'); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startExternalHttp, type VerifiedHttpIdentity } from '../../src/adapters/mcp/http.js';
import type { RequestContext } from '../../src/core/policy/authorize.js';
import type { Command } from '../../src/application/dispatch.js';

const audience = 'http://127.0.0.1/repo-conduit';
const identities: Record<string, VerifiedHttpIdentity> = {
  alice: { principal: 'alice', audience, recipient: 'alice-recipient', expiresAt: Date.now() + 60_000,
    delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'], allowedWorkspaceId: 'ws-a', allowedCollaborationId: 'col-a' },
  bob: { principal: 'bob', audience, recipient: 'bob-recipient', expiresAt: Date.now() + 60_000,
    delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'], allowedWorkspaceId: 'ws-b', allowedCollaborationId: 'col-b' },
  expired: { principal: 'alice', audience, recipient: 'alice-recipient', expiresAt: Date.now() - 1,
    delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'], allowedWorkspaceId: 'ws-a' },
  wrong: { principal: 'alice', audience: 'another-resource', recipient: 'alice-recipient', expiresAt: Date.now() + 60_000,
    delegatedPermissions: ['collab.read'], visibleOperations: ['collab.get'], allowedWorkspaceId: 'ws-a' },
};

test('HTTP MCP verifies every request and binds identity and scope', async () => {
  const calls: { context: RequestContext; command: Command }[] = [];
  const revoked = new Set<string>();
  const server = await startExternalHttp({ expectedAudience: audience,
    async verifyBearer(token) { return revoked.has(token) ? undefined : identities[token]; },
    dispatcher: { async dispatch(context, command) {
      calls.push({ context, command });
      return { principal: context.principal, recipient: context.recipient, scope: command.scope };
    } },
  });
  try {
    for (const token of ['', 'forged', 'expired', 'wrong']) {
      const response = await fetch(server.url, { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      assert.equal(response.status, 401, token);
    }
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(server.url, { headers: { host: 'attacker.example', authorization: 'Bearer alice' } },
        (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHostStatus, 403);
    const badOrigin = await fetch(server.url, { headers: { origin: 'https://attacker.example', authorization: 'Bearer alice' } });
    assert.equal(badOrigin.status, 403);
    for (const token of ['alice', 'bob']) {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: 'test', version: '1' });
      try {
        await client.connect(transport);
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['collab.get']);
        const own = token === 'alice' ? ['ws-a', 'col-a'] : ['ws-b', 'col-b'];
        const good = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: own[0], collaborationId: own[1] }, payload: {},
        } });
        assert.equal(good.isError, undefined);
        const value = JSON.parse((good.content[0] as { text: string }).text) as { principal: string };
        assert.equal(value.principal, token);
        const forgedPayload = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: own[0], collaborationId: own[1] }, payload: { principal: 'forged' },
        } });
        assert.equal(forgedPayload.isError, true);
        const wrongScope = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: token === 'alice' ? 'ws-b' : 'ws-a', collaborationId: own[1] }, payload: {},
        } });
        assert.equal(wrongScope.isError, true);
        const wrongCollaboration = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: own[0], collaborationId: 'other' }, payload: {},
        } });
        assert.equal(wrongCollaboration.isError, true);
        const forgedIdentity = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: own[0], collaborationId: own[1] }, payload: {}, principal: 'owner',
        } });
        assert.equal(forgedIdentity.isError, true);
        if (token === 'bob') {
          revoked.add(token);
          await assert.rejects(client.listTools());
        }
      } finally { await client.close(); }
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(({ context }) => context.delegatedPermissions), [['collab.read'], ['collab.read']]);
  } finally { await server.close(); }
});

test('HTTP MCP withholds an in-flight result when bearer authority is revoked', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let valid = true;
  let checks = 0;
  const server = await startExternalHttp({ expectedAudience: audience,
    async verifyBearer(token) { checks++; return token === 'alice' && valid ? identities.alice : undefined; },
    dispatcher: { async dispatch() { enter(); await held; return { leaked: 'SYNTHETIC_PRIVATE_RESULT' }; } },
  });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: 'Bearer alice' } },
  });
  const client = new Client({ name: 'revoke-test', version: '1' });
  try {
    await client.connect(transport);
    const pending = client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-a', collaborationId: 'col-a' }, payload: {},
    } });
    await entered;
    valid = false;
    release();
    await assert.rejects(pending);
    assert.ok(checks >= 2);
  } finally { await client.close(); await server.close(); }
});

test('HTTP MCP rejects unauthenticated partial bodies before reading them', async () => {
  const server = await startExternalHttp({ expectedAudience: audience,
    async verifyBearer() { throw new Error('must not be called without bearer'); },
    dispatcher: { async dispatch() { throw new Error('must not dispatch'); } },
  });
  try {
    for (const headers of [
      { host: 'attacker.example', authorization: 'Bearer alice' },
      { host: new URL(server.url).host },
    ]) {
      const status = await Promise.race([
        new Promise<number>((resolve, reject) => {
          const req = httpRequest(server.url, { method: 'POST', headers: {
            ...headers, 'content-type': 'application/json', 'content-length': '1024',
          } }, response => { response.resume(); resolve(response.statusCode ?? 0); req.destroy(); });
          req.on('error', reject);
          req.write('{');
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow rejection')), 1_000)),
      ]);
      assert.equal(status, headers.host === 'attacker.example' ? 403 : 401);
    }
  } finally { await server.close(); }
});

test('HTTP MCP rechecks bearer after the request body and before a tool mutation', async () => {
  let firstCheck!: () => void;
  const checked = new Promise<void>(resolve => { firstCheck = resolve; });
  let active = true;
  let dispatched = 0;
  const server = await startExternalHttp({ expectedAudience: audience,
    async verifyBearer(token) {
      firstCheck();
      return token === 'alice' && active ? identities.alice : undefined;
    },
    dispatcher: { async dispatch() { dispatched++; return {}; } },
  });
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'collab.get', arguments: {
        scope: { workspaceId: 'ws-a', collaborationId: 'col-a' }, payload: {},
      } } });
    let client!: ReturnType<typeof httpRequest>;
    const responseStatus = new Promise<number>((resolve, reject) => {
      client = httpRequest(server.url, { method: 'POST', headers: {
        host: new URL(server.url).host, authorization: 'Bearer alice',
        'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
      } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      client.on('error', reject);
      client.write(body.slice(0, 1));
    });
    await checked;
    active = false;
    client.end(body.slice(1));
    assert.equal(await responseStatus, 401);
    assert.equal(dispatched, 0);
  } finally { await server.close(); }
});

test('configured OAuth resource metadata is discoverable and unauthenticated MCP requests challenge with its exact URL', async () => {
  const resource = 'https://mcp.example.test';
  const issuer = 'https://issuer.example.test';
  const server = await startExternalHttp({ expectedAudience: resource,
    resourceMetadata: { resource, authorizationServer: issuer, scopes: ['repo.read'] },
    async verifyBearer(token) { return token === 'valid' ? { ...identities.alice!, audience: resource } : undefined; },
    dispatcher: { async dispatch() { throw new Error('must not dispatch'); } },
  });
  try {
    const metadata = await fetch(new URL('/.well-known/oauth-protected-resource', server.url));
    assert.equal(metadata.status, 200);
    const document = { resource, authorization_servers: [issuer], scopes_supported: ['repo.read'] };
    assert.deepEqual(await metadata.json(), document);
    const nestedMetadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', server.url));
    assert.equal(nestedMetadata.status, 404);
    assert.equal((await fetch(new URL('/.well-known/oauth-protected-resource/mcp', server.url),
      { method: 'POST' })).status, 404);
    assert.equal((await fetch(new URL('/.well-known/oauth-protected-resource/other', server.url))).status, 404);
    const unauthorized = await fetch(server.url, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'),
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"');
    const listed = await fetch(server.url, { method: 'POST', headers: {
      authorization: 'Bearer valid', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(listed.status, 200);
    const message = (await listed.text()).split(/\r?\n/).find(line => line.startsWith('data: '));
    assert.ok(message);
    const catalog = JSON.parse(message.slice(6)) as { result: { tools: { name: string; securitySchemes?: unknown }[] } };
    assert.deepEqual(catalog.result.tools.map(tool => ({ name: tool.name, securitySchemes: tool.securitySchemes })),
      [{ name: 'collab.get', securitySchemes: [{ type: 'oauth2', scopes: ['repo.read'] }] }]);
  } finally { await server.close(); }
});

test('pathful OAuth resource uses matching metadata path and exact token audience', async () => {
  const resource = 'https://mcp.example.test/mcp';
  const issuer = 'https://issuer.example.test';
  const server = await startExternalHttp({ expectedAudience: resource,
    resourceMetadata: { resource, authorizationServer: issuer, scopes: ['repo.read'] },
    async verifyBearer(token) {
      return token === 'path-token' ? { ...identities.alice!, audience: resource } :
        token === 'origin-token' ? { ...identities.alice!, audience: 'https://mcp.example.test' } : undefined;
    },
    dispatcher: { async dispatch() { return {}; } },
  });
  try {
    const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', server.url));
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { resource, authorization_servers: [issuer],
      scopes_supported: ['repo.read'] });
    assert.equal((await fetch(new URL('/.well-known/oauth-protected-resource', server.url))).status, 404);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const request = (token?: string) => fetch(server.url, { method: 'POST', headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body });
    assert.equal((await request('origin-token')).status, 401);
    assert.equal((await request('path-token')).status, 200);
    assert.equal((await request()).headers.get('www-authenticate'),
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
  } finally { await server.close(); }
});

test('OAuth metadata configuration fails closed on inconsistent or non-HTTPS authorities', async () => {
  for (const resourceMetadata of [
    { resource: 'https://other.example.test', authorizationServer: 'https://issuer.example.test', scopes: [] },
    { resource: 'http://mcp.example.test', authorizationServer: 'https://issuer.example.test', scopes: [] },
    { resource: 'https://mcp.example.test', authorizationServer: 'http://issuer.example.test', scopes: [] },
  ]) {
    await assert.rejects(startExternalHttp({ expectedAudience: 'https://mcp.example.test', resourceMetadata,
      async verifyBearer() { return undefined; }, dispatcher: { async dispatch() { return {}; } },
    }));
  }
});

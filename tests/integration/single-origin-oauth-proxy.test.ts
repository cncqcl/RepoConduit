import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { exportJWK, generateKeyPair } from 'jose';
import { startLocalIssuer } from '../../src/adapters/auth/issuer.js';

// Fixture is deliberately a standalone Node script, outside the packaged product.
// @ts-expect-error The test-only .mjs fixture has no TypeScript declaration.
import { startSingleOriginOAuthProxy } from '../helpers/single-origin-oauth-proxy.mjs';

async function mockListener(label: string) {
  const received: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(201, { 'content-type': 'text/plain', 'x-upstream': label });
    res.end(label);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, received,
    close: async () => { server.close(); await once(server, 'close'); } };
}

async function call(url: string, options: { method?: string; headers: Record<string, string>; body?: string }) {
  return await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0,
        headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

test('single-origin fixture preserves method, headers, query and body on issuer and MCP paths', async () => {
  const issuer = await mockListener('issuer');
  const mcp = await mockListener('mcp');
  const proxy = await startSingleOriginOAuthProxy({ publicOrigin: 'https://fixture.example.test',
    issuerUrl: issuer.url, mcpUrl: `${mcp.url}/mcp`, port: 0 });
  try {
    const paths = [
      ['/.well-known/oauth-authorization-server', 'issuer'],
      ['/auth?state=x&redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback', 'issuer'],
      ['/auth/abc_123?state=x', 'issuer'],
      ['/token', 'issuer'], ['/interaction/abc_123', 'issuer'],
      ['/.well-known/oauth-protected-resource/mcp', 'mcp'], ['/mcp?session=abc', 'mcp'],
    ];
    for (const [path, expected] of paths) {
      const response = await call(`${proxy.url}${path}`, { method: 'POST',
        headers: { host: 'fixture.example.test', origin: 'https://fixture.example.test',
          authorization: 'Bearer synthetic', 'content-type': 'text/plain', 'x-fixture': 'exact',
          'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'http',
          forwarded: 'host=attacker.example.test' },
        body: 'synthetic-body' });
      assert.equal(response.status, 201, path);
      assert.equal(response.headers['x-upstream'], expected);
      const received = expected === 'issuer' ? issuer.received.at(-1) : mcp.received.at(-1);
      assert.equal(received?.method, 'POST');
      assert.equal(received?.url, path);
      assert.equal(received?.headers.host, 'fixture.example.test');
      assert.equal(received?.headers.origin, 'https://fixture.example.test');
      assert.equal(received?.headers.authorization, 'Bearer synthetic');
      assert.equal(received?.headers['x-fixture'], 'exact');
      assert.equal(received?.headers['x-forwarded-host'], undefined);
      assert.equal(received?.headers['x-forwarded-proto'], undefined);
      assert.equal(received?.headers.forwarded, undefined);
      assert.equal(received?.body, 'synthetic-body');
    }
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await proxy.close(); await issuer.close(); await mcp.close();
  }
});

test('real local issuer PKCE authorization resumes through proxy with cookies', async () => {
  const publicOrigin = 'https://fixture.example.test';
  const resource = `${publicOrigin}/mcp`;
  const redirectUri = 'https://client.example.test/callback';
  const password = 'fixture-password';
  const salt = randomBytes(16);
  const db = new DatabaseSync(':memory:');
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const issuer = await startLocalIssuer({ issuer: publicOrigin, resource,
    clientId: 'fixture-client', redirectUris: [redirectUri], scopes: ['collab.read'],
    operator: { subject: 'fixture-operator', saltHex: salt.toString('hex'),
      hashHex: scryptSync(password, salt, 64).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')],
    jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] }, db });
  const mcp = await mockListener('mcp');
  const proxy = await startSingleOriginOAuthProxy({ publicOrigin,
    issuerUrl: issuer.url, mcpUrl: `${mcp.url}/mcp`, port: 0 });
  const cookies = new Map<string, string>();
  const issuerCall = async (path: string, method = 'GET', body?: string) => {
    const headers: Record<string, string> = { host: 'fixture.example.test', origin: publicOrigin };
    if (cookies.size) headers.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const response = await call(`${proxy.url}${path}`, { method, headers,
      ...(body === undefined ? {} : { body }) });
    const setCookie = response.headers['set-cookie'];
    for (const item of Array.isArray(setCookie) ? setCookie : []) {
      const pair = item.split(';', 1)[0]!;
      const equal = pair.indexOf('=');
      if (equal > 0) cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
    }
    return response;
  };
  try {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ response_type: 'code', client_id: 'fixture-client',
      redirect_uri: redirectUri, scope: 'collab.read', resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state: 'fixture-state' });
    const started = await issuerCall(`/auth?${query}`);
    assert.equal(started.status, 303, started.body);
    const loginPath = String(started.headers.location);
    assert.match(loginPath, /^\/interaction\/[A-Za-z0-9_-]+$/);
    const login = await issuerCall(loginPath);
    assert.equal(login.status, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(login.body)?.[1];
    assert.ok(csrf);
    const logged = await issuerCall(loginPath, 'POST', new URLSearchParams({ csrf, password }).toString());
    assert.equal(logged.status, 303);
    const resumedUrl = new URL(String(logged.headers.location), publicOrigin);
    assert.equal(resumedUrl.origin, publicOrigin);
    const resumedPath = `${resumedUrl.pathname}${resumedUrl.search}`;
    assert.match(resumedPath, /^\/auth\/[A-Za-z0-9_-]+$/);
    const resumed = await issuerCall(resumedPath);
    assert.equal(resumed.status, 303, resumed.body);
    assert.match(String(resumed.headers.location), /^\/interaction\/[A-Za-z0-9_-]+$/);
  } finally {
    await proxy.close(); await issuer.close(); await mcp.close(); db.close();
  }
});

test('single-origin fixture rejects unknown host and paths without reaching upstream', async () => {
  const issuer = await mockListener('issuer');
  const mcp = await mockListener('mcp');
  const proxy = await startSingleOriginOAuthProxy({ publicOrigin: 'https://fixture.example.test',
    issuerUrl: issuer.url, mcpUrl: `${mcp.url}/mcp`, port: 0 });
  try {
    for (const [path, host] of [
      ['/mcp', 'attacker.example.test'], ['/auth', '127.0.0.1'],
      ['/admin', 'fixture.example.test'], ['/mcp/other', 'fixture.example.test'],
      ['/auth%2fadmin', 'fixture.example.test'],
      ['/auth/../admin', 'fixture.example.test'],
      ['/.well-known/oauth-protected-resource/other', 'fixture.example.test'],
      ['//attacker.example.test/mcp', 'fixture.example.test'],
    ] as const) {
      const response = await call(`${proxy.url}${path}`, { headers: { host } });
      assert.ok(response.status === 400 || response.status === 404, `${path}: ${response.status}`);
    }
    assert.equal(issuer.received.length, 0);
    assert.equal(mcp.received.length, 0);
  } finally {
    await proxy.close(); await issuer.close(); await mcp.close();
  }
});

test('single-origin fixture rejects non-loopback upstreams', async () => {
  await assert.rejects(startSingleOriginOAuthProxy({ publicOrigin: 'https://fixture.example.test',
    issuerUrl: 'http://example.com:4444', mcpUrl: 'http://127.0.0.1:4000/mcp', port: 0 }));
});

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import test from 'node:test';
import { createSqliteOidcAdapter } from '../../src/adapters/auth/sqlite-adapter.js';
import { startLocalIssuer } from '../../src/adapters/auth/issuer.js';

test('OIDC adapter preserves grants across restart, expires tokens, and consumes code once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-issuer-'));
  const path = join(root, 'oidc.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    let factory = createSqliteOidcAdapter(db);
    await factory('AuthorizationCode').upsert('code-1', { grantId: 'grant-1', uid: 'uid-1' }, 600);
    await factory('AccessToken').upsert('token-1', { grantId: 'grant-1' }, 600);
    db.close();
    db = new DatabaseSync(path);
    factory = createSqliteOidcAdapter(db);
    const code = factory('AuthorizationCode');
    assert.equal((await code.find('code-1'))?.grantId, 'grant-1');
    await code.consume('code-1');
    const first = (await code.find('code-1'))?.consumed;
    assert.equal(typeof first, 'number');
    await assert.rejects(code.consume('code-1'), /invalid_grant/);
    assert.equal((await code.find('code-1'))?.consumed, first);
    await code.revokeByGrantId('grant-1');
    assert.equal(await code.find('code-1'), undefined);
    assert.equal(await factory('AccessToken').find('token-1'), undefined);
    await factory('AccessToken').upsert('expired', { grantId: 'grant-2' }, -1);
    assert.equal(await factory('AccessToken').find('expired'), undefined);
    db.close();
    db = undefined;
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('local issuer rejects missing public deployment configuration', async () => {
  await assert.rejects(startLocalIssuer({} as never), /issuer|configuration|HTTPS/i);
});

test('real authorization code flow needs operator login, consent, PKCE, and single-use code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-issuer-flow-'));
  const db = new DatabaseSync(join(root, 'oidc.sqlite'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(privateKey), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
  const salt = randomBytes(16);
  const operatorPassword = 'fixture-correct-horse-battery';
  const config = { issuer: 'https://issuer.example.test', resource: 'https://mcp.example.test',
    clientId: 'approved-chatgpt', redirectUris: ['https://chatgpt.example.test/oauth/callback'],
    scopes: ['repo.read', 'artifact.write'], operator: { subject: 'operator-1', saltHex: salt.toString('hex'),
      hashHex: scryptSync(operatorPassword, salt, 64).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')], jwks: { keys: [jwk] }, db };
  let server = await startLocalIssuer(config);
  server.provider.on('server_error', (_context, error) => { process.stderr.write(`issuer server error: ${inspect(error, { depth: 2 })}\n`); });
  try {
    const metadata = await (await fetch(new URL('/.well-known/oauth-authorization-server', server.url))).json() as
      { issuer?: string; registration_endpoint?: string; code_challenge_methods_supported?: string[];
        scopes_supported?: string[] };
    assert.equal(metadata.issuer, config.issuer);
    assert.equal(metadata.registration_endpoint, undefined);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.scopes_supported, config.scopes);
    const oidcMetadata = await (await fetch(new URL('/.well-known/openid-configuration', server.url))).json() as
      { scopes_supported?: string[] };
    assert.deepEqual(oidcMetadata.scopes_supported, config.scopes);
    for (const path of [
      '/.WELL-KNOWN/OAUTH-AUTHORIZATION-SERVER',
      '/.well-known/oauth-authorization-server/',
      '/.WELL-KNOWN/OPENID-CONFIGURATION',
      '/.well-known/openid-configuration/',
    ]) {
      const response = await fetch(new URL(path, server.url));
      assert.equal(response.status, 200, path);
      const aliasMetadata = await response.json() as { scopes_supported?: string[] };
      assert.deepEqual(aliasMetadata.scopes_supported, config.scopes, path);
    }
    assert.equal((await fetch(new URL('/.well-known/openid-configuration/extra', server.url))).status, 404);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const jar = new Map<string, string>();
    const request = async (url: URL, init: RequestInit = {}) => {
      const target = url.origin === config.issuer ? new URL(`${url.pathname}${url.search}`, server.url) : url;
      const response = await fetch(target, { ...init, redirect: 'manual', headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      } });
      for (const item of response.headers.getSetCookie()) {
        const [pair] = item.split(';');
        const separator = pair?.indexOf('=') ?? -1;
        if (separator > 0) jar.set(pair!.slice(0, separator), pair!.slice(separator + 1));
      }
      return response;
    };
    const authorization = new URL('/auth', server.url);
    authorization.searchParams.set('client_id', 'approved-chatgpt');
    authorization.searchParams.set('redirect_uri', 'https://chatgpt.example.test/oauth/callback');
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', 'artifact.write repo.read');
    authorization.searchParams.set('resource', config.resource);
    authorization.searchParams.set('code_challenge', challenge);
    authorization.searchParams.set('code_challenge_method', 'S256');
    authorization.searchParams.set('state', 'fixture-state');
    const noPkce = new URL(authorization);
    noPkce.searchParams.delete('code_challenge');
    const rejectedPkce = await request(noPkce);
    assert.match(rejectedPkce.headers.get('location') ?? '', /error=/);
    const unknownResource = new URL(authorization);
    unknownResource.searchParams.set('resource', 'https://other.example.test');
    assert.match((await request(unknownResource)).headers.get('location') ?? '', /error=/);
    const unknownScope = new URL(authorization);
    unknownScope.searchParams.set('scope', 'repo.read unauthorized.write');
    const rejectedScope = await request(unknownScope);
    if ((rejectedScope.headers.get('location') ?? '').startsWith('/interaction/')) {
      assert.equal((await request(new URL(rejectedScope.headers.get('location')!, server.url))).status, 403);
    } else {
      assert.match(rejectedScope.headers.get('location') ?? '', /error=/);
    }
    const unknownClient = new URL(authorization);
    unknownClient.searchParams.set('client_id', 'unapproved-client');
    assert.equal((await request(unknownClient)).status, 400);
    const start = await request(authorization);
    assert.equal(start.status, 303);
    assert.ok(jar.size);
    const loginPath = start.headers.get('location');
    assert.match(loginPath ?? '', /^\/interaction\//);
    const login = await request(new URL(loginPath!, server.url));
    assert.equal(login.status, 200);
    const html = await login.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    const badCsrf = await request(new URL(loginPath!, server.url), { method: 'POST',
      headers: { origin: config.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'forged', password: operatorPassword }) });
    assert.equal(badCsrf.status, 403);
    const wrong = await request(new URL(loginPath!, server.url), { method: 'POST',
      headers: { origin: config.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, password: 'wrong' }) });
    assert.equal(wrong.status, 403);
    const logged = await request(new URL(loginPath!, server.url), { method: 'POST',
      headers: { origin: config.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, password: operatorPassword }) });
    assert.equal(logged.status, 303);
    const resume = await request(new URL(logged.headers.get('location')!, server.url));
    assert.equal(resume.status, 303);
    const consentPath = resume.headers.get('location');
    assert.match(consentPath ?? '', /^\/interaction\//);
    const consent = await request(new URL(consentPath!, server.url));
    assert.equal(consent.status, 200);
    const consentCsrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1];
    assert.ok(consentCsrf);
    const approved = await request(new URL(consentPath!, server.url), { method: 'POST',
      headers: { origin: config.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: consentCsrf, approve: 'yes' }) });
    assert.equal(approved.status, 303);
    const completed = await request(new URL(approved.headers.get('location')!, server.url));
    assert.equal(completed.status, 303);
    const callback = new URL(completed.headers.get('location')!);
    assert.equal(callback.origin, 'https://chatgpt.example.test');
    assert.equal(callback.searchParams.get('state'), 'fixture-state');
    const code = callback.searchParams.get('code');
    assert.ok(code);
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code,
      client_id: config.clientId, redirect_uri: config.redirectUris[0]!, code_verifier: verifier,
      resource: config.resource });
    const codeModel = server.provider.AuthorizationCode;
    const originalFind = codeModel.find;
    let found = 0;
    let release!: () => void;
    const bothFound = new Promise<void>(resolve => { release = resolve; });
    const timeout = setTimeout(release, 2_000);
    Object.defineProperty(codeModel, 'find', { configurable: true, value: async function (...args: Parameters<typeof originalFind>) {
      const saved = await originalFind.apply(codeModel, args);
      if (args[0] === code && found < 2) {
        found++;
        if (found === 2) release();
        await bothFound;
      }
      return saved;
    } });
    let exchanges: Response[];
    try {
      exchanges = await Promise.all([0, 1].map(() => request(new URL('/token', server.url), { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody })));
    } finally { clearTimeout(timeout); codeModel.find = originalFind; }
    assert.equal(found, 2);
    assert.deepEqual(exchanges.map(response => response.status).sort(), [200, 400]);
    const tokenResponse = exchanges.find(response => response.status === 200)!;
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json() as { access_token?: string; token_type?: string; scope?: string };
    assert.equal(token.token_type, 'Bearer');
    assert.deepEqual(new Set(token.scope?.split(' ')), new Set(config.scopes));
    assert.ok(token.access_token && !token.access_token.includes('.'));
    assert.ok(await server.provider.AccessToken.find(token.access_token));
    const introspection = await request(new URL('/token/introspection', server.url), { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.access_token, client_id: config.clientId }) });
    assert.equal(introspection.status, 200);
    const introspected = await introspection.json() as { active?: boolean; aud?: string; scope?: string;
      client_id?: string; sub?: string; iss?: string; exp?: number };
    assert.equal(introspected.active, true);
    assert.equal(introspected.aud, config.resource);
    assert.equal(introspected.client_id, config.clientId);
    assert.equal(introspected.sub, config.operator.subject);
    assert.ok(typeof introspected.exp === 'number' && introspected.exp > Date.now() / 1000);
    assert.deepEqual(new Set(introspected.scope?.split(' ')), new Set(config.scopes));
    await server.close();
    server = await startLocalIssuer(config);
    assert.ok(await server.provider.AccessToken.find(token.access_token));
    const replay = await request(new URL('/token', server.url), { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody });
    assert.equal(replay.status, 400);
    assert.equal(await server.provider.AccessToken.find(token.access_token), undefined);
    const forcedLogin = new URL(authorization.pathname + authorization.search, server.url);
    forcedLogin.searchParams.set('prompt', 'login');
    const challengeLogin = await request(forcedLogin);
    assert.equal(challengeLogin.status, 303);
    const newLoginPath = challengeLogin.headers.get('location');
    assert.match(newLoginPath ?? '', /^\/interaction\//);
    const newLogin = await request(new URL(newLoginPath!, server.url));
    const newCsrf = /name="csrf" value="([^"]+)"/.exec(await newLogin.text())?.[1];
    assert.ok(newCsrf);
    for (let attempt = 0; attempt < 5; attempt++) {
      const denied = await request(new URL(newLoginPath!, server.url), { method: 'POST',
        headers: { origin: config.issuer, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: newCsrf, password: 'wrong' }) });
      assert.equal(denied.status, 403);
    }
    const locked = await request(new URL(newLoginPath!, server.url), { method: 'POST',
      headers: { origin: config.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: newCsrf, password: operatorPassword }) });
    assert.equal(locked.status, 429);
  } finally { await server.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

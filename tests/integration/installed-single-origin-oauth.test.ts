import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { pinRetainedInstallationArchive } from '../support/retained-installation-archive.js';

// The proxy is a standalone test fixture. Product issuer and MCP are installed package processes.
// @ts-expect-error Test-only .mjs fixture has no TypeScript declaration.
import { startSingleOriginOAuthProxy } from '../helpers/single-origin-oauth-proxy.mjs';

const publicOrigin = 'https://fixture.example.test';
const resource = `${publicOrigin}/mcp`;
const redirectUri = 'https://client.example.test/callback';
const clientId = 'synthetic-client';

function run(program: string, args: string[], cwd: string, input?: unknown): string {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 60_000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
  assert.equal(result.status, 0, `${program} exited ${result.status ?? result.signal ?? result.error?.name}`);
  return result.stdout;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('exit', exited); resolve(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', exited);
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 3_000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForExit(child, 3_000), true, 'installed HTTP process must exit');
}

async function startHttp(cli: string, data: string, cwd: string): Promise<{
  child: ChildProcess; issuerUrl: string; mcpUrl: string;
}> {
  const child = spawn(process.execPath, [cli, '--data-dir', data, 'serve-http'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr!.resume();
  const lines = createInterface({ input: child.stdout! });
  try {
    const first = await new Promise<string>((resolveLine, reject) => {
      const timer = setTimeout(() => reject(new Error('installed HTTP startup timed out')), 15_000);
      lines.once('line', line => { clearTimeout(timer); resolveLine(line); });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`installed HTTP exited ${code}`));
      });
    });
    const urls = JSON.parse(first) as { issuerUrl: string; mcpUrl: string };
    assert.match(urls.issuerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(urls.mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    return { child, ...urls };
  } catch (error) { await stop(child); throw error; }
  finally { lines.close(); }
}

async function installedSingleOriginOAuth(retainedArchive?: string): Promise<void> {
    const repositoryRoot = resolve('.');
    const base = process.platform === 'win32' ? homedir() : tmpdir();
    const temporary = mkdtempSync(join(base, 'rcac-installed-oauth-proxy-'));
    const source = join(temporary, 'source');
    const install = join(temporary, 'installed');
    const data = join(temporary, 'data');
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, 'run through npm to identify the npm CLI');
    let http: Awaited<ReturnType<typeof startHttp>> | undefined;
    let proxy: Awaited<ReturnType<typeof startSingleOriginOAuthProxy>> | undefined;
    let client: Client | undefined;
    let primaryError: unknown, cleanupError: unknown;
    try {
      mkdirSync(source);
      writeFileSync(join(source, 'synthetic.txt'), 'SYNTHETIC_ONLY\n');
      let packageArchive: string;
      if (retainedArchive === undefined) {
        run(process.execPath, [npmCli, 'run', 'build'], repositoryRoot);
        const packed = JSON.parse(run(process.execPath,
          [npmCli, 'pack', '--json', '--pack-destination', temporary], repositoryRoot)) as { filename: string }[];
        assert.equal(packed.length, 1);
        packageArchive = join(temporary, packed[0]!.filename);
      } else { packageArchive = pinRetainedInstallationArchive(retainedArchive, temporary, '0.1.0'); }
      run(process.execPath, [npmCli, 'install', '--offline', '--prefix', install, '--ignore-scripts',
        '--no-audit', '--no-fund', packageArchive], repositoryRoot);
      const cliPath = join(install, 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js');
      assert.ok(existsSync(cliPath), 'packed CLI must be installed');
      const cli = (action: string, input?: unknown) => JSON.parse(run(process.execPath,
        [cliPath, '--data-dir', data, action], temporary, input)) as Record<string, unknown>;
      const request = (operation: string, workspaceId: string, collaborationId: string | undefined,
        payload: unknown, idempotencyKey: string) => cli('request', { operation,
          scope: { workspaceId, ...(collaborationId ? { collaborationId } : {}) },
          idempotencyKey, payload });
      const initialized = cli('init');
      const principal = initialized.principal as string;
      const workspaceId = request('admin.register_workspace', 'management', undefined,
        { name: 'Synthetic OAuth proxy fixture', root: source }, 'register').id as string;
      request('admin.grant', 'management', undefined,
        { principal, audience: 'local-os', recipient: principal, workspaceId,
          permissions: ['collab.create'], expiresAt: null }, 'local-grant');
      const collaborationId = request('collab.open', workspaceId, undefined,
        { purpose: 'Synthetic OAuth proxy verification' }, 'open').id as string;
      const externalPrincipal = 'synthetic-external';
      request('admin.grant', 'management', undefined,
        { principal: externalPrincipal, audience: resource, recipient: clientId,
          workspaceId, collaborationId, permissions: ['collab.read'], expiresAt: null }, 'external-grant');
      const password = randomBytes(32).toString('base64url');
      cli('configure-oauth', { issuer: publicOrigin, resource, clientId,
        redirectUris: [redirectUri], scopes: ['collab.read'],
        operator: { subject: 'synthetic-operator', password },
        binding: { issuer: publicOrigin, clientId, subject: 'synthetic-operator',
          principal: externalPrincipal, recipient: clientId, workspaceId, collaborationId,
          scopes: { 'collab.read': { delegatedPermissions: ['collab.read'],
            visibleOperations: ['collab.get'] } } } });

      const startIngress = async () => {
        http = await startHttp(cliPath, data, temporary);
        proxy = await startSingleOriginOAuthProxy({ publicOrigin,
          issuerUrl: http.issuerUrl, mcpUrl: http.mcpUrl, port: 0 });
      };
      await startIngress();
      const cookies = new Map<string, string>();
      const throughProxy = async (path: string, init: RequestInit = {}) => {
        assert.ok(proxy);
        const headers = new Headers(init.headers);
        headers.set('host', new URL(publicOrigin).host);
        if (init.method === 'POST' && path.startsWith('/interaction/')) headers.set('origin', publicOrigin);
        if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
        const body = init.body === undefined ? undefined : String(init.body);
        const response = await new Promise<{ status: number; headers: Headers;
          json: () => Promise<unknown>; text: () => Promise<string> }>((resolveResponse, reject) => {
          const outgoing = httpRequest(`${proxy!.url}${path}`, { method: init.method ?? 'GET',
            headers: Object.fromEntries(headers) }, incoming => {
            const chunks: Buffer[] = [];
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
            incoming.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              const receivedHeaders = new Headers();
              for (const [name, value] of Object.entries(incoming.headers)) {
                for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                  receivedHeaders.append(name, item);
                }
              }
              resolveResponse({ status: incoming.statusCode ?? 0, headers: receivedHeaders,
                json: async () => JSON.parse(raw) as unknown, text: async () => raw });
            });
          });
          outgoing.on('error', reject);
          outgoing.end(body);
        });
        for (const item of response.headers.getSetCookie()) {
          const pair = item.split(';', 1)[0]!;
          const equal = pair.indexOf('=');
          if (equal > 0) cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
        }
        return response;
      };
      const discovery = await throughProxy('/.well-known/oauth-authorization-server');
      assert.equal(discovery.status, 200);
      const metadata = await discovery.json() as { issuer: string; token_endpoint: string;
        authorization_endpoint: string; code_challenge_methods_supported: string[] };
      assert.equal(metadata.issuer, publicOrigin);
      assert.equal(metadata.authorization_endpoint, `${publicOrigin}/auth`);
      assert.equal(metadata.token_endpoint, `${publicOrigin}/token`);
      assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
      const resourceMetadata = await throughProxy('/.well-known/oauth-protected-resource/mcp');
      assert.equal(resourceMetadata.status, 200);
      assert.deepEqual(await resourceMetadata.json(), { resource,
        authorization_servers: [publicOrigin], scopes_supported: ['collab.read'] });
      const verifier = randomBytes(32).toString('base64url');
      const authorization = new URLSearchParams({ response_type: 'code', client_id: clientId,
        redirect_uri: redirectUri, scope: 'collab.read', resource,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', state: 'synthetic-state' });
      const started = await throughProxy(`/auth?${authorization}`);
      assert.equal(started.status, 303);
      const loginPath = started.headers.get('location');
      assert.match(loginPath ?? '', /^\/interaction\/[A-Za-z0-9_-]+$/);
      const login = await throughProxy(loginPath!);
      assert.equal(login.status, 200);
      const loginCsrf = /name="csrf" value="([^"]+)"/.exec(await login.text())?.[1];
      assert.ok(loginCsrf);
      const logged = await throughProxy(loginPath!, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: loginCsrf, password }) });
      assert.equal(logged.status, 303);
      const resumed = await throughProxy(new URL(logged.headers.get('location')!, publicOrigin).pathname);
      assert.equal(resumed.status, 303);
      const consentPath = resumed.headers.get('location');
      assert.match(consentPath ?? '', /^\/interaction\/[A-Za-z0-9_-]+$/);
      const consent = await throughProxy(consentPath!);
      assert.equal(consent.status, 200);
      const consentCsrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1];
      assert.ok(consentCsrf);
      const approved = await throughProxy(consentPath!, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: consentCsrf, approve: 'yes' }) });
      assert.equal(approved.status, 303);
      const completed = await throughProxy(new URL(approved.headers.get('location')!, publicOrigin).pathname);
      assert.equal(completed.status, 303);
      const callback = new URL(completed.headers.get('location')!);
      assert.equal(callback.origin, new URL(redirectUri).origin);
      assert.equal(callback.searchParams.get('state'), 'synthetic-state');
      const code = callback.searchParams.get('code');
      assert.ok(code);
      const exchanged = await throughProxy('/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId,
          redirect_uri: redirectUri, code_verifier: verifier, resource }) });
      assert.equal(exchanged.status, 200);
      const token = await exchanged.json() as { access_token: string; token_type: string; scope: string };
      assert.equal(token.token_type, 'Bearer');
      assert.equal(token.scope, 'collab.read');
      assert.ok(token.access_token.length > 20);

      const callMcp = async () => {
        assert.ok(proxy);
        client = new Client({ name: 'installed-oauth-proxy-test', version: '1.0.0' });
        const proxyFetch = (url: string | URL, init?: RequestInit): Promise<Response> =>
          new Promise((resolveResponse, reject) => {
            const headers = new Headers(init?.headers);
            headers.set('host', new URL(publicOrigin).host);
            const outgoing = httpRequest(url, { method: init?.method ?? 'GET',
              headers: Object.fromEntries(headers), signal: init?.signal ?? undefined }, incoming => {
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(incoming.headers)) {
                for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                  responseHeaders.append(name, item);
                }
              }
              resolveResponse(new Response(incoming.statusCode === 204 ? null :
                Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              { status: incoming.statusCode ?? 500, headers: responseHeaders }));
            });
            outgoing.on('error', reject);
            assert.ok(init?.body === undefined || typeof init.body === 'string');
            outgoing.end(init?.body);
          });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${proxy.url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
          fetch: proxyFetch,
        }));
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['collab.get']);
        const read = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId, collaborationId }, payload: {} } });
        assert.equal(read.isError, undefined);
        assert.equal(JSON.parse((read.content[0] as { text: string }).text).id, collaborationId);
        const outside = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: 'ws_other_synthetic', collaborationId }, payload: {} } });
        assert.equal(outside.isError, true);
        await client.close();
        client = undefined;
      };
      await callMcp();
      await proxy.close(); proxy = undefined;
      await stop(http?.child); http = undefined;
      await startIngress();
      await callMcp();
    } catch (error) { primaryError = error; }
    finally {
      try {
        const failures: unknown[] = [];
        for (const close of [() => client?.close(), () => proxy?.close(), () => stop(http?.child)]) {
          try { await close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) cleanupError = new AggregateError(failures, 'Installed OAuth proxy cleanup failed');
        const child = relative(resolve(base), resolve(temporary));
        assert.ok(child.startsWith('rcac-installed-oauth-proxy-') && !child.includes('..') && !child.includes('\\'));
        if (primaryError === undefined && cleanupError === undefined) rmSync(temporary, { recursive: true, force: true });
        else console.error('Retained installed OAuth proxy fixture:', temporary);
      } catch (error) {
        cleanupError = cleanupError === undefined ? error : new AggregateError([cleanupError, error], 'Installed OAuth proxy cleanup failed');
        console.error('Retained installed OAuth proxy fixture:', temporary);
      }
    }
    if (primaryError !== undefined && cleanupError !== undefined)
      throw new AggregateError([primaryError, cleanupError], 'Installed OAuth proxy and cleanup failed', { cause: primaryError });
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
}

test('installed issuer and MCP complete single-origin PKCE, consent, bearer read, and restart',
  { timeout: 180_000 }, () => installedSingleOriginOAuth());

test('retained package issuer and MCP complete single-origin PKCE, consent, bearer read, and restart',
  { timeout: 180_000, skip: process.env.RCAC_TEST_INSTALLED_ARCHIVE === undefined &&
    'requires an explicitly selected retained package' },
  () => installedSingleOriginOAuth(process.env.RCAC_TEST_INSTALLED_ARCHIVE));

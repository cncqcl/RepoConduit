import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(result.status, 0, `${program} exited ${result.status ?? result.signal ?? result.error?.name}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function runWhileIngressLive(program: string, args: string[], cwd: string,
  operation: string, input?: unknown,
  limits = { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024, closeGraceMs: 3_000 }): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let timedOut = false, outputExceeded = false, stdinFinished = false, settled = false;
    let failure: string | undefined, killFailure: string | undefined;
    let closeGuard: NodeJS.Timeout | undefined, forceKill: NodeJS.Timeout | undefined;
    const diagnostic = (code: number | null, signal: NodeJS.Signals | null, close: string) =>
      `installed local CLI ${operation} code=${code} signal=${signal} close=${close} timedOut=${timedOut} outputExceeded=${outputExceeded} stdinFinished=${stdinFinished} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes} failure=${failure ?? 'none'} killFailure=${killFailure ?? 'none'}`;
    const clearTimers = () => {
      clearTimeout(deadline);
      if (forceKill) clearTimeout(forceKill);
      if (closeGuard) clearTimeout(closeGuard);
    };
    const kill = (signal?: NodeJS.Signals) => {
      try { if (!child.kill(signal)) killFailure = 'kill-unconfirmed'; }
      catch (error) { killFailure = error instanceof Error ? error.name : 'unknown'; }
    };
    const fail = (reason: string) => {
      if (settled) return;
      failure ??= reason;
      if (closeGuard) return;
      kill();
      forceKill = setTimeout(() => kill('SIGKILL'), Math.max(1, Math.floor(limits.closeGraceMs / 2)));
      closeGuard = setTimeout(() => {
        settled = true;
        clearTimers();
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref();
        rejectRun(new Error(diagnostic(child.exitCode, child.signalCode, 'unconfirmed')));
      }, limits.closeGraceMs);
    };
    const deadline = setTimeout(() => { timedOut = true; fail('deadline'); }, limits.timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxOutputBytes) { outputExceeded = true; fail('output-bound'); }
      else stdout.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; });
    child.once('error', error => fail(`spawn-${'code' in error ? error.code : error.name}`));
    child.stdin!.on('error', error => fail(`stdin-${'code' in error ? error.code : error.name}`));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (failure === undefined && code === 0 && signal === null && stdinFinished &&
          !timedOut && !outputExceeded) resolveRun(Buffer.concat(stdout).toString('utf8'));
      else rejectRun(new Error(diagnostic(code, signal, 'confirmed')));
    });
    try { child.stdin!.end(input === undefined ? undefined : JSON.stringify(input),
      () => { stdinFinished = true; }); }
    catch { fail('stdin-write'); }
  });
}

test('live CLI fixture rejects deadline after confirmed owned child close', async () => {
  await assert.rejects(runWhileIngressLive(process.execPath,
    ['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => process.exit(0), 1000)'],
    process.cwd(), 'deadline-probe', undefined,
    { timeoutMs: 300, maxOutputBytes: 1024, closeGraceMs: 1_000 }), /close=confirmed timedOut=true/);
});

test('live CLI fixture rejects output beyond its byte bound', async () => {
  await assert.rejects(runWhileIngressLive(process.execPath,
    ['-e', 'process.stdout.write("é".repeat(64)); setTimeout(() => {}, 300)'],
    process.cwd(), 'output-probe', undefined,
    { timeoutMs: 1_000, maxOutputBytes: 32, closeGraceMs: 1_000 }), /outputExceeded=true/);
});

test('live CLI fixture bounds a failed spawn', async () => {
  await assert.rejects(runWhileIngressLive('rcac-no-such-program-20261020', [],
    process.cwd(), 'spawn-probe', undefined,
    { timeoutMs: 1_000, maxOutputBytes: 32, closeGraceMs: 1_000 }), /ENOENT|spawn-probe/);
});

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
  child: ChildProcess; issuerUrl: string; mcpUrl: string; stderrTail: () => string;
}> {
  const child = spawn(process.execPath, [cli, '--data-dir', data, 'serve-http'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4096); });
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
    return { child, ...urls, stderrTail: () => stderrTail };
  } catch (error) { await stop(child); throw error; }
  finally { lines.close(); }
}

async function installedOAuthBundle(retainedArchive?: string): Promise<void> {
    const repositoryRoot = resolve('.');
    const base = process.platform === 'win32' ? homedir() : tmpdir();
    const temporary = mkdtempSync(join(base, 'rcac-installed-oauth-bundle-'));
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
      const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'user.name', 'Fixture');
      git('add', '.');
      git('commit', '-qm', 'synthetic base');
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
      const liveRequest = async (operation: string, workspaceId: string,
        collaborationId: string, payload: unknown, idempotencyKey: string) =>
        JSON.parse(await runWhileIngressLive(process.execPath,
          [cliPath, '--data-dir', data, 'request'], temporary, operation,
          { operation, scope: { workspaceId, collaborationId }, idempotencyKey, payload })) as Record<string, unknown>;
      const initialized = cli('init');
      const principal = initialized.principal as string;
      const workspaceId = request('admin.register_workspace', 'management', undefined,
        { name: 'Synthetic OAuth proxy fixture', root: source }, 'register').id as string;
      const workingCopyId = request('admin.register_working_copy', 'management', undefined,
        { workspaceId, root: source }, 'copy').id as string;
      request('admin.grant', 'management', undefined,
        { principal, audience: 'local-os', recipient: principal, workspaceId,
          permissions: ['collab.create', 'snapshot.create', 'context.propose', 'context.accept',
            'artifact.read', 'artifact.export', 'artifact.collect'], expiresAt: null }, 'local-grant');
      const collaborationId = request('collab.open', workspaceId, undefined,
        { purpose: 'Synthetic OAuth proxy verification' }, 'open').id as string;
      const scope = { workspaceId, collaborationId };
      const snapshotId = request('snapshot.capture', workspaceId, collaborationId,
        { workingCopyId }, 'snapshot').snapshotId as string;
      request('context.propose', workspaceId, collaborationId, { proposalId: 'bundle-proposal',
        parentRevisionId: null, snapshotId, sourceRefs: ['synthetic-fixture'], content: {
          goal: 'Check installed authenticated bundle transport', constraints: [],
          acceptedDecisions: [], rejectedDecisions: [], currentQuestions: [], evidenceRefs: [],
          expectedDeliverables: ['report.md', 'details/summary.json'], unknowns: [], recentChanges: [],
        } }, 'proposal');
      const revisionId = request('context.accept', workspaceId, collaborationId,
        { proposalId: 'bundle-proposal', revisionId: 'bundle-context-v1' }, 'accept').id as string;
      const externalPrincipal = 'synthetic-external';
      request('admin.grant', 'management', undefined,
        { principal: externalPrincipal, audience: resource, recipient: clientId,
          workspaceId, collaborationId, permissions: ['collab.read', 'artifact.submit', 'artifact.read'],
          expiresAt: null }, 'external-grant');
      const password = randomBytes(32).toString('base64url');
      const operations = ['collab.get', 'artifact.begin', 'artifact.put_text',
        'artifact.status', 'artifact.finalize'];
      cli('configure-oauth', { issuer: publicOrigin, resource, clientId,
        redirectUris: [redirectUri], scopes: ['collab.read', 'artifact.submit', 'artifact.read'],
        operator: { subject: 'synthetic-operator', password },
        binding: { issuer: publicOrigin, clientId, subject: 'synthetic-operator',
          principal: externalPrincipal, recipient: clientId, workspaceId, collaborationId,
          scopes: { 'collab.read': { delegatedPermissions: ['collab.read'],
            visibleOperations: ['collab.get'] },
          'artifact.submit': { delegatedPermissions: ['artifact.submit'],
            visibleOperations: ['artifact.begin', 'artifact.put_text', 'artifact.finalize'] },
          'artifact.read': { delegatedPermissions: ['artifact.read'],
            visibleOperations: ['artifact.status'] } } } });

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
        authorization_servers: [publicOrigin], scopes_supported: ['collab.read', 'artifact.submit', 'artifact.read'] });
      const verifier = randomBytes(32).toString('base64url');
      const authorization = new URLSearchParams({ response_type: 'code', client_id: clientId,
        redirect_uri: redirectUri, scope: 'collab.read artifact.submit artifact.read', resource,
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
      assert.equal(new Set(token.scope.split(' ')).size, 3);
      assert.deepEqual(new Set(token.scope.split(' ')), new Set(['collab.read', 'artifact.submit', 'artifact.read']));
      assert.ok(token.access_token.length > 20);

      const deliveries = [
        { bundleId: 'installed-oauth-v1', parentBundleId: undefined,
          files: { 'report.md': '# Synthetic report v1\n',
            'details/summary.json': '{"version":1,"synthetic":true}\n' } },
        { bundleId: 'installed-oauth-v2', parentBundleId: 'installed-oauth-v1',
          files: { 'report.md': '# Synthetic report v2\n',
            'details/summary.json': '{"version":2,"synthetic":true}\n',
            'details/changes.html': '<p>Synthetic revision</p>\n' } },
      ] as const;
      const binaryPath = 'assets/source.bin';
      const binaryBytes = Buffer.from([0, 255, 1, 128, 10, 0]);
      const selectedBinary = join(temporary, 'selected.bin');
      writeFileSync(selectedBinary, binaryBytes);
      const manifests = new Map<string, Record<string, unknown>>();
      let ingressPhase = 'connect';
      const callMcp = async (publish: boolean) => {
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
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), operations.sort());
        const read = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId, collaborationId }, payload: {} } });
        assert.equal(read.isError, undefined);
        assert.equal(JSON.parse((read.content[0] as { text: string }).text).id, collaborationId);
        const outside = await client.callTool({ name: 'collab.get', arguments: {
          scope: { workspaceId: 'ws_other_synthetic', collaborationId }, payload: {} } });
        assert.equal(outside.isError, true);
        const call = async (name: string, payload: unknown, idempotencyKey?: string) => {
          ingressPhase = `${publish ? 'publish' : 'reopen'}:${name}`;
          const response = await client!.callTool({ name, arguments: { scope, payload,
            ...(idempotencyKey ? { idempotencyKey } : {}) } });
          assert.equal(response.isError, undefined, `${name}: ${JSON.stringify(response.content)}`);
          return JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
        };
        for (const delivery of deliveries) {
          ingressPhase = `${publish ? 'publish' : 'reopen'}:${delivery.bundleId}`;
          if (publish) {
            const paths = [...Object.keys(delivery.files),
              ...(delivery.parentBundleId ? [binaryPath] : [])];
            await call('artifact.begin', { bundleId: delivery.bundleId,
              contextRevision: revisionId, snapshotRefs: [snapshotId], expectedPaths: paths,
              ...(delivery.parentBundleId ? { parentBundleId: delivery.parentBundleId } : {}) },
            `${delivery.bundleId}-begin`);
            for (const [path, content] of Object.entries(delivery.files)) {
              await call('artifact.put_text', { bundleId: delivery.bundleId, path,
                text: content, mediaType: path.endsWith('.json') ? 'application/json' :
                  path.endsWith('.html') ? 'text/html' : 'text/markdown' },
              `${delivery.bundleId}-${path}`);
            }
            if (delivery.parentBundleId) {
              ingressPhase = `publish:${delivery.bundleId}:collect-local`;
              const collected = JSON.parse(await runWhileIngressLive(process.execPath,
                [cliPath, '--data-dir', data, 'collect-local', selectedBinary], temporary,
                'artifact.collect_local',
                { operation: 'artifact.collect_local', scope,
                  idempotencyKey: `${delivery.bundleId}-collect-binary`,
                  payload: { bundleId: delivery.bundleId, path: binaryPath,
                    mediaType: 'application/octet-stream' } })) as {
                  sha256: string; actualSizeBytes: number; sourceReceipt: string };
              assert.equal(collected.sha256, createHash('sha256').update(binaryBytes).digest('hex'));
              assert.equal(collected.actualSizeBytes, binaryBytes.length);
              assert.equal(collected.sourceReceipt, 'manual_import');
            }
            const manifest = await call('artifact.finalize', { bundleId: delivery.bundleId },
              `${delivery.bundleId}-finalize`);
            manifests.set(delivery.bundleId, manifest);
          }
          const status = await call('artifact.status', { bundleId: delivery.bundleId });
          assert.equal(status.state, 'published');
          assert.equal(status.integrityStatus, 'ok');
          const manifest = manifests.get(delivery.bundleId)!;
          assert.equal(manifest.parentBundleId ?? null, delivery.parentBundleId ?? null);
          assert.equal(manifest.expectedSetBasis, 'producer_declared');
          const actualFiles = manifest.files as Array<{ normalizedRelativePath: string;
            actualSizeBytes: number; sha256: string; sourceReceipt: string }>;
          assert.deepEqual(actualFiles.map(file => file.normalizedRelativePath).sort(),
            [...Object.keys(delivery.files), ...(delivery.parentBundleId ? [binaryPath] : [])].sort());
          for (const file of actualFiles) {
            const original = file.normalizedRelativePath === binaryPath ? binaryBytes :
              Buffer.from(delivery.files[file.normalizedRelativePath as keyof typeof delivery.files], 'utf8');
            assert.equal(file.actualSizeBytes, original.length);
            assert.equal(file.sha256, createHash('sha256').update(original).digest('hex'));
            assert.equal(file.sourceReceipt,
              file.normalizedRelativePath === binaryPath ? 'manual_import' : 'text_set_mcp');
          }
          ingressPhase = `${publish ? 'publish' : 'reopen'}:${delivery.bundleId}:inspect`;
          const inspected = await liveRequest('artifact.inspect', workspaceId, collaborationId,
            { bundleId: delivery.bundleId }, `inspect-${delivery.bundleId}-${publish}`);
          assert.equal(inspected.integrityStatus, 'ok');
          const expectedManifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
          assert.equal(inspected.manifestHash, expectedManifestHash);
          ingressPhase = `${publish ? 'publish' : 'reopen'}:${delivery.bundleId}:export`;
          const exported = await liveRequest('artifact.export', workspaceId, collaborationId,
            { bundleId: delivery.bundleId, expectedManifestHash,
              exportName: `installed-${delivery.bundleId}-${publish ? 'first' : 'reopened'}` },
          `export-${delivery.bundleId}-${publish}`);
          for (const [path, content] of Object.entries(delivery.files)) {
            assert.deepEqual(readFileSync(join(exported.path as string, path)), Buffer.from(content, 'utf8'));
          }
          if (delivery.parentBundleId) {
            assert.deepEqual(readFileSync(join(exported.path as string, binaryPath)), binaryBytes);
          }
        }
        await client.close();
        client = undefined;
      };
      try { await callMcp(true); }
      catch (error) {
        const running = http as Awaited<ReturnType<typeof startHttp>> | undefined;
        const tail = running?.stderrTail() ?? '';
        throw new Error(`installed OAuth phase=${ingressPhase} proxyActive=${proxy !== undefined} clientActive=${client !== undefined} httpExit=${running?.child.exitCode ?? 'unknown'} httpSignal=${running?.child.signalCode ?? 'none'} stderrBytes=${Buffer.byteLength(tail)} stderrSha256=${createHash('sha256').update(tail).digest('hex')}`, { cause: error });
      }
      await proxy.close(); proxy = undefined;
      await stop(http?.child); http = undefined;
      await startIngress();
      try { await callMcp(false); }
      catch (error) {
        const running = http as Awaited<ReturnType<typeof startHttp>> | undefined;
        const tail = running?.stderrTail() ?? '';
        throw new Error(`installed OAuth phase=${ingressPhase} proxyActive=${proxy !== undefined} clientActive=${client !== undefined} httpExit=${running?.child.exitCode ?? 'unknown'} httpSignal=${running?.child.signalCode ?? 'none'} stderrBytes=${Buffer.byteLength(tail)} stderrSha256=${createHash('sha256').update(tail).digest('hex')}`, { cause: error });
      }
    } catch (error) { primaryError = error; }
    finally {
      try {
        const failures: unknown[] = [];
        for (const close of [() => client?.close(), () => proxy?.close(), () => stop(http?.child)]) {
          try { await close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) cleanupError = new AggregateError(failures, 'Installed OAuth bundle cleanup failed');
        const child = relative(resolve(base), resolve(temporary));
        assert.ok(child.startsWith('rcac-installed-oauth-bundle-') && !child.includes('..') && !child.includes('\\'));
        if (primaryError === undefined && cleanupError === undefined) rmSync(temporary, { recursive: true, force: true });
        else console.error('Retained installed OAuth bundle fixture:', temporary);
      } catch (error) {
        cleanupError = cleanupError === undefined ? error : new AggregateError([cleanupError, error], 'Installed OAuth bundle cleanup failed');
        console.error('Retained installed OAuth bundle fixture:', temporary);
      }
    }
    if (primaryError !== undefined && cleanupError !== undefined)
      throw new AggregateError([primaryError, cleanupError], 'Installed OAuth bundle and cleanup failed', { cause: primaryError });
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
}

test('installed OAuth bearer publishes versioned text bundles with separate local binary import',
  { timeout: 180_000 }, () => installedOAuthBundle());

test('retained package OAuth bearer publishes versioned text bundles with separate local binary import',
  { timeout: 180_000, skip: process.env.RCAC_TEST_INSTALLED_ARCHIVE === undefined &&
    'requires an explicitly selected retained package' },
  () => installedOAuthBundle(process.env.RCAC_TEST_INSTALLED_ARCHIVE));

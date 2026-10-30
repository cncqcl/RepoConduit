import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair } from 'jose';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { openApplication } from '../../src/runtime/application.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('self-hosted OAuth restart gates the file tool on configured origins, apart from grant', async () => {
  const root = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-file-origin-'));
  protectNewDataDirectory(root);
  const state = new SqliteStore(join(root, 'state.sqlite'));
  const issuer = 'https://issuer.example.test';
  const resource = 'https://mcp.example.test';
  const clientId = 'fixture-client';
  const subject = 'operator-1';
  const salt = randomBytes(16);
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  mkdirSync(join(root, 'workspace'));
  state.insertWorkspace({ id: 'ws-a', name: 'A', canonicalRoot: join(root, 'workspace'), registeredBy: 'owner' });
  state.insertCollaboration({ id: 'col-a', workspaceId: 'ws-a', openedBy: 'owner',
    purpose: 'file origin fixture', hostThreadId: null, state: 'open' });
  state.insertGrant({ id: 'file-grant', principal: 'external-operator', audience: resource,
    recipient: clientId, workspaceId: 'ws-a', permissions: ['artifact.submit'],
    expiresAt: null, revokedAt: null });
  const { snapshotId } = await seedBundleProvenance(state, join(root, 'state.sqlite'), {
    workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a',
    root: join(root, 'workspace'), revisionIds: ['ctx-a'],
  });
  state.close();
  const context = { principal: 'external-operator', audience: resource, recipient: clientId,
    surface: 'external_mcp' as const, now: new Date(), delegatedPermissions: ['artifact.submit'] };
  const scope = { workspaceId: 'ws-a', collaborationId: 'col-a' };
  const app = openApplication(root);
  try {
    await app.ready;
    await app.dispatch.dispatch(context, { operation: 'artifact.begin', scope,
      idempotencyKey: 'begin-file', payload: { bundleId: 'bundle-a', contextRevision: 'ctx-a',
        snapshotRefs: [snapshotId], expectedPaths: ['file.bin'] } });
  } finally { await app.close(); }
  // Import the production composition root after replacing only its built-in DNS/HTTPS dependencies.
  // The MCP call must acquire bytes; no prior idempotency receipt can satisfy it.
  const fileBytes = Buffer.from([0, 255, 1, 128, 10]);
  const originalLookup = dns.promises.lookup;
  const originalRequest = https.request;
  let dnsCalls = 0;
  let downloadCalls = 0;
  const requestOptions: RequestOptions[] = [];
  Object.assign(dns.promises, { lookup: (async (hostname: string) => {
    assert.equal(hostname, 'files.example.test');
    dnsCalls++;
    return [{ address: '93.184.216.34', family: 4 }];
  }) as unknown as typeof dns.promises.lookup });
  Object.assign(https, { request: ((url: URL, options: RequestOptions,
    onResponse: (response: IncomingMessage) => void): ClientRequest => {
    assert.equal(url.href, 'https://files.example.test/signed?token=fixture');
    assert.equal(options.method, 'GET');
    requestOptions.push(options);
    downloadCalls++;
    const req = new EventEmitter() as ClientRequest;
    req.end = () => {
      const stream = new PassThrough();
      const response = stream as unknown as IncomingMessage;
      response.statusCode = 200;
      process.nextTick(() => { onResponse(response); stream.end(fileBytes); });
      return req;
    };
    req.destroy = () => req;
    return req;
  }) as typeof https.request });
  syncBuiltinESMExports();
  try {
  const { startSelfHostedOAuthHttp } = await import('../../src/runtime/self-hosted-oauth-http.js');
  const configuration = {
    issuer: { issuer, resource, clientId, redirectUris: ['https://chatgpt.example.test/callback'],
      scopes: ['artifact.submit'], operator: { subject, saltHex: salt.toString('hex'),
        hashHex: scryptSync('fixture-secret', salt, 64).toString('hex') },
      cookieKeys: [randomBytes(32).toString('hex')],
      jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] } },
    bindings: [{ issuer, clientId, subject, principal: 'external-operator', recipient: clientId,
      workspaceId: 'ws-a', scopes: { 'artifact.submit': {
        delegatedPermissions: ['artifact.submit'], visibleOperations: ['artifact.import_reference'] } } }],
  };
  const toolNames = async (allowedFileOrigins: string[], expectedImport?: boolean): Promise<string[]> => {
    const handle = await startSelfHostedOAuthHttp(root, { ...configuration, allowedFileOrigins });
    const mcp = new Client({ name: 'origin-test', version: '1' });
    try {
      const client = await handle.provider.Client.find(clientId);
      assert.ok(client);
      const grant = new handle.provider.Grant({ accountId: subject, clientId });
      grant.addResourceScope(resource, 'artifact.submit');
      const grantId = await grant.save();
      const token = await new handle.provider.AccessToken({ accountId: subject, client, grantId,
        gty: 'authorization_code', scope: 'artifact.submit', aud: resource }).save();
      await mcp.connect(new StreamableHTTPClientTransport(new URL(handle.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));
      const names = (await mcp.listTools()).tools.map(tool => tool.name);
      if (expectedImport !== undefined) {
        const response = await mcp.callTool({ name: 'artifact.import_reference', arguments: {
          scope: { workspaceId: 'ws-a', collaborationId: 'col-a' }, idempotencyKey: 'import-file',
          payload: { bundleId: 'bundle-a', path: 'file.bin' },
          file: { download_url: 'https://files.example.test/signed?token=fixture', file_id: 'fixture-file' },
        } });
        assert.equal(Boolean(response.isError), !expectedImport);
      }
      return names;
    } finally { await mcp.close(); await handle.close(); }
  };
    assert.deepEqual(await toolNames([]), []);
    assert.equal(downloadCalls, 0);
    assert.deepEqual(await toolNames(['https://files.example.test'], true), ['artifact.import_reference']);
    assert.equal(dnsCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.equal(requestOptions[0]?.servername, 'files.example.test');
    assert.equal(requestOptions[0]?.rejectUnauthorized, true);
    assert.equal(typeof requestOptions[0]?.lookup, 'function');
    const published = openApplication(root);
    try {
      await published.ready;
      await published.dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
        idempotencyKey: 'finalize-file', payload: { bundleId: 'bundle-a' } });
    } finally { await published.close(); }
    const reopened = new SqliteStore(join(root, 'state.sqlite'));
    try {
      const file = reopened.getBundle('bundle-a')?.manifest?.files[0];
      assert.equal(file?.sha256, createHash('sha256').update(fileBytes).digest('hex'));
      assert.equal(file?.sourceReceipt, 'platform_file_reference');
      assert.deepEqual(new ArtifactObjects(join(root, 'artifact-objects')).readFile('bundle-a', 'file.bin'), fileBytes);
    } finally { reopened.close(); }
    const revoker = new SqliteStore(join(root, 'state.sqlite'));
    try { revoker.revokeGrant('file-grant', new Date().toISOString()); }
    finally { revoker.close(); }
    // Discovery is based on the OAuth binding; dispatch still checks the revoked grant.
    assert.deepEqual(await toolNames(['https://files.example.test'], false), ['artifact.import_reference']);
    assert.equal(dnsCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.deepEqual(await toolNames([]), []);
  } finally {
    Object.assign(dns.promises, { lookup: originalLookup });
    Object.assign(https, { request: originalRequest });
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

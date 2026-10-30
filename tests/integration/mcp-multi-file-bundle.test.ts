import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createExternalMcpServer } from '../../src/adapters/mcp/server.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

function fixtureZip(): Buffer {
  // Python 3.13 zipfile, ZIP_DEFLATED, ASCII filename, UTF-8 flag unset.
  return Buffer.from('UEsDBBQAAAAIAIQbPV20N7uzEgAAABAAAAARAAAAbmVzdGVkL3JlcG9ydC50eHQrrswryUgtyUxWKEotyC8qAQBQSwECFAAUAAAACACEGz1dtDe7sxIAAAAQAAAAEQAAAAAAAAAAAAAAgAEAAAAAbmVzdGVkL3JlcG9ydC50eHRQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');
}

test('in-memory MCP integration stores text, binary, and ZIP with retry and bound scope', async () => {
  const root = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-mcp-bundle-'));
  const dbFile = join(root, 'state.sqlite');
  const scope = { workspaceId: 'ws-a', collaborationId: 'col-a' };
  const otherScope = { workspaceId: 'ws-a', collaborationId: 'col-other' };
  const bundleId = 'bundle-multi';
  const paths = ['plan.md', 'assets/raw.bin', 'archives/delivery.zip'];
  const textBytes = Buffer.from('# Delivery\n', 'utf8');
  const binaryBytes = Buffer.from([0, 255, 1, 128, 10]);
  const zipBytes = fixtureZip();
  const fileBytes = new Map([['file-raw', binaryBytes], ['file-zip', zipBytes]]);
  let failZipOnce = true;
  let acquiredRaw = 0;
  let acquiredZip = 0;
  let seed: SqliteStore | undefined;
  let app: ReturnType<typeof openApplication> | undefined;
  let server: ReturnType<typeof createExternalMcpServer> | undefined;
  let client: Client | undefined;
  let serverClosed = false;
  let clientClosed = false;
  try {
    protectNewDataDirectory(root);
    seed = new SqliteStore(dbFile);
    seed.insertWorkspace({ id: scope.workspaceId, name: 'A', canonicalRoot: root, registeredBy: 'owner' });
    for (const [target, purpose] of [[scope, 'multi-file bundle'], [otherScope, 'second authorized collaboration']] as const) {
      seed.insertCollaboration({ id: target.collaborationId, workspaceId: target.workspaceId,
        openedBy: 'owner', purpose, hostThreadId: null, state: 'open' });
      seed.insertGrant({ id: `bundle-grant-${target.collaborationId}`, principal: 'external',
        audience: 'mcp', recipient: 'chatgpt', ...target,
        permissions: ['artifact.submit', 'artifact.read', 'collab.read'], expiresAt: null, revokedAt: null });
    }
    const { snapshotId } = await seedBundleProvenance(seed, dbFile, { ...scope,
      workingCopyId: 'copy-a', root, revisionIds: ['ctx-a'] });
    seed.close(); seed = undefined;
    app = openApplication(root);
    server = createExternalMcpServer({ dispatcher: app.dispatch,
      context: { principal: 'external', audience: 'mcp', recipient: 'chatgpt',
        surface: 'external_mcp', now: new Date() },
      visibleOperations: ['collab.get', 'artifact.begin', 'artifact.put_text', 'artifact.import_reference',
        'artifact.status', 'artifact.finalize'],
      allowedWorkspaceId: scope.workspaceId, allowedCollaborationId: scope.collaborationId,
      // The fixture resolver uses file_id; these URLs are never fetched.
      resolveFileTransfer(file) {
        const bytes = fileBytes.get(file.file_id);
        if (!bytes) throw new Error('Unknown fixture file');
        return { referenceIdentity: file.file_id,
          mediaType: file.mime_type ?? null,
          async acquireBytes() {
            if (file.file_id === 'file-raw') acquiredRaw++;
            else { acquiredZip++; if (failZipOnce) { failZipOnce = false; throw new Error('Temporary transfer failure'); } }
            return bytes;
          } };
      },
    });
    client = new Client({ name: 'bundle-integration-test', version: '1.0.0' });
    const activeClient = client;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    async function call(name: string, payload: Record<string, unknown>, idempotencyKey?: string,
      file?: Record<string, string>, callScope = scope): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> {
      return await activeClient.callTool({ name, arguments: { scope: callScope, payload,
        ...(idempotencyKey ? { idempotencyKey } : {}), ...(file ? { file } : {}) } }) as
        { isError?: boolean; content: Array<{ type: string; text?: string }> };
    }
    const result = <T>(response: Awaited<ReturnType<typeof call>>): T => {
      assert.equal(response.isError, undefined, response.content[0]?.text);
      return JSON.parse(response.content[0]!.text!) as T;
    };
    await app.ready;
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
      ['collab.get', 'artifact.begin', 'artifact.put_text', 'artifact.import_reference',
        'artifact.status', 'artifact.finalize'].sort());
    result(await call('artifact.begin', { bundleId, contextRevision: 'ctx-a',
      snapshotRefs: [snapshotId], expectedPaths: paths }, 'begin'));
    // The other collaboration and grant are real; this connection's adapter binding is narrower.
    assert.ok(await app.dispatch.dispatch({ principal: 'external', audience: 'mcp', recipient: 'chatgpt',
      surface: 'external_mcp', now: new Date() },
    { operation: 'collab.get', scope: otherScope, payload: {} }));
    assert.equal((await call('collab.get', {}, undefined, undefined, otherScope)).isError, true);
    const denied = await call('artifact.begin', { bundleId: 'other-bundle', contextRevision: 'ctx-a',
      snapshotRefs: [snapshotId], expectedPaths: paths }, 'cross-scope', undefined, otherScope);
    assert.equal(denied.isError, true);
    const afterDenied = new SqliteStore(dbFile);
    try { assert.equal(afterDenied.getBundle('other-bundle'), null); }
    finally { afterDenied.close(); }
    result(await call('artifact.put_text', { bundleId, path: paths[0], text: textBytes.toString(),
      mediaType: 'text/markdown' }, 'put-text'));
    const rawFile = { download_url: 'https://files.example.test/raw', file_id: 'file-raw',
      mime_type: 'application/octet-stream', file_name: 'raw.bin' };
    const raw = result<{ sha256: string; actualSizeBytes: number; sourceReceipt: string }>(
      await call('artifact.import_reference', { bundleId, path: paths[1] }, 'import-raw', rawFile));
    assert.equal(raw.sha256, createHash('sha256').update(binaryBytes).digest('hex'));
    assert.equal(raw.actualSizeBytes, binaryBytes.length);
    assert.equal(raw.sourceReceipt, 'platform_file_reference');
    assert.deepEqual(result(await call('artifact.import_reference', { bundleId, path: paths[1] },
      'import-raw', rawFile)), raw);
    assert.equal(acquiredRaw, 1);
    assert.equal((await call('artifact.finalize', { bundleId }, 'too-early')).isError, true);
    const staged = result<{ state: string; missingPaths: string[] }>(await call('artifact.status', { bundleId }));
    assert.equal(staged.state, 'staging');
    assert.deepEqual(staged.missingPaths, [paths[2]]);
    const zipFile = { download_url: 'https://files.example.test/zip', file_id: 'file-zip',
      file_name: 'delivery.zip' };
    assert.equal((await call('artifact.import_reference', { bundleId, path: paths[2] },
      'import-zip', zipFile)).isError, true);
    assert.deepEqual(result<{ missingPaths: string[] }>(await call('artifact.status', { bundleId })).missingPaths,
      [paths[2]]);
    result(await call('artifact.import_reference', { bundleId, path: paths[2] }, 'import-zip', zipFile));
    assert.equal(acquiredZip, 2);
    const manifest = result<{ expectedSetBasis: string; semanticStatus: string;
      files: Array<{ normalizedRelativePath: string; sha256: string; actualSizeBytes: number; sourceReceipt: string; mediaType: string }> }>(
      await call('artifact.finalize', { bundleId }, 'finalize'));
    assert.equal(manifest.expectedSetBasis, 'producer_declared');
    assert.equal(manifest.semanticStatus, 'not_reviewed');
    assert.deepEqual(manifest.files.map(file => file.normalizedRelativePath).sort(), [...paths].sort());
    assert.equal(manifest.files.find(file => file.normalizedRelativePath === paths[2])?.mediaType, 'application/zip');
    for (const [path, bytes] of [[paths[0], textBytes], [paths[1], binaryBytes], [paths[2], zipBytes]] as const) {
      const file = manifest.files.find(entry => entry.normalizedRelativePath === path)!;
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(file.actualSizeBytes, bytes.length);
    }
    assert.equal((await call('artifact.import_reference', { bundleId, path: paths[2] },
      'overwrite-zip', zipFile)).isError, true);
    assert.deepEqual(result(await call('artifact.finalize', { bundleId }, 'finalize')), manifest);
    assert.equal(acquiredZip, 2);
    await client.close(); clientClosed = true;
    await server.close(); serverClosed = true;
    await app.close(); app = undefined;
    app = openApplication(root);
    await app.ready;
    const persisted = new SqliteStore(dbFile);
    try { assert.deepEqual(persisted.getBundle(bundleId)?.manifest, manifest); }
    finally { persisted.close(); }
    const objects = new ArtifactObjects(join(root, 'artifact-objects'));
    assert.deepEqual(objects.readFile(bundleId, paths[0]!), textBytes);
    assert.deepEqual(objects.readFile(bundleId, paths[1]!), binaryBytes);
    assert.deepEqual(objects.readFile(bundleId, paths[2]!), zipBytes);
  } finally {
    const closes = await Promise.allSettled([clientClosed ? undefined : client?.close(),
      serverClosed ? undefined : server?.close(), app?.close(),
      Promise.resolve().then(() => seed?.close())]);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(closes.filter(close => close.status === 'rejected'), [], 'fixture close failed');
  }
});

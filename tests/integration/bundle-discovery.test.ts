import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createExternalMcpServer } from '../../src/adapters/mcp/server.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('local published bundle discovery is scoped, paginated, and checks integrity after reopen', async () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const outer = mkdtempSync(join(fixtureRoot, 'rcac-bundle-discovery-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  const dbFile = join(dir, 'state.sqlite');
  const local = { principal: 'owner', audience: 'local', recipient: 'owner', surface: 'local_cli' as const, now: new Date() };
  const otherLocal = { ...local, principal: 'other' };
  const external = { ...local, surface: 'external_mcp' as const };
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(dbFile);
  seed.insertWorkspace({ id: 'ws_a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertWorkspace({ id: 'ws_b', name: 'B', canonicalRoot: join(dir, 'other'), registeredBy: 'owner' });
  for (const [workspaceId, collaborationId] of [['ws_a', 'col_a'], ['ws_b', 'col_b']] as const) {
    seed.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner', purpose: 'test', hostThreadId: null, state: 'open' });
    seed.insertGrant({ id: `grant-${collaborationId}`, principal: 'owner', audience: 'local', recipient: 'owner',
      workspaceId, collaborationId, permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
    seed.insertGrant({ id: `external-${collaborationId}`, principal: 'owner', audience: 'local', recipient: 'owner',
      workspaceId, collaborationId, permissions: ['artifact.read'], expiresAt: null, revokedAt: null });
    seed.insertGrant({ id: `other-${collaborationId}`, principal: 'other', audience: 'local', recipient: 'owner',
      workspaceId, collaborationId, permissions: ['artifact.read'], expiresAt: null, revokedAt: null });
  }
  const a = await seedBundleProvenance(seed, dbFile, { workspaceId: 'ws_a', collaborationId: 'col_a',
    workingCopyId: 'copy-a', root: dir, revisionIds: ['ctx_a'] });
  seed.close();
  let app = openApplication(dir);
  let appClosed = false;
  const scopeA = { workspaceId: 'ws_a', collaborationId: 'col_a' };
  const scopeB = { workspaceId: 'ws_b', collaborationId: 'col_b' };
  const call = (scope: typeof scopeA, operation: string, payload: object, idempotencyKey?: string) =>
    app.dispatch.dispatch(local, { operation, scope, payload, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const publish = async (scope: typeof scopeA, bundleId: string, revision: string, snapshotId: string, parentBundleId?: string) => {
    await call(scope, 'artifact.begin', { bundleId, contextRevision: revision, snapshotRefs: [snapshotId],
      expectedPaths: ['report.md'], ...(parentBundleId ? { parentBundleId } : {}) }, `begin-${bundleId}`);
    await call(scope, 'artifact.put_text', { bundleId, path: 'report.md', text: bundleId, mediaType: 'text/markdown' }, `put-${bundleId}`);
    return call(scope, 'artifact.finalize', { bundleId }, `finish-${bundleId}`);
  };
  try {
    await publish(scopeA, 'a-v1', 'ctx_a', a.snapshotId);
    const v2 = await publish(scopeA, 'a-v2', 'ctx_a', a.snapshotId, 'a-v1');
    await call(scopeA, 'artifact.begin', { bundleId: 'a-staging', contextRevision: 'ctx_a', snapshotRefs: [a.snapshotId] }, 'begin-staging');
    app.close(); appClosed = true;
    const oldSchema = new DatabaseSync(dbFile);
    try { oldSchema.exec('DROP INDEX bundles_published_seq; DROP INDEX bundles_scope_publication; ALTER TABLE bundles DROP COLUMN published_seq'); }
    finally { oldSchema.close(); }
    app = openApplication(dir); appClosed = false;

    const first = await call(scopeA, 'artifact.list', { limit: 1 }) as { bundles: { bundleId: string; integrityStatusRecorded: string | null; ready?: boolean }[]; nextCursor: string | null };
    assert.deepEqual(first.bundles.map((item) => item.bundleId), ['a-v1']);
    assert.equal(first.bundles[0]?.integrityStatusRecorded, 'ok');
    assert.equal('ready' in first.bundles[0]!, false);
    assert.equal(typeof first.nextCursor, 'string');
    app.close(); appClosed = true;
    app = openApplication(dir); appClosed = false;
    const forged = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as
      { afterSeq?: number; body?: { afterSeq: number; highWater: number } };
    if (forged.body) forged.body.afterSeq++;
    else forged.afterSeq = forged.afterSeq! + 1;
    await assert.rejects(call(scopeA, 'artifact.list', { limit: 1,
      cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }));
    const forgedHighWater = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as
      { body: { highWater: number } };
    forgedHighWater.body.highWater++;
    await assert.rejects(call(scopeA, 'artifact.list', { limit: 1,
      cursor: Buffer.from(JSON.stringify(forgedHighWater)).toString('base64url') }));
    await call(scopeA, 'artifact.put_text', { bundleId: 'a-staging', path: 'report.md', text: 'a-staging',
      mediaType: 'text/markdown' }, 'put-staging');
    await call(scopeA, 'artifact.finalize', { bundleId: 'a-staging' }, 'finish-staging');
    await assert.rejects(call(scopeB, 'artifact.list', { cursor: first.nextCursor }));
    await assert.rejects(app.dispatch.dispatch(otherLocal, { operation: 'artifact.list', scope: scopeA,
      payload: { limit: 1, cursor: first.nextCursor } }));
    await assert.rejects(call(scopeA, 'artifact.list', { limit: 2, cursor: first.nextCursor }));
    const tamperedCursor = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.at(-1) === 'A' ? 'B' : 'A'}`;
    await assert.rejects(call(scopeA, 'artifact.list', { limit: 1, cursor: tamperedCursor }));
    const second = await call(scopeA, 'artifact.list', { limit: 1, cursor: first.nextCursor }) as typeof first;
    assert.deepEqual(second.bundles.map((item) => item.bundleId), ['a-v2']);
    assert.equal(second.nextCursor, null);
    const inspect = await call(scopeA, 'artifact.inspect', { bundleId: 'a-v2' }) as {
      bundleId: string; parentBundleId: string; manifestHash: string; integrityStatus: string; ready: boolean; manifest: unknown;
    };
    assert.equal(inspect.parentBundleId, 'a-v1');
    assert.equal(inspect.manifestHash, createHash('sha256').update(JSON.stringify(v2)).digest('hex'));
    assert.equal(inspect.integrityStatus, 'ok');
    assert.equal(inspect.ready, true);
    assert.deepEqual(inspect.manifest, v2);
    await assert.rejects(call(scopeB, 'artifact.inspect', { bundleId: 'a-v1' }));
    const later = await call(scopeA, 'artifact.list', { limit: 10 }) as typeof first;
    assert.deepEqual(later.bundles.map((item) => item.bundleId), ['a-v1', 'a-v2', 'a-staging']);
    await assert.rejects(app.dispatch.dispatch(external, { operation: 'artifact.list', scope: scopeA, payload: {} }));
    await assert.rejects(call(scopeA, 'artifact.list', { limit: 0 }));
    await assert.rejects(call(scopeA, 'artifact.list', { limit: 11 }));

    const fileHash = (v2 as { files: { sha256: string }[] }).files[0]!.sha256;
    writeFileSync(join(dir, 'artifact-objects', 'objects', fileHash.slice(0, 2), fileHash), 'corrupt');
    const damaged = await call(scopeA, 'artifact.inspect', { bundleId: 'a-v2' }) as typeof inspect;
    assert.equal(damaged.integrityStatus, 'corrupt');
    assert.equal(damaged.ready, false);
    const listedAfterDamage = await call(scopeA, 'artifact.list', { limit: 10 }) as typeof first;
    assert.equal(listedAfterDamage.bundles.find((item) => item.bundleId === 'a-v2')?.integrityStatusRecorded, 'ok');
  } finally {
    if (!appClosed) app.close();
    const child = relative(resolve(fixtureRoot), resolve(outer));
    assert.ok(child.startsWith('rcac-bundle-discovery-') && !child.includes('..') && !child.includes('\\'));
    rmSync(outer, { recursive: true, force: true });
  }
});

test('external MCP does not advertise local bundle discovery even when requested visible', async () => {
  const server = createExternalMcpServer({ dispatcher: { async dispatch() { return null; } },
    context: { principal: 'external', audience: 'mcp', recipient: 'external', surface: 'external_mcp', now: new Date() },
    visibleOperations: ['artifact.list', 'artifact.inspect', 'artifact.status'] });
  const client = new Client({ name: 'discovery-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['artifact.status']);
  } finally {
    await client.close();
    await server.close();
  }
});

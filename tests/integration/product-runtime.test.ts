import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('the production application reopens a published multi-file bundle through one dispatcher', async () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const outer = mkdtempSync(join(fixtureRoot, 'rcac-runtime-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  const dbFile = join(dir, 'state.sqlite');
  const ws = 'ws_a', col = 'col_a', bundle = 'bundle_a';
  const context = { principal: 'external', audience: 'mcp', recipient: 'external',
    surface: 'external_mcp' as const, now: new Date() };
  protectNewDataDirectory(dir);
  const seed = new SqliteStore(dbFile);
  seed.insertWorkspace({ id: ws, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  seed.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'test', hostThreadId: null, state: 'open' });
  seed.insertGrant({ id: 'grant', principal: context.principal, audience: context.audience,
    recipient: context.recipient, workspaceId: ws, collaborationId: col,
    permissions: ['artifact.submit', 'artifact.read'], expiresAt: null, revokedAt: null });
  const { snapshotId } = await seedBundleProvenance(seed, dbFile, { workspaceId: ws,
    collaborationId: col, workingCopyId: 'copy-a', root: dir, revisionIds: ['ctx_a'] });
  seed.close();
  let app = openApplication(dir);
  const scope = { workspaceId: ws, collaborationId: col };
  try {
    await app.dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: 'begin',
      payload: { bundleId: bundle, contextRevision: 'ctx_a', snapshotRefs: [snapshotId], expectedPaths: ['a.md', 'b.md'] } });
    await app.dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: 'a',
      payload: { bundleId: bundle, path: 'a.md', text: 'A', mediaType: 'text/markdown' } });
    await app.dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: 'b',
      payload: { bundleId: bundle, path: 'b.md', text: 'B', mediaType: 'text/markdown' } });
    const manifest = await app.dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
      idempotencyKey: 'finalize', payload: { bundleId: bundle } }) as { files: unknown[] };
    assert.equal(manifest.files.length, 2);
    app.close();
    app = openApplication(dir);
    const status = await app.dispatch.dispatch(context, { operation: 'artifact.status', scope,
      payload: { bundleId: bundle } }) as { state: string; integrityStatus: string; files: unknown[] };
    assert.equal(status.state, 'published');
    assert.equal(status.integrityStatus, 'ok');
    assert.equal(status.files.length, 2);
  } finally {
    app.close();
    const child = relative(resolve(fixtureRoot), resolve(outer));
    assert.match(child, /^rcac-runtime-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

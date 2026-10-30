import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { createSqliteOidcAdapter } from '../../src/adapters/auth/sqlite-adapter.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createManagedInstallation } from '../../src/cli/install.js';
import { recordDecision } from '../../src/core/collaboration/decision.js';
import type { Permit } from '../../src/core/policy/authorize.js';
import { backupInstallation, restoreInstallation } from '../../src/runtime/installation-backup.js';
import { acquireInstallationMaintenance } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

const parent = process.platform === 'win32' ? homedir() : tmpdir();
const archive = Buffer.from('UEsDBBQAAAAIAIQbPV20N7uzEgAAABAAAAARAAAAbmVzdGVkL3JlcG9ydC50eHQrrswryUgtyUxWKEotyC8qAQBQSwECFAAUAAAACACEGz1dtDe7sxIAAAAQAAAAEQAAAAAAAAAAAAAAgAEAAAAAbmVzdGVkL3JlcG9ydC50eHRQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');
// A complete 1x1 RGB PNG with IHDR, a zlib-compressed red pixel, and IEND.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const raw = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
const scope = { workspaceId: 'ws_dataset', collaborationId: 'col_dataset' };
const permit = (operation: string): Permit => ({ grantId: 'local-fixture', operation,
  effect: 'state_write', scope, principal: 'owner', recipient: 'owner' });

type TableRows = Record<string, unknown[]>;
function normalized(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytesHex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  return value;
}
function logicalRows(file: string): TableRows {
  const db = new DatabaseSync(file, { readOnly: true });
  let primary: unknown;
  let rows: TableRows | undefined;
  try {
    db.exec('PRAGMA query_only=ON');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as
      { name: string }[];
    rows = Object.fromEntries(tables.map(({ name }) => {
      const safe = name.replaceAll('"', '""');
      const values = db.prepare(`SELECT * FROM "${safe}"`).all().map(normalized)
        .map(value => JSON.stringify(value)).sort();
      return [name, values];
    }));
  } catch (error) { primary = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error],
    'Dataset inspection database close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
  return rows!;
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

test('managed backup and restore preserve v1/v2 multiformat objects, provenance, decisions and issuer rows', async () => {
  const base = mkdtempSync(join(parent, 'rcac-backup-dataset-'));
  let state: SqliteStore | undefined;
  let decisions: ContextDecisionSqlite | undefined;
  let issuer: DatabaseSync | undefined;
  let sourceData!: string;
  let primary: unknown;
  try {
    protectNewDataDirectory(base);
    const workspace = join(base, 'workspace');
    mkdirSync(workspace);
    const source = join(base, 'source');
    createManagedInstallation(source);
    const selected = acquireInstallationMaintenance(source);
    try { sourceData = selected.dataDirectory; } finally { selected.release(); }
    const stateFile = join(sourceData, 'state.sqlite');
    state = new SqliteStore(stateFile);
    state.insertWorkspace({ id: scope.workspaceId, name: 'Dataset fixture',
      canonicalRoot: workspace, registeredBy: 'owner' });
    state.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId,
      openedBy: 'owner', purpose: 'backup dataset', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(state, stateFile, {
      ...scope, workingCopyId: 'copy_dataset', root: workspace, revisionIds: ['ctx_v1', 'ctx_v2'],
    });
    decisions = new ContextDecisionSqlite(stateFile);
    const objects = new ArtifactObjects(join(sourceData, 'artifact-objects'));
    const first = { ...scope, bundleId: 'bundle_v1', contextRevision: 'ctx_v1',
      snapshotRefs: [snapshotId], expectedPaths: ['plan.md', 'assets/image.png', 'archives/evidence.zip', 'raw.bin'] };
    objects.begin(first);
    objects.putText(first.bundleId, 'plan.md', '# original v1\n', 'text/markdown', 'text_set_mcp');
    objects.putBytes(first.bundleId, 'assets/image.png', png, 'image/png', 'authorized_local_collector');
    objects.putBytes(first.bundleId, 'archives/evidence.zip', archive, 'application/zip', 'authorized_local_collector');
    objects.putBytes(first.bundleId, 'raw.bin', raw, 'application/octet-stream', 'authorized_local_collector');
    state.saveBundle({ input: first });
    const manifestV1 = objects.finalize(first.bundleId, manifest => state!.publishBundle(manifest));
    const second = { ...first, bundleId: 'bundle_v2', contextRevision: 'ctx_v2',
      parentBundleId: first.bundleId };
    objects.begin(second);
    objects.putText(second.bundleId, 'plan.md', '# revised v2\n', 'text/markdown', 'text_set_mcp');
    objects.putBytes(second.bundleId, 'assets/image.png', png, 'image/png', 'authorized_local_collector');
    objects.putBytes(second.bundleId, 'archives/evidence.zip', archive, 'application/zip', 'authorized_local_collector');
    objects.putBytes(second.bundleId, 'raw.bin', raw, 'application/octet-stream', 'authorized_local_collector');
    state.saveBundle({ input: second });
    const manifestV2 = objects.finalize(second.bundleId, manifest => state!.publishBundle(manifest));
    assert.equal(manifestV1.files.length, 4);
    assert.equal(manifestV2.files.length, 4);
    assert.equal(manifestV2.parentBundleId, first.bundleId);
    const firstHash = decisions.getPublishedBundleHash(scope.workspaceId, scope.collaborationId, first.bundleId);
    const review = decisions.insertBaselineReview({ id: 'review_v1', ...scope, bundleId: first.bundleId,
      bundleManifestHash: firstHash, snapshotId, contextRevisionId: 'ctx_v1', reviewedBy: 'owner' },
    permit('decision.review'), 'local_host');
    const decision = recordDecision({ id: 'decision_v1', ...scope, bundleId: first.bundleId,
      bundleManifestHash: firstHash, snapshotId, contextRevisionId: 'ctx_v1', reviewId: review.id,
      outcome: 'modify', reason: 'Version two addresses the review', decidedBy: 'owner',
      items: [{ id: 'revision_requested', sourceRef: 'file:plan.md', outcome: 'modify',
        reason: 'Clarify the plan' }] }, permit('decision.record'), 'local_host');
    assert.equal(decisions.insertDecision(decision, permit('decision.record'), 'local_host').implementationAuthorized, false);
    try { decisions.close(); decisions = undefined; }
    catch (error) { throw new AggregateError([error], 'Dataset decision store close unconfirmed', { cause: error }); }
    try { state.close(); state = undefined; }
    catch (error) { throw new AggregateError([error], 'Dataset state store close unconfirmed', { cause: error }); }

    issuer = new DatabaseSync(join(sourceData, 'issuer.sqlite'));
    const adapter = createSqliteOidcAdapter(issuer);
    await adapter('Grant').upsert('grant-synthetic', { uid: 'synthetic-user', grantId: 'grant-synthetic' }, 3600);
    await adapter('Session').upsert('session-synthetic', { uid: 'synthetic-user' }, 3600);
    try { issuer.close(); issuer = undefined; }
    catch (error) { throw new AggregateError([error], 'Dataset issuer store close unconfirmed', { cause: error }); }

    const beforeState = logicalRows(stateFile);
    const beforeIssuer = logicalRows(join(sourceData, 'issuer.sqlite'));
    assert.equal(beforeState.bundles?.length, 2);
    assert.equal(beforeState.bundle_files?.length, 8);
    assert.equal(beforeState.snapshots?.length, 1);
    assert.equal(beforeState.context_revisions?.length, 2);
    assert.equal(beforeState.baseline_reviews?.length, 1);
    assert.equal(beforeState.decisions?.length, 1);
    assert.equal(beforeIssuer.oidc_models?.length, 2);
    const backup = join(base, 'backup');
    assert.deepEqual(await backupInstallation(source, backup),
      { completed: true, dataset: 'active_generation' });
    const restored = join(base, 'restored');
    assert.deepEqual(await restoreInstallation(backup, restored), { restored: true });
    const owner = acquireInstallationMaintenance(restored);
    let restoredData: string;
    try { restoredData = owner.dataDirectory; } finally { owner.release(); }
    assert.deepEqual(logicalRows(join(restoredData, 'state.sqlite')), beforeState);
    assert.deepEqual(logicalRows(join(restoredData, 'issuer.sqlite')), beforeIssuer);
    assert.equal(beforeState.grants?.length, 1, 'restore retains the sole original admin grant');
    const restoredObjects = new ArtifactObjects(join(restoredData, 'artifact-objects'));
    for (const [bundleId, text] of [[first.bundleId, '# original v1\n'], [second.bundleId, '# revised v2\n']] as const) {
      assert.deepEqual(restoredObjects.readFile(bundleId, 'plan.md'), Buffer.from(text));
      assert.deepEqual(restoredObjects.readFile(bundleId, 'assets/image.png'), png);
      assert.deepEqual(restoredObjects.readFile(bundleId, 'archives/evidence.zip'), archive);
      assert.deepEqual(restoredObjects.readFile(bundleId, 'raw.bin'), raw);
    }
    for (const manifest of [manifestV1, manifestV2]) {
      const original = Buffer.from(JSON.stringify(manifest));
      const originalHash = hash(original);
      const path = restoredObjects.objectPath(originalHash);
      assert.deepEqual(readFileSync(path), original);
      for (const file of manifest.files) {
        const bytes = readFileSync(restoredObjects.objectPath(file.sha256));
        assert.equal(bytes.length, file.actualSizeBytes);
        assert.equal(hash(bytes), file.sha256);
      }
    }
    assert.equal(existsSync(join(restored, 'managed.json')), true);
  } catch (error) { primary = error; }
  const closeErrors: unknown[] = [];
  for (const resource of [decisions, state, issuer]) {
    if (resource) try { resource.close(); } catch (error) { closeErrors.push(error); }
  }
  if (closeErrors.length || primary !== undefined) {
    throw new AggregateError(primary === undefined ? closeErrors : [primary, ...closeErrors],
      `Dataset fixture retained after failure at ${base}`);
  }
  let cleanup: unknown;
  try {
    for (const name of ['source', 'restored']) {
      const root = join(base, name);
      if (existsSync(join(root, 'managed.json'))) acquireInstallationMaintenance(root).release();
    }
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-backup-dataset-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (cleanup !== undefined) throw cleanup;
});

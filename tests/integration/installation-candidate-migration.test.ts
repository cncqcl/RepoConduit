import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { createManagedInstallation } from '../../src/cli/install.js';
import { migrateInstallationCandidate } from '../../src/cli/migrate-installation.js';
import { proposeDecision, recordDecision } from '../../src/core/collaboration/decision.js';
import type { Permit } from '../../src/core/policy/authorize.js';
import { acquireInstallationMaintenance, currentInstallationPackageVersion, retainInstallationMaintenance,
  type InstallationMaintenance } from '../../src/runtime/installation.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

async function fixture(run: (base: string, retain: () => void) => Promise<void>): Promise<void> {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-migrate-candidate-'));
  let primary: unknown;
  let retained = false;
  try { protectNewDataDirectory(base); await run(base, () => { retained = true; }); }
  catch (error) { primary = error; }
  if (primary !== undefined) throw primary;
  if (retained) throw new Error('Migration fixture retained after unconfirmed resource closure');
  let cleanup: unknown;
  try {
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-migrate-candidate-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (cleanup !== undefined) throw cleanup;
}

function withOwner(owner: InstallationMaintenance, retainFixture: () => void, action: () => void): void {
  let primary: unknown;
  try { action(); } catch (error) { primary = error; }
  if (primary instanceof AggregateError) {
    retainInstallationMaintenance(owner);
    retainFixture();
    throw primary;
  }
  try { owner.release(); }
  catch (closeError) {
    retainInstallationMaintenance(owner);
    retainFixture();
    throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
      'Migration owner release unconfirmed', { cause: closeError });
  }
  if (primary !== undefined) throw primary;
}

function expectUnsafe(action: () => unknown): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  if (error instanceof AggregateError) throw error;
  assert.ok(error instanceof Error, 'candidate migration unexpectedly succeeded');
  assert.equal(error.message, 'INSTALLATION_MIGRATION_UNSAFE');
}

function manifest(root: string): { activeGeneration: string; packageVersion: string } {
  return JSON.parse(readFileSync(join(root, 'managed.json'), 'utf8')) as
    { activeGeneration: string; packageVersion: string };
}

function candidate(root: string, activeData: string): { generation: string; data: string } {
  const generation = `gen_${randomUUID()}`;
  const generationPath = join(root, 'generations', generation);
  mkdirSync(generationPath, { mode: 0o700 });
  protectNewDataDirectory(generationPath);
  const data = join(generationPath, 'data');
  cpSync(activeData, data, { recursive: true });
  protectNewDataDirectory(data);
  return { generation, data };
}

test('candidate migration checks the copied dataset and preserves identities and the active source', async () => {
  await fixture(async (base, retain) => {
    const root = join(base, 'installation');
    createManagedInstallation(root);
    const before = readFileSync(join(root, 'managed.json'));
    const active = manifest(root);
    assert.equal(active.packageVersion, '0.1.0');
    const sourceData = join(root, 'generations', active.activeGeneration, 'data');
    const state = join(sourceData, 'state.sqlite');
    const store = new SqliteStore(state);
    try {
      const scope = { workspaceId: 'ws-a', collaborationId: 'col-a' };
      store.insertWorkspace({ id: scope.workspaceId, name: 'Migration fixture', canonicalRoot: base, registeredBy: 'owner' });
      store.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId,
        openedBy: 'owner', purpose: 'upgrade evidence', hostThreadId: null, state: 'open' });
      const { snapshotId } = await seedBundleProvenance(store, state,
        { ...scope, workingCopyId: 'copy-a', root: base, revisionIds: ['ctx-v1', 'ctx-v2'] });
      const objects = new ArtifactObjects(join(sourceData, 'artifact-objects'));
      const first = { bundleId: 'bundle-v1', ...scope, contextRevision: 'ctx-v1', snapshotRefs: [snapshotId],
        expectedPaths: ['plan.md'] };
      objects.begin(first);
      objects.putText(first.bundleId, 'plan.md', 'first revision', 'text/markdown', 'text_set_mcp');
      store.saveBundle({ input: first });
      objects.finalize(first.bundleId, value => store.publishBundle(value));
      const second = { ...first, bundleId: 'bundle-v2', contextRevision: 'ctx-v2', parentBundleId: first.bundleId };
      objects.begin(second);
      objects.putText(second.bundleId, 'plan.md', 'second revision', 'text/markdown', 'text_set_mcp');
      store.saveBundle({ input: second });
      objects.finalize(second.bundleId, value => store.publishBundle(value));
      const contexts = new ContextDecisionSqlite(state);
      try {
        const permit = (operation: string): Permit => ({ grantId: 'local-fixture', operation,
          effect: 'state_write', scope, principal: 'owner', recipient: 'owner' });
        const hash = contexts.getPublishedBundleHash(scope.workspaceId, scope.collaborationId, second.bundleId);
        const proposal = proposeDecision({ id: 'proposal-upgrade', ...scope, snapshotId, contextRevisionId: 'ctx-v2',
          recommendation: 'accept', reason: 'Synthetic migration review', proposedBy: 'owner',
          bundleId: second.bundleId, bundleManifestHash: hash }, permit('decision.propose'));
        contexts.insertDecisionProposal(proposal, permit('decision.propose'));
        const review = contexts.insertBaselineReview({ id: 'review-upgrade', ...scope, snapshotId,
          contextRevisionId: 'ctx-v2', proposalId: proposal.id, reviewedBy: 'owner' },
        permit('decision.review'), 'local_host');
        const decision = recordDecision({ id: 'decision-upgrade', ...scope, proposalId: proposal.id,
          snapshotId, contextRevisionId: 'ctx-v2', reviewId: review.id, outcome: 'accept',
          reason: 'Fixture decision', decidedBy: 'owner' }, permit('decision.record'), 'local_host');
        contexts.insertDecision(decision, permit('decision.record'), 'local_host');
      } finally { contexts.close(); }
    } finally { store.close(); }
    const sourceBytes = readFileSync(state);
    const copied = candidate(root, sourceData);
    const owner = acquireInstallationMaintenance(root);
    withOwner(owner, retain, () => {
      assert.deepEqual(migrateInstallationCandidate(root, copied.generation, '0.1.0'),
        { migrated: true, dataFormatVersion: 1, packageVersion: currentInstallationPackageVersion() });
    });
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
    assert.deepEqual(readFileSync(state), sourceBytes);
    assert.equal(existsSync(join(root, 'managed.json.pending')), false);
    const migratedState = join(copied.data, 'state.sqlite');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      assert.equal(existsSync(`${migratedState}${suffix}`), false, `candidate left a SQLite ${suffix} sidecar`);
    }
    const immutable = (file: string): DatabaseSync =>
      new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true });
    const original = immutable(state);
    const migrated = immutable(migratedState);
    try {
      const grants = (db: DatabaseSync) => db.prepare('SELECT id, principal, permissions_json FROM grants ORDER BY id').all();
      assert.deepEqual(migrated.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(grants(migrated), grants(original));
      assert.equal(grants(migrated).length, 1, 'migration must not reseed an administrator');
      for (const table of ['snapshots', 'context_revisions', 'bundles', 'bundle_files',
        'decision_proposals', 'baseline_reviews', 'decisions']) {
        const rows = (db: DatabaseSync) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        assert.deepEqual(rows(migrated), rows(original), `${table} lost a persisted row`);
      }
      assert.equal((migrated.prepare('SELECT count(*) AS n FROM bundles').get() as { n: number }).n, 2);
      assert.equal((migrated.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }).n, 1);
    } finally { original.close(); migrated.close(); }
  });
});

test('candidate migration refuses active generation, unsupported version, and invalid copied database before writes', async () => {
  await fixture(async (base, retain) => {
    const root = join(base, 'installation');
    createManagedInstallation(root);
    const before = readFileSync(join(root, 'managed.json'));
    const active = manifest(root);
    const sourceData = join(root, 'generations', active.activeGeneration, 'data');
    const sourceBytes = readFileSync(join(sourceData, 'state.sqlite'));
    const copied = candidate(root, sourceData);
    const copiedState = join(copied.data, 'state.sqlite');
    const owner = acquireInstallationMaintenance(root);
    withOwner(owner, retain, () => {
      expectUnsafe(() => migrateInstallationCandidate(root, active.activeGeneration, '0.1.0'));
      expectUnsafe(() => migrateInstallationCandidate(root, copied.generation, '0.0.9'));
      const sidecar = `${copiedState}-wal`;
      writeFileSync(sidecar, 'synthetic uncommitted WAL');
      expectUnsafe(() => migrateInstallationCandidate(root, copied.generation, '0.1.0'));
      assert.equal(readFileSync(sidecar, 'utf8'), 'synthetic uncommitted WAL');
      assert.deepEqual(readFileSync(copiedState), sourceBytes, 'sidecar refusal changed the candidate database');
      rmSync(sidecar);
      writeFileSync(copiedState, 'not a database');
      const corrupt = readFileSync(copiedState);
      expectUnsafe(() => migrateInstallationCandidate(root, copied.generation, '0.1.0'));
      assert.deepEqual(readFileSync(copiedState), corrupt, 'invalid DB was modified');
    });
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
    assert.deepEqual(readFileSync(join(sourceData, 'state.sqlite')), sourceBytes);
  });
});

test('candidate migration refuses a linked candidate dataset', async t => {
  await fixture(async (base, retain) => {
    const root = join(base, 'installation');
    createManagedInstallation(root);
    const active = manifest(root);
    const sourceData = join(root, 'generations', active.activeGeneration, 'data');
    const generation = `gen_${randomUUID()}`;
    const generationPath = join(root, 'generations', generation);
    mkdirSync(generationPath, { mode: 0o700 });
    protectNewDataDirectory(generationPath);
    const data = join(generationPath, 'data');
    try { symlinkSync(sourceData, data, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { t.skip('directory link unavailable'); return; }
      throw error;
    }
    assert.equal(lstatSync(data).isSymbolicLink(), true);
    const before = readFileSync(join(root, 'managed.json'));
    const owner = acquireInstallationMaintenance(root);
    withOwner(owner, retain, () => { expectUnsafe(() => migrateInstallationCandidate(root, generation, '0.1.0')); });
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
  });
});

test('a real store migration conflict leaves the copied candidate inactive and source unchanged', async () => {
  await fixture(async (base, retain) => {
    const root = join(base, 'installation');
    createManagedInstallation(root);
    const active = manifest(root);
    const sourceData = join(root, 'generations', active.activeGeneration, 'data');
    const sourceState = join(sourceData, 'state.sqlite');
    const sourceBytes = readFileSync(sourceState);
    const before = readFileSync(join(root, 'managed.json'));
    const copied = candidate(root, sourceData);
    const candidateState = join(copied.data, 'state.sqlite');
    const db = new DatabaseSync(candidateState);
    try {
      db.exec('DROP INDEX session_control_current_participant');
      db.prepare('INSERT INTO workspaces(id,name,canonical_root,registered_by) VALUES (?,?,?,?)')
        .run('ws-conflict', 'Conflict fixture', base, 'owner');
      db.prepare(`INSERT INTO collaborations(id,workspace_id,opened_by,purpose,host_thread_id,state)
        VALUES (?,?,?,?,?,?)`).run('col-conflict', 'ws-conflict', 'owner', 'fixture', null, 'open');
      const insert = db.prepare(`INSERT INTO session_control(binding_id,workspace_id,collaboration_id,provider_id,
        account_id,native_session_id,revision,epoch,state_json,lifecycle) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const id of ['first', 'second']) {
        const state = { bindingId: id, workspaceId: 'ws-conflict', collaborationId: 'col-conflict',
          providerId: 'provider', accountId: 'account', nativeSessionId: `chat-${id}`,
          cursor: 'start', control: 'host_controlled', revision: 0, epoch: 0, lifecycle: 'current' };
        insert.run(id, state.workspaceId, state.collaborationId, state.providerId, state.accountId,
          state.nativeSessionId, 0, 0, JSON.stringify(state), 'current');
      }
    } finally { db.close(); }
    const owner = acquireInstallationMaintenance(root);
    withOwner(owner, retain, () => { expectUnsafe(() => migrateInstallationCandidate(root, copied.generation, '0.1.0')); });
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
    assert.deepEqual(readFileSync(sourceState), sourceBytes);
    const after = new DatabaseSync(candidateState, { readOnly: true });
    try { assert.equal((after.prepare('SELECT count(*) AS n FROM session_control').get() as { n: number }).n, 2); }
    finally { after.close(); }
  });
});

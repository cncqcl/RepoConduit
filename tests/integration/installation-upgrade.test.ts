import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { proposeDecision, recordDecision } from '../../src/core/collaboration/decision.js';
import type { Permit } from '../../src/core/policy/authorize.js';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { upgradeInstallation } from '../../src/runtime/installation-upgrade.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';
import { pinRetainedInstallationArchive } from '../support/retained-installation-archive.js';

function runNode(args: string[], cwd: string, timeout = 120_000): string {
  const processResult = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
  if (processResult.error) throw processResult.error;
  assert.equal(processResult.status, 0, processResult.stderr.slice(0, 512));
  return processResult.stdout;
}
async function expectRefusal(action: Promise<unknown>, message: RegExp): Promise<void> {
  let caught: unknown;
  try { await action; } catch (error) { caught = error; }
  if (caught instanceof AggregateError) throw caught;
  assert.ok(caught instanceof Error, 'upgrade unexpectedly succeeded');
  assert.match(caught.message, message);
}
function expectSyncRefusal(action: () => unknown, message: RegExp): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  if (caught instanceof AggregateError) throw caught;
  assert.ok(caught instanceof Error, 'old installed runtime unexpectedly opened');
  assert.match(caught.message, message);
}

/** Build and pack a controlled second-version publication with the real compiled product. */
function packCandidate(base: string): string {
  const repository = resolve('.');
  runNode([resolve('node_modules/typescript/bin/tsc')], repository);
  const staging = join(base, 'staging');
  mkdirSync(staging, { mode: 0o700 }); protectNewDataDirectory(staging);
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as Record<string, unknown>;
  const lock = JSON.parse(readFileSync(join(repository, 'package-lock.json'), 'utf8')) as
    { version: string; packages: Record<string, Record<string, unknown>> };
  assert.equal(pkg.version, '0.1.0');
  pkg.version = '0.1.1'; lock.version = '0.1.1'; lock.packages['']!.version = '0.1.1';
  pkg.files = ['npm-shrinkwrap.json', 'dist/src', 'dist/contracts'];
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(staging, 'package-lock.json'), JSON.stringify(lock, null, 2));
  cpSync(join(repository, 'dist', 'src'), join(staging, 'dist', 'src'), { recursive: true });
  cpSync(join(repository, 'dist', 'contracts'), join(staging, 'dist', 'contracts'), { recursive: true });
  runNode([join(repository, 'tools', 'prepare-installation-package.mjs'), staging], repository);
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packed = JSON.parse(runNode([npm, 'pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', base], staging)) as { filename: string }[];
  assert.equal(packed.length, 1);
  assert.equal(packed[0]!.filename, 'repo-conduit-0.1.1.tgz');
  return join(base, packed[0]!.filename);
}

async function installedUpgrade(retainedArchive?: string): Promise<void> {
    const parent = process.platform === 'win32' ? homedir() : tmpdir();
    const base = mkdtempSync(join(parent, 'rcac-upgrade-real-'));
    let failure: unknown;
    try {
      protectNewDataDirectory(base);
      const root = join(base, 'installation');
      createManagedInstallation(root);
      const oldManifest = readFileSync(join(root, 'managed.json'));
      const old = JSON.parse(oldManifest.toString('utf8')) as { activeGeneration: string; packageVersion: string };
      assert.equal(old.packageVersion, '0.1.0');
      const oldData = join(root, 'generations', old.activeGeneration, 'data');
      const ordinary = Buffer.from([0, 255, 128, 13, 10, 1]);
      const runtime = acquireInstallationRuntime(root);
      try {
        writeFileSync(join(oldData, 'ordinary.lock'), ordinary);
        const db = new SqliteStore(join(oldData, 'state.sqlite'));
        try {
          db.insertGrant({ id: 'gr-upgrade-reader', principal: 'fixture-reader', audience: 'local-os',
            recipient: 'fixture-reader', workspaceId: 'management', permissions: ['collaboration.read'],
            expiresAt: null, revokedAt: null });
          const scope = { workspaceId: 'ws-upgrade', collaborationId: 'col-upgrade' };
          const workspaceRoot = join(base, 'workspace');
          mkdirSync(workspaceRoot, { mode: 0o700 }); protectNewDataDirectory(workspaceRoot);
          db.insertWorkspace({ id: scope.workspaceId, name: 'Upgrade fixture',
            canonicalRoot: workspaceRoot, registeredBy: 'owner' });
          db.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId,
            openedBy: 'owner', purpose: 'upgrade evidence', hostThreadId: null, state: 'open' });
          const state = join(oldData, 'state.sqlite');
          const { snapshotId } = await seedBundleProvenance(db, state,
            { ...scope, workingCopyId: 'copy-upgrade', root: workspaceRoot,
              revisionIds: ['ctx-upgrade-v1', 'ctx-upgrade-v2'] });
          const objects = new ArtifactObjects(join(oldData, 'artifact-objects'));
          const v1 = { bundleId: 'bundle-upgrade-v1', ...scope,
            contextRevision: 'ctx-upgrade-v1', snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] };
          objects.begin(v1);
          objects.putText(v1.bundleId, 'plan.md', 'Original plan', 'text/markdown', 'text_set_mcp');
          db.saveBundle({ input: v1 });
          objects.finalize(v1.bundleId, value => db.publishBundle(value));
          const v2 = { ...v1, bundleId: 'bundle-upgrade-v2', contextRevision: 'ctx-upgrade-v2',
            parentBundleId: v1.bundleId };
          objects.begin(v2);
          objects.putText(v2.bundleId, 'plan.md', 'Revised plan', 'text/markdown', 'text_set_mcp');
          db.saveBundle({ input: v2 });
          objects.finalize(v2.bundleId, value => db.publishBundle(value));
          const contexts = new ContextDecisionSqlite(state);
          try {
            const permit = (operation: string): Permit => ({ grantId: 'local-fixture', operation,
              effect: 'state_write', scope, principal: 'owner', recipient: 'owner' });
            const hash = contexts.getPublishedBundleHash(scope.workspaceId, scope.collaborationId, v2.bundleId);
            const proposal = proposeDecision({ id: 'proposal-upgrade', ...scope, snapshotId,
              contextRevisionId: 'ctx-upgrade-v2', recommendation: 'accept', reason: 'Migration fixture',
              proposedBy: 'owner', bundleId: v2.bundleId, bundleManifestHash: hash }, permit('decision.propose'));
            contexts.insertDecisionProposal(proposal, permit('decision.propose'));
            const review = contexts.insertBaselineReview({ id: 'review-upgrade', ...scope, snapshotId,
              contextRevisionId: 'ctx-upgrade-v2', proposalId: proposal.id, reviewedBy: 'owner' },
            permit('decision.review'), 'local_host');
            const decision = recordDecision({ id: 'decision-upgrade', ...scope, proposalId: proposal.id,
              snapshotId, contextRevisionId: 'ctx-upgrade-v2', reviewId: review.id, outcome: 'accept',
              reason: 'Synthetic upgrade decision', decidedBy: 'owner' }, permit('decision.record'), 'local_host');
            contexts.insertDecision(decision, permit('decision.record'), 'local_host');
          } finally { contexts.close(); }
        }
        finally { db.close(); }
      } finally { runtime.release(); }
      const archive = retainedArchive === undefined ? packCandidate(base) :
        pinRetainedInstallationArchive(retainedArchive, base, '0.1.1');
      const backup = join(base, 'complete-backup');
      const bad = join(base, 'bad.tgz'); writeFileSync(bad, Buffer.from('invalid archive'));
      await expectRefusal(upgradeInstallation(root, bad, backup), /Invalid upgrade package archive|INSTALLATION_UPGRADE_UNSAFE/);
      assert.equal(existsSync(backup), false);
      assert.deepEqual(readFileSync(join(root, 'managed.json')), oldManifest);
      const activeRuntime = acquireInstallationRuntime(root);
      try { await expectRefusal(upgradeInstallation(root, archive, backup), /MAINTENANCE_GATE_BUSY/); }
      finally { activeRuntime.release(); }
      assert.equal(existsSync(backup), false);
      const result = await upgradeInstallation(root, archive, backup);
      assert.deepEqual({ upgraded: result.upgraded, packageVersion: result.packageVersion },
        { upgraded: true, packageVersion: '0.1.1' });
      assert.notEqual(result.activeGeneration, old.activeGeneration);
      assert.equal(existsSync(result.candidateCli), true);
      assert.equal(existsSync(join(backup, 'backup.json')), true);
      const next = JSON.parse(readFileSync(join(root, 'managed.json'), 'utf8')) as
        { activeGeneration: string; packageVersion: string };
      assert.equal(next.activeGeneration, result.activeGeneration);
      assert.equal(next.packageVersion, '0.1.1');
      assert.deepEqual(readFileSync(join(oldData, 'ordinary.lock')), ordinary);
      assert.equal(existsSync(join(root, 'generations', old.activeGeneration, 'data', 'state.sqlite')), true);
      expectSyncRefusal(() => acquireInstallationRuntime(root), /INSTALLATION_UNSAFE/);
      const newData = join(root, 'generations', result.activeGeneration, 'data');
      assert.deepEqual(readFileSync(join(newData, 'ordinary.lock')), ordinary);
      const oldState = join(oldData, 'state.sqlite');
      const newState = join(newData, 'state.sqlite');
      assert.equal(existsSync(`${newState}-wal`), false, 'coordinator left a WAL sidecar');
      assert.equal(existsSync(`${newState}-shm`), false, 'coordinator left a SHM sidecar');
      const immutable = (file: string): DatabaseSync =>
        new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true });
      const oldDb = immutable(oldState);
      const newDb = immutable(newState);
      try {
        const grants = (db: DatabaseSync) => db.prepare('SELECT id, permissions_json FROM grants ORDER BY id').all();
        assert.deepEqual(grants(newDb), grants(oldDb));
        assert.equal(grants(newDb).length, 2, 'migration must preserve both grants without reseeding');
        for (const table of ['snapshots', 'context_revisions', 'bundles', 'bundle_files',
          'decision_proposals', 'baseline_reviews', 'decisions']) {
          const rows = (db: DatabaseSync) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
          assert.deepEqual(rows(newDb), rows(oldDb), `${table} lost historical rows`);
        }
        assert.equal((newDb.prepare('SELECT count(*) AS n FROM bundles').get() as { n: number }).n, 2);
        assert.equal((newDb.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }).n, 1);
      } finally { oldDb.close(); newDb.close(); }
      const stdout = runNode([result.candidateCli, '--data-dir', root, 'doctor'], repositoryRoot(), 60_000);
      const report = JSON.parse(stdout) as { schemaVersion?: unknown;
        installation?: { status?: unknown; reason?: unknown } };
      assert.equal(report.schemaVersion, 1);
      assert.deepEqual(report.installation,
        { status: 'readable', reason: 'private_database_schema_valid' });
    } catch (error) { failure = error; }
    if (failure !== undefined) throw failure; // Preserve failed or uncertain fixture for inspection.
    const root = join(base, 'installation');
    const gate = acquireExclusiveMaintenanceGate(root); gate.release();
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-upgrade-real-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
}

test('actual second-version package upgrades a managed installation and leaves the old generation and backup intact',
  { timeout: 480_000 }, () => installedUpgrade());

test('retained package upgrades a managed installation and leaves the old generation and backup intact',
  { timeout: 480_000, skip: process.env.RCAC_TEST_UPGRADE_ARCHIVE === undefined &&
    'requires an explicitly selected retained upgrade package' },
  () => installedUpgrade(process.env.RCAC_TEST_UPGRADE_ARCHIVE));

function repositoryRoot(): string { return resolve('.'); }

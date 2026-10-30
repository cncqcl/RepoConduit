import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCandidatePackage } from '../dist/src/runtime/installation-npm.js';
import { protectNewDataDirectory } from '../dist/src/runtime/local-security.js';

const parent = process.platform === 'win32' ? homedir() : tmpdir();
const base = mkdtempSync(join(parent, 'rcac-installed-upgrade-'));
let passed = false;
const run = (args, cwd, input, expected = 0) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000,
    maxBuffer: 1024 * 1024, input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true });
  if (result.error || result.signal || result.status === null) {
    throw new AggregateError([result.error ?? new Error('Child exit unconfirmed')], 'Installed upgrade child unconfirmed');
  }
  assert.equal(result.status, expected, result.stderr.slice(0, 512));
  return result.stdout;
};
const privateDirectory = path => { mkdirSync(path); protectNewDataDirectory(path); };
const imported = (root, path) => import(pathToFileURL(join(root, 'dist', 'src', path)).href);
const scope = { workspaceId: 'ws-installed-upgrade', collaborationId: 'col-installed-upgrade' };

function zip() {
  const name = Buffer.from('report.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}

async function seed(installed, root) {
  const runtimeModule = await imported(installed, 'runtime/installation.js');
  const { SqliteStore } = await imported(installed, 'adapters/storage/sqlite.js');
  const { ContextDecisionSqlite } = await imported(installed, 'adapters/storage/context-decisions-sqlite.js');
  const { ArtifactObjects } = await imported(installed, 'adapters/storage/objects.js');
  const { createSnapshotFromFiles } = await imported(installed, 'adapters/repository/snapshots.js');
  const { proposeContext, acceptContext } = await imported(installed, 'core/collaboration/context.js');
  const { proposeDecision, recordDecision } = await imported(installed, 'core/collaboration/decision.js');
  const owner = runtimeModule.acquireInstallationRuntime(root);
  const stores = [];
  let primary;
  const contents = new Map();
  try {
    const file = join(owner.dataDirectory, 'state.sqlite');
    const store = new SqliteStore(file); stores.push(store);
    const workspace = join(base, 'workspace'); privateDirectory(workspace);
    store.insertWorkspace({ id: scope.workspaceId, name: 'installed upgrade', canonicalRoot: workspace, registeredBy: 'owner' });
    store.insertWorkingCopy({ id: 'copy-upgrade', workspaceId: scope.workspaceId, canonicalRoot: workspace });
    store.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId, openedBy: 'owner',
      purpose: 'installed maintenance test', hostThreadId: null, state: 'open' });
    const principal = `${hostname()}\\${userInfo().username}`;
    store.insertGrant({ id: 'gr-installed-history', principal, audience: 'local-os', recipient: principal,
      workspaceId: scope.workspaceId, permissions: ['artifact.read', 'context.read'], expiresAt: null, revokedAt: null });
    const snapshot = createSnapshotFromFiles('copy-upgrade', 'synthetic-upgrade',
      { 'src/a.ts': Buffer.from('export const a = 1;') }).toPersisted();
    await store.saveSnapshot({ ...scope, workingCopyId: 'copy-upgrade', snapshot },
      { ...scope, workingCopyId: 'copy-upgrade', commitRef: 'synthetic-upgrade' }, 'capture', 'owner', 'local_cli');
    const contexts = new ContextDecisionSqlite(file); stores.push(contexts);
    const permit = operation => ({ grantId: 'fixture', operation, effect: 'state_write', scope, principal: 'owner', recipient: 'owner' });
    const content = { goal: 'upgrade', constraints: [], acceptedDecisions: [], rejectedDecisions: [], currentQuestions: [],
      evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] };
    const objects = new ArtifactObjects(join(owner.dataDirectory, 'artifact-objects'));
    let previous = null;
    for (const version of [1, 2]) {
      const revisionId = `ctx-upgrade-${version}`;
      const proposal = proposeContext({ id: `ctx-proposal-${version}`, ...scope, parentRevisionId: previous,
        snapshotId: snapshot.id, proposedBy: 'external', sourceRefs: ['synthetic'], content });
      contexts.insertProposal(proposal);
      contexts.insertRevision(acceptContext(proposal, revisionId, permit('context.accept'), 'local_host'), permit('context.accept'), 'local_host');
      previous = revisionId;
      const bundleId = `bundle-upgrade-${version}`;
      const files = new Map([
        ['plan.md', { bytes: Buffer.from(`Plan version ${version}\n`), mediaType: 'text/markdown' }],
        ['raw.bin', { bytes: Buffer.from([0, 255, version, 128]), mediaType: 'application/octet-stream' }],
        ['image.png', { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=', 'base64'), mediaType: 'image/png' }],
        ['files.zip', { bytes: zip(), mediaType: 'application/zip' }]
      ]);
      const input = { bundleId, ...scope, contextRevision: revisionId, snapshotRefs: [snapshot.id], expectedPaths: [...files.keys()],
        ...(version === 2 ? { parentBundleId: 'bundle-upgrade-1' } : {}) };
      objects.begin(input);
      for (const [path, file] of files) objects.putBytes(bundleId, path, file.bytes, file.mediaType, 'manual_import');
      store.saveBundle({ input }); objects.finalize(bundleId, manifest => store.publishBundle(manifest));
      contents.set(bundleId, files);
    }
    const bundleId = 'bundle-upgrade-2';
    const proposal = proposeDecision({ id: 'proposal-upgrade', ...scope, snapshotId: snapshot.id, contextRevisionId: previous,
      recommendation: 'accept', reason: 'synthetic', proposedBy: 'owner', bundleId,
      bundleManifestHash: contexts.getPublishedBundleHash(scope.workspaceId, scope.collaborationId, bundleId) }, permit('decision.propose'));
    contexts.insertDecisionProposal(proposal, permit('decision.propose'));
    const review = contexts.insertBaselineReview({ id: 'review-upgrade', ...scope, snapshotId: snapshot.id,
      contextRevisionId: previous, proposalId: proposal.id, reviewedBy: 'owner' }, permit('decision.review'), 'local_host');
    const decision = recordDecision({ id: 'decision-upgrade', ...scope, proposalId: proposal.id, snapshotId: snapshot.id,
      contextRevisionId: previous, reviewId: review.id, outcome: 'accept', reason: 'synthetic', decidedBy: 'owner' }, permit('decision.record'), 'local_host');
    contexts.insertDecision(decision, permit('decision.record'), 'local_host');
  } catch (error) { primary = error; }
  const closeErrors = [];
  for (const store of stores.reverse()) { try { store.close(); } catch (error) { closeErrors.push(error); } }
  if (closeErrors.length || primary instanceof AggregateError) {
    runtimeModule.retainInstallationRuntime(owner);
    throw new AggregateError(primary === undefined ? closeErrors : [primary, ...closeErrors], 'Fixture stores close unconfirmed');
  }
  try { owner.release(); } catch (error) { runtimeModule.retainInstallationRuntime(owner); throw error; }
  if (primary !== undefined) throw primary;
  return contents;
}

try {
  protectNewDataDirectory(base);
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const archives = new Map();
  console.log('installed upgrade: packing actual compiled versions 0.1.0 and 0.1.1');
  for (const version of ['0.1.0', '0.1.1']) {
    const staging = join(base, `staging-${version}`); privateDirectory(staging);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    pkg.version = version; lock.version = version; lock.packages[''].version = version;
    pkg.files = ['npm-shrinkwrap.json', 'dist/src', 'dist/contracts'];
    writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(staging, 'package-lock.json'), JSON.stringify(lock));
    cpSync(resolve('dist'), join(staging, 'dist'), { recursive: true });
    run([resolve('tools/prepare-installation-package.mjs'), staging], resolve('.'));
    const packed = JSON.parse(run([npm, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', base], staging));
    assert.equal(packed[0].filename, `repo-conduit-${version}.tgz`);
    archives.set(version, { path: join(base, packed[0].filename), integrity: packed[0].integrity });
  }
  const prefix = join(base, 'old-installed'); privateDirectory(prefix);
  await installCandidatePackage(archives.get('0.1.0').path, prefix);
  const installed = join(prefix, 'node_modules', 'repo-conduit');
  const oldCli = join(installed, 'dist', 'src', 'cli', 'main.js');
  const root = join(base, 'installation');
  assert.equal(JSON.parse(run([oldCli, '--data-dir', root, 'init-managed'], base)).initialized, true);
  console.log('installed upgrade: seeding v1/v2 four-format original bytes and a reviewed decision through installed modules');
  const contents = await seed(installed, root);
  const request = (cli, operation, payload) => JSON.parse(run([cli, '--data-dir', root, 'request'], base, { operation, scope, payload }));
  const oldDecision = request(oldCli, 'decision.get', { decisionId: 'decision-upgrade' });
  const oldManifest = readFileSync(join(root, 'managed.json'));
  console.log('installed upgrade: old installed CLI performs real candidate install, migration and activation');
  const backup = join(base, 'backup');
  const result = JSON.parse(run([oldCli, '--data-dir', root, 'upgrade', '--package', archives.get('0.1.1').path, '--backup', backup], base));
  assert.equal(result.upgraded, true); assert.equal(result.packageVersion, '0.1.1');
  run([oldCli, '--data-dir', root, 'doctor'], base, undefined, 1);
  assert.equal(JSON.parse(run([result.candidateCli, '--data-dir', root, 'doctor'], base)).installation.status, 'readable');
  assert.deepEqual(request(result.candidateCli, 'decision.get', { decisionId: 'decision-upgrade' }), oldDecision);
  const newInstalled = dirname(dirname(dirname(dirname(result.candidateCli))));
  const { ArtifactObjects } = await imported(newInstalled, 'adapters/storage/objects.js');
  const manifest = JSON.parse(readFileSync(join(root, 'managed.json')));
  const objects = new ArtifactObjects(join(root, 'generations', manifest.activeGeneration, 'data', 'artifact-objects'));
  for (const [bundleId, files] of contents) {
    const inspection = request(result.candidateCli, 'artifact.inspect', { bundleId });
    assert.equal(inspection.integrityStatus, 'ok'); assert.equal(inspection.manifest.files.length, 4);
    for (const [path, file] of files) assert.deepEqual(objects.readFile(bundleId, path), file.bytes);
  }
  const oldGeneration = JSON.parse(oldManifest).activeGeneration;
  assert.ok(readFileSync(join(root, 'generations', oldGeneration, 'data', 'state.sqlite')).length);
  const runtimeModule = await imported(newInstalled, 'runtime/installation.js');
  const owner = runtimeModule.acquireInstallationMaintenance(root);
  try { owner.release(); }
  catch (error) { runtimeModule.retainInstallationMaintenance(owner); throw error; }
  console.log(JSON.stringify({ case: 'installed_cli_different_version_upgrade', passed: true, fromVersion: '0.1.0',
    toVersion: '0.1.1', oldPackageIntegrity: archives.get('0.1.0').integrity,
    candidatePackageIntegrity: archives.get('0.1.1').integrity,
    candidateArchiveSha256: createHash('sha256').update(readFileSync(archives.get('0.1.1').path)).digest('hex'),
    originalByteFilesPreserved: 8, reviewedDecisionPreserved: true, oldCliRejected: true, newCliHistoryRead: true }));
  passed = true;
} finally {
  if (passed) {
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-installed-upgrade-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true });
  } else console.error('Failed or uncertain installed upgrade fixture retained:', base);
}

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { proposeDecision, recordDecision } from '../../src/core/collaboration/decision.js';
import type { Permit } from '../../src/core/policy/authorize.js';
import { acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { installCandidatePackage } from '../../src/runtime/installation-npm.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';
import { pinRetainedInstallationArchive } from '../support/retained-installation-archive.js';
import { createInstallationTestDiagnostics } from '../support/installation-test-diagnostics.js';

type Phase = 'after_backup_first_data_write' | 'after_candidate_first_data_write' |
  'before_npm_spawn' | 'before_migration_spawn' | 'before_manifest_rename' | 'after_manifest_rename';
type Observation = { phase: Phase; active: number; started: Array<{ kind: string; pid: number }>;
  closed: Array<{ kind: string; pid: number; code: number | null; signal: string | null }>;
  writeBytes?: number };
const phases: Phase[] = ['after_backup_first_data_write', 'after_candidate_first_data_write',
  'before_npm_spawn', 'before_migration_spawn',
  'before_manifest_rename', 'after_manifest_rename'];
if (process.env.npm_lifecycle_event === 'test' && Object.hasOwn(process.env, 'RCAC_CRASH_PHASE'))
  throw new Error('RCAC_CRASH_PHASE must not filter npm test');
const requestedPhases = process.env.RCAC_CRASH_PHASE?.split(',');
const selectedPhases = requestedPhases ? phases.filter(phase => requestedPhases.includes(phase)) : phases;
if (selectedPhases.length === 0 || (requestedPhases && selectedPhases.length !== requestedPhases.length))
  throw new Error('Unknown test-only crash phase');
const repo = resolve('.');
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function node(args: string[], cwd: string, input?: unknown, timeout = 120_000): string {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout,
    maxBuffer: 1024 * 1024, input: input === undefined ? undefined : JSON.stringify(input) });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `node ${args.slice(0, 3).join(' ')}: ${result.stderr.slice(0, 800)}`);
  return result.stdout;
}
function cli(entry: string, root: string, action: 'doctor' | 'request', input?: unknown): Record<string, unknown> {
  return JSON.parse(node([entry, '--data-dir', root, action], repo, input, 60_000)) as Record<string, unknown>;
}
function history(entry: string, root: string): void {
  const scope = { workspaceId: 'ws-crash', collaborationId: 'col-crash' };
  const request = (operation: string, payload: object): Record<string, unknown> =>
    cli(entry, root, 'request', { operation, scope, payload });
  const bundle = request('artifact.inspect', { bundleId: 'bundle-crash-v2' });
  assert.equal(bundle.integrityStatus, 'ok');
  assert.equal(bundle.ready, true);
  const decision = request('decision.get', { decisionId: 'decision-crash' });
  assert.equal(decision.id, 'decision-crash');
  const list = request('decision.list', { limit: 10 });
  assert.match(JSON.stringify(list), /decision-crash/);
}
function pack(base: string, version: '0.1.0' | '0.1.1'): string {
  const staging = join(base, `staging-${version}`);
  mkdirSync(staging, { mode: 0o700 }); protectNewDataDirectory(staging);
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Record<string, unknown>;
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as
    { version: string; packages: Record<string, Record<string, unknown>> };
  assert.equal(pkg.version, '0.1.0');
  pkg.version = version; lock.version = version; lock.packages['']!.version = version;
  pkg.files = ['npm-shrinkwrap.json', 'dist/src', 'dist/contracts'];
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(staging, 'package-lock.json'), JSON.stringify(lock, null, 2));
  cpSync(join(repo, 'dist', 'src'), join(staging, 'dist', 'src'), { recursive: true });
  cpSync(join(repo, 'dist', 'contracts'), join(staging, 'dist', 'contracts'), { recursive: true });
  node([join(repo, 'tools', 'prepare-installation-package.mjs'), staging], repo);
  const packed = JSON.parse(node([npmCli, 'pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', base], staging)) as Array<{ filename: string }>;
  assert.equal(packed.length, 1);
  assert.equal(packed[0]!.filename, `repo-conduit-${version}.tgz`);
  return join(base, packed[0]!.filename);
}
async function installOld(base: string, archive: string): Promise<string> {
  const prefix = join(base, 'old-installed');
  mkdirSync(prefix, { mode: 0o700 }); protectNewDataDirectory(prefix);
  await installCandidatePackage(archive, prefix);
  const entry = join(prefix, 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js');
  assert.equal(existsSync(entry), true);
  return entry;
}
function copyBytes(): Buffer {
  return Buffer.from(Array.from({ length: 128 * 1024 + 17 }, (_, index) => index % 251));
}
async function seed(root: string, base: string, stageIncomplete = false, copyInterrupt = false): Promise<{
  oldManifest: Buffer; oldGeneration: string; sentinel: Buffer; copyFile?: Buffer }> {
  const oldManifest = readFileSync(join(root, 'managed.json'));
  const oldGeneration = (JSON.parse(oldManifest.toString('utf8')) as { activeGeneration: string }).activeGeneration;
  const oldData = join(root, 'generations', oldGeneration, 'data');
  const sentinel = Buffer.from([0, 255, 128, 13, 10, 1]);
  writeFileSync(join(oldData, 'sentinel.bin'), sentinel);
  const copyFile = copyInterrupt ? copyBytes() : undefined;
  if (copyFile) writeFileSync(join(oldData, 'copy-interruption.bin'), copyFile);
  const workspaceRoot = join(base, 'workspace');
  mkdirSync(workspaceRoot, { mode: 0o700 }); protectNewDataDirectory(workspaceRoot);
  writeFileSync(join(workspaceRoot, 'source-sentinel.txt'), 'SOURCE_SENTINEL_CRASH_MATRIX');
  const state = join(oldData, 'state.sqlite');
  const db = new SqliteStore(state);
  try {
    const principal = `${hostname()}\\${userInfo().username}`;
    db.insertGrant({ id: 'grant-crash-history', principal, audience: 'local-os', recipient: principal,
      workspaceId: 'ws-crash', collaborationId: 'col-crash',
      permissions: ['artifact.read', 'context.read'], expiresAt: null, revokedAt: null });
    const scope = { workspaceId: 'ws-crash', collaborationId: 'col-crash' };
    db.insertWorkspace({ id: scope.workspaceId, name: 'Crash fixture', canonicalRoot: workspaceRoot,
      registeredBy: 'owner' });
    db.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId,
      openedBy: 'owner', purpose: 'crash upgrade', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(db, state,
      { ...scope, workingCopyId: 'copy-crash', root: workspaceRoot,
        revisionIds: ['ctx-crash-v1', 'ctx-crash-v2'] });
    const objects = new ArtifactObjects(join(oldData, 'artifact-objects'));
    const first = { bundleId: 'bundle-crash-v1', ...scope, contextRevision: 'ctx-crash-v1',
      snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] };
    objects.begin(first);
    objects.putText(first.bundleId, 'plan.md', 'First plan', 'text/markdown', 'text_set_mcp');
    db.saveBundle({ input: first });
    objects.finalize(first.bundleId, value => db.publishBundle(value));
    const second = { ...first, bundleId: 'bundle-crash-v2', contextRevision: 'ctx-crash-v2',
      parentBundleId: first.bundleId };
    objects.begin(second);
    objects.putText(second.bundleId, 'plan.md', 'Second plan', 'text/markdown', 'text_set_mcp');
    db.saveBundle({ input: second });
    objects.finalize(second.bundleId, value => db.publishBundle(value));
    if (stageIncomplete) {
      const staged = { ...second, bundleId: 'bundle-crash-staging', parentBundleId: second.bundleId };
      objects.begin(staged);
      db.saveBundle({ input: staged });
    }
    const contexts = new ContextDecisionSqlite(state);
    try {
      const permit = (operation: string): Permit => ({ grantId: 'fixture', operation,
        effect: 'state_write', scope, principal: 'owner', recipient: 'owner' });
      const hash = contexts.getPublishedBundleHash(scope.workspaceId, scope.collaborationId, second.bundleId);
      const proposal = proposeDecision({ id: 'proposal-crash', ...scope, snapshotId,
        contextRevisionId: 'ctx-crash-v2', recommendation: 'accept', reason: 'Crash fixture',
        proposedBy: 'owner', bundleId: second.bundleId, bundleManifestHash: hash }, permit('decision.propose'));
      contexts.insertDecisionProposal(proposal, permit('decision.propose'));
      const review = contexts.insertBaselineReview({ id: 'review-crash', ...scope, snapshotId,
        contextRevisionId: 'ctx-crash-v2', proposalId: proposal.id, reviewedBy: 'owner' },
      permit('decision.review'), 'local_host');
      const decision = recordDecision({ id: 'decision-crash', ...scope, proposalId: proposal.id,
        snapshotId, contextRevisionId: 'ctx-crash-v2', reviewId: review.id, outcome: 'accept',
        reason: 'Crash fixture', decidedBy: 'owner' }, permit('decision.record'), 'local_host');
      contexts.insertDecision(decision, permit('decision.record'), 'local_host');
    } finally { contexts.close(); }
  } finally { db.close(); }
  return { oldManifest, oldGeneration, sentinel, ...(copyFile ? { copyFile } : {}) };
}
function assertStaging(root: string, generation: string): void {
  const db = new DatabaseSync(join(root, 'generations', generation, 'data', 'state.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT manifest_json, published_seq, integrity_status FROM bundles WHERE id=?')
      .get('bundle-crash-staging') as Record<string, unknown>;
    assert.equal(row.manifest_json, null);
    assert.equal(row.published_seq, null);
    assert.equal(row.integrity_status, null);
  } finally { db.close(); }
}

async function finishCoordinator(child: ReturnType<typeof spawn>,
  close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  safeObservation: () => Observation | undefined, closeTimeout = 135_000): Promise<void> {
  if (safeObservation() && child.exitCode === null && child.signalCode === null)
    assert.equal(child.kill(), true, 'owned coordinator kill unconfirmed');
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([close, new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(`Owned coordinator close unconfirmed: ${child.pid}`)),
        safeObservation() ? 10_000 : closeTimeout);
    })]);
    if (safeObservation()) assert.ok(result.signal !== null || result.code !== 0, 'coordinator unexpectedly completed');
  } catch (error) {
    // Unknown in-flight descendants are preserved for investigation; detach only our pipes.
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
function safeClosedHook(value: unknown, phase: Phase): value is Observation {
  if (typeof value !== 'object' || value === null) return false;
  const hook = value as Partial<Observation>;
  const expectedKinds = phase === 'before_migration_spawn' ? ['npm'] :
    phase === 'before_manifest_rename' || phase === 'after_manifest_rename' ? ['npm', 'migration'] : [];
  return hook.phase === phase && hook.active === 0 && Array.isArray(hook.started) &&
    Array.isArray(hook.closed) && hook.started.length === hook.closed.length &&
    hook.started.map(item => item.kind).join(',') === expectedKinds.join(',') &&
    hook.closed.every((item, index) => item.kind === hook.started![index]?.kind &&
      item.pid === hook.started![index]?.pid && item.code === 0 && item.signal === null) &&
    (phase !== 'after_backup_first_data_write' && phase !== 'after_candidate_first_data_write' ||
      typeof hook.writeBytes === 'number' && hook.writeBytes > 0 && hook.writeBytes <= 64 * 1024);
}
async function observeAndKill(child: ReturnType<typeof spawn>, phase: Phase,
  hookTimeout = 120_000, closeTimeout = 135_000,
  onCleanupStarted?: () => void): Promise<Observation> {
  const trace = createInstallationTestDiagnostics('installation-upgrade-crash', `${phase}:${child.pid}`);
  trace.event('coordinator.observe.begin', { coordinatorPid: child.pid, phase, hookTimeout, closeTimeout });
  let output = '', errors = '';
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (part: string) => { errors = (errors + part).slice(-8192); });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    child.once('error', error => { trace.failure('coordinator.spawn', error); rejectClose(error); });
    child.once('close', (code, signal) => {
      trace.event('coordinator.close', { coordinatorPid: child.pid, phase, code, signal });
      resolveClose({ code, signal });
    });
  });
  let timer: NodeJS.Timeout | undefined;
  let observation: Observation | undefined;
  let safeObservation: Observation | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  let cleanupActive = false;
  let lateKillUnconfirmed = false;
  try {
    observation = await Promise.race([new Promise<Observation>((resolveObserved, rejectObserved) => {
      child.stdout!.on('data', (part: string) => {
        output += part;
        if (output.length > 8192) { rejectObserved(new Error('Coordinator observation output limit')); return; }
        for (let newline = output.indexOf('\n'); newline !== -1; newline = output.indexOf('\n')) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (line.startsWith('RCAC_CRASH_HOOK:')) {
            try {
              const parsed: unknown = JSON.parse(line.slice('RCAC_CRASH_HOOK:'.length));
              trace.event('coordinator.hook', { coordinatorPid: child.pid, phase,
                safeClosedHook: safeClosedHook(parsed, phase) });
              if (safeClosedHook(parsed, phase)) {
                safeObservation = parsed;
                if (cleanupActive && child.exitCode === null && child.signalCode === null)
                  lateKillUnconfirmed = !child.kill();
              }
              resolveObserved(parsed as Observation);
            }
            catch (error) { rejectObserved(error); }
          }
        }
      });
      void close.then(value => rejectObserved(new Error(`Coordinator exited before hook: ${JSON.stringify(value)} ${errors} ${output}`)), rejectObserved);
    }), new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(`Coordinator hook timeout ${phase}: ${errors} ${output}`)), hookTimeout);
    })]);
    assert.equal(observation.phase, phase);
    assert.equal(observation.active, 0, 'cannot kill coordinator with a live spawned worker');
    assert.equal(observation.started.length, observation.closed.length);
    assert.deepEqual(observation.started.map(item => item.kind),
      phase === 'after_backup_first_data_write' || phase === 'after_candidate_first_data_write' ||
        phase === 'before_npm_spawn' ? [] : phase === 'before_migration_spawn' ? ['npm'] : ['npm', 'migration']);
    if (phase === 'after_backup_first_data_write' || phase === 'after_candidate_first_data_write')
      assert.ok(typeof observation.writeBytes === 'number' && observation.writeBytes > 0 &&
        observation.writeBytes <= 64 * 1024, 'pause did not follow the first actual data write');
    assert.ok(observation.closed.every(item => item.code === 0 && item.signal === null));
  } catch (error) { primaryError = error; trace.failure('coordinator.observe', error); }
  finally {
    if (timer) clearTimeout(timer);
    cleanupActive = true;
    try {
      onCleanupStarted?.();
      await finishCoordinator(child, close, () => safeObservation, closeTimeout);
      assert.equal(lateKillUnconfirmed, false, 'late owned coordinator kill unconfirmed');
    }
    catch (error) { cleanupError = error; trace.failure('coordinator.cleanup', error); }
    finally { cleanupActive = false; }
  }
  trace.event('coordinator.observe.end', { coordinatorPid: child.pid, phase,
    safeClosedHook: safeObservation !== undefined, primaryFailed: primaryError !== undefined,
    cleanupFailed: cleanupError !== undefined });
  if (primaryError !== undefined && cleanupError !== undefined)
    throw new AggregateError([primaryError, cleanupError], 'Crash hook and coordinator cleanup failed',
      { cause: primaryError });
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return observation!;
}
async function pauseAndKill(phase: Phase, oldCli: string, root: string, archive: string, backup: string): Promise<Observation> {
  const helper = join(repo, 'tests', 'support', 'installation-upgrade-crash-child.mjs');
  const child = spawn(process.execPath, [helper, phase, oldCli, root, archive, backup],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return observeAndKill(child, phase);
}

test('crash fixture keeps the hook timeout after a late closed-worker hook permits cleanup', async () => {
  const phase: Phase = 'before_npm_spawn';
  const fake = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough;
    exitCode: number | null; signalCode: NodeJS.Signals | null; pid: number; kill: () => boolean;
    unref: () => void };
  fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.exitCode = null; fake.signalCode = null; fake.pid = 123;
  let killed = 0;
  fake.kill = () => {
    killed++;
    fake.signalCode = 'SIGTERM';
    queueMicrotask(() => fake.emit('close', null, 'SIGTERM'));
    return true;
  };
  fake.unref = () => {};
  // Arm the synthetic late hook at cleanup, after diagnostic setup and timeout.
  const lateHook = () => fake.stdout.write(`RCAC_CRASH_HOOK:${JSON.stringify({ phase, active: 0,
    started: [], closed: [] })}\n`);
  await assert.rejects(observeAndKill(fake as unknown as ReturnType<typeof spawn>, phase, 5, 80, lateHook),
    /Coordinator hook timeout before_npm_spawn/);
  assert.equal(killed, 1);
});

test('crash fixture retains both errors and never kills an unknown or live worker', async () => {
  for (const hook of [{ phase: 'before_npm_spawn', active: 1, started: [], closed: [] },
    { phase: 'wrong-phase', active: 0, started: [], closed: [] }]) {
    const fake = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough;
      exitCode: number | null; signalCode: NodeJS.Signals | null; pid: number; kill: () => boolean;
      unref: () => void };
    fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
    fake.exitCode = null; fake.signalCode = null; fake.pid = 124;
    let killed = 0, detached = 0;
    fake.kill = () => { killed++; return true; };
    fake.unref = () => { detached++; };
    const lateHook = () => fake.stdout.write(`RCAC_CRASH_HOOK:${JSON.stringify(hook)}\n`);
    await assert.rejects(observeAndKill(fake as unknown as ReturnType<typeof spawn>,
      'before_npm_spawn', 5, 40, lateHook), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /Coordinator hook timeout/);
      assert.match(String(error.errors[1]), /Owned coordinator close unconfirmed/);
      return true;
    });
    assert.equal(killed, 0);
    assert.equal(detached, 1);
  }
});

async function installedCrashRecovery(t: TestContext,
  archives?: { old: string; candidate: string }): Promise<void> {
    const parent = process.platform === 'win32' ? homedir() : tmpdir();
    const base = mkdtempSync(join(parent, 'rcac-upgrade-crash-'));
    const trace = createInstallationTestDiagnostics('installation-upgrade-crash', base);
    let stage = 'fixture.protect';
    const begin = (value: string): void => { stage = value; trace.event(`${value}.begin`); };
    try {
      begin('fixture.protect');
      protectNewDataDirectory(base);
      trace.event('fixture.protect.end');
      begin('fixture.pack');
      if (archives === undefined) node([join(repo, 'node_modules', 'typescript', 'bin', 'tsc')], repo);
      const oldArchive = archives === undefined ? pack(base, '0.1.0') :
        pinRetainedInstallationArchive(archives.old, base, '0.1.0');
      const candidateArchive = archives === undefined ? pack(base, '0.1.1') :
        pinRetainedInstallationArchive(archives.candidate, base, '0.1.1');
      trace.event('fixture.pack.end');
      t.diagnostic(`selected crash phases: ${selectedPhases.join(',')}`);
      begin('fixture.install-old');
      const oldCli = await installOld(base, oldArchive);
      trace.event('fixture.install-old.end');
      t.signal.throwIfAborted();
      begin('fixture.staging-refusal');
      const refusalBase = join(base, 'staging-refusal');
      mkdirSync(refusalBase, { mode: 0o700 }); protectNewDataDirectory(refusalBase);
      const refusalRoot = join(refusalBase, 'installation');
      node([oldCli, '--data-dir', refusalRoot, 'init-managed'], repo);
      const refusalSeed = await seed(refusalRoot, refusalBase, true);
      t.signal.throwIfAborted();
      const refusalState = join(refusalRoot, 'generations', refusalSeed.oldGeneration, 'data', 'state.sqlite');
      const refusalStateBytes = readFileSync(refusalState);
      const refusalBackup = join(refusalBase, 'backup');
      assertStaging(refusalRoot, refusalSeed.oldGeneration);
      const stagingRefusal = spawnSync(process.execPath, [oldCli, '--data-dir', refusalRoot, 'upgrade',
        '--package', candidateArchive, '--backup', refusalBackup],
      { cwd: repo, encoding: 'utf8', timeout: 60_000 });
      if (stagingRefusal.error) throw stagingRefusal.error;
      assert.equal(stagingRefusal.status, 1, 'upgrade silently accepted an unfinished bundle');
      assert.deepEqual(readFileSync(join(refusalRoot, 'managed.json')), refusalSeed.oldManifest);
      assert.deepEqual(readFileSync(refusalState), refusalStateBytes);
      assert.equal(existsSync(refusalBackup), false);
      assertStaging(refusalRoot, refusalSeed.oldGeneration);
      assert.deepEqual(readdirSync(join(refusalRoot, 'generations')), [refusalSeed.oldGeneration]);
      t.diagnostic('staging_refusal: preflight rejected without activation or backup');
      trace.event('fixture.staging-refusal.end');
      for (const phase of selectedPhases) {
        t.signal.throwIfAborted();
        const started = Date.now();
        t.diagnostic(`${phase}: fixture start`);
        begin(`${phase}.initialize`);
        const caseBase = join(base, phase);
        mkdirSync(caseBase, { mode: 0o700 }); protectNewDataDirectory(caseBase);
        const root = join(caseBase, 'installation');
        node([oldCli, '--data-dir', root, 'init-managed'], repo);
        const early = phase === 'after_backup_first_data_write' || phase === 'after_candidate_first_data_write';
        const { oldManifest, oldGeneration, sentinel, copyFile } = await seed(root, caseBase, false, early);
        trace.event(`${phase}.initialize.end`);
        t.signal.throwIfAborted();
        begin(`${phase}.history`);
        history(oldCli, root);
        trace.event(`${phase}.history.end`);
        const oldStateBytes = readFileSync(join(root, 'generations', oldGeneration, 'data', 'state.sqlite'));
        const backup = join(caseBase, 'backup');
        t.signal.throwIfAborted();
        begin(`${phase}.observe-hook`);
        const observed = await pauseAndKill(phase, oldCli, root, candidateArchive, backup);
        trace.event(`${phase}.observe-hook.end`);
        // pauseAndKill closes its own coordinator before returning. A timed-out
        // test must retain that boundary and never start another crash phase.
        t.signal.throwIfAborted();
        begin(`${phase}.verify-recovery`);
        if (early) {
          assert.ok(copyFile);
          assert.deepEqual(readFileSync(join(root, 'managed.json')), oldManifest);
          assert.deepEqual(readFileSync(join(root, 'generations', oldGeneration, 'data', 'state.sqlite')), oldStateBytes);
          assert.deepEqual(readFileSync(join(root, 'generations', oldGeneration, 'data', 'copy-interruption.bin')), copyFile);
          assert.deepEqual(readFileSync(join(root, 'generations', oldGeneration, 'data', 'sentinel.bin')), sentinel);
          assert.equal(readFileSync(join(caseBase, 'workspace', 'source-sentinel.txt'), 'utf8'),
            'SOURCE_SENTINEL_CRASH_MATRIX');
          const generations = readdirSync(join(root, 'generations')).filter(name => name !== oldGeneration);
          const candidateCopy = phase === 'after_candidate_first_data_write';
          assert.equal(generations.length, candidateCopy ? 1 : 0);
          assert.equal(existsSync(join(backup, 'backup.json')), candidateCopy);
          const assertEarlyMarkers = (): void => {
            const currentGenerations = readdirSync(join(root, 'generations')).filter(name => name !== oldGeneration);
            assert.equal(currentGenerations.length, candidateCopy ? 1 : 0);
            assert.equal(existsSync(join(backup, 'backup.json')), candidateCopy);
            assert.equal(existsSync(join(backup, 'backup.json.pending')), false);
            assert.deepEqual(readdirSync(root).filter(name =>
              name.startsWith('managed.json.upgrade-') && name.endsWith('.pending')), []);
            if (candidateCopy) {
              const candidate = join(root, 'generations', currentGenerations[0]!);
              for (const name of ['package', 'candidate.tgz', 'upgrade-complete.json'])
                assert.equal(existsSync(join(candidate, name)), false, `${phase}: unexpected ${name}`);
            }
          };
          assertEarlyMarkers();
          const partialPath = candidateCopy ?
            join(root, 'generations', generations[0]!, 'data', 'copy-interruption.bin') :
            join(backup, 'data', 'copy-interruption.bin');
          const partial = readFileSync(partialPath);
          assert.equal(partial.length, observed.writeBytes);
          assert.ok(partial.length > 0 && partial.length < copyFile.length);
          assert.deepEqual(partial, copyFile.subarray(0, partial.length));
          if (candidateCopy) {
            assert.deepEqual(readFileSync(join(backup, 'data', 'copy-interruption.bin')), copyFile);
            const completedBackup = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8')) as
              { dataset: string; entries: Array<{ path: string; size: number; sha256?: string }> };
            assert.equal(completedBackup.dataset, 'active_generation');
            assert.deepEqual(completedBackup.entries.find(entry => entry.path === 'copy-interruption.bin'),
              { path: 'copy-interruption.bin', kind: 'file', size: copyFile.length,
                sha256: createHash('sha256').update(copyFile).digest('hex') });
          }
          const backupManifest = candidateCopy ? readFileSync(join(backup, 'backup.json')) : undefined;
          const gate = acquireExclusiveMaintenanceGate(root); gate.release();
          history(oldCli, root);
          assert.deepEqual(readFileSync(join(root, 'managed.json')), oldManifest);
          assert.deepEqual(readFileSync(partialPath), partial);
          assert.equal(existsSync(join(backup, 'backup.json')), candidateCopy);
          assertEarlyMarkers();
          const retry = spawnSync(process.execPath, [oldCli, '--data-dir', root, 'upgrade',
            '--package', candidateArchive, '--backup', backup],
          { cwd: repo, encoding: 'utf8', timeout: 60_000 });
          if (retry.error) throw retry.error;
          assert.equal(retry.status, 1, 'retry with retained partial backup unexpectedly succeeded');
          assert.deepEqual(readFileSync(join(root, 'managed.json')), oldManifest);
          assert.deepEqual(readFileSync(partialPath), partial);
          if (backupManifest) assert.deepEqual(readFileSync(join(backup, 'backup.json')), backupManifest);
          assert.equal(readdirSync(join(root, 'generations')).filter(name => name !== oldGeneration).length,
            candidateCopy ? 1 : 0);
          assertEarlyMarkers();
          t.diagnostic(`${phase}: observed and recovery checked in ${Date.now() - started} ms`);
          trace.event(`${phase}.verify-recovery.end`, { phaseElapsedMs: Date.now() - started });
          continue;
        }
        const current = readFileSync(join(root, 'managed.json'));
        const activated = phase === 'after_manifest_rename';
        assert.equal(current.equals(oldManifest), !activated, `${phase}: manifest activation mismatch`);
        const manifest = JSON.parse(current.toString('utf8')) as { activeGeneration: string; packageVersion: string };
        assert.equal(manifest.packageVersion, activated ? '0.1.1' : '0.1.0');
        assert.deepEqual(readFileSync(join(root, 'generations', oldGeneration, 'data', 'sentinel.bin')), sentinel);
        assert.equal(readFileSync(join(caseBase, 'workspace', 'source-sentinel.txt'), 'utf8'),
          'SOURCE_SENTINEL_CRASH_MATRIX');
        assert.equal(existsSync(join(backup, 'backup.json')), true);
        const backupManifest = readFileSync(join(backup, 'backup.json'));
        assert.deepEqual(readFileSync(join(backup, 'data', 'sentinel.bin')), sentinel);
        const candidates = readdirSync(join(root, 'generations')).filter(name => name !== oldGeneration);
        assert.equal(candidates.length, 1, `${phase}: expected one retained candidate`);
        const candidate = join(root, 'generations', candidates[0]!);
        assert.deepEqual(readFileSync(join(candidate, 'data', 'sentinel.bin')), sentinel);
        assert.equal(existsSync(join(candidate, 'candidate.tgz')), true);
        assert.equal(existsSync(join(candidate, 'upgrade-complete.json')),
          phase === 'before_manifest_rename' || activated);
        assert.equal(existsSync(join(candidate, 'package', 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js')),
          phase !== 'before_npm_spawn');
        const pending = readdirSync(root).filter(name => name.startsWith('managed.json.upgrade-') && name.endsWith('.pending'));
        assert.equal(pending.length, phase === 'before_manifest_rename' ? 1 : 0);
        if (pending.length) {
          const next = JSON.parse(readFileSync(join(root, pending[0]!), 'utf8')) as { packageVersion: string };
          assert.equal(next.packageVersion, '0.1.1');
        }
        const gate = acquireExclusiveMaintenanceGate(root); gate.release();
        if (!activated) {
          history(oldCli, root);
          assert.deepEqual(readFileSync(join(root, 'managed.json')), oldManifest,
            `${phase}: restart activated a partial candidate`);
          assert.equal(existsSync(candidate), true, 'restart removed retained candidate');
          const retry = spawnSync(process.execPath, [oldCli, '--data-dir', root, 'upgrade',
            '--package', candidateArchive, '--backup', backup],
          { cwd: repo, encoding: 'utf8', timeout: 60_000 });
          if (retry.error) throw retry.error;
          assert.equal(retry.status, 1, 'retry with retained backup unexpectedly succeeded');
          assert.deepEqual(readFileSync(join(root, 'managed.json')), oldManifest);
          assert.deepEqual(readFileSync(join(backup, 'backup.json')), backupManifest);
          assert.equal(existsSync(candidate), true);
          assert.deepEqual(readdirSync(root).filter(name => name.startsWith('managed.json.upgrade-') && name.endsWith('.pending')), pending);
        } else {
          const candidateCli = join(candidate, 'package', 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js');
          assert.deepEqual((cli(candidateCli, root, 'doctor').installation as object),
            { status: 'readable', reason: 'private_database_schema_valid' });
          history(candidateCli, root);
          const oldResult = spawnSync(process.execPath, [oldCli, '--data-dir', root, 'doctor'],
            { cwd: repo, encoding: 'utf8', timeout: 60_000 });
          assert.equal(oldResult.status, 1, `old CLI opened postactivation: ${oldResult.stdout}`);
          assert.deepEqual(readFileSync(join(root, 'managed.json')), current);
        }
        // Existing backup destination is deliberately retained; no automatic replay may overwrite it.
        assert.equal(observed.active, 0);
        t.diagnostic(`${phase}: observed and recovery checked in ${Date.now() - started} ms`);
        trace.event(`${phase}.verify-recovery.end`, { phaseElapsedMs: Date.now() - started });
      }
      t.signal.throwIfAborted();
    } catch (error) {
      trace.failure(stage, error);
      trace.event('fixture.retained', { aborted: t.signal.aborted });
      try { process.stderr.write(`Retained crash fixture: ${base}\n`); } catch { /* Retain the primary error. */ }
      throw error;
    }
    if (!t.signal.aborted) {
      try {
        trace.event('fixture.cleanup.begin');
        assert.match(relative(resolve(parent), resolve(base)), /^rcac-upgrade-crash-[A-Za-z0-9_-]{6}$/);
        rmSync(base, { recursive: true, force: true });
        trace.event('fixture.cleanup.end');
      } catch (error) { trace.failure('fixture.cleanup', error); throw error; }
    } else {
      trace.event('fixture.retained', { aborted: t.signal.aborted });
      try { process.stderr.write(`Retained crash fixture: ${base}\n`); } catch { /* No error may be replaced. */ }
    }
}

// On Windows the observed first four phases take 103–111s each, before
// packing/setup and the last two phases. This bounds the test, not the product.
const crashMatrixTimeoutMs = process.platform === 'win32' ? 1_200_000 : 480_000;
test('real packed managed upgrade survives six coordinator deaths at closed-worker boundaries',
  { timeout: crashMatrixTimeoutMs }, t => installedCrashRecovery(t));

test('retained packages managed upgrade preserves selected crash boundaries',
  { timeout: crashMatrixTimeoutMs, skip: process.env.RCAC_TEST_INSTALLED_ARCHIVE === undefined &&
    process.env.RCAC_TEST_UPGRADE_ARCHIVE === undefined && 'requires explicitly selected retained packages' }, t => {
    const old = process.env.RCAC_TEST_INSTALLED_ARCHIVE, candidate = process.env.RCAC_TEST_UPGRADE_ARCHIVE;
    assert.ok(old && candidate, 'both retained versions are required');
    return installedCrashRecovery(t, { old, candidate });
  });

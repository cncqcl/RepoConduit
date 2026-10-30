import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { initializeMaintenanceGate, acquireRuntimeMaintenanceGate,
  acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { assertPrivateDataDirectory, assertPrivateInstallationDirectory,
  protectNewDataDirectory } from '../../src/runtime/local-security.js';

async function fixture(run: (root: string, retain: () => void) => void | Promise<void>): Promise<void> {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-gate-'));
  let primary: unknown;
  let cleanup: unknown;
  let keep = false;
  try {
    protectNewDataDirectory(root);
    await run(root, () => { keep = true; });
  } catch (error) { primary = error; }
  finally {
    if (!keep) {
      try {
        const child = relative(resolve(base), resolve(root));
        assert.ok(child.startsWith('rcac-gate-') && !child.includes('..') && !child.includes('\\'));
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (error) { cleanup = error; }
    }
  }
  if (primary && cleanup) throw new AggregateError([primary, cleanup], 'Gate test and cleanup failed');
  if (primary) throw primary;
  if (cleanup) throw cleanup;
}

const gateModule = new URL('../../src/runtime/maintenance-gate.ts', import.meta.url).href;
const holderProgram = `
import { acquireRuntimeMaintenanceGate, acquireExclusiveMaintenanceGate } from ${JSON.stringify(gateModule)};
const root = process.env.RCAC_TEST_GATE_ROOT;
const acquire = process.env.RCAC_TEST_GATE_MODE === 'exclusive' ? acquireExclusiveMaintenanceGate : acquireRuntimeMaintenanceGate;
try {
  const held = acquire(root);
  process.stdout.write('READY\\n');
  process.stdin.resume();
  process.stdin.once('end', () => { held.release(); });
} catch (error) {
  process.stdout.write(error?.message === 'MAINTENANCE_GATE_BUSY' ? 'BUSY\\n' : 'UNSAFE\\n');
  process.exitCode = 2;
}
`;

function childArgs(): string[] { return ['--import', 'tsx', '--input-type=module', '-e', holderProgram]; }
function childEnv(root: string, mode: 'runtime' | 'exclusive'): NodeJS.ProcessEnv {
  return { ...process.env, RCAC_TEST_GATE_ROOT: root, RCAC_TEST_GATE_MODE: mode };
}
function terminal(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: string | null }> {
  return new Promise(resolveTerminal => {
    child.once('close', (code, signal) => resolveTerminal({ code, signal }));
    child.once('error', () => { /* close remains the actual terminal event */ });
  });
}
async function waitTerminal(closed: ReturnType<typeof terminal>): Promise<{ code: number | null; signal: string | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic gate child terminal unconfirmed')), 8_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function startHolder(root: string, mode: 'runtime' | 'exclusive', retain: () => void) {
  const child = spawn(process.execPath, childArgs(), { cwd: resolve('.'),
    env: childEnv(root, mode), stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = terminal(child);
  child.stdin.on('error', () => { /* terminal code is authoritative; no uncaught EPIPE */ });
  let output = '';
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Synthetic gate child readiness timed out')), 8_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output = (output + chunk).slice(0, 128);
        if (output === 'READY\n') { clearTimeout(timer); resolveReady(); }
        else if (output.includes('\n')) { clearTimeout(timer); rejectReady(new Error('Synthetic gate child refused lock')); }
      });
      child.once('error', () => { clearTimeout(timer); rejectReady(new Error('Synthetic gate child spawn failed')); });
      child.once('close', () => { clearTimeout(timer); rejectReady(new Error('Synthetic gate child closed before ready')); });
    });
  } catch (error) {
    child.kill();
    try { await waitTerminal(closed); } catch { retain(); }
    throw error;
  }
  return {
    child,
    async release(): Promise<void> {
      child.stdin.end();
      try { assert.deepEqual(await waitTerminal(closed), { code: 0, signal: null }); }
      catch (error) { retain(); throw error; }
    },
    async kill(): Promise<void> {
      child.kill('SIGKILL');
      try { const result = await waitTerminal(closed); assert.notEqual(result.code, 0); }
      catch (error) { retain(); throw error; }
    },
  };
}

test('fresh private managed root initializes one DELETE-mode gate without state.sqlite', t => fixture(root => {
  assertPrivateInstallationDirectory(root);
  assert.throws(() => assertPrivateDataDirectory(root));
  initializeMaintenanceGate(root);
  const path = join(root, 'lifecycle.sqlite');
  assert.equal(existsSync(path), true);
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete'); }
  finally { db.close(); }
  assert.throws(() => initializeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
  const runtime = acquireRuntimeMaintenanceGate(root);
  try {
    assert.throws(() => { const unexpected = acquireExclusiveMaintenanceGate(root); unexpected.release(); },
      /MAINTENANCE_GATE_BUSY/);
  } finally { runtime.release(); runtime.release(); }
  const exclusive = acquireExclusiveMaintenanceGate(root);
  try {
    assert.throws(() => { const unexpected = acquireRuntimeMaintenanceGate(root); unexpected.release(); },
      /MAINTENANCE_GATE_BUSY/);
  } finally { exclusive.release(); exclusive.release(); }
  const resumed = acquireRuntimeMaintenanceGate(root);
  resumed.release();
}).catch(error => {
  const primary = error instanceof AggregateError ? error.errors[0] : error;
  const cause = primary instanceof Error ? primary.cause : undefined;
  if (cause && typeof cause === 'object') {
    const value = cause as { component?: unknown; stage?: unknown; reason?: unknown; detail?: unknown };
    if (value.component === 'maintenance_gate' &&
      ['root_shape', 'root_lstat', 'root_realpath', 'root_acl', 'unknown']
        .includes(String(value.stage)) &&
      ['invalid', 'missing', 'io_failed', 'security_rejected', 'rejected']
        .includes(String(value.reason))) {
      const detail = value.detail && typeof value.detail === 'object' ?
        (value.detail as { reason?: unknown }).reason : undefined;
      t.diagnostic(JSON.stringify({ component: 'maintenance_gate', stage: value.stage,
        reason: value.reason,
        ...(detail && ['timeout', 'output_limit', 'spawn_missing', 'spawn_denied',
          'helper_rejected', 'unknown'].includes(String(detail)) ? { detailReason: detail } : {}) }));
    }
  }
  throw error;
}));

test('two real child runtime readers coexist and exclude maintenance until both close', async () => fixture(async (root, retain) => {
  initializeMaintenanceGate(root);
  const first = await startHolder(root, 'runtime', retain);
  let second: Awaited<ReturnType<typeof startHolder>> | undefined;
  let primary: unknown;
  try {
    second = await startHolder(root, 'runtime', retain);
    assert.throws(() => { const unexpected = acquireExclusiveMaintenanceGate(root); unexpected.release(); },
      /MAINTENANCE_GATE_BUSY/);
    await first.release();
    assert.throws(() => { const unexpected = acquireExclusiveMaintenanceGate(root); unexpected.release(); },
      /MAINTENANCE_GATE_BUSY/);
  } catch (error) { primary = error; }
  const cleanup = await Promise.allSettled([
    first.child.exitCode === null && first.child.signalCode === null ? first.release() : Promise.resolve(),
    second && second.child.exitCode === null && second.child.signalCode === null ?
      second.release() : Promise.resolve(),
  ]);
  const cleanupFailures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
  if (primary && cleanupFailures.length) throw new AggregateError([primary, ...cleanupFailures],
    'Gate assertion and child cleanup failed');
  if (primary) throw primary;
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Gate child cleanup failed');
  const maintenance = acquireExclusiveMaintenanceGate(root);
  try {
    const blocked = spawnSync(process.execPath, childArgs(), { cwd: resolve('.'),
      env: childEnv(root, 'runtime'), input: '', encoding: 'utf8', timeout: 8_000 });
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stdout, 'BUSY\n');
    const anotherMaintenance = spawnSync(process.execPath, childArgs(), { cwd: resolve('.'),
      env: childEnv(root, 'exclusive'), input: '', encoding: 'utf8', timeout: 8_000 });
    assert.equal(anotherMaintenance.status, 2);
    assert.equal(anotherMaintenance.stdout, 'BUSY\n');
  } finally { maintenance.release(); }
  const resumed = acquireRuntimeMaintenanceGate(root);
  resumed.release();
}));

test('killing an owned synthetic runtime child releases the SQLite lock without replacing the gate',
  async () => fixture(async (root, retain) => {
    initializeMaintenanceGate(root);
    const path = join(root, 'lifecycle.sqlite');
    const before = readFileSync(path);
    const holder = await startHolder(root, 'runtime', retain);
    try {
      assert.throws(() => { const unexpected = acquireExclusiveMaintenanceGate(root); unexpected.release(); },
        /MAINTENANCE_GATE_BUSY/);
    } finally { await holder.kill(); }
    const maintenance = acquireExclusiveMaintenanceGate(root);
    maintenance.release();
    assert.deepEqual(readFileSync(path), before);
  }));

test('missing, legacy flat, malformed, linked, and WAL gates are refused without repair', async () => {
  await fixture(root => {
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.equal(existsSync(join(root, 'lifecycle.sqlite')), false);
    writeFileSync(join(root, 'state.sqlite'), 'legacy');
    assert.throws(() => initializeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.equal(existsSync(join(root, 'lifecycle.sqlite')), false);
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const file = join(root, 'lifecycle.sqlite');
    linkSync(file, join(root, 'extra-link.sqlite'));
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const file = join(root, 'lifecycle.sqlite');
    const db = new DatabaseSync(file);
    try { db.exec('ALTER TABLE lifecycle_marker ADD COLUMN unknown TEXT'); }
    finally { db.close(); }
    const before = readFileSync(file);
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.deepEqual(readFileSync(file), before);
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const file = join(root, 'lifecycle.sqlite');
    const db = new DatabaseSync(file);
    try { db.exec("DROP TABLE lifecycle_marker; CREATE TABLE lifecycle_marker (id INTEGER, version INTEGER, marker TEXT); INSERT INTO lifecycle_marker VALUES (1, 2, 'rcac-managed-lifecycle-v2')"); }
    finally { db.close(); }
    const before = readFileSync(file);
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.deepEqual(readFileSync(file), before);
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const file = join(root, 'lifecycle.sqlite');
    writeFileSync(file, 'bad SQLite header');
    const before = readFileSync(file);
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.deepEqual(readFileSync(file), before);
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const file = join(root, 'lifecycle.sqlite');
    const sidecar = `${file}-wal`;
    writeFileSync(sidecar, 'untrusted sidecar');
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.equal(readFileSync(sidecar, 'utf8'), 'untrusted sidecar');
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const alias = join(root, 'alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try { assert.throws(() => acquireRuntimeMaintenanceGate(alias), /MAINTENANCE_GATE_UNSAFE/); }
    finally { unlinkSync(alias); }
  });
  await fixture(root => {
    initializeMaintenanceGate(root);
    const file = join(root, 'lifecycle.sqlite');
    const db = new DatabaseSync(file);
    try { db.prepare('PRAGMA journal_mode=WAL').get(); }
    finally { db.close(); }
    const before = readFileSync(file);
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
    assert.deepEqual(readFileSync(file), before);
  });
  if (process.platform === 'win32') await fixture(root => {
    initializeMaintenanceGate(root);
    execFileSync('C:\\Windows\\System32\\icacls.exe',
      [root, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore', timeout: 15_000 });
    assert.throws(() => acquireRuntimeMaintenanceGate(root), /MAINTENANCE_GATE_UNSAFE/);
  });
});

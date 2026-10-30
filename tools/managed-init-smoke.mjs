import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const base = process.platform === 'win32' ? homedir() : tmpdir();
const fixture = mkdtempSync(join(base, 'rcac-managed-pack-'));
const root = join(fixture, 'managed');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm exec');
let gateModule;
let runtimeModule;
let restored;
let retainFixture = false;
let primary;
let result;
function run(args, input, expected = 0) {
  const result = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input), timeout: 90_000 });
  if (result.error) retainFixture = true;
  assert.equal(result.status, expected, `Owned subprocess failed: ${result.error?.code ?? 'none'} ${result.stderr.slice(0, 512)}`);
  return result.stdout;
}
try {
  console.log('managed smoke: packing actual build');
  const packed = JSON.parse(run([npmCli, 'pack', '--json', '--pack-destination', fixture]));
  assert.equal(packed.length, 1);
  console.log('managed smoke: installing locally with offline npm');
  const prefix = join(fixture, 'installed');
  run([npmCli, 'install', '--offline', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
    join(fixture, packed[0].filename)]);
  const installed = join(prefix, 'node_modules', 'repo-conduit');
  const cli = join(installed, 'dist', 'src', 'cli', 'main.js');
  gateModule = await import(pathToFileURL(join(installed, 'dist', 'src', 'runtime', 'maintenance-gate.js')).href);
  runtimeModule = await import(pathToFileURL(join(installed, 'dist', 'src', 'runtime', 'installation.js')).href);
  const command = (action, input, expected) => run([cli, '--data-dir', root, action], input, expected);
  console.log('managed smoke: initializing via installed CLI');
  assert.deepEqual(JSON.parse(command('init-managed')), {
    initialized: true, mode: 'managed', schemaVersion: 1, dataFormatVersion: 1,
  });
  const manifestPath = join(root, 'managed.json');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const data = join(root, 'generations', manifest.activeGeneration, 'data');
  assert.equal(existsSync(join(root, 'state.sqlite')), false);
  assert.equal(existsSync(join(root, 'generations', manifest.activeGeneration, 'package')), false);
  const state = join(data, 'state.sqlite');
  const db = new DatabaseSync(state, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const table of ['grants', 'context_revisions', 'session_control', 'investigation_requests']) {
      assert.ok(tables.has(table), `Initialization must create ${table} before reopening any product store`);
    }
    assert.equal(db.prepare('SELECT count(*) AS count FROM grants').get().count, 1);
  } finally { db.close(); }
  const stateBytes = readFileSync(state);
  command('init-managed', undefined, 1);
  assert.deepEqual(readFileSync(manifestPath), manifestBytes);
  assert.deepEqual(readFileSync(state), stateBytes);
  console.log('managed smoke: installed backup and fresh restore with original grant and binary bytes');
  const originalBytes = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(join(data, 'ordinary.lock'), originalBytes);
  const originalDb = new DatabaseSync(state, { readOnly: true });
  let originalGrant;
  try { originalGrant = originalDb.prepare('SELECT id FROM grants').get().id; }
  finally { originalDb.close(); }
  const backup = join(fixture, 'backup');
  const shared = runtimeModule.acquireInstallationRuntime(root);
  try { run([cli, '--data-dir', root, 'backup', backup], undefined, 1); }
  finally { shared.release(); }
  assert.equal(existsSync(backup), false);
  assert.deepEqual(JSON.parse(run([cli, '--data-dir', root, 'backup', backup])),
    { completed: true, dataset: 'active_generation' });
  assert.ok(existsSync(join(backup, 'backup.json')));
  run([cli, '--data-dir', root, 'backup', backup], undefined, 1);
  restored = join(fixture, 'restored');
  assert.deepEqual(JSON.parse(run([cli, '--data-dir', restored, 'restore', backup])), { restored: true });
  const restoredOwner = runtimeModule.acquireInstallationRuntime(restored);
  try {
    assert.deepEqual(readFileSync(join(restoredOwner.dataDirectory, 'ordinary.lock')), originalBytes);
    const restoredDb = new DatabaseSync(join(restoredOwner.dataDirectory, 'state.sqlite'), { readOnly: true });
    try { assert.deepEqual(restoredDb.prepare('SELECT id FROM grants').all().map(row => row.id), [originalGrant]); }
    finally { restoredDb.close(); }
  } finally { restoredOwner.release(); }
  run([cli, '--data-dir', restored, 'restore', backup], undefined, 1);
  console.log('managed smoke: real maintenance exclusion and local request');
  const held = gateModule.acquireExclusiveMaintenanceGate(root);
  try { command('doctor', undefined, 1); } finally { held.release(); }
  const workspace = join(fixture, 'workspace'); mkdirSync(workspace);
  const registered = JSON.parse(command('request', { operation: 'admin.register_workspace',
    scope: { workspaceId: 'management' }, idempotencyKey: 'managed-installed-workspace',
    payload: { name: 'Managed installed synthetic workspace', root: workspace } }));
  assert.ok(registered.id);
  JSON.parse(command('doctor'));
  const exclusive = gateModule.acquireExclusiveMaintenanceGate(root); exclusive.release();
  result = { case: 'installed_managed_init', passed: true,
    packageIntegrity: packed[0].integrity, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    initialSchemaTables: 4, duplicatePreserved: true, maintenanceExcluded: true, localRequestVerified: true,
    installedBackupRestore: true, originalGrantPreserved: true, binaryBytesPreserved: true };
} catch (error) { primary = error; }
let cleanup;
try {
  if (retainFixture || primary) throw new Error('Failed installed smoke fixture retained for inspection', { cause: primary });
  for (const candidate of [root, restored].filter(Boolean)) if (existsSync(candidate)) {
    if (!gateModule) throw new Error('Installed gate unavailable; synthetic fixture retained');
    const held = gateModule.acquireExclusiveMaintenanceGate(candidate); held.release();
  }
  assert.match(relative(resolve(base), resolve(fixture)), /^rcac-managed-pack-[A-Za-z0-9_-]{6}$/);
  rmSync(fixture, { recursive: true, force: true });
} catch (error) { cleanup = error; }
if (primary && cleanup) throw new AggregateError([primary, cleanup], 'Installed managed smoke and cleanup failed');
if (primary) throw primary;
if (cleanup) throw cleanup;
console.log(JSON.stringify(result));

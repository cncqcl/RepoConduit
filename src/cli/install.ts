import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../adapters/storage/context-decisions-sqlite.js';
import { SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';
import { SessionControlSqlite } from '../adapters/storage/session-control-sqlite.js';
import { assertFreshManagedInstallationDestination, currentInstallationPackageVersion } from '../runtime/installation.js';
import { assertPrivateDataDirectory, assertPrivateInstallationDirectory,
  protectNewDataDirectory } from '../runtime/local-security.js';
import { acquireExclusiveMaintenanceGate, initializeMaintenanceGate } from '../runtime/maintenance-gate.js';

const uncertainGates = new Set<{ release(): void }>();

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  protectNewDataDirectory(path);
}

function initializeStores(file: string): void {
  const opened: { close(): void }[] = [];
  let primary: unknown;
  try {
    const core = new SqliteStore(file);
    opened.push(core);
    const account = userInfo();
    const principal = `${hostname()}\\${account.username}`;
    core.insertGrant({ id: `gr_${randomUUID()}`, principal, audience: 'local-os', recipient: principal,
      workspaceId: 'management', permissions: ['admin.workspace', 'admin.grant', 'admin.revoke', 'admin.profile'],
      expiresAt: null, revokedAt: null });
    opened.push(new ContextDecisionSqlite(file));
    opened.push(new SessionControlSqlite(file));
    opened.push(new SqliteInvestigationStore(file));
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  for (const store of opened.reverse()) {
    try { store.close(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup],
    'Managed initialization store cleanup unconfirmed', { cause: cleanup[0] });
  if (primary !== undefined) throw primary;
}

function publishManifest(file: string, value: unknown): void {
  const fd = openSync(file, 'wx', 0o600);
  let primary: unknown;
  try {
    writeFileSync(fd, JSON.stringify(value), 'utf8');
    fsyncSync(fd);
  } catch (error) { primary = error; }
  let cleanup: unknown;
  try { closeSync(fd); } catch (error) { cleanup = error; }
  if (cleanup !== undefined) throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup],
    'Managed manifest close unconfirmed', { cause: cleanup });
  if (primary !== undefined) throw primary;
}

/** Create a new managed installation. A failed attempt keeps its partial tree for inspection. */
export function createManagedInstallation(directory: string):
  { initialized: true; mode: 'managed'; schemaVersion: 1; dataFormatVersion: 1 } {
  const root = assertFreshManagedInstallationDestination(directory);
  createPrivateDirectory(root);
  initializeMaintenanceGate(root);
  const gate = acquireExclusiveMaintenanceGate(root);
  let primary: unknown;
  let publishing = false;
  try {
    const generations = join(root, 'generations');
    const generation = `gen_${randomUUID()}`;
    const generationDirectory = join(generations, generation);
    const data = join(generationDirectory, 'data');
    createPrivateDirectory(generations);
    createPrivateDirectory(generationDirectory);
    createPrivateDirectory(data);
    const state = join(data, 'state.sqlite');
    initializeStores(state);
    assertPrivateDataDirectory(data);
    const manifest = join(root, 'managed.json');
    publishing = true;
    publishManifest(manifest, { schemaVersion: 1, activeGeneration: generation,
      packageVersion: currentInstallationPackageVersion(), dataFormatVersion: 1 });
    assertPrivateInstallationDirectory(root, manifest);
  } catch (error) { primary = error; }
  if (primary instanceof AggregateError || (publishing && primary !== undefined)) {
    uncertainGates.add(gate);
    throw primary;
  }
  try { gate.release(); }
  catch (error) {
    uncertainGates.add(gate);
    if (primary !== undefined) throw new AggregateError([primary, error], 'Managed initialization cleanup unconfirmed',
      { cause: error });
    throw error;
  }
  if (primary !== undefined) throw primary;
  return { initialized: true, mode: 'managed', schemaVersion: 1, dataFormatVersion: 1 };
}

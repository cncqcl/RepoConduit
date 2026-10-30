import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, renameSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { normalizeArtifactPath } from '../core/artifact/paths.js';
import { acquireInstallationMaintenance, assertActiveInstallationMaintenance,
  assertFreshManagedInstallationDestination, currentInstallationPackageVersion,
  retainInstallationMaintenance, type InstallationMaintenance } from './installation.js';
import { inspectInstallationDataFiles, inventoryInstallationData } from './installation-data-files.js';
import { inspectInstallationStateDatabase } from './installation-state-preflight.js';
import { inspectInstallationArtifactDataset } from './installation-artifact-preflight.js';
import { inspectInstallationReferenceDatabase } from './installation-reference-preflight.js';
import { assertPrivateInstallationDirectory, protectNewDataDirectory } from './local-security.js';
import { acquireExclusiveMaintenanceGate, initializeMaintenanceGate } from './maintenance-gate.js';

interface FileEntry { path: string; kind: 'file' | 'directory'; size: number; sha256?: string }
interface BackupManifest {
  schemaVersion: 1; dataFormatVersion: 1; packageVersion: string;
  dataset: 'active_generation'; entries: FileEntry[];
}
const uncertainRestoreGates = new Set<{ release(): void }>();
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
function invalid(): never { throw new Error('INSTALLATION_BACKUP_UNSAFE'); }
function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 }); protectNewDataDirectory(path);
}
function plain(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) invalid();
  return stat;
}
function closeAll(fds: readonly number[], primary: unknown): void {
  const errors: unknown[] = [];
  for (const fd of fds) { try { closeSync(fd); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors],
    'Installation backup file close unconfirmed', { cause: errors[0] });
  if (primary !== undefined) throw primary;
}
/** Stream and revalidate the opened object; never buffer an entire dataset. */
function transfer(source: string, target?: string, expected?: FileEntry): FileEntry {
  const before = plain(source);
  const input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const fds = [input];
  let primary: unknown;
  let digest = '';
  try {
    const stat = fstatSync(input);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size ||
        !stat.isFile() || stat.nlink !== 1) invalid();
    const output = target === undefined ? undefined : openSync(target, 'wx', 0o600);
    if (output !== undefined) fds.unshift(output);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, size);
      if (count === 0) break;
      size += count;
      if (size > before.size) invalid();
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) {
        let written = 0;
        while (written < count) {
          const part = writeSync(output, buffer, written, count - written);
          if (part === 0) invalid();
          written += part;
        }
      }
    }
    const after = fstatSync(input), pathAfter = plain(source);
    if (size !== before.size || after.size !== before.size || after.dev !== before.dev ||
        after.ino !== before.ino || after.nlink !== 1 || pathAfter.dev !== before.dev ||
        pathAfter.ino !== before.ino || pathAfter.size !== before.size) invalid();
    digest = hash.digest('hex');
    if (expected && (expected.size !== size || expected.sha256 !== digest)) invalid();
    if (output !== undefined) fsyncSync(output);
  } catch (error) { primary = error; }
  closeAll(fds, primary);
  return { path: '', kind: 'file', size: before.size, sha256: digest };
}
function writeJson(path: string, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_BYTES) invalid();
  const pending = `${path}.pending`;
  const fd = openSync(pending, 'wx', 0o600);
  let primary: unknown;
  try { writeFileSync(fd, body); fsyncSync(fd); }
  catch (error) { primary = error; }
  closeAll([fd], primary);
  if (existsSync(path)) invalid();
  renameSync(pending, path);
}
function readManifest(path: string): BackupManifest {
  const stat = plain(path);
  if (stat.size > MAX_MANIFEST_BYTES) invalid();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: unknown;
  let value: unknown;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
      if (size > stat.size) invalid();
    }
    const after = plain(path), descriptorAfter = fstatSync(fd);
    if (size !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size ||
        !descriptorAfter.isFile() || descriptorAfter.nlink !== 1 || descriptorAfter.ino !== stat.ino ||
        descriptorAfter.dev !== stat.dev || descriptorAfter.size !== stat.size) invalid();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
  } catch (error) { primary = error; }
  closeAll([fd], primary);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const manifest = value as BackupManifest;
  if (Object.keys(manifest).sort().join(',') !== 'dataFormatVersion,dataset,entries,packageVersion,schemaVersion' ||
      manifest.schemaVersion !== 1 || manifest.dataFormatVersion !== 1 ||
      manifest.packageVersion !== currentInstallationPackageVersion() || manifest.dataset !== 'active_generation' ||
      !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) invalid();
  let size = 0;
  const names = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object' || (entry.kind !== 'file' && entry.kind !== 'directory') ||
        typeof entry.path !== 'string' || normalizeArtifactPath(entry.path) !== entry.path ||
        names.has(entry.path.toLocaleLowerCase('en-US')) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        Object.keys(entry).sort().join(',') !== (entry.kind === 'file' ? 'kind,path,sha256,size' : 'kind,path,size') ||
        (entry.kind === 'directory' ? entry.size !== 0 : typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256))) invalid();
    names.add(entry.path.toLocaleLowerCase('en-US'));
    size += entry.size;
    if (size > MAX_BYTES) invalid();
  }
  if (!manifest.entries.some(entry => entry.path === 'state.sqlite' && entry.kind === 'file')) invalid();
  return manifest;
}
function inspectOpenedDatabase(db: DatabaseSync, data: string, state: boolean): void {
  db.exec('PRAGMA query_only=ON');
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get() !== undefined) invalid();
  if (state) {
    inspectInstallationStateDatabase(db);
    inspectInstallationReferenceDatabase(db);
    inspectInstallationArtifactDataset(db, data);
  }
}
function inspectDatabase(path: string, data: string, state: boolean): void {
  plain(path);
  const db = new DatabaseSync(path, { readOnly: true });
  let primary: unknown;
  try {
    inspectOpenedDatabase(db, data, state);
  } catch (error) { primary = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error],
    'Installation backup database close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
}

/** Only an owned, closed inactive copy may bypass SQLite's WAL-aware locking. */
function inspectQuietCopiedDatabase(path: string, data: string, state: boolean): void {
  const quiet = (): void => {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }) !== undefined) invalid();
    }
  };
  quiet();
  const before = transfer(path);
  const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
  let primary: unknown;
  try { inspectOpenedDatabase(db, data, state); }
  catch (error) { primary = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error],
    'Installation candidate database close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
  quiet();
  transfer(path, undefined, before);
}
function noOverlap(destination: string, source: string): void {
  const within = (left: string, right: string) => {
    const value = relative(left, right);
    return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
  };
  if (within(source, destination) || within(destination, source)) invalid();
}
function excludeRegisteredRoots(state: string, destination: string): void {
  plain(state);
  const db = new DatabaseSync(state, { readOnly: true });
  let primary: unknown;
  try {
    const query = 'SELECT canonical_root FROM workspaces UNION SELECT canonical_root FROM working_copies LIMIT 10001';
    const preview = db.prepare(`SELECT count(*) AS rows, COALESCE(sum(length(CAST(canonical_root AS BLOB))),0) AS bytes FROM (${query})`).get();
    if (!preview || typeof preview.rows !== 'number' || typeof preview.bytes !== 'number' ||
        !Number.isSafeInteger(preview.rows) || !Number.isSafeInteger(preview.bytes) ||
        preview.rows > MAX_ENTRIES || preview.bytes > 16 * 1024 * 1024) invalid();
    const rows = db.prepare(query).all();
    if (rows.length > MAX_ENTRIES) invalid();
    for (const row of rows) {
      if (typeof row.canonical_root !== 'string' || !isAbsolute(row.canonical_root)) invalid();
      noOverlap(destination, row.canonical_root);
    }
  } catch (error) { primary = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error],
    'Installation backup registry close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
}
function normalizeCopiedDatabase(path: string): void {
  const db = new DatabaseSync(path);
  let primary: unknown;
  try { if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') invalid(); }
  catch (error) { primary = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error],
    'Installation copied database close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
}

export async function backupInstallationWithinMaintenance(owner: InstallationMaintenance, destination: string):
  Promise<{ completed: true; dataset: 'active_generation' }> {
  assertActiveInstallationMaintenance(owner);
  const root = assertFreshManagedInstallationDestination(destination);
  const canonicalRoot = join(realpathSync.native(dirname(root)), basename(root));
  noOverlap(canonicalRoot, owner.installationDirectory);
  const inventory = inventoryInstallationData(owner);
  excludeRegisteredRoots(join(owner.dataDirectory, 'state.sqlite'), canonicalRoot);
  inspectDatabase(join(owner.dataDirectory, 'state.sqlite'), owner.dataDirectory, true);
  privateDirectory(root);
  const data = join(root, 'data'); privateDirectory(data);
  const dbNames = ['state.sqlite', ...(existsSync(join(owner.dataDirectory, 'issuer.sqlite')) ? ['issuer.sqlite'] : [])];
  for (const name of dbNames) {
    if (existsSync(join(owner.dataDirectory, `${name}-journal`))) invalid();
    assertActiveInstallationMaintenance(owner);
    const source = join(owner.dataDirectory, name); plain(source);
    const db = new DatabaseSync(source, { readOnly: true });
    let primary: unknown;
    try { await backup(db, join(data, name)); }
    catch (error) { primary = error; }
    try { db.close(); }
    catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error],
      'Installation backup source database close unconfirmed', { cause: error }); }
    if (primary !== undefined) throw primary;
    assertActiveInstallationMaintenance(owner);
    normalizeCopiedDatabase(join(data, name));
  }
  const entries: FileEntry[] = [];
  for (const entry of inventory.entries) {
    assertActiveInstallationMaintenance(owner);
    if (dbNames.some(name => entry.relativePath === `${name}-wal` || entry.relativePath === `${name}-shm`)) continue;
    const target = join(data, ...entry.relativePath.split('/'));
    if (entry.kind === 'directory') {
      mkdirSync(target, { mode: 0o700 });
      entries.push({ path: entry.relativePath, kind: 'directory', size: 0 });
    } else {
      const result = dbNames.includes(entry.relativePath) ? transfer(target) :
        transfer(join(owner.dataDirectory, ...entry.relativePath.split('/')), target);
      entries.push({ ...result, path: entry.relativePath });
    }
  }
  inspectDatabase(join(data, 'state.sqlite'), data, true);
  if (dbNames.includes('issuer.sqlite')) inspectDatabase(join(data, 'issuer.sqlite'), data, false);
  if (entries.reduce((total, entry) => total + entry.size, 0) > MAX_BYTES) invalid();
  assertActiveInstallationMaintenance(owner);
  writeJson(join(root, 'backup.json'), { schemaVersion: 1, dataFormatVersion: 1,
    packageVersion: currentInstallationPackageVersion(), dataset: 'active_generation', entries } satisfies BackupManifest);
  assertPrivateInstallationDirectory(root, join(root, 'backup.json'));
  return { completed: true, dataset: 'active_generation' };
}

export async function backupInstallation(source: string, destination: string): Promise<{ completed: true; dataset: 'active_generation' }> {
  const owner = acquireInstallationMaintenance(source);
  let result: { completed: true; dataset: 'active_generation' } | undefined;
  let primary: unknown;
  try { result = await backupInstallationWithinMaintenance(owner, destination); }
  catch (error) { primary = error; }
  if (primary instanceof AggregateError) { retainInstallationMaintenance(owner); throw primary; }
  try { owner.release(); }
  catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error], 'Installation backup owner close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
  return result!;
}

function validatedBackup(source: string): { manifest: BackupManifest; original: string; backupRoot: string } {
  if (!isAbsolute(source)) invalid();
  const backupRoot = resolve(source);
  assertPrivateInstallationDirectory(backupRoot, join(backupRoot, 'backup.json'));
  const manifest = readManifest(join(backupRoot, 'backup.json'));
  const original = join(backupRoot, 'data'); assertPrivateInstallationDirectory(original);
  const inventory = inspectInstallationDataFiles(original);
  if (inventory.entries.length !== manifest.entries.length) invalid();
  const declaredEntries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  for (const entry of inventory.entries) {
    const declared = declaredEntries.get(entry.relativePath);
    if (!declared || declared.kind !== entry.kind || declared.size !== entry.size) invalid();
  }
  for (const entry of manifest.entries) {
    const file = join(original, ...entry.path.split('/'));
    if (entry.kind === 'file') transfer(file, undefined, entry);
    else if (!lstatSync(file).isDirectory() || lstatSync(file).isSymbolicLink()) invalid();
  }
  inspectDatabase(join(original, 'state.sqlite'), original, true);
  if (manifest.entries.some(entry => entry.path === 'issuer.sqlite')) inspectDatabase(join(original, 'issuer.sqlite'), original, false);
  return { manifest, original, backupRoot };
}

function inactiveGeneration(owner: InstallationMaintenance, generation: string): string {
  assertActiveInstallationMaintenance(owner);
  if (!/^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation) ||
      generation === basename(dirname(owner.dataDirectory))) invalid();
  const generations = join(owner.installationDirectory, 'generations');
  const path = join(generations, generation);
  for (const directory of [generations, path]) {
    const stat = lstatSync(directory);
    const canonical = realpathSync.native(directory);
    const equal = process.platform === 'win32' ? canonical.toLowerCase() === directory.toLowerCase() : canonical === directory;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equal) invalid();
    assertPrivateInstallationDirectory(directory);
  }
  return path;
}

/** Check the entire candidate write destination before any generation/package mkdir. */
export function assertFreshInactiveGenerationDestination(owner: InstallationMaintenance, generation: string): string {
  assertActiveInstallationMaintenance(owner);
  if (!/^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation) ||
      generation === basename(dirname(owner.dataDirectory))) invalid();
  const parent = join(owner.installationDirectory, 'generations');
  const stat = lstatSync(parent);
  const canonical = realpathSync.native(parent);
  const equal = process.platform === 'win32' ? canonical.toLowerCase() === parent.toLowerCase() : canonical === parent;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !equal) invalid();
  assertPrivateInstallationDirectory(parent);
  const target = join(parent, generation);
  let present = true;
  try { lstatSync(target); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') present = false;
    else throw error;
  }
  if (present) invalid();
  excludeRegisteredRoots(join(owner.dataDirectory, 'state.sqlite'), target);
  return target;
}

/** Fixed internal upgrade copy, owned by the old-version coordinator. Never publishes or reseeds. */
export function copyInstallationBackupIntoGeneration(owner: InstallationMaintenance, source: string, generation: string):
  { dataDirectory: string } {
  const path = inactiveGeneration(owner, generation);
  const { manifest, original, backupRoot } = validatedBackup(source);
  noOverlap(owner.installationDirectory, realpathSync.native(backupRoot));
  const data = join(path, 'data');
  excludeRegisteredRoots(join(owner.dataDirectory, 'state.sqlite'), data);
  assertActiveInstallationMaintenance(owner);
  privateDirectory(data);
  for (const entry of manifest.entries) {
    assertActiveInstallationMaintenance(owner);
    const target = join(data, ...entry.path.split('/'));
    if (entry.kind === 'directory') mkdirSync(target, { mode: 0o700 });
    else transfer(join(original, ...entry.path.split('/')), target, entry);
  }
  inspectInstallationDataFiles(data);
  inspectDatabase(join(data, 'state.sqlite'), data, true);
  if (manifest.entries.some(entry => entry.path === 'issuer.sqlite')) inspectDatabase(join(data, 'issuer.sqlite'), data, false);
  return { dataDirectory: data };
}

/** Pure consistency check within the coordinator's still-owned inactive generation. */
export function inspectInstallationGenerationWithinMaintenance(owner: InstallationMaintenance, generation: string): void {
  const data = join(inactiveGeneration(owner, generation), 'data');
  assertPrivateInstallationDirectory(data);
  const before = inspectInstallationDataFiles(data);
  inspectQuietCopiedDatabase(join(data, 'state.sqlite'), data, true);
  if (existsSync(join(data, 'issuer.sqlite'))) inspectQuietCopiedDatabase(join(data, 'issuer.sqlite'), data, false);
  if (JSON.stringify(inspectInstallationDataFiles(data)) !== JSON.stringify(before)) invalid();
}

export async function restoreInstallation(source: string, destination: string): Promise<{ restored: true }> {
  const { manifest, original, backupRoot } = validatedBackup(source);
  const root = assertFreshManagedInstallationDestination(destination);
  const canonicalRoot = join(realpathSync.native(dirname(root)), basename(root));
  noOverlap(canonicalRoot, realpathSync.native(backupRoot));
  excludeRegisteredRoots(join(original, 'state.sqlite'), canonicalRoot);
  privateDirectory(root); initializeMaintenanceGate(root);
  const gate = acquireExclusiveMaintenanceGate(root);
  let primary: unknown;
  let publishing = false;
  try {
    const generations = join(root, 'generations'); privateDirectory(generations);
    const generation = `gen_${randomUUID()}`;
    const active = join(generations, generation); privateDirectory(active);
    const data = join(active, 'data'); privateDirectory(data);
    for (const entry of manifest.entries) {
      const target = join(data, ...entry.path.split('/'));
      if (entry.kind === 'directory') mkdirSync(target, { mode: 0o700 });
      else transfer(join(original, ...entry.path.split('/')), target, entry);
    }
    inspectDatabase(join(data, 'state.sqlite'), data, true);
    if (manifest.entries.some(entry => entry.path === 'issuer.sqlite')) inspectDatabase(join(data, 'issuer.sqlite'), data, false);
    publishing = true;
    writeJson(join(root, 'managed.json'), { schemaVersion: 1, dataFormatVersion: 1,
      packageVersion: manifest.packageVersion, activeGeneration: generation });
    assertPrivateInstallationDirectory(root, join(root, 'managed.json'));
  } catch (error) { primary = error; }
  if (primary instanceof AggregateError || (publishing && primary !== undefined)) {
    uncertainRestoreGates.add(gate); throw primary;
  }
  try { gate.release(); }
  catch (error) { uncertainRestoreGates.add(gate); throw new AggregateError(primary === undefined ? [error] : [primary, error],
    'Installation restore gate close unconfirmed', { cause: error }); }
  if (primary !== undefined) throw primary;
  return { restored: true };
}

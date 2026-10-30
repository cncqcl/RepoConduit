#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { createReferenceBudget, referenceCellByteLimit, reserveReferenceTableCapacity,
  type ReferenceLimits } from '../adapters/storage/reference-budget.js';
import { ContextDecisionSqlite } from '../adapters/storage/context-decisions-sqlite.js';
import { SessionControlSqlite } from '../adapters/storage/session-control-sqlite.js';
import { SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';
import { currentInstallationPackageVersion } from '../runtime/installation.js';
import { inspectInstallationDataFiles } from '../runtime/installation-data-files.js';
import { inspectInstallationStateDatabase } from '../runtime/installation-state-preflight.js';
import { inspectInstallationReferenceDatabase } from '../runtime/installation-reference-preflight.js';
import { inspectInstallationArtifactDataset } from '../runtime/installation-artifact-preflight.js';
import { assertPrivateDataDirectory, assertPrivateInstallationDirectory } from '../runtime/local-security.js';

const MAX_MANIFEST = 8 * 1024;
const MAX_LOGICAL_ROWS = 100_000;
const MAX_LOGICAL_BYTES = 256 * 1024 * 1024;
const GENERATION = /^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function unsafe(): never { throw new Error('INSTALLATION_MIGRATION_UNSAFE'); }
function same(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}
function privatePath(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same(realpathSync.native(path), path)) unsafe();
  assertPrivateInstallationDirectory(path);
}
function sourceRoot(root: string): void {
  if (typeof root !== 'string' || !isAbsolute(root) || root !== resolve(root) || root.endsWith(sep) ||
      root === parse(root).root) unsafe();
  let current = root;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  privatePath(root);
}
function ordinaryFile(path: string, max: number): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max || stat.size < 0 ||
      !same(realpathSync.native(path), path)) unsafe();
  return stat;
}
function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true;
    return unsafe();
  }
}
function quietDatabaseFiles(data: string): void {
  for (const name of ['state.sqlite', 'issuer.sqlite']) {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (!absent(join(data, `${name}${suffix}`))) unsafe();
    }
  }
}
function hashOrdinaryFile(file: string): string {
  const before = ordinaryFile(file, 2 * 1024 * 1024 * 1024);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: unknown;
  let digest: string | undefined;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.nlink !== 1) unsafe();
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (size < 1) unsafe();
      hash.update(chunk.subarray(0, size));
      offset += size;
    }
    const after = fstatSync(fd), pathAfter = ordinaryFile(file, 2 * 1024 * 1024 * 1024);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) unsafe();
    digest = hash.digest('hex');
  } catch (error) { primary = error; }
  try { closeSync(fd); }
  catch (closeError) { throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
    'Installation migration hash close unconfirmed', { cause: closeError }); }
  if (primary !== undefined) throw primary;
  return digest!;
}
function nonDatabaseFingerprint(data: string): ReadonlyMap<string, string> {
  quietDatabaseFiles(data);
  const entries = inspectInstallationDataFiles(data).entries;
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.relativePath === 'state.sqlite' || entry.relativePath === 'issuer.sqlite') continue;
    result.set(entry.relativePath, entry.kind === 'directory' ? 'directory' :
      hashOrdinaryFile(join(data, ...entry.relativePath.split('/'))));
  }
  quietDatabaseFiles(data);
  return result;
}
function quietRead<T>(file: string, data: string, inspect: (db: DatabaseSync) => T): T {
  quietDatabaseFiles(data);
  const inventoryBefore = inspectInstallationDataFiles(data);
  const hashBefore = hashOrdinaryFile(file);
  const db = new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true });
  let primary: unknown;
  let result: T | undefined;
  try { result = inspect(db); }
  catch (error) { primary = error; }
  try { db.close(); }
  catch (closeError) { throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
    'Installation migration database close unconfirmed', { cause: closeError }); }
  let afterError: unknown;
  try {
    quietDatabaseFiles(data);
    if (!isDeepStrictEqual(inspectInstallationDataFiles(data), inventoryBefore) ||
        hashOrdinaryFile(file) !== hashBefore) unsafe();
    quietDatabaseFiles(data);
  } catch (error) { afterError = error; }
  if (primary !== undefined && afterError !== undefined) throw new AggregateError([primary, afterError],
    'Installation migration quiet read unconfirmed', { cause: afterError });
  if (afterError !== undefined) throw afterError;
  if (primary !== undefined) throw primary;
  return result!;
}
function manifest(root: string): { activeGeneration: string; packageVersion: string } {
  const file = join(root, 'managed.json');
  const before = ordinaryFile(file, MAX_MANIFEST);
  assertPrivateInstallationDirectory(root, file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  let primary: unknown;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) unsafe();
    const bytes = Buffer.alloc(MAX_MANIFEST + 1);
    let size = 0;
    while (size <= MAX_MANIFEST) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd), pathAfter = ordinaryFile(file, MAX_MANIFEST);
    if (size !== before.size || size > MAX_MANIFEST || after.size !== before.size || after.nlink !== 1 ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) unsafe();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
  } catch (error) { primary = error; }
  try { closeSync(fd); }
  catch (closeError) {
    throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
      'Installation migration manifest close unconfirmed', { cause: closeError });
  }
  if (primary !== undefined) throw primary;
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsafe();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'activeGeneration,dataFormatVersion,packageVersion,schemaVersion' ||
      record.schemaVersion !== 1 || record.dataFormatVersion !== 1 ||
      typeof record.packageVersion !== 'string' ||
      typeof record.activeGeneration !== 'string' || !GENERATION.test(record.activeGeneration)) unsafe();
  return { activeGeneration: record.activeGeneration, packageVersion: record.packageVersion };
}
function inspectDatabase(file: string, data: string, state: boolean): void {
  ordinaryFile(file, 2 * 1024 * 1024 * 1024);
  quietRead(file, data, db => {
    db.exec('PRAGMA query_only=ON');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get() !== undefined) unsafe();
    if (state) {
      inspectInstallationStateDatabase(db);
      inspectInstallationReferenceDatabase(db);
      inspectInstallationArtifactDataset(db, data);
    }
  });
}

type LogicalTable = { readonly columns: readonly string[]; readonly rowHashes: ReadonlyMap<string, number> };
/** Freeze every existing logical row. Additive tables/columns may be introduced, but existing values cannot be lost. */
function logicalRows(file: string): ReadonlyMap<string, LogicalTable> {
  const data = dirname(file);
  return quietRead(file, data, inspectLogicalMigrationRows);
}

/** Bounded logical scanner used by migration; it never loads all payload rows at once. */
export function inspectLogicalMigrationRows(db: DatabaseSync, limits: {
  maxLogicalBytes?: number; referenceLimits?: Partial<ReferenceLimits>;
} = {}): ReadonlyMap<string, LogicalTable> {
    const maxLogicalBytes = limits.maxLogicalBytes ?? MAX_LOGICAL_BYTES;
    if (!Number.isSafeInteger(maxLogicalBytes) || maxLogicalBytes < 1 || maxLogicalBytes > MAX_LOGICAL_BYTES) unsafe();
    const referenceBudget = createReferenceBudget(limits.referenceLimits);
    const tables = new Map<string, LogicalTable>();
    const boundedTables: { name: string; columns: string[] }[] = [];
    db.exec('PRAGMA query_only=ON');
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 513")
      .all() as { name: string }[];
    if (names.length > 512) unsafe();
    let rows = 0, bytes = 0;
    for (const { name } of names) {
      if (typeof name !== 'string' || !IDENTIFIER.test(name)) unsafe();
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(item => item.name);
      if (columns.length < 1 || columns.length > 128 || columns.some(item => !IDENTIFIER.test(item))) unsafe();
      const quoted = columns.map(item => `"${item}"`);
      const lengths = quoted.map(item => `COALESCE(length(CAST(${item} AS BLOB)),0)`);
      const maxima = lengths.map((length, index) => `COALESCE(max(${length}),0) AS cell_${index}`);
      const aggregate = db.prepare(`SELECT count(*) AS rows, COALESCE(sum(${lengths.join(' + ')}),0) AS bytes,
        ${maxima.join(',')} FROM "${name}"`).get() as
        ({ rows: number; bytes: number } & Record<string, number>) | undefined;
      if (!aggregate || !Number.isSafeInteger(aggregate.rows) || !Number.isSafeInteger(aggregate.bytes) ||
          aggregate.rows < 0 || aggregate.bytes < 0 || aggregate.rows > MAX_LOGICAL_ROWS - rows ||
          columns.some((column, index) => !Number.isSafeInteger(aggregate[`cell_${index}`]) ||
            aggregate[`cell_${index}`]! > referenceCellByteLimit(name, column))) unsafe();
      const encodedContentBytes = reserveReferenceTableCapacity(db, name, columns, referenceBudget);
      const metadataBytes = aggregate.bytes - encodedContentBytes;
      if (metadataBytes < 0 || metadataBytes > maxLogicalBytes - bytes) unsafe();
      rows += aggregate.rows; bytes += metadataBytes;
      boundedTables.push({ name, columns });
    }
    // All aggregate, cell and content bounds are established before loading/hashing any row.
    for (const { name, columns } of boundedTables) {
      const quoted = columns.map(item => `"${item}"`);
      const rowHashes = new Map<string, number>();
      for (const row of db.prepare(`SELECT ${quoted.join(',')} FROM "${name}"`).iterate()) {
        const hash = createHash('sha256');
        for (const column of columns) {
          const value = row[column];
          const type = value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value;
          const data = value === null ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value));
          hash.update(`${column}:${type}:${data.length}:`);
          hash.update(data);
        }
        const digest = hash.digest('hex');
        rowHashes.set(digest, (rowHashes.get(digest) ?? 0) + 1);
      }
      tables.set(name, { columns, rowHashes });
    }
    return tables;
}
function assertRowsPreserved(file: string, baseline: ReadonlyMap<string, LogicalTable>): void {
  const data = dirname(file);
  quietRead(file, data, db => {
    db.exec('PRAGMA query_only=ON');
    for (const [name, table] of baseline) {
      const remaining = new Map(table.rowHashes);
      const columns = table.columns.map(item => `"${item}"`);
      for (const row of db.prepare(`SELECT ${columns.join(',')} FROM "${name}"`).iterate()) {
        const hash = createHash('sha256');
        for (const column of table.columns) {
          const value = row[column];
          const type = value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value;
          const data = value === null ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value));
          hash.update(`${column}:${type}:${data.length}:`);
          hash.update(data);
        }
        const digest = hash.digest('hex');
        const found = remaining.get(digest);
        if (found) remaining.set(digest, found - 1);
      }
      if ([...remaining.values()].some(count => count !== 0)) unsafe();
    }
  });
}
function initializeStores(file: string): void {
  const opened: { close(): void }[] = [];
  let primary: unknown;
  try {
    opened.push(new SqliteStore(file));
    opened.push(new ContextDecisionSqlite(file));
    opened.push(new SessionControlSqlite(file));
    opened.push(new SqliteInvestigationStore(file));
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  for (const store of opened.reverse()) {
    try { store.close(); } catch (closeError) { cleanup.push(closeError); }
  }
  if (cleanup.length) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup],
    'Installation migration store cleanup unconfirmed', { cause: cleanup[0] });
  if (primary !== undefined) throw primary;
}

/** Fixed local candidate worker. Coordinator alone holds EXCLUSIVE and decides activation. */
export function migrateInstallationCandidate(root: string, generation: string, fromVersion: string):
  { migrated: true; dataFormatVersion: 1; packageVersion: string } {
  try {
    sourceRoot(root);
    if (fromVersion !== '0.1.0' || typeof generation !== 'string' || !GENERATION.test(generation)) unsafe();
    const current = currentInstallationPackageVersion();
    if (!/^0\.1\.[0-9]+$/.test(current)) unsafe();
    const source = manifest(root);
    if (source.packageVersion !== fromVersion || source.activeGeneration === generation) unsafe();
    const generations = join(root, 'generations');
    for (const path of [generations, join(generations, source.activeGeneration),
      join(generations, source.activeGeneration, 'data')]) privatePath(path);
    const selected = join(generations, generation);
    const data = join(selected, 'data');
    for (const path of [generations, selected, data]) privatePath(path);
    assertPrivateDataDirectory(data);
    quietDatabaseFiles(data);
    const entries = inspectInstallationDataFiles(data);
    if (!entries.entries.some(item => item.relativePath === 'state.sqlite' && item.kind === 'file')) unsafe();
    const state = join(data, 'state.sqlite');
    if (entries.entries.some(item => item.relativePath === 'issuer.sqlite' && item.kind !== 'file')) unsafe();
    const issuer = entries.entries.some(item => item.relativePath === 'issuer.sqlite' && item.kind === 'file');
    const nonDatabaseBefore = nonDatabaseFingerprint(data);
    inspectDatabase(state, data, true);
    if (issuer) inspectDatabase(join(data, 'issuer.sqlite'), data, false);
    const rows = logicalRows(state);
    initializeStores(state);
    quietDatabaseFiles(data);
    inspectInstallationDataFiles(data);
    inspectDatabase(state, data, true);
    if (issuer) inspectDatabase(join(data, 'issuer.sqlite'), data, false);
    assertRowsPreserved(state, rows);
    if (!isDeepStrictEqual(nonDatabaseFingerprint(data), nonDatabaseBefore)) unsafe();
    quietDatabaseFiles(data);
    const final = manifest(root);
    if (final.activeGeneration !== source.activeGeneration || final.packageVersion !== source.packageVersion) unsafe();
    return { migrated: true, dataFormatVersion: 1, packageVersion: current };
  } catch (error) {
    if (error instanceof AggregateError) throw error;
    return unsafe();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) unsafe();
    const result = migrateInstallationCandidate(args[0]!, args[1]!, args[2]!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('{"code":"ERROR","message":"Request failed or resource unavailable"}\n');
    process.exitCode = 1;
  }
}

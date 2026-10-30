import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPrivateInstallationDirectory } from './local-security.js';

const gateName = 'lifecycle.sqlite';
const markerSql = "CREATE TABLE lifecycle_marker (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1), marker TEXT NOT NULL CHECK (marker = 'rcac-managed-lifecycle-v1')) STRICT";
type GateStage = 'unknown' | 'root_shape' | 'root_lstat' | 'root_realpath' | 'root_acl' |
  'gate_lstat' | 'gate_shape' | 'gate_sidecars' | 'gate_acl' | 'gate_header' |
  'init_root_empty' | 'init_file_create' | 'init_db_open' |
  'init_journal_mode' | 'init_begin' | 'init_schema' | 'init_marker' | 'init_commit' |
  'init_validate' | 'init_close';
type GateReason = 'rejected' | 'invalid' | 'missing' | 'io_failed' | 'security_rejected';
const unsafe = (stage: GateStage = 'unknown', reason: GateReason = 'rejected', detail?: object): never => {
  throw new Error('MAINTENANCE_GATE_UNSAFE', {
    cause: Object.freeze({ component: 'maintenance_gate', stage, reason, ...(detail ? { detail } : {}) }),
  });
};
const busy = (): never => { throw new Error('MAINTENANCE_GATE_BUSY'); };

/** Retain only the fixed local-security diagnostic, never the native error. */
export function extractPrivateDirectoryDetail(error: unknown): Readonly<{
  component: 'private_directory'; operation: 'verify_installation';
  reason: 'timeout' | 'output_limit' | 'spawn_missing' | 'spawn_denied' | 'helper_rejected' | 'unknown';
}> | undefined {
  if (!(error instanceof Error) || error.message !== 'Data directory permissions unavailable or unsafe')
    return undefined;
  try {
    const source = error.cause;
    if (source === null || typeof source !== 'object' ||
        Reflect.ownKeys(source).sort().join(',') !== 'component,operation,reason') return undefined;
    const fields = Object.getOwnPropertyDescriptors(source);
    const component = fields.component?.value;
    const operation = fields.operation?.value;
    const reason = fields.reason?.value;
    if (component !== 'private_directory' || operation !== 'verify_installation' ||
        typeof reason !== 'string' ||
        !['timeout', 'output_limit', 'spawn_missing', 'spawn_denied', 'helper_rejected', 'unknown']
          .includes(reason)) return undefined;
    return Object.freeze({ component: 'private_directory', operation: 'verify_installation',
      reason: reason as 'timeout' | 'output_limit' | 'spawn_missing' | 'spawn_denied' |
        'helper_rejected' | 'unknown' });
  } catch { return undefined; }
}

function isBusy(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'errcode' in error &&
    (error.errcode === 5 || error.errcode === 6);
}

function privateRoot(root: string): string {
  let stage: GateStage = 'root_shape';
  try {
    if (typeof root !== 'string' || !isAbsolute(root) || root !== resolve(root) || root.endsWith(sep) ||
      root === parse(root).root) unsafe(stage, 'invalid');
    stage = 'root_lstat';
    let current = root;
    while (true) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe(stage, 'invalid');
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
    stage = 'root_realpath';
    const canonical = realpathSync.native(root);
    if (process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US') :
      canonical !== root) unsafe(stage, 'invalid');
    stage = 'root_acl';
    assertPrivateInstallationDirectory(root);
    return root;
  } catch (error) {
    if (error instanceof Error && error.message === 'MAINTENANCE_GATE_UNSAFE') throw error;
    const detail = extractPrivateDirectoryDetail(error);
    const reason: GateReason = stage === 'root_acl' ? 'security_rejected' :
      error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'io_failed';
    return unsafe(stage, reason, detail);
  }
}

function gateFile(root: string, checkHeader = true): string {
  const file = join(privateRoot(root), gateName);
  let stage: GateStage = 'gate_lstat';
  let reason: GateReason = 'io_failed';
  try {
    const stat = lstatSync(file);
    stage = 'gate_shape'; reason = 'rejected';
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) unsafe();
    stage = 'gate_sidecars'; reason = 'rejected';
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { lstatSync(`${file}${suffix}`); unsafe(); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
        unsafe();
      }
    }
    stage = 'gate_acl'; reason = 'security_rejected';
    assertPrivateInstallationDirectory(root, file);
    if (checkHeader) {
      stage = 'gate_header'; reason = 'rejected';
      if (stat.size < 100) unsafe();
      const fd = openSync(file, 'r');
      try {
        const header = Buffer.alloc(100);
        if (readSync(fd, header, 0, header.length, 0) !== header.length ||
          header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
          header[18] !== 1 || header[19] !== 1) unsafe();
      } finally { closeSync(fd); }
    }
    return file;
  } catch (error) { return unsafe(stage, reason, extractPrivateDirectoryDetail(error)); }
}

function validateGate(db: DatabaseSync, schema: 'main' | 'gate' = 'main'): void {
  const mode = db.prepare(`PRAGMA ${schema}.journal_mode`).get() as { journal_mode?: unknown } | undefined;
  if (mode?.journal_mode !== 'delete') unsafe();
  const schemas = db.prepare(`SELECT type, name, sql FROM ${schema}.sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2`).all() as
    Array<{ type: unknown; name: unknown; sql: unknown }>;
  if (schemas.length !== 1 || schemas[0]?.type !== 'table' || schemas[0].name !== 'lifecycle_marker' ||
      schemas[0].sql !== markerSql) unsafe();
  const rows = db.prepare(`SELECT id, version, marker FROM ${schema}.lifecycle_marker LIMIT 2`).all() as
    Array<{ id: unknown; version: unknown; marker: unknown }>;
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].version !== 1 ||
      rows[0].marker !== 'rcac-managed-lifecycle-v1') unsafe();
}

/** Initialize only a new, caller-created and already protected managed root. */
export function initializeMaintenanceGate(root: string): void {
  privateRoot(root);
  try { if (readdirSync(root).length !== 0) unsafe(); }
  catch { unsafe('init_root_empty', 'rejected'); }
  const file = join(root, gateName);
  try {
    const fd = openSync(file, 'wx', 0o600);
    closeSync(fd);
  } catch { unsafe('init_file_create', 'io_failed'); }
  gateFile(root, false);
  let db: DatabaseSync | undefined;
  let stage: GateStage = 'init_db_open';
  let reason: GateReason = 'io_failed';
  try {
    db = new DatabaseSync(file, { timeout: 0 });
    stage = 'init_journal_mode'; reason = 'rejected';
    const mode = db.prepare('PRAGMA journal_mode=DELETE').get() as { journal_mode?: unknown } | undefined;
    if (mode?.journal_mode !== 'delete') unsafe();
    stage = 'init_begin'; reason = 'io_failed';
    db.exec('BEGIN EXCLUSIVE');
    stage = 'init_schema';
    db.exec(markerSql);
    stage = 'init_marker';
    db.prepare('INSERT INTO lifecycle_marker (id, version, marker) VALUES (1, 1, ?)')
      .run('rcac-managed-lifecycle-v1');
    stage = 'init_commit';
    db.exec('COMMIT');
    stage = 'init_validate'; reason = 'rejected';
    validateGate(db);
    stage = 'init_close'; reason = 'io_failed';
    db.close(); db = undefined;
  } catch {
    if (db) {
      try { db.exec('ROLLBACK'); } catch { /* A failed initialization remains an unsafe gate. */ }
      try { db.close(); } catch { /* Do not replace or delete the gate. */ }
    }
    unsafe(stage, reason);
  }
  gateFile(root);
}

interface MaintenanceGateHandle { release(): void }

function acquire(root: string, mode: 'runtime' | 'exclusive'): MaintenanceGateHandle {
  const file = gateFile(root);
  let db: DatabaseSync | undefined;
  let begun = false;
  try {
    // mode=rw forbids SQLite from recreating a removed gate while allowing an actual EXCLUSIVE lock.
    db = mode === 'runtime' ? new DatabaseSync(file, { readOnly: true, timeout: 0 }) :
      new DatabaseSync(':memory:', { timeout: 0 });
    if (mode === 'exclusive') db.prepare('ATTACH DATABASE ? AS gate')
      .run(`${pathToFileURL(file).href}?mode=rw`);
    db.exec(mode === 'runtime' ? 'BEGIN' : 'BEGIN EXCLUSIVE');
    begun = true;
    // The bounded sqlite_schema read inside validateGate obtains the real SHARED lock.
    const schema = mode === 'runtime' ? 'main' : 'gate';
    validateGate(db, schema);
    let releaseState: 'held' | 'released' | 'failed' = 'held';
    const held = db;
    return { release(): void {
      if (releaseState === 'released') return;
      if (releaseState === 'failed') unsafe();
      let failed = false;
      try { held.exec('ROLLBACK'); } catch { failed = true; }
      try { held.close(); }
      catch { releaseState = 'failed'; unsafe(); }
      releaseState = 'released';
      if (failed) unsafe();
    } };
  } catch (error) {
    if (db) {
      if (begun) { try { db.exec('ROLLBACK'); } catch { /* fail closed */ } }
      try { db.close(); } catch { /* fail closed */ }
    }
    if (isBusy(error)) return busy();
    return unsafe();
  }
}

export function acquireRuntimeMaintenanceGate(root: string): MaintenanceGateHandle {
  return acquire(root, 'runtime');
}

export function acquireExclusiveMaintenanceGate(root: string): MaintenanceGateHandle {
  return acquire(root, 'exclusive');
}

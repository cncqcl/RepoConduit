import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { validateFileOrigins, validateFileSourcePolicy, type FileSourcePolicy } from '../adapters/mcp/platform-file-download.js';
import { authorize, type RequestContext } from '../core/policy/authorize.js';
import { assertActiveInstallation, type InstallationRuntime } from '../runtime/installation.js';
import { assertPrivateDataDirectory } from '../runtime/local-security.js';

export type DailyBinding = { principal: string; audience: string; recipient: string; allowedFileOrigins: string[];
  fileSourcePolicy?: FileSourcePolicy; codexRuntimeSource?: DailyCodexRuntimeSource };
export type DailyCodexRuntimeSource = { dataDirectory: string; workspaceId: string; profileRevision: string };
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
export function parseDailyCodexRuntimeSource(value: unknown): DailyCodexRuntimeSource {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'dataDirectory,profileRevision,workspaceId')
    throw new Error('Invalid daily connection');
  const source = value as Record<string, unknown>;
  if (typeof source.dataDirectory !== 'string' || !isAbsolute(source.dataDirectory) ||
      !name(source.workspaceId) || !name(source.profileRevision)) throw new Error('Invalid daily connection');
  return { dataDirectory: source.dataDirectory, workspaceId: source.workspaceId, profileRevision: source.profileRevision };
}
export function parseDailyBinding(value: unknown): DailyBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid daily connection');
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some(key => !['principal', 'audience', 'recipient', 'allowedFileOrigins', 'fileSourcePolicy', 'codexRuntimeSource'].includes(key)) ||
      !['principal', 'audience', 'recipient'].every(key => typeof b[key] === 'string' && Boolean((b[key] as string).trim()))) {
    throw new Error('Invalid daily connection');
  }
  const fileSourcePolicy = validateFileSourcePolicy(b.fileSourcePolicy);
  return { principal: b.principal as string, audience: b.audience as string, recipient: b.recipient as string,
    allowedFileOrigins: validateFileOrigins(b.allowedFileOrigins), ...(fileSourcePolicy ? { fileSourcePolicy } : {}),
    ...(b.codexRuntimeSource === undefined ? {} : { codexRuntimeSource: parseDailyCodexRuntimeSource(b.codexRuntimeSource) }) };
}

export function readDailyBinding(root: string): DailyBinding {
  const file = join(root, 'daily-binding.json'); const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error('Invalid daily connection');
  assertPrivateDataDirectory(root, file);
  return parseDailyBinding(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

export type DailyOriginReport = { configured: true; allowedFileOrigins: string[];
  fileSourcePolicy?: FileSourcePolicy;
  restartRequired: true; saveStatus: 'saved' | 'unchanged' | 'saved-but-cleanup-unconfirmed' };
function unknownSave(): Error {
  return Object.assign(new Error('Daily binding save outcome unknown'), { code: 'UNKNOWN' });
}
export function dailyOriginConflict(error: unknown): unknown {
  const value = error as { errcode?: unknown; message?: unknown };
  return value?.errcode === 5 || value?.errcode === 6 ||
    typeof value?.message === 'string' && /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/u.test(value.message)
    ? Object.assign(new Error('CONFLICT', { cause: error }), { code: 'CONFLICT' }) : error;
}

type DailyBindingFaults = { beforeOpen?: (path: string) => void; beforeClose?: (fd: number) => void;
  beforeRename?: () => void; afterRename?: () => void };

export function addDailyFileOriginsWithinInstallation(runtime: InstallationRuntime,
  localAdmin: RequestContext, origins: readonly string[],
  faults?: DailyBindingFaults): DailyOriginReport {
  return updateDailyFilePolicy(runtime, localAdmin, origins, false, faults);
}

export function enableDailyChatGPTFilesWithinInstallation(runtime: InstallationRuntime,
  localAdmin: RequestContext, faults?: DailyBindingFaults): DailyOriginReport {
  return updateDailyFilePolicy(runtime, localAdmin, [], true, faults);
}
export function setDailyCodexRuntimeSourceWithinInstallation(runtime: InstallationRuntime,
  localAdmin: RequestContext, source: DailyCodexRuntimeSource, faults?: DailyBindingFaults): DailyOriginReport {
  return updateDailyFilePolicy(runtime, localAdmin, [], false, faults, parseDailyCodexRuntimeSource(source));
}

/** One short write lock protects exact-origin appends and explicit source-policy enablement. */
function updateDailyFilePolicy(runtime: InstallationRuntime, localAdmin: RequestContext,
  origins: readonly string[], enableChatGPT: boolean, faults?: DailyBindingFaults,
  codexRuntimeSource?: DailyCodexRuntimeSource): DailyOriginReport {
  assertActiveInstallation(runtime);
  if (localAdmin.surface !== 'local_admin' || !origins.length && !enableChatGPT && !codexRuntimeSource) throw new Error('NOT_AVAILABLE');
  const requested = validateFileOrigins([...new Set(origins)]);
  const root = runtime.dataDirectory;
  assertPrivateDataDirectory(root);
  let store: SqliteStore | undefined;
  let db: DatabaseSync | undefined;
  let inTransaction = false;
  let renamed = false;
  let temp: string | undefined;
  let ownedTemp = false;
  let primary: unknown;
  let merged: string[] | undefined;
  let expectedBinding: DailyBinding | undefined;
  let unchanged = false;
  const cleanupErrors: unknown[] = [];
  try {
    const state = join(root, 'state.sqlite');
    store = new SqliteStore(state);
    db = new DatabaseSync(state);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    inTransaction = true;
    authorize({ ...localAdmin, now: new Date() }, 'admin.grant', { workspaceId: 'management' },
      store.grantsFor(localAdmin.principal, localAdmin.audience));
    const binding = readDailyBinding(root);
    if (codexRuntimeSource && binding.codexRuntimeSource &&
        JSON.stringify(binding.codexRuntimeSource) !== JSON.stringify(codexRuntimeSource)) throw new Error('CONFLICT');
    merged = validateFileOrigins([...binding.allowedFileOrigins,
      ...requested.filter(origin => !binding.allowedFileOrigins.includes(origin))]);
    expectedBinding = { ...binding, allowedFileOrigins: merged,
      ...(enableChatGPT ? { fileSourcePolicy: 'chatgpt-official-v1' } : {}),
      ...(codexRuntimeSource ? { codexRuntimeSource } : {}) };
    unchanged = merged.length === binding.allowedFileOrigins.length &&
      (!enableChatGPT || binding.fileSourcePolicy === 'chatgpt-official-v1') &&
      (!codexRuntimeSource || binding.codexRuntimeSource !== undefined);
    if (!unchanged) {
      const serialized = JSON.stringify(expectedBinding);
      if (Buffer.byteLength(serialized, 'utf8') > 16384) throw new Error('NOT_AVAILABLE');
      temp = join(root, `daily-binding.${randomUUID()}.tmp`);
      faults?.beforeOpen?.(temp);
      const fd = openSync(temp, 'wx', 0o600);
      ownedTemp = true;
      let writeError: unknown;
      try { writeFileSync(fd, serialized); fsyncSync(fd); }
      catch (error) { writeError = error; }
      faults?.beforeClose?.(fd);
      try { closeSync(fd); }
      catch (error) { throw new AggregateError(writeError === undefined ? [error] : [writeError, error],
        'Daily binding temporary file close unconfirmed', { cause: error }); }
      if (writeError !== undefined) throw writeError;
      assertPrivateDataDirectory(root, temp);
      faults?.beforeRename?.();
      renameSync(temp, join(root, 'daily-binding.json'));
      renamed = true; temp = undefined; ownedTemp = false;
      faults?.afterRename?.();
    }
    db.exec('COMMIT'); inTransaction = false;
  } catch (error) {
    primary = error;
    if (inTransaction) {
      try { db?.exec('ROLLBACK'); }
      catch (rollbackError) { cleanupErrors.push(rollbackError); }
    }
  }
  if (temp && ownedTemp) {
    try { unlinkSync(temp); } catch (error) { cleanupErrors.push(error); }
  }
  try { db?.close(); } catch (error) { cleanupErrors.push(error); }
  try { store?.close(); } catch (error) { cleanupErrors.push(error); }
  if (renamed && (primary !== undefined || cleanupErrors.length)) {
    try {
      const observed = readDailyBinding(root);
      if (JSON.stringify(observed) === JSON.stringify(expectedBinding)) {
        return { configured: true, allowedFileOrigins: observed.allowedFileOrigins,
          ...(observed.fileSourcePolicy ? { fileSourcePolicy: observed.fileSourcePolicy } : {}),
          restartRequired: true, saveStatus: 'saved-but-cleanup-unconfirmed' };
      }
    } catch { /* The file outcome is unknown; never claim rollback after rename. */ }
    throw unknownSave();
  }
  if (cleanupErrors.length) throw new AggregateError(primary === undefined ? cleanupErrors : [primary, ...cleanupErrors],
    'Daily binding cleanup unconfirmed');
  if (primary !== undefined) throw dailyOriginConflict(primary);
  return { configured: true, allowedFileOrigins: merged!, restartRequired: true,
    ...(expectedBinding?.fileSourcePolicy ? { fileSourcePolicy: expectedBinding.fileSourcePolicy } : {}),
    saveStatus: unchanged ? 'unchanged' : 'saved' };
}

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { detectRecognizedMediaType } from '../core/artifact/media.js';
import { validateArtifactPaths } from '../core/artifact/paths.js';
import { inspectZip } from '../core/artifact/zip.js';
import type { ArtifactFile, BundleInput, BundleManifest, DeliveryState } from '../core/artifact/types.js';
import { assertActiveInstallationMaintenance, retainInstallationMaintenance,
  type InstallationMaintenance } from './installation.js';

const MAX_ROWS = 10_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DATASET_WORK_BYTES = 2 * 1024 * 1024 * 1024;
type Reason = 'state' | 'scope' | 'limit' | 'storage';
type Json = Record<string, unknown>;
interface BundleRow { id: string; workspace_id: string; collaboration_id: string; parent_id: string | null;
  input_json: string; manifest_json: string | null; published_seq: number | null;
  integrity_status: string | null; aborted_state_json: string | null }
interface FileRow { bundle_id: string; path: string; sha256: string; size_bytes: number;
  media_type: string; source_receipt: string; source_identity: string | null }

function unsafe(reason: Reason): never {
  throw new Error('INSTALLATION_ARTIFACTS_UNSAFE', { cause: Object.freeze({
    component: 'installation_artifact_preflight', reason,
  }) });
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsafe('state');
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) unsafe('state');
  return value;
}
function id(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) unsafe('scope');
  return result;
}
function parsed(value: unknown, budget: { bytes: number }, count = false): Json {
  if (typeof value !== 'string') unsafe('state');
  if (count) budget.bytes += Buffer.byteLength(value, 'utf8');
  if (budget.bytes > MAX_JSON_BYTES) unsafe('limit');
  try { return object(JSON.parse(value) as unknown); }
  catch { return unsafe('state'); }
}
function fileList(value: unknown): ArtifactFile[] {
  if (!Array.isArray(value) || value.length > 256) unsafe('limit');
  const files = value.map(item => {
    const entry = object(item);
    if (!Number.isSafeInteger(entry.actualSizeBytes) || (entry.actualSizeBytes as number) < 0 ||
        (entry.actualSizeBytes as number) > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(String(entry.sha256)) ||
        typeof entry.mediaType !== 'string' || !entry.mediaType ||
        typeof entry.sourceReceipt !== 'string' || !entry.sourceReceipt ||
        (entry.sourceIdentity !== undefined && !/^[a-f0-9]{64}$/.test(String(entry.sourceIdentity)))) unsafe('state');
    return entry as unknown as ArtifactFile;
  });
  try { validateArtifactPaths(files.map(file => file.normalizedRelativePath)); }
  catch { unsafe('scope'); }
  return files;
}
function input(value: unknown, row: BundleRow): BundleInput {
  const found = object(value);
  if (id(found.bundleId) !== id(row.id) || string(found.workspaceId) !== string(row.workspace_id) ||
      string(found.collaborationId) !== string(row.collaboration_id) ||
      typeof found.contextRevision !== 'string' || !found.contextRevision ||
      (found.parentBundleId ?? null) !== row.parent_id || !Array.isArray(found.snapshotRefs) ||
      !found.snapshotRefs.length || found.snapshotRefs.some(ref => typeof ref !== 'string' || !ref)) unsafe('scope');
  if (found.expectedPaths !== undefined) {
    if (!Array.isArray(found.expectedPaths) || found.expectedPaths.length > 256) unsafe('limit');
    try { validateArtifactPaths(found.expectedPaths as string[]); }
    catch { unsafe('scope'); }
  }
  return found as unknown as BundleInput;
}
function expectedBasis(value: BundleInput): 'producer_declared' | 'receiver_observed' {
  return value.expectedPaths === undefined ? 'receiver_observed' : 'producer_declared';
}
function missingPaths(inputValue: BundleInput, files: ArtifactFile[]): string[] {
  return (inputValue.expectedPaths ?? []).filter(path => !files.some(file => file.normalizedRelativePath === path));
}
function plainFile(path: string, max: number): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max || stat.size < 0) unsafe('storage');
  return stat;
}
function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe('storage');
}
function readBounded(owner: InstallationMaintenance | undefined, path: string, max: number): Buffer {
  const before = plainFile(path, max);
  const size = before.size;
  let fd: number | undefined;
  let primary: unknown;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size ||
        stat.dev !== before.dev || stat.ino !== before.ino) unsafe('storage');
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read <= 0) unsafe('storage');
      offset += read;
    }
    const after = fstatSync(fd), pathAfter = lstatSync(path);
    if (after.size !== size || pathAfter.size !== size || pathAfter.dev !== stat.dev ||
        pathAfter.ino !== stat.ino || pathAfter.nlink !== 1 || pathAfter.isSymbolicLink()) unsafe('storage');
  } catch { primary = new Error('ARTIFACT_FILE_READ_FAILED'); }
  if (fd !== undefined) {
    try { closeSync(fd); }
    catch {
      if (owner) retainInstallationMaintenance(owner);
      const close = new Error('ARTIFACT_FILE_CLOSE_UNCONFIRMED');
      throw new AggregateError(primary === undefined ? [close] : [primary, close],
        'Installation artifact file close unconfirmed', { cause: close });
    }
  }
  if (primary !== undefined) throw primary;
  return bytes!;
}
function objectBytes(owner: InstallationMaintenance | undefined, root: string, hash: string, size: number): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) unsafe('state');
  const objects = join(root, 'objects');
  directory(objects);
  const shard = join(objects, hash.slice(0, 2));
  directory(shard);
  const bytes = readBounded(owner, join(shard, hash), MAX_FILE_BYTES);
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== hash) unsafe('storage');
  return bytes;
}
interface VerifiedObject { size: number; detected: string | null; zipExpanded: number; zipEntries: number }
class ObjectVerifier {
  private readonly declared = new Map<string, number>();
  private readonly verified = new Map<string, VerifiedObject>();
  private declaredBytes = 0;
  private workBytes = 0;
  private workEntries = 0;
  constructor(private readonly owner: InstallationMaintenance | undefined, private readonly root: string) {}

  declare(hash: string, size: number): void {
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) unsafe('state');
    const existing = this.declared.get(hash);
    if (existing !== undefined) {
      if (existing !== size) unsafe('state');
      return;
    }
    this.declaredBytes += size;
    if (this.declaredBytes > MAX_DATASET_WORK_BYTES) unsafe('limit');
    this.declared.set(hash, size);
  }

  private get(hash: string, size: number): VerifiedObject {
    if (this.declared.get(hash) !== size) unsafe('state');
    const cached = this.verified.get(hash);
    if (cached) {
      if (cached.size !== size) unsafe('state');
      return cached;
    }
    this.workBytes += size;
    if (this.workBytes > MAX_DATASET_WORK_BYTES) unsafe('limit');
    const bytes = objectBytes(this.owner, this.root, hash, size);
    const detected = detectRecognizedMediaType(bytes);
    const zip = detected === 'application/zip' ? inspectZip(bytes) : null;
    this.workBytes += zip?.expandedBytes ?? 0;
    this.workEntries += 1 + (zip?.entryCount ?? 0);
    if (this.workBytes > MAX_DATASET_WORK_BYTES || this.workEntries > MAX_ROWS) unsafe('limit');
    const result = { size, detected, zipExpanded: zip?.expandedBytes ?? 0, zipEntries: zip?.entryCount ?? 0 };
    this.verified.set(hash, result);
    return result;
  }

  file(file: ArtifactFile): VerifiedObject {
    const result = this.get(file.sha256, file.actualSizeBytes);
    const type = file.mediaType.toLowerCase().split(';', 1)[0]?.trim();
    const zip = result.detected === 'application/zip';
    if ((file.normalizedRelativePath.toLowerCase().endsWith('.zip') || type === 'application/zip') !== zip ||
        (zip && type !== 'application/zip')) unsafe('state');
    for (const recognized of ['image/png', 'image/jpeg', 'image/gif', 'application/pdf']) {
      if ((type === recognized) !== (result.detected === recognized)) unsafe('state');
    }
    return result;
  }

  manifest(hash: string, size: number): void { this.get(hash, size); }
}
function verifyFiles(verifier: ObjectVerifier, files: ArtifactFile[]): void {
  let expanded = 0;
  let entries = 0;
  for (const file of files) {
    const checked = verifier.file(file);
    expanded += checked.size + checked.zipExpanded;
    entries += 1 + checked.zipEntries;
    if (expanded > 128 * 1024 * 1024 || entries > 256) unsafe('limit');
  }
}
function inspectMarker(owner: InstallationMaintenance | undefined, root: string, row: BundleRow,
  bundleInput: BundleInput, files: ArtifactFile[], manifest: BundleManifest | null,
  abort: DeliveryState | null, budget: { bytes: number }): void {
  const path = join(root, 'staging', `${id(row.id)}.json`);
  let markerBytes: Buffer;
  try { markerBytes = readBounded(owner, path, MAX_JSON_BYTES); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const marker = parsed(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes), budget, true);
  const markerFiles = fileList(marker.files);
  const comparableFiles = manifest ? [...markerFiles].sort((a, b) =>
    a.normalizedRelativePath.localeCompare(b.normalizedRelativePath)) : markerFiles;
  if (!isDeepStrictEqual(marker.input, bundleInput) || marker.expectedSetBasis !== expectedBasis(bundleInput) ||
      (marker.state !== 'staging' && marker.state !== (manifest ? 'published' : 'aborted')) ||
      (marker.state === 'staging' && marker.manifest !== undefined) ||
      (marker.state === 'published' && !isDeepStrictEqual(marker.manifest, manifest)) ||
      (abort !== null && marker.manifest !== undefined) ||
      !isDeepStrictEqual(comparableFiles, files)) unsafe('state');
  if (abort && !isDeepStrictEqual(missingPaths(bundleInput, markerFiles), abort.missingPaths)) unsafe('state');
}

function visitDirectory(owner: InstallationMaintenance | undefined, path: string,
  visit: (name: string) => void): void {
  directory(path);
  const opened = opendirSync(path);
  let primary: unknown;
  try {
    let entry;
    while ((entry = opened.readSync()) !== null) visit(entry.name);
  } catch (error) { primary = error; }
  try { opened.closeSync(); }
  catch {
    if (owner) retainInstallationMaintenance(owner);
    const close = new Error('ARTIFACT_DIRECTORY_CLOSE_UNCONFIRMED');
    throw new AggregateError(primary === undefined ? [close] : [
      primary instanceof Error && primary.message === 'INSTALLATION_ARTIFACTS_UNSAFE' ? primary :
        new Error('ARTIFACT_DIRECTORY_READ_FAILED'), close],
    'Installation artifact directory close unconfirmed', { cause: close });
  }
  if (primary !== undefined) throw primary;
}
function inventory(owner: InstallationMaintenance | undefined, root: string,
  known: Set<string>, initial: number): void {
  let entries = initial;
  const account = () => { if (++entries > MAX_ROWS) unsafe('limit'); };
  visitDirectory(owner, root, entry => {
    account();
    if (!['staging', 'objects', 'idempotency-locks', 'export-locks'].includes(entry)) unsafe('state');
  });
  const staging = join(root, 'staging');
  visitDirectory(owner, staging, entry => {
    account();
    const match = /^([A-Za-z0-9_-]{1,128})\.(json|lock)$/.exec(entry);
    if (!match || !known.has(match[1]!)) unsafe('state');
    plainFile(join(staging, entry), MAX_JSON_BYTES);
  });
  for (const name of ['idempotency-locks', 'export-locks']) {
    const path = join(root, name);
    visitDirectory(owner, path, entry => {
      account();
      if (!/^[a-f0-9]{64}\.lock$/.test(entry)) unsafe('state');
      plainFile(join(path, entry), MAX_JSON_BYTES);
    });
  }
  const objects = join(root, 'objects');
  visitDirectory(owner, objects, shard => {
    account();
    if (!/^[a-f0-9]{2}$/.test(shard)) unsafe('state');
    const path = join(objects, shard);
    visitDirectory(owner, path, entry => {
      account();
      if (!/^[a-f0-9]{64}$/.test(entry) || entry.slice(0, 2) !== shard) unsafe('state');
      plainFile(join(path, entry), MAX_FILE_BYTES);
    });
  });
}

function measure(db: DatabaseSync, table: 'bundles' | 'bundle_files', columns: readonly string[],
  limit: number): { rows: number; bytes: number } {
  const sum = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
  const selected = columns.join(',');
  const result = db.prepare(`SELECT COUNT(*) AS rows,COALESCE(SUM(${sum}),0) AS bytes
    FROM (SELECT ${selected} FROM ${table} LIMIT ?)`).get(limit) as
    { rows: number; bytes: number } | undefined;
  if (!result || !Number.isSafeInteger(result.rows) || !Number.isSafeInteger(result.bytes) ||
      result.rows < 0 || result.bytes < 0 || result.rows >= limit) unsafe('limit');
  return result;
}

function inspectDataset(db: DatabaseSync, data: string, owner?: InstallationMaintenance): void {
  try {
    db.exec('PRAGMA query_only=ON');
    const bundleColumns = ['id', 'workspace_id', 'collaboration_id', 'parent_id',
      'input_json', 'manifest_json', 'published_seq', 'integrity_status', 'aborted_state_json'] as const;
    const fileColumns = ['bundle_id', 'path', 'sha256', 'size_bytes', 'media_type',
      'source_receipt', 'source_identity'] as const;
    const bundleMeasure = measure(db, 'bundles', bundleColumns, MAX_ROWS + 1);
    if (bundleMeasure.bytes > MAX_JSON_BYTES) unsafe('limit');
    const fileMeasure = measure(db, 'bundle_files', fileColumns, MAX_ROWS - bundleMeasure.rows + 1);
    if (bundleMeasure.bytes + fileMeasure.bytes > MAX_JSON_BYTES) unsafe('limit');
    const rows = db.prepare('SELECT id,workspace_id,collaboration_id,parent_id,input_json,manifest_json,published_seq,integrity_status,aborted_state_json FROM bundles LIMIT ?')
      .all(MAX_ROWS + 1) as unknown as BundleRow[];
    if (rows.length > MAX_ROWS) unsafe('limit');
    const fileRows = db.prepare('SELECT bundle_id,path,sha256,size_bytes,media_type,source_receipt,source_identity FROM bundle_files LIMIT ?')
      .all(MAX_ROWS - rows.length + 1) as unknown as FileRow[];
    if (rows.length + fileRows.length > MAX_ROWS) unsafe('limit');
    const root = join(data, 'artifact-objects');
    let rootPresent = true;
    try { directory(root); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') rootPresent = false;
      else throw error;
    }
    if (!rootPresent && rows.length) unsafe('storage');
    const known = new Set(rows.map(row => id(row.id)));
    if (rootPresent) inventory(owner, root, known, rows.length + fileRows.length);
    const indexed = new Map<string, FileRow[]>();
    for (const file of fileRows) {
      if (!known.has(id(file.bundle_id))) unsafe('scope');
      const list = indexed.get(file.bundle_id) ?? [];
      list.push(file);
      indexed.set(file.bundle_id, list);
    }
    const seq = new Set<number>();
    const budget = { bytes: bundleMeasure.bytes + fileMeasure.bytes };
    const verifier = new ObjectVerifier(owner, root);
    const facts: { files: ArtifactFile[]; manifest?: { hash: string; size: number } }[] = [];
    for (const row of rows) {
      const bundleInput = input(parsed(row.input_json, budget), row);
      const hasManifest = row.manifest_json !== null;
      const hasAbort = row.aborted_state_json !== null;
      if (hasManifest === hasAbort) unsafe('state');
      const storedFiles = indexed.get(row.id) ?? [];
      let manifest: BundleManifest | null = null;
      let abort: DeliveryState | null = null;
      let files: ArtifactFile[];
      let manifestObject: { hash: string; size: number } | undefined;
      if (hasManifest) {
        const found = parsed(row.manifest_json, budget);
        files = fileList(found.files);
        if (!isDeepStrictEqual({ ...bundleInput, expectedSetBasis: expectedBasis(bundleInput), files,
          semanticStatus: 'not_reviewed' }, found) ||
            !Number.isSafeInteger(row.published_seq) || (row.published_seq ?? 0) < 1 ||
            seq.has(row.published_seq!) || row.integrity_status !== 'ok' || files.length === 0 ||
            storedFiles.length !== files.length) unsafe('state');
        seq.add(row.published_seq!);
        manifest = found as unknown as BundleManifest;
        if (!isDeepStrictEqual(files, [...files].sort((a, b) => a.normalizedRelativePath.localeCompare(b.normalizedRelativePath))) ||
            missingPaths(bundleInput, files).length) unsafe('state');
        for (const file of files) {
          const stored = storedFiles.find(item => item.path === file.normalizedRelativePath);
          if (!stored || stored.sha256 !== file.sha256 || stored.size_bytes !== file.actualSizeBytes ||
              stored.media_type !== file.mediaType || stored.source_receipt !== file.sourceReceipt ||
              stored.source_identity !== (file.sourceIdentity ?? null)) unsafe('state');
        }
        const manifestBytes = Buffer.from(JSON.stringify(manifest));
        manifestObject = { hash: createHash('sha256').update(manifestBytes).digest('hex'), size: manifestBytes.length };
      } else {
        if (row.published_seq !== null || row.integrity_status !== null || storedFiles.length) unsafe('state');
        const found = parsed(row.aborted_state_json, budget);
        files = fileList(found.files);
        if (found.state !== 'aborted' || !Array.isArray(found.missingPaths) ||
            !isDeepStrictEqual(found.missingPaths, missingPaths(bundleInput, files))) unsafe('state');
        abort = found as unknown as DeliveryState;
      }
      inspectMarker(owner, root, row, bundleInput, files, manifest, abort, budget);
      for (const file of files) verifier.declare(file.sha256, file.actualSizeBytes);
      if (manifestObject) verifier.declare(manifestObject.hash, manifestObject.size);
      facts.push({ files, ...(manifestObject ? { manifest: manifestObject } : {}) });
    }
    for (const fact of facts) {
      verifyFiles(verifier, fact.files);
      if (fact.manifest) verifier.manifest(fact.manifest.hash, fact.manifest.size);
    }
  } catch (error) {
    if (error instanceof AggregateError ||
        (error instanceof Error && error.message === 'INSTALLATION_ARTIFACTS_UNSAFE')) throw error;
    return unsafe('storage');
  }
}

/** Validate a caller-selected private dataset. Caller owns read-only database lifecycle and selected path. */
export function inspectInstallationArtifactDataset(db: DatabaseSync, dataDirectory: string): void {
  inspectDataset(db, dataDirectory);
}

/** Inspect a live managed installation while holding its exclusive maintenance owner. */
export function assertInstallationArtifactsConsistent(owner: InstallationMaintenance): void {
  assertActiveInstallationMaintenance(owner);
  let db: DatabaseSync | undefined;
  let primary: unknown;
  try {
    const file = join(owner.dataDirectory, 'state.sqlite');
    plainFile(file, Number.MAX_SAFE_INTEGER);
    db = new DatabaseSync(file, { readOnly: true });
    inspectDataset(db, owner.dataDirectory, owner);
  } catch (error) { primary = error; }
  try { db?.close(); }
  catch {
    retainInstallationMaintenance(owner);
    throw new AggregateError(primary === undefined ? [new Error('INSTALLATION_ARTIFACTS_CLOSE_UNCONFIRMED')] :
      [primary, new Error('INSTALLATION_ARTIFACTS_CLOSE_UNCONFIRMED')],
    'Installation artifact inspection close unconfirmed');
  }
  if (primary !== undefined) throw primary;
}

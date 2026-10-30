import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { normalizeArtifactPath, validateArtifactPaths } from '../../core/artifact/paths.js';
import { validateArtifactBytes } from '../../core/artifact/media.js';
import { inspectZip } from '../../core/artifact/zip.js';
import type { ArtifactFile, BundleInput, BundleManifest, DeliveryState } from '../../core/artifact/types.js';

interface StoredBundle { input: BundleInput; expectedSetBasis: 'producer_declared' | 'receiver_observed'; state: 'staging' | 'published' | 'aborted'; files: ArtifactFile[]; manifest?: BundleManifest }

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid bundle identifier');
  return id;
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx');
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

function checkLockFile(path: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Artifact lock directory or invalid file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function withFileLock<T>(path: string, timeoutMessage: string, action: () => Promise<T>): Promise<T> {
  checkLockFile(path);
  const lock = new DatabaseSync(path, { timeout: 0 });
  try {
    checkLockFile(path);
    const deadline = Date.now() + 10_000;
    while (true) {
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        const sqlite = error as { code?: string; errcode?: number };
        if (sqlite.code !== 'ERR_SQLITE_ERROR' || sqlite.errcode !== 5) throw error;
        if (Date.now() >= deadline) throw new Error(timeoutMessage, { cause: error });
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    try { return await action(); }
    finally { lock.exec('ROLLBACK'); }
  } finally { lock.close(); }
}

/** Filesystem half of bundle delivery. The application supplies an idempotent DB publication transaction. */
export class ArtifactObjects {
  constructor(private readonly root: string) {
    mkdirSync(join(root, 'staging'), { recursive: true });
    mkdirSync(join(root, 'objects'), { recursive: true });
    mkdirSync(join(root, 'idempotency-locks'), { recursive: true });
    mkdirSync(join(root, 'export-locks'), { recursive: true });
  }

  private bundlePath(id: string): string { return join(this.root, 'staging', `${safeId(id)}.json`); }
  /** SQLite file lock shared by coordinator processes and released when a holder exits. */
  async withProcessLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, 'staging', `${safeId(id)}.lock`);
    return withFileLock(lockPath, 'Bundle is locked; recovery required', action);
  }
  /** Cross-process mutation lock with a namespace separate from user-selected bundle IDs. */
  async withIdempotencyLock<T>(hash: string, action: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid idempotency lock hash');
    const lockPath = join(this.root, 'idempotency-locks', `${hash}.lock`);
    return withFileLock(lockPath, 'Idempotency scope is locked; recovery required', action);
  }
  /** Export names use a separate namespace from bundle and idempotency locks. */
  async withExportNameLock<T>(hash: string, action: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid export lock hash');
    const lockPath = join(this.root, 'export-locks', `${hash}.lock`);
    return withFileLock(lockPath, 'Export name is locked; recovery required', action);
  }
  private loadIfPresent(id: string): StoredBundle | null {
    try { return JSON.parse(readFileSync(this.bundlePath(id), 'utf8')) as StoredBundle; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private load(id: string): StoredBundle {
    const bundle = this.loadIfPresent(id);
    if (!bundle) throw new Error('Unknown bundle');
    return bundle;
  }
  private save(id: string, value: StoredBundle): void { atomicJson(this.bundlePath(id), value); }

  begin(input: BundleInput): DeliveryState {
    const path = this.bundlePath(input.bundleId);
    if (!input.workspaceId || !input.collaborationId || !input.contextRevision || !Array.isArray(input.snapshotRefs)) throw new Error('Incomplete bundle identity');
    const expectedPaths = input.expectedPaths === undefined ? undefined : validateArtifactPaths(input.expectedPaths);
    if (expectedPaths && expectedPaths.length > 256) throw new Error('Bundle file count exceeded');
    const normalized: BundleInput = { ...input, ...(expectedPaths === undefined ? {} : { expectedPaths }) };
    if (existsSync(path)) {
      const existing = this.load(input.bundleId);
      if (JSON.stringify(existing.input) !== JSON.stringify(normalized)) throw new Error('Bundle input conflict');
      return this.status(input.bundleId);
    }
    if (input.parentBundleId) {
      const parent = this.load(input.parentBundleId);
      if (parent.state !== 'published' || parent.input.workspaceId !== input.workspaceId || parent.input.collaborationId !== input.collaborationId) throw new Error('Invalid bundle parent');
    }
    this.save(input.bundleId, { input: normalized, expectedSetBasis: expectedPaths === undefined ? 'receiver_observed' : 'producer_declared', state: 'staging', files: [] });
    return this.status(input.bundleId);
  }

  status(id: string): DeliveryState {
    const bundle = this.load(id);
    return { state: bundle.state, files: bundle.files, missingPaths: (bundle.input.expectedPaths ?? []).filter((path) => !bundle.files.some((file) => file.normalizedRelativePath === path)) };
  }

  statusIfPresent(id: string): DeliveryState | null {
    const bundle = this.loadIfPresent(id);
    return bundle ? { state: bundle.state, files: bundle.files, missingPaths: (bundle.input.expectedPaths ?? []).filter((path) => !bundle.files.some((file) => file.normalizedRelativePath === path)) } : null;
  }

  /** DB abort receipt is authoritative. A missing marker can be rebuilt after a DB commit. */
  abort(id: string, input: BundleInput, receipt: DeliveryState): void {
    if (receipt.state !== 'aborted' || input.bundleId !== id) throw new Error('CONFLICT');
    const marker = this.loadIfPresent(id);
    const expectedSetBasis = input.expectedPaths === undefined ? 'receiver_observed' : 'producer_declared';
    if (marker && (!isDeepStrictEqual(marker.input, input) || marker.expectedSetBasis !== expectedSetBasis ||
        (marker.state !== 'staging' && marker.state !== 'aborted') || marker.manifest !== undefined ||
        !isDeepStrictEqual(marker.files, receipt.files) ||
        !isDeepStrictEqual(this.status(id).missingPaths, receipt.missingPaths))) throw new Error('CONFLICT');
    if (marker?.state === 'aborted') return;
    this.save(id, marker ? { ...marker, state: 'aborted' } : {
      input, expectedSetBasis, state: 'aborted', files: receipt.files,
    });
  }

  /** Missing/staging marker may reflect an interrupted post-commit update; conflicting content fails closed. */
  inspectAborted(id: string, input: BundleInput, receipt: DeliveryState): void {
    const marker = this.loadIfPresent(id);
    if (!marker) return;
    const expectedSetBasis = input.expectedPaths === undefined ? 'receiver_observed' : 'producer_declared';
    if (receipt.state !== 'aborted' || !isDeepStrictEqual(marker.input, input) ||
        marker.expectedSetBasis !== expectedSetBasis ||
        (marker.state !== 'staging' && marker.state !== 'aborted') || marker.manifest !== undefined ||
        !isDeepStrictEqual(marker.files, receipt.files) ||
        !isDeepStrictEqual(this.status(id).missingPaths, receipt.missingPaths)) throw new Error('CONFLICT');
  }

  /** Repair a marker left staging after the database committed publication. */
  reconcilePublished(id: string, manifest: BundleManifest, publishedInput?: BundleInput): void {
    const bundle = this.loadIfPresent(id);
    try {
      const paths = validateArtifactPaths(manifest.files.map(file => file.normalizedRelativePath));
      if (manifest.expectedPaths) {
        const expected = validateArtifactPaths(manifest.expectedPaths);
        if (expected.length !== paths.length || expected.some(path => !paths.includes(path))) {
          throw new Error('Declared file set incomplete');
        }
      }
      if (bundle) validateArtifactPaths(bundle.files.map(file => file.normalizedRelativePath));
    } catch (error) { throw new Error('Artifact integrity error: invalid path structure', { cause: error }); }
    const manifestInput: BundleInput = {
      bundleId: manifest.bundleId, workspaceId: manifest.workspaceId,
      collaborationId: manifest.collaborationId, contextRevision: manifest.contextRevision,
      snapshotRefs: manifest.snapshotRefs,
      ...(manifest.parentBundleId ? { parentBundleId: manifest.parentBundleId } : {}),
      ...(manifest.expectedPaths ? { expectedPaths: manifest.expectedPaths } : {}),
    };
    if (manifest.bundleId !== id || !isDeepStrictEqual(bundle?.input ?? publishedInput, manifestInput) ||
      (publishedInput !== undefined && !isDeepStrictEqual(publishedInput, manifestInput))) throw new Error('Published bundle input conflict');
    if (bundle && bundle.state !== 'staging' && bundle.state !== 'published') throw new Error('Published bundle state conflict');
    if (manifest.expectedSetBasis !== (manifest.expectedPaths === undefined ? 'receiver_observed' : 'producer_declared')) throw new Error('Published bundle expected set conflict');
    const ordered = [...(bundle?.files ?? manifest.files)].sort((a, b) => a.normalizedRelativePath.localeCompare(b.normalizedRelativePath));
    if (!isDeepStrictEqual(ordered, manifest.files)) throw new Error('Published bundle file conflict');
    if (bundle?.state === 'published' && !isDeepStrictEqual(bundle.manifest, manifest)) throw new Error('Published bundle manifest conflict');
    for (const file of manifest.files) this.verifyObject(file);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    this.verifyObject({ normalizedRelativePath: 'manifest.json', actualSizeBytes: manifestBytes.length,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'), mediaType: 'application/json', sourceReceipt: 'internal' });
    if (bundle?.state === 'published') return;
    this.save(id, bundle ? { ...bundle, state: 'published', manifest } : {
      input: manifestInput, expectedSetBasis: manifest.expectedSetBasis, state: 'published',
      files: manifest.files, manifest,
    });
  }

  objectPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid object hash');
    return join(this.root, 'objects', sha256.slice(0, 2), sha256);
  }

  putText(id: string, path: string, text: string, mediaType: string, sourceReceipt: string): ArtifactFile {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > 1024 * 1024) throw new Error('Text submission budget exceeded');
    return this.putBytes(id, path, bytes, mediaType, sourceReceipt);
  }

  putBytes(id: string, path: string, bytes: Buffer, mediaType: string, sourceReceipt: string, sourceIdentity?: string): ArtifactFile {
    const bundle = this.load(id);
    if (bundle.state !== 'staging') throw new Error('Bundle is immutable');
    const normalized = normalizeArtifactPath(path);
    if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('File budget exceeded');
    if (!mediaType || !sourceReceipt) throw new Error('Missing artifact provenance');
    const key = normalized.toLocaleLowerCase('en-US');
    const colliding = bundle.files.find((file) => file.normalizedRelativePath.toLocaleLowerCase('en-US') === key);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (colliding) {
      if (colliding.normalizedRelativePath !== normalized || colliding.sha256 !== sha256 || colliding.mediaType !== mediaType || colliding.sourceReceipt !== sourceReceipt || colliding.sourceIdentity !== sourceIdentity) throw new Error('Artifact path conflict');
      return colliding;
    }
    validateArtifactPaths([...bundle.files.map(file => file.normalizedRelativePath), normalized]);
    if (bundle.input.expectedPaths && !bundle.input.expectedPaths.includes(normalized)) throw new Error('Artifact path not declared');
    validateArtifactBytes(normalized, bytes, mediaType);
    this.checkBundleBudget(bundle.files, bytes, mediaType);
    const object = this.objectPath(sha256);
    mkdirSync(join(this.root, 'objects', sha256.slice(0, 2)), { recursive: true });
    if (!existsSync(object)) {
      const temp = `${object}.${randomUUID()}.tmp`;
      const fd = openSync(temp, 'wx');
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temp, object); } catch (error) { rmSync(temp, { force: true }); throw error; }
    }
    const file: ArtifactFile = { normalizedRelativePath: normalized, actualSizeBytes: bytes.length, sha256, mediaType, sourceReceipt,
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }) };
    bundle.files.push(file);
    this.save(id, bundle);
    return file;
  }

  /** Publishes only after durable objects exist. `commit` must atomically and idempotently persist the manifest in the application DB. */
  finalize(id: string, commit: (manifest: BundleManifest) => void): BundleManifest {
    const bundle = this.load(id);
    if (bundle.state === 'aborted') throw new Error('Bundle is immutable');
    if (bundle.state === 'published') {
      if (!bundle.manifest) throw new Error('Artifact integrity error: missing manifest');
      this.reconcilePublished(id, bundle.manifest);
      return bundle.manifest;
    }
    const missing = this.status(id).missingPaths;
    if (missing.length) throw new Error(`Bundle missing files: ${missing.join(', ')}`);
    if (bundle.files.length === 0) throw new Error('Empty bundle');
    const paths = validateArtifactPaths(bundle.files.map(file => file.normalizedRelativePath));
    if (bundle.input.expectedPaths) {
      const expected = validateArtifactPaths(bundle.input.expectedPaths);
      if (expected.length !== paths.length || expected.some(path => !paths.includes(path))) {
        throw new Error('Bundle contains a file outside the declared set');
      }
    }
    let expanded = 0;
    let entries = 0;
    for (const file of bundle.files) {
      const bytes = this.verifyObject(file);
      expanded += bytes.length;
      entries++;
      if (file.mediaType.toLowerCase().split(';', 1)[0]?.trim() === 'application/zip') {
        const zip = inspectZip(bytes);
        expanded += zip.expandedBytes;
        entries += zip.entryCount;
      }
    }
    if (expanded > 128 * 1024 * 1024 || entries > 256) throw new Error('Bundle budget exceeded');
    const manifest: BundleManifest = { ...bundle.input, expectedSetBasis: bundle.expectedSetBasis, files: [...bundle.files].sort((a, b) => a.normalizedRelativePath.localeCompare(b.normalizedRelativePath)), semanticStatus: 'not_reviewed' };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
    const manifestObject = this.objectPath(manifestHash);
    mkdirSync(join(this.root, 'objects', manifestHash.slice(0, 2)), { recursive: true });
    if (!existsSync(manifestObject)) {
      const temp = `${manifestObject}.${randomUUID()}.tmp`;
      const fd = openSync(temp, 'wx');
      try { writeFileSync(fd, manifestBytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temp, manifestObject); } catch (error) { rmSync(temp, { force: true }); throw error; }
    }
    commit(manifest);
    bundle.state = 'published';
    bundle.manifest = manifest;
    this.save(id, bundle);
    return manifest;
  }

  private verifyObject(file: ArtifactFile): Buffer {
    const path = this.objectPath(file.sha256);
    if (!existsSync(path)) throw new Error('Artifact integrity error: missing object');
    const bytes = readFileSync(path);
    if (bytes.length !== file.actualSizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Artifact integrity error: corrupt object');
    return bytes;
  }

  private checkBundleBudget(existing: readonly ArtifactFile[], incoming: Buffer, mediaType: string): void {
    let expanded = incoming.length;
    let entries = 1;
    const accountZip = (bytes: Buffer) => {
      const zip = inspectZip(bytes);
      expanded += zip.expandedBytes;
      entries += zip.entryCount;
    };
    if (mediaType.toLowerCase().split(';', 1)[0]?.trim() === 'application/zip') accountZip(incoming);
    for (const file of existing) {
      const bytes = this.verifyObject(file);
      expanded += bytes.length;
      entries++;
      if (file.mediaType.toLowerCase().split(';', 1)[0]?.trim() === 'application/zip') accountZip(bytes);
    }
    if (expanded > 128 * 1024 * 1024 || entries > 256) throw new Error('Bundle budget exceeded');
  }

  readFile(id: string, path: string): Buffer {
    const bundle = this.load(id);
    if (bundle.state !== 'published') throw new Error('Bundle is not published');
    if (!bundle.manifest) throw new Error('Artifact integrity error: missing manifest');
    this.reconcilePublished(id, bundle.manifest);
    const file = bundle.files.find((entry) => entry.normalizedRelativePath === normalizeArtifactPath(path));
    if (!file) throw new Error('Unknown artifact file');
    return this.verifyObject(file);
  }
}

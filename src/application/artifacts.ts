import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactObjects } from '../adapters/storage/objects.js';
import type { LocalArtifactSource } from '../adapters/transfers/local-source.js';
import type { BundleInput, BundleManifest, DeliveryState, ArtifactFile } from '../core/artifact/types.js';
import { normalizeArtifactPath, validateArtifactPaths } from '../core/artifact/paths.js';
import { detectRecognizedMediaType } from '../core/artifact/media.js';
import type { Permit, RequestContext } from '../core/policy/authorize.js';
import type { IdempotencyScope } from '../adapters/storage/sqlite.js';

type Operation = 'artifact.begin' | 'artifact.put_text' | 'artifact.import_reference' | 'artifact.collect_local' | 'artifact.collect_browser' | 'artifact.export' | 'artifact.finalize' | 'artifact.abort' | 'artifact.status' | 'artifact.list' | 'artifact.inspect';
type Binding = { workspaceId: string; collaborationId: string; bundleId: string };
type Request = Binding & { context: RequestContext };
type MutationRequest = Request & { idempotencyKey: string };
export type IntegrityStatus = 'ok' | 'missing' | 'corrupt';
export interface ArtifactRecord { input: BundleInput; manifest?: BundleManifest; abortedState?: DeliveryState; integrityStatus?: IntegrityStatus }
export type ArtifactStatus = DeliveryState & { integrityStatus: IntegrityStatus | null; expectedSetBasis: BundleManifest['expectedSetBasis'] };
export interface ArtifactReferenceTransfer {
  referenceIdentity: string;
  mediaType: string | null;
  acquireBytes(maxBytes: number): Promise<Buffer>;
}
export interface BrowserArtifactSelection {
  nativeSessionId: string; nativeMessageId: string; filename: string;
  attachmentIndex?: number;
  /** Receiver's expected bytes supplement the original host download-completion record. */
  expectedSha256: string; expectedSize: number;
}
export interface BrowserArtifactCollector {
  capture(request: Binding & BrowserArtifactSelection & {
    id: string; path: string; principal: string; audience: string; recipient: string; grantId: string;
    retryOfCaptureId?: string;
    reconcileOnlyCapture?: boolean;
    /** Existing staged destination permits only recovery of this original capture, never a new click. */
    requireExistingCapture?: boolean;
    assertAuthority(): Promise<void>;
  }): Promise<{ bytes: Buffer; sha256: string; sourceIdentity: string }>;
  assertCaptureWritable?(id: string): void;
  assertRetryRecovery?(id: string, predecessorId: string): void;
}
const MAX_IMPORTED_FILE_BYTES = 32 * 1024 * 1024;
const EXPORT_RECEIPT_FILE = '.rcac-export-receipt.json';

/** All callbacks except authorize/binding must be synchronous so runIdempotent can enclose DB writes in one transaction. */
export interface ArtifactDependencies {
  objects: ArtifactObjects;
  exportRoot?: string;
  forbiddenSourceRoots?: () => readonly string[];
  registeredRoots?: () => readonly string[];
  browserCollector?: BrowserArtifactCollector;
  authorize(request: { context: RequestContext; operation: Operation; workspaceId: string; collaborationId: string }): Promise<Permit> | Permit;
  collaborationBelongsToWorkspace(workspaceId: string, collaborationId: string): Promise<boolean> | boolean;
  /** Rejects context revisions or snapshots outside the persisted collaboration before filesystem side effects. */
  validateBundleReferences(input: BundleInput): void;
  getBundle(bundleId: string): ArtifactRecord | null;
  publishedBundleHighWater?(workspaceId: string, collaborationId: string): number;
  signBundleCursor?(body: string): string;
  verifyBundleCursor?(body: string, signature: string): boolean;
  listPublishedBundles?(workspaceId: string, collaborationId: string, afterSeq: number,
    highWater: number, limit: number): { bundleId: string; publishedSeq: number; integrityStatusRecorded: IntegrityStatus | null }[];
  saveBundle(record: ArtifactRecord): void;
  /** Must atomically insert immutable manifest and file references. Duplicate equal publication is safe; different publication conflicts. */
  publishBundle(manifest: BundleManifest): void;
  /** Called inside runIdempotent so tombstone and receipt commit together. */
  abortBundle(bundleId: string, state: DeliveryState): void;
  /** Read-only lookup. Equal payload returns the prior result; different payload throws CONFLICT. */
  lookupIdempotent<T>(scope: IdempotencyScope, payload: unknown): T | null;
  /** Serializes operations on one bundle without holding a DB transaction during filesystem I/O. */
  withBundleLock<T>(bundleId: string, action: () => Promise<T>): Promise<T>;
  runIdempotent<T>(scope: IdempotencyScope, payload: unknown,
    mutation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T;
}

function unavailable(): never { throw new Error('NOT_AVAILABLE'); }
function within(path: string, root: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const child = relative(normalize(root), normalize(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function readExactFile(path: string, expected: number): Buffer {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 128 * 1024 * 1024) throw new Error('integrity_error');
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== expected) throw new Error('integrity_error');
    const bytes = Buffer.allocUnsafe(expected);
    let offset = 0;
    while (offset < expected) {
      const count = readSync(fd, bytes, offset, Math.min(64 * 1024, expected - offset), null);
      if (count === 0) throw new Error('integrity_error');
      offset += count;
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, null) !== 0 || fstatSync(fd).size !== expected) throw new Error('integrity_error');
    return bytes;
  } finally { closeSync(fd); }
}
function writeExportFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export class ArtifactApplication {
  constructor(private readonly dependencies: ArtifactDependencies, private readonly clock: () => Date = () => new Date()) {}

  private async permitted(request: Request, operation: Operation): Promise<Permit> {
    const permit = await this.dependencies.authorize({ context: { ...request.context, now: this.clock() }, operation, workspaceId: request.workspaceId, collaborationId: request.collaborationId });
    if (!permit || permit.operation !== operation || permit.effect !== (operation === 'artifact.status' || operation === 'artifact.list' || operation === 'artifact.inspect' ? 'read' : operation === 'artifact.export' ? 'local_export' : operation === 'artifact.import_reference' || operation === 'artifact.collect_local' || operation === 'artifact.collect_browser' ? 'artifact_transfer' : 'artifact_write') || permit.scope.workspaceId !== request.workspaceId || permit.scope.collaborationId !== request.collaborationId || permit.principal !== request.context.principal || permit.recipient !== request.context.recipient) unavailable();
    return permit;
  }

  private bound(request: Request): ArtifactRecord {
    const record = this.dependencies.getBundle(request.bundleId);
    if (!record || record.input.bundleId !== request.bundleId || record.input.workspaceId !== request.workspaceId || record.input.collaborationId !== request.collaborationId) unavailable();
    return record;
  }

  private scope(request: MutationRequest, operation: Operation): IdempotencyScope {
    if (!request.idempotencyKey) unavailable();
    return { principal: request.context.principal, audience: request.context.audience, workspaceId: request.workspaceId, operation, idempotencyKey: request.idempotencyKey };
  }

  private withLock<T>(request: MutationRequest, operation: Operation, action: () => Promise<T>): Promise<T> {
    const scope = this.scope(request, operation);
    const scopeHash = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    return this.dependencies.objects.withIdempotencyLock(scopeHash,
      () => this.dependencies.objects.withProcessLock(request.bundleId,
        () => this.dependencies.withBundleLock(request.bundleId, action)));
  }

  async begin(request: MutationRequest & Omit<BundleInput, 'workspaceId' | 'collaborationId' | 'bundleId'>): Promise<DeliveryState> {
    await this.permitted(request, 'artifact.begin');
    if (!(await this.dependencies.collaborationBelongsToWorkspace(request.workspaceId, request.collaborationId))) unavailable();
    const input: BundleInput = { bundleId: request.bundleId, workspaceId: request.workspaceId, collaborationId: request.collaborationId, contextRevision: request.contextRevision, snapshotRefs: request.snapshotRefs, ...(request.parentBundleId ? { parentBundleId: request.parentBundleId } : {}), ...(request.expectedPaths ? { expectedPaths: request.expectedPaths } : {}) };
    const result = await this.withLock(request, 'artifact.begin', async () => {
      await this.permitted(request, 'artifact.begin');
      this.dependencies.validateBundleReferences(input);
      const scope = this.scope(request, 'artifact.begin');
      const prior = this.dependencies.lookupIdempotent<DeliveryState>(scope, input);
      if (prior) { if (this.dependencies.getBundle(request.bundleId)?.abortedState) throw new Error('Bundle is immutable'); return prior; }
      if (this.dependencies.getBundle(request.bundleId)) throw new Error('CONFLICT');
      if (input.parentBundleId) {
        const parent = this.dependencies.getBundle(input.parentBundleId);
        if (!parent?.manifest || parent.input.workspaceId !== input.workspaceId || parent.input.collaborationId !== input.collaborationId) unavailable();
        this.dependencies.objects.reconcilePublished(input.parentBundleId, parent.manifest, parent.input);
      }
      const state = this.dependencies.objects.begin(input);
      return this.dependencies.runIdempotent(scope, input, () => {
        this.dependencies.saveBundle({ input });
        return state;
      });
    });
    await this.permitted(request, 'artifact.begin');
    return result;
  }

  async putText(request: MutationRequest & { path: string; text: string; mediaType: string; sourceReceipt: string }): Promise<ArtifactFile> {
    await this.permitted(request, 'artifact.put_text');
    const payload = { ...this.binding(request), path: request.path, text: request.text, mediaType: request.mediaType, sourceReceipt: request.sourceReceipt };
    const result = await this.withLock(request, 'artifact.put_text', async () => {
      await this.permitted(request, 'artifact.put_text');
      const scope = this.scope(request, 'artifact.put_text');
      const prior = this.dependencies.lookupIdempotent<ArtifactFile>(scope, payload);
      if (prior) { if (this.bound(request).abortedState) throw new Error('Bundle is immutable'); return prior; }
      const record = this.bound(request);
      if (record.manifest || record.abortedState) throw new Error('Bundle is immutable');
      const file = this.dependencies.objects.putText(request.bundleId, request.path, request.text, request.mediaType, request.sourceReceipt);
      return this.dependencies.runIdempotent(scope, payload, () => file);
    });
    await this.permitted(request, 'artifact.put_text');
    return result;
  }

  async importReference(request: MutationRequest & { path: string } & ArtifactReferenceTransfer): Promise<ArtifactFile> {
    await this.permitted(request, 'artifact.import_reference');
    if (typeof request.referenceIdentity !== 'string' || !request.referenceIdentity ||
      (request.mediaType !== null && (typeof request.mediaType !== 'string' || !request.mediaType))) unavailable();
    const declaredMediaType = request.mediaType;
    const referenceIdentity = request.referenceIdentity;
    const acquireBytes = request.acquireBytes;
    const payload = { ...this.binding(request), path: request.path, referenceIdentity, mediaType: declaredMediaType };
    const result = await this.withLock(request, 'artifact.import_reference', async () => {
      await this.permitted(request, 'artifact.import_reference');
      const scope = this.scope(request, 'artifact.import_reference');
      const prior = this.dependencies.lookupIdempotent<ArtifactFile>(scope, payload);
      if (prior) { if (this.bound(request).abortedState) throw new Error('Bundle is immutable'); return prior; }
      const record = this.bound(request);
      if (record.manifest || record.abortedState) throw new Error('Bundle is immutable');
      if (typeof acquireBytes !== 'function') throw new Error('UNSUPPORTED_CAPABILITY');
      const bytes = await acquireBytes(MAX_IMPORTED_FILE_BYTES);
      await this.permitted(request, 'artifact.import_reference');
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMPORTED_FILE_BYTES) throw new Error('File budget exceeded');
      const sourceIdentity = createHash('sha256').update(referenceIdentity).digest('hex');
      const effectiveMediaType = declaredMediaType ?? detectRecognizedMediaType(bytes) ?? 'application/octet-stream';
      const imported = this.dependencies.objects.putBytes(request.bundleId, request.path, bytes, effectiveMediaType, 'platform_file_reference', sourceIdentity);
      return this.dependencies.runIdempotent(scope, payload, () => imported);
    });
    await this.permitted(request, 'artifact.import_reference');
    return result;
  }

  async collectLocal(request: MutationRequest & { path: string; mediaType: string; source: LocalArtifactSource }): Promise<ArtifactFile> {
    await this.permitted(request, 'artifact.collect_local');
    if (request.context.surface !== 'local_cli' && request.context.surface !== 'local_host') unavailable();
    if (!this.dependencies.forbiddenSourceRoots || !request.source || typeof request.source.read !== 'function') unavailable();
    const result = await this.withLock(request, 'artifact.collect_local', async () => {
      await this.permitted(request, 'artifact.collect_local');
      const record = this.bound(request);
      if (record.abortedState) throw new Error('Bundle is immutable');
      this.dependencies.validateBundleReferences(record.input);
      const source = request.source.read(this.dependencies.forbiddenSourceRoots!());
      await this.permitted(request, 'artifact.collect_local');
      const payload = { ...this.binding(request), path: request.path, mediaType: request.mediaType,
        sourceIdentity: source.identity, sha256: source.sha256 };
      const scope = this.scope(request, 'artifact.collect_local');
      const prior = this.dependencies.lookupIdempotent<ArtifactFile>(scope, payload);
      if (prior) { this.bound(request); return prior; }
      if (record.manifest || record.abortedState) throw new Error('Bundle is immutable');
      const file = this.dependencies.objects.putBytes(request.bundleId, request.path, source.bytes, request.mediaType, 'manual_import');
      return this.dependencies.runIdempotent(scope, payload, () => file);
    });
    await this.permitted(request, 'artifact.collect_local');
    return result;
  }

  async collectBrowser(request: MutationRequest & BrowserArtifactSelection & { path: string; retryOfCaptureId?: string;
    reconcileOnly?: { captureIntentId: string } }): Promise<ArtifactFile> {
    const permit = await this.permitted(request, 'artifact.collect_browser');
    if ((request.context.surface !== 'local_cli' && request.context.surface !== 'local_host') ||
        !this.dependencies.browserCollector || !/^[a-f0-9]{64}$/.test(request.expectedSha256) ||
        !Number.isSafeInteger(request.expectedSize) || request.expectedSize < 0 ||
        request.expectedSize > MAX_IMPORTED_FILE_BYTES || normalizeArtifactPath(request.path) !== request.path ||
        (Object.hasOwn(request, 'attachmentIndex') && (!Number.isSafeInteger(request.attachmentIndex) ||
          request.attachmentIndex! < 0 || request.attachmentIndex! > 63)) ||
        (request.retryOfCaptureId !== undefined && !/^[a-f0-9]{64}$/.test(request.retryOfCaptureId)) ||
        (request.reconcileOnly !== undefined && (request.retryOfCaptureId !== undefined ||
          !request.reconcileOnly || typeof request.reconcileOnly !== 'object' ||
          Object.keys(request.reconcileOnly).join(',') !== 'captureIntentId' ||
          !/^[a-f0-9]{64}$/.test(request.reconcileOnly.captureIntentId)))) unavailable();
    const selection: BrowserArtifactSelection = { nativeSessionId: request.nativeSessionId,
      nativeMessageId: request.nativeMessageId, filename: request.filename,
      ...(request.attachmentIndex === undefined ? {} : { attachmentIndex: request.attachmentIndex }),
      expectedSha256: request.expectedSha256, expectedSize: request.expectedSize };
    const payload = { ...this.binding(request), path: request.path, ...selection, grantId: permit.grantId,
      ...(request.retryOfCaptureId ? { retryOfCaptureId: request.retryOfCaptureId } : {}),
      ...(request.reconcileOnly ? { reconcileOnly: request.reconcileOnly } : {}) };
    const scope = this.scope(request, 'artifact.collect_browser');
    // The same request remains one intent even if its payload, grant, or browser root later changes.
    const id = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const assertAuthority = async () => {
      const current = await this.permitted(request, 'artifact.collect_browser');
      if (current.grantId !== permit.grantId) unavailable();
    };
    const result = await this.withLock(request, 'artifact.collect_browser', async () => {
      await assertAuthority();
      const record = this.bound(request);
      if (record.abortedState) throw new Error('Bundle is immutable');
      this.dependencies.validateBundleReferences(record.input);
      const prior = this.dependencies.lookupIdempotent<ArtifactFile>(scope, payload);
      if (prior) return prior;
      if (record.manifest) throw new Error('Bundle is immutable');
      if (record.input.expectedPaths && !record.input.expectedPaths.includes(request.path)) throw new Error('Artifact path not declared');
      const staging = this.dependencies.objects.status(request.bundleId);
      if (staging.state !== 'staging') throw new Error('Bundle is immutable');
      const existing = staging.files.find(file => file.normalizedRelativePath.toLocaleLowerCase('en-US') === request.path.toLocaleLowerCase('en-US'));
      if (existing && request.retryOfCaptureId) {
        if (!this.dependencies.browserCollector!.assertRetryRecovery) unavailable();
        this.dependencies.browserCollector!.assertRetryRecovery(id, request.retryOfCaptureId);
      }
      if (existing) {
        // Preserve recovery after object staging but before the application receipt commits.
        // The collector still has to reconcile the original immutable capture and source identity.
        if (existing.normalizedRelativePath !== request.path || existing.sha256 !== request.expectedSha256 ||
            existing.actualSizeBytes !== request.expectedSize || existing.sourceReceipt !== 'authorized_local_collector') {
          throw new Error('Artifact path conflict');
        }
      } else validateArtifactPaths([...staging.files.map(file => file.normalizedRelativePath), request.path]);
      const captured = await this.dependencies.browserCollector!.capture({ ...this.binding(request),
        ...selection, id: request.reconcileOnly?.captureIntentId ?? id, path: request.path, grantId: permit.grantId,
        ...(request.retryOfCaptureId ? { retryOfCaptureId: request.retryOfCaptureId } : {}),
        ...(request.reconcileOnly ? { reconcileOnlyCapture: true } : {}),
        ...(existing ? { requireExistingCapture: true } : {}),
        principal: request.context.principal, audience: request.context.audience,
        recipient: request.context.recipient, assertAuthority });
      await assertAuthority();
      if (!Buffer.isBuffer(captured.bytes) || captured.bytes.length !== request.expectedSize ||
          captured.sha256 !== request.expectedSha256 ||
          createHash('sha256').update(captured.bytes).digest('hex') !== request.expectedSha256 ||
          !/^[a-f0-9]{64}$/.test(captured.sourceIdentity) ||
          (existing && existing.sourceIdentity !== captured.sourceIdentity)) unavailable();
      this.dependencies.browserCollector!.assertCaptureWritable?.(request.reconcileOnly?.captureIntentId ?? id);
      const file = this.dependencies.objects.putBytes(request.bundleId, request.path, captured.bytes,
        detectRecognizedMediaType(captured.bytes) ?? 'application/octet-stream',
        'authorized_local_collector', captured.sourceIdentity);
      return this.dependencies.runIdempotent(scope, payload, () => file);
    });
    await assertAuthority();
    return result;
  }

  async export(request: MutationRequest & { expectedManifestHash: string; exportName: string }): Promise<{ exportName: string; path: string; manifestHash: string }> {
    await this.permitted(request, 'artifact.export');
    if ((request.context.surface !== 'local_cli' && request.context.surface !== 'local_host') || !this.dependencies.exportRoot) unavailable();
    const name = normalizeArtifactPath(request.exportName);
    if (name.includes('/') || !/^[a-f0-9]{64}$/.test(request.expectedManifestHash)) throw new Error('INVALID_ARGUMENT');
    const nameLock = createHash('sha256').update(name).digest('hex');
    const result = await this.dependencies.objects.withExportNameLock(nameLock, () => this.withLock(request, 'artifact.export', async () => {
      await this.permitted(request, 'artifact.export');
      const record = this.bound(request);
      if (!record.manifest) unavailable();
      this.dependencies.validateBundleReferences(record.input);
      const manifest = record.manifest;
      const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      if (request.expectedManifestHash !== manifestHash) throw new Error('BASELINE_MISMATCH');
      const payload = { ...this.binding(request), expectedManifestHash: manifestHash, exportName: name };
      const scope = this.scope(request, 'artifact.export');
      const receiptIdentity = createHash('sha256').update(JSON.stringify({ scope, payload })).digest('hex');
      const receiptBytes = Buffer.from(JSON.stringify({ identity: receiptIdentity, manifestHash }));
      const exportRoot = resolve(this.dependencies.exportRoot!);
      if (!this.dependencies.registeredRoots) unavailable();
      const assertExportPlacement = () => {
        const canonicalParent = realpathSync.native(resolve(exportRoot, '..'));
        const canonicalExportRoot = join(canonicalParent, basename(exportRoot));
        for (const registered of this.dependencies.registeredRoots!()) {
          if (within(canonicalExportRoot, realpathSync.native(registered))) unavailable();
        }
      };
      assertExportPlacement();
      if (!existsSync(exportRoot)) mkdirSync(exportRoot, { recursive: true, mode: 0o700 });
      if (!lstatSync(exportRoot).isDirectory() || lstatSync(exportRoot).isSymbolicLink()) unavailable();
      const destination = join(exportRoot, name);
      const verify = () => {
        if (this.integrity(record) !== 'ok') throw new Error('integrity_error');
        if (!existsSync(destination) || !lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink()) throw new Error('integrity_error');
        const expectedFiles = new Set([EXPORT_RECEIPT_FILE, ...manifest.files.map((file) => file.normalizedRelativePath)]);
        const expectedDirectories = new Set<string>();
        for (const file of manifest.files) {
          const parts = file.normalizedRelativePath.split('/');
          for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join('/'));
        }
        const pending = [{ directory: destination, prefix: '' }];
        const observed = new Set<string>();
        let visited = 0;
        while (pending.length) {
          const current = pending.pop()!;
          const directory = opendirSync(current.directory);
          try {
            for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
              const relativePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
              visited++;
              if (visited > expectedFiles.size + expectedDirectories.size || entry.isSymbolicLink()) throw new Error('integrity_error');
              if (entry.isDirectory() && expectedDirectories.has(relativePath)) {
                pending.push({ directory: join(current.directory, entry.name), prefix: relativePath });
              } else if (entry.isFile() && expectedFiles.has(relativePath)) observed.add(relativePath);
              else throw new Error('integrity_error');
            }
          } finally { directory.closeSync(); }
        }
        if (visited !== expectedFiles.size + expectedDirectories.size || observed.size !== expectedFiles.size) throw new Error('integrity_error');
        try { if (!readExactFile(join(destination, EXPORT_RECEIPT_FILE), receiptBytes.length).equals(receiptBytes)) throw new Error('CONFLICT'); }
        catch (error) { if ((error as Error).message === 'CONFLICT') throw error; throw new Error('integrity_error', { cause: error }); }
        for (const file of manifest.files) {
          const target = join(destination, ...file.normalizedRelativePath.split('/'));
          let bytes: Buffer;
          try { bytes = readExactFile(target, file.actualSizeBytes); }
          catch (error) { throw new Error('integrity_error', { cause: error }); }
          if (bytes.length !== file.actualSizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('integrity_error');
        }
      };
      const prior = this.dependencies.lookupIdempotent<{ exportName: string; path: string; manifestHash: string }>(scope, payload);
      if (prior) { verify(); return prior; }
      if (existsSync(destination)) {
        let marker: Buffer;
        try { marker = readExactFile(join(destination, EXPORT_RECEIPT_FILE), receiptBytes.length); }
        catch { throw new Error('CONFLICT'); }
        if (!marker.equals(receiptBytes)) throw new Error('CONFLICT');
        verify();
        return this.dependencies.runIdempotent(scope, payload, () => ({ exportName: name, path: destination, manifestHash }));
      }
      if (this.integrity(record) !== 'ok') throw new Error('integrity_error');
      const paths = manifest.files.map((file) => file.normalizedRelativePath);
      const folded = paths.map((path) => path.toLocaleLowerCase('en-US'));
      const receiptName = EXPORT_RECEIPT_FILE.toLocaleLowerCase('en-US');
      if (folded.includes(receiptName) || folded.some((path) => path.startsWith(`${receiptName}/`))) throw new Error('Artifact path conflict');
      for (const path of folded) if (folded.some((other) => other.startsWith(`${path}/`))) throw new Error('Artifact path conflict');
      const directorySpellings = new Map<string, string>();
      for (const path of paths) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const directory = parts.slice(0, i).join('/');
          const foldedDirectory = directory.toLocaleLowerCase('en-US');
          const prior = directorySpellings.get(foldedDirectory);
          if (prior && prior !== directory) throw new Error('Artifact path conflict');
          directorySpellings.set(foldedDirectory, directory);
        }
      }
      const temp = mkdtempSync(join(exportRoot, `.pending-${randomUUID()}-`));
      try {
        for (const file of manifest.files) {
          const target = join(temp, ...file.normalizedRelativePath.split('/'));
          const parent = target.slice(0, target.lastIndexOf(sep));
          mkdirSync(parent, { recursive: true });
          const bytes = readExactFile(this.dependencies.objects.objectPath(file.sha256), file.actualSizeBytes);
          if (bytes.length !== file.actualSizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('integrity_error');
          writeExportFile(target, bytes);
        }
        writeExportFile(join(temp, EXPORT_RECEIPT_FILE), receiptBytes);
        await this.permitted(request, 'artifact.export');
        assertExportPlacement();
        if (this.integrity(record) !== 'ok') throw new Error('integrity_error');
        if (existsSync(destination)) throw new Error('CONFLICT');
        renameSync(temp, destination);
        const receipt = { exportName: name, path: destination, manifestHash };
        return this.dependencies.runIdempotent(scope, payload, () => receipt);
      } finally { if (existsSync(temp)) rmSync(temp, { recursive: true, force: true }); }
    }));
    await this.permitted(request, 'artifact.export');
    return result;
  }

  async finalize(request: MutationRequest): Promise<BundleManifest> {
    await this.permitted(request, 'artifact.finalize');
    const result = await this.withLock(request, 'artifact.finalize', async () => {
      await this.permitted(request, 'artifact.finalize');
      const record = this.bound(request);
      if (record.abortedState) throw new Error('Bundle is immutable');
      this.dependencies.validateBundleReferences(record.input);
      const scope = this.scope(request, 'artifact.finalize');
      const payload = this.binding(request);
      const prior = this.dependencies.lookupIdempotent<BundleManifest>(scope, payload);
      if (prior) {
        if (!record.manifest) unavailable();
        this.dependencies.objects.reconcilePublished(request.bundleId, record.manifest, record.input);
        return record.manifest;
      }
      if (record.manifest) {
        this.dependencies.objects.reconcilePublished(request.bundleId, record.manifest, record.input);
        return this.dependencies.runIdempotent(scope, payload, () => record.manifest!);
      }
      return this.dependencies.objects.finalize(request.bundleId, (manifest) => {
        if (manifest.workspaceId !== request.workspaceId || manifest.collaborationId !== request.collaborationId || manifest.bundleId !== request.bundleId) unavailable();
        this.dependencies.runIdempotent(scope, payload, () => {
          this.dependencies.publishBundle(manifest);
          return manifest;
        });
      });
    });
    await this.permitted(request, 'artifact.finalize');
    return result;
  }

  async abort(request: MutationRequest): Promise<DeliveryState> {
    await this.permitted(request, 'artifact.abort');
    const result = await this.withLock(request, 'artifact.abort', async () => {
      await this.permitted(request, 'artifact.abort');
      const record = this.bound(request);
      if (record.manifest) throw new Error('Bundle is immutable');
      const scope = this.scope(request, 'artifact.abort');
      const payload = this.binding(request);
      const prior = this.dependencies.lookupIdempotent<DeliveryState>(scope, payload);
      if (record.abortedState) {
        if (prior && !isDeepStrictEqual(prior, record.abortedState)) throw new Error('CONFLICT');
        this.dependencies.objects.abort(request.bundleId, record.input, record.abortedState);
        return prior ?? this.dependencies.runIdempotent(scope, payload, () => record.abortedState!);
      }
      if (prior) throw new Error('CONFLICT');
      const marker = this.dependencies.objects.status(request.bundleId);
      if (marker.state !== 'staging') throw new Error('CONFLICT');
      const state: DeliveryState = { ...marker, state: 'aborted' };
      this.dependencies.objects.inspectAborted(request.bundleId, record.input, state);
      const receipt = this.dependencies.runIdempotent(scope, payload, () => {
        this.dependencies.abortBundle(request.bundleId, state);
        return state;
      });
      this.dependencies.objects.abort(request.bundleId, record.input, receipt);
      return receipt;
    });
    await this.permitted(request, 'artifact.abort');
    return result;
  }

  async status(request: Request): Promise<ArtifactStatus> {
    await this.permitted(request, 'artifact.status');
    const record = this.bound(request);
    if (record.abortedState) this.dependencies.objects.inspectAborted(request.bundleId, record.input, record.abortedState);
    const state = record.abortedState ?? (record.manifest
      ? this.dependencies.objects.statusIfPresent(request.bundleId) ?? { state: 'published' as const, files: record.manifest.files, missingPaths: [] }
      : this.dependencies.objects.status(request.bundleId));
    const integrityStatus = this.integrity(record);
    await this.permitted(request, 'artifact.status');
    return { ...state, state: record.abortedState ? 'aborted' : record.manifest ? 'published' : 'staging', files: record.manifest?.files ?? state.files, missingPaths: record.manifest ? [] : state.missingPaths, integrityStatus, expectedSetBasis: record.manifest?.expectedSetBasis ?? (record.input.expectedPaths === undefined ? 'receiver_observed' : 'producer_declared') };
  }

  async list(request: Omit<Request, 'bundleId'> & { limit?: number; cursor?: string }): Promise<{
    bundles: { bundleId: string; parentBundleId: string | null; manifestHash: string;
      publishedSeq: number; integrityStatusRecorded: IntegrityStatus | null }[];
    nextCursor: string | null;
  }> {
    if (request.context.surface !== 'local_cli' && request.context.surface !== 'local_host') unavailable();
    await this.permitted({ ...request, bundleId: '' }, 'artifact.list');
    if (!this.dependencies.listPublishedBundles || !this.dependencies.publishedBundleHighWater ||
        !this.dependencies.signBundleCursor || !this.dependencies.verifyBundleCursor) unavailable();
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_ARGUMENT');
    let afterSeq = 0;
    let highWater = this.dependencies.publishedBundleHighWater(request.workspaceId, request.collaborationId);
    if (request.cursor !== undefined) {
      if (request.cursor.length > 2048) throw new Error('INVALID_ARGUMENT');
      try {
        const envelope = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (!envelope || Object.keys(envelope).sort().join(',') !== 'body,signature' ||
            typeof envelope.signature !== 'string' || !envelope.body || typeof envelope.body !== 'object' ||
            Array.isArray(envelope.body)) throw new Error('INVALID_ARGUMENT');
        const decoded = envelope.body as Record<string, unknown>;
        if (!this.dependencies.verifyBundleCursor(JSON.stringify(decoded), envelope.signature)) throw new Error('INVALID_ARGUMENT');
        if (decoded.workspaceId !== request.workspaceId || decoded.collaborationId !== request.collaborationId ||
            decoded.principal !== request.context.principal || decoded.recipient !== request.context.recipient ||
            decoded.audience !== request.context.audience || decoded.limit !== limit ||
            Object.keys(decoded).sort().join(',') !== 'afterSeq,audience,collaborationId,highWater,limit,principal,recipient,workspaceId' ||
            !Number.isSafeInteger(decoded.afterSeq) || !Number.isSafeInteger(decoded.highWater) ||
            (decoded.afterSeq as number) < 0 || (decoded.highWater as number) < (decoded.afterSeq as number) ||
            Buffer.from(JSON.stringify(envelope)).toString('base64url') !== request.cursor) throw new Error('INVALID_ARGUMENT');
        afterSeq = decoded.afterSeq as number;
        highWater = decoded.highWater as number;
      } catch { throw new Error('INVALID_ARGUMENT'); }
    }
    const rows = this.dependencies.listPublishedBundles(request.workspaceId, request.collaborationId,
      afterSeq, highWater, limit + 1);
    const page = rows.slice(0, limit);
    const bundles = page.map(({ bundleId, publishedSeq, integrityStatusRecorded }) => {
      const record = this.bound({ ...request, bundleId });
      if (!record.manifest || record.abortedState) unavailable();
      return { bundleId, parentBundleId: record.manifest.parentBundleId ?? null,
        manifestHash: createHash('sha256').update(JSON.stringify(record.manifest)).digest('hex'),
        publishedSeq, integrityStatusRecorded };
    });
    await this.permitted({ ...request, bundleId: '' }, 'artifact.list');
    const body = { workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      principal: request.context.principal, recipient: request.context.recipient, audience: request.context.audience,
      limit, highWater, afterSeq: page.at(-1)?.publishedSeq };
    return { bundles, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ body, signature:
      this.dependencies.signBundleCursor(JSON.stringify(body)),
    })).toString('base64url') : null };
  }

  async inspect(request: Request): Promise<{ bundleId: string; parentBundleId: string | null;
    manifestHash: string; integrityStatus: IntegrityStatus; ready: boolean; manifest: BundleManifest }> {
    if (request.context.surface !== 'local_cli' && request.context.surface !== 'local_host') unavailable();
    await this.permitted(request, 'artifact.inspect');
    const record = this.bound(request);
    if (!record.manifest || record.abortedState) unavailable();
    const integrityStatus = this.integrity(record) ?? 'corrupt';
    const manifestHash = createHash('sha256').update(JSON.stringify(record.manifest)).digest('hex');
    await this.permitted(request, 'artifact.inspect');
    return { bundleId: request.bundleId, parentBundleId: record.manifest.parentBundleId ?? null,
      manifestHash, integrityStatus, ready: integrityStatus === 'ok', manifest: record.manifest };
  }

  private integrity(record: ArtifactRecord): IntegrityStatus | null {
    if (!record.manifest) return null;
    try {
      const paths = validateArtifactPaths(record.manifest.files.map(file => file.normalizedRelativePath));
      if (record.manifest.expectedPaths) {
        const expected = validateArtifactPaths(record.manifest.expectedPaths);
        if (expected.length !== paths.length || expected.some(path => !paths.includes(path))) return 'corrupt';
      }
    } catch { return 'corrupt'; }
    const manifestBytes = Buffer.from(JSON.stringify(record.manifest));
    const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
    const entries = [{ sha256: manifestHash, actualSizeBytes: manifestBytes.length }, ...record.manifest.files];
    for (const file of entries) {
      const objectPath = this.dependencies.objects.objectPath(file.sha256);
      if (!existsSync(objectPath)) return 'missing';
      let bytes: Buffer;
      try { bytes = readExactFile(objectPath, file.actualSizeBytes); }
      catch { return 'corrupt'; }
      if (bytes.length !== file.actualSizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return 'corrupt';
    }
    return 'ok';
  }

  async readFile(request: Request & { path: string }): Promise<Buffer> {
    await this.permitted(request, 'artifact.status');
    const record = this.bound(request);
    if (!record.manifest) unavailable();
    if (this.integrity(record) !== 'ok') throw new Error('integrity_error');
    const path = normalizeArtifactPath(request.path);
    const file = record.manifest.files.find((item) => item.normalizedRelativePath === path);
    if (!file) unavailable();
    const objectPath = this.dependencies.objects.objectPath(file.sha256);
    if (!existsSync(objectPath)) throw new Error('integrity_error');
    const result = readExactFile(objectPath, file.actualSizeBytes);
    if (result.length !== file.actualSizeBytes || createHash('sha256').update(result).digest('hex') !== file.sha256) throw new Error('integrity_error');
    await this.permitted(request, 'artifact.status');
    return result;
  }

  private binding(request: Request): Binding { return { workspaceId: request.workspaceId, collaborationId: request.collaborationId, bundleId: request.bundleId }; }
}

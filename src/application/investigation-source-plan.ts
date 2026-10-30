import { createHash } from 'node:crypto';
import { RepositorySnapshot, type PersistedSnapshot } from '../adapters/repository/snapshots.js';
import { portablePathKey, validateRelativePath } from '../adapters/repository/path-policy.js';
import type { InvestigationClaim } from '../adapters/storage/investigation-sqlite.js';
import type { InvestigationRecord } from '../core/investigation/request.js';

export interface InvestigationSourceBinding {
  workspaceId: string;
  collaborationId: string;
  workingCopyId: string;
  snapshotRef: string;
  contextRevisionId: string;
  recipient: string;
  requestId: string;
  attemptId: string;
  workerEpoch: number;
}

export interface InvestigationSourceFile {
  path: string;
  sizeBytes: number;
  sha256: string;
  base64: string;
}

export interface InvestigationSourcePlan {
  binding: InvestigationSourceBinding;
  sourceConsistency: PersistedSnapshot['sourceConsistency'];
  files: InvestigationSourceFile[];
  totalBytes: number;
  digest: string;
}

export interface InvestigationSourceLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const maximum = { maxFiles: 128, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const unavailable = (): never => { throw new Error('NOT_AVAILABLE'); };

function boundedLimits(limits: InvestigationSourceLimits | undefined) {
  const result = { ...maximum, ...limits };
  for (const key of Object.keys(maximum) as (keyof typeof maximum)[]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum[key]) {
      throw new Error('INVALID_ARGUMENT');
    }
  }
  return result;
}

/** Reject portable aliases in every directory, including files outside the selected scope. */
function validateSnapshotTree(paths: readonly string[]): void {
  const names = new Map<string, string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const path of paths) {
    validateRelativePath(path);
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join('/');
      const key = portablePathKey(prefix);
      const previous = names.get(key);
      if (previous !== undefined && previous !== prefix) throw new Error('INTEGRITY_ERROR');
      names.set(key, prefix);
      if (index === parts.length - 1) {
        if (directories.has(key) || files.has(key)) throw new Error('INTEGRITY_ERROR');
        files.add(key);
      } else {
        if (files.has(key)) throw new Error('INTEGRITY_ERROR');
        directories.add(key);
      }
    }
  }
}

/** A pure plan for one fenced attempt. The caller must establish current authorization separately. */
export function buildInvestigationSourcePlan(input: {
  record: InvestigationRecord;
  claim: InvestigationClaim;
  snapshot: PersistedSnapshot;
  expected: InvestigationSourceBinding;
  limits?: InvestigationSourceLimits;
}): InvestigationSourcePlan {
  const limits = boundedLimits(input.limits);
  const { record, claim, expected } = input;
  const actual: InvestigationSourceBinding = {
    workspaceId: record.workspaceId,
    collaborationId: record.collaborationId,
    workingCopyId: record.workingCopyId,
    snapshotRef: record.snapshotRef,
    contextRevisionId: record.contextRevisionId,
    recipient: record.recipient,
    requestId: record.id,
    attemptId: claim.attemptId,
    workerEpoch: claim.workerEpoch,
  };
  for (const key of Object.keys(actual) as (keyof InvestigationSourceBinding)[]) {
    if (!actual[key] || actual[key] !== expected[key]) unavailable();
  }
  const attempt = record.attempts.find(item => item.id === claim.attemptId);
  if (claim.requestId !== record.id || claim.workspaceId !== record.workspaceId ||
    !Number.isSafeInteger(claim.workerEpoch) || claim.workerEpoch < 1 ||
    !attempt || attempt.workerEpoch !== claim.workerEpoch ||
    (attempt.state !== 'claimed' && attempt.state !== 'running') ||
    (record.state !== 'queued' && record.state !== 'running') || record.cancelRequested ||
    record.result != null) unavailable();
  const snapshot = RepositorySnapshot.fromPersisted(input.snapshot);
  if (snapshot.id !== record.snapshotRef || snapshot.workingCopyId !== record.workingCopyId) unavailable();
  validateSnapshotTree(snapshot.manifest.map(entry => entry.path));
  const selected = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  if (selected.length === 0 || selected.length > limits.maxFiles) unavailable();
  const entries = new Map(snapshot.manifest.map(entry => [entry.path, entry]));
  const files: InvestigationSourceFile[] = [];
  let totalBytes = 0;
  for (const path of selected) {
    validateRelativePath(path);
    const entry = entries.get(path);
    const bytes = snapshot.file(path);
    if (!entry || !bytes) throw new Error('NOT_AVAILABLE');
    if (bytes.length !== entry.sizeBytes || hash(bytes) !== entry.sha256) throw new Error('INTEGRITY_ERROR');
    totalBytes += bytes.length;
    if (bytes.length > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) unavailable();
    files.push({ path, sizeBytes: bytes.length, sha256: entry.sha256, base64: bytes.toString('base64') });
  }
  const binding = { ...actual };
  const digest = hash(JSON.stringify({ binding, sourceConsistency: snapshot.sourceConsistency,
    files: files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })) }));
  return { binding, sourceConsistency: snapshot.sourceConsistency, files, totalBytes, digest };
}

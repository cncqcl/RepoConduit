import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { portablePathKey, validateRelativePath } from './path-policy.ts';

export type Exclusion = { path?: string; reason: 'dirty_worktree' | 'untracked' | 'unsafe_path' | 'symlink' | 'submodule' | 'lfs_pointer' | 'size_limit' | 'ignored_not_enumerated' };
export type ManifestEntry = { path: string; sizeBytes: number; sha256: string; gitObjectId?: string };
export type PersistedSnapshot = {
  id: string; workingCopyId: string; baseCommit: string; sourceConsistency: 'verified_git_tree' | 'best_effort_capture';
  files: Record<string, string>; manifest: ManifestEntry[]; exclusions: Exclusion[];
  cursorKey: string;
};

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export class RepositorySnapshot {
  readonly id: string;
  readonly workingCopyId: string;
  readonly baseCommit: string;
  readonly sourceConsistency: 'verified_git_tree' | 'best_effort_capture';
  readonly manifest: readonly ManifestEntry[];
  readonly exclusions: readonly Exclusion[];
  readonly #files: ReadonlyMap<string, Buffer>;
  readonly cursorKey: Buffer;

  constructor(workingCopyId: string, baseCommit: string, files: Map<string, Buffer>, manifest: ManifestEntry[], exclusions: Exclusion[], cursorKey = randomBytes(32), sourceConsistency: 'verified_git_tree' | 'best_effort_capture' = 'best_effort_capture') {
    this.workingCopyId = workingCopyId;
    this.baseCommit = baseCommit;
    this.sourceConsistency = sourceConsistency;
    this.#files = new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
    this.manifest = Object.freeze(manifest.map(entry => Object.freeze({ ...entry })));
    this.exclusions = Object.freeze(exclusions.map(entry => Object.freeze({ ...entry })));
    this.cursorKey = Buffer.from(cursorKey);
    this.id = `snp_${hash(JSON.stringify({ workingCopyId, baseCommit, sourceConsistency, manifest, exclusions })).slice(0, 32)}`;
  }

  file(path: string): Buffer | undefined {
    const bytes = this.#files.get(path);
    return bytes ? Buffer.from(bytes) : undefined;
  }

  toPersisted(): PersistedSnapshot {
    return {
      id: this.id, workingCopyId: this.workingCopyId, baseCommit: this.baseCommit,
      sourceConsistency: this.sourceConsistency,
      files: Object.fromEntries([...this.#files].map(([path, bytes]) => [path, bytes.toString('base64')])),
      manifest: [...this.manifest], exclusions: [...this.exclusions], cursorKey: this.cursorKey.toString('base64'),
    };
  }

  static fromPersisted(value: PersistedSnapshot): RepositorySnapshot {
    if (value.sourceConsistency !== 'verified_git_tree' && value.sourceConsistency !== 'best_effort_capture') throw new Error('INVALID_ARGUMENT');
    const files = new Map(Object.entries(value.files).map(([path, encoded]) => [validateRelativePath(path), Buffer.from(encoded, 'base64')]));
    const keys = new Set<string>();
    for (const entry of value.manifest) {
      validateRelativePath(entry.path);
      const key = portablePathKey(entry.path);
      if (keys.has(key)) throw new Error('INTEGRITY_ERROR');
      keys.add(key);
    }
    const result = new RepositorySnapshot(value.workingCopyId, value.baseCommit, files, value.manifest, value.exclusions, Buffer.from(value.cursorKey, 'base64'), value.sourceConsistency);
    if (result.id !== value.id || result.manifest.length !== files.size || result.manifest.some(entry => hash(files.get(entry.path) ?? Buffer.alloc(0)) !== entry.sha256 || files.get(entry.path)?.length !== entry.sizeBytes)) throw new Error('INTEGRITY_ERROR');
    return result;
  }
}

export function createSnapshotFromFiles(workingCopyId: string, baseCommit: string, input: Record<string, Buffer>, exclusions: Exclusion[] = []): RepositorySnapshot {
  const files = new Map<string, Buffer>();
  const keys = new Set<string>();
  for (const [path, bytes] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) {
    validateRelativePath(path);
    const key = portablePathKey(path);
    if (keys.has(key)) throw new Error('CONFLICT');
    keys.add(key);
    files.set(path, Buffer.from(bytes));
  }
  const manifest = [...files].map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: hash(bytes) }));
  return new RepositorySnapshot(workingCopyId, baseCommit, files, manifest, exclusions);
}

function git(root: string, ...args: string[]): Buffer {
  const executable = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
  return execFileSync(executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
}

/** Capture an immutable commit tree. Worktree modifications are reported, never included. */
export async function captureGitTree(root: string, commitRef = 'HEAD', options: { workingCopyId?: string; maxFileBytes?: number; maxTotalBytes?: number } = {}): Promise<RepositorySnapshot> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('INVALID_ARGUMENT');
  const canonical = await realpath(root);
  const top = git(canonical, 'rev-parse', '--show-toplevel').toString('utf8').trim();
  if (resolve(top).toLowerCase() !== resolve(canonical).toLowerCase()) throw new Error('INVALID_ARGUMENT');
  const commit = git(canonical, 'rev-parse', '--verify', `${commitRef}^{commit}`).toString('utf8').trim();
  const tree = git(canonical, 'ls-tree', '-rlz', '--full-tree', commit);
  const files = new Map<string, Buffer>();
  const manifest: ManifestEntry[] = [];
  const exclusions: Exclusion[] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const item of tree.toString('utf8').split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    if (tab < 0) throw new Error('INTEGRITY_ERROR');
    const [mode, type, oid, sizeText] = item.slice(0, tab).trim().split(/\s+/);
    const path = item.slice(tab + 1);
    try { validateRelativePath(path); } catch { exclusions.push({ reason: 'unsafe_path' }); continue; }
    const key = portablePathKey(path);
    if (keys.has(key)) { exclusions.push({ reason: 'unsafe_path' }); continue; }
    keys.add(key);
    if (mode === '120000') { exclusions.push({ path, reason: 'symlink' }); continue; }
    if (mode === '160000' || type === 'commit') { exclusions.push({ path, reason: 'submodule' }); continue; }
    if (type !== 'blob' || !oid || !/^[0-9a-f]{40,64}$/.test(oid)) { exclusions.push({ path, reason: 'unsafe_path' }); continue; }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > (options.maxFileBytes ?? 16 * 1024 * 1024) || total + size > (options.maxTotalBytes ?? 128 * 1024 * 1024)) { exclusions.push({ path, reason: 'size_limit' }); continue; }
    const bytes = git(canonical, 'cat-file', 'blob', oid);
    if (bytes.length !== size) throw new Error('INTEGRITY_ERROR');
    if (bytes.subarray(0, 80).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) { exclusions.push({ path, reason: 'lfs_pointer' }); continue; }
    files.set(path, bytes);
    manifest.push({ path, sizeBytes: size, sha256: hash(bytes), gitObjectId: oid });
    total += size;
  }
  const status = git(canonical, 'status', '--porcelain=v1', '-z', '--untracked-files=all').toString('utf8').split('\0');
  for (let i = 0; i < status.length; i++) {
    const record = status[i];
    if (!record || record.length < 4) continue;
    const kind = record.slice(0, 2);
    const path = record.slice(3);
    // Preserve exclusion category without disclosing an unsafe path.
    let safePath: string | undefined;
    try { safePath = validateRelativePath(path); } catch { /* Do not surface unsafe names. */ }
    exclusions.push({ ...(safePath ? { path: safePath } : {}), reason: kind === '??' ? 'untracked' : 'dirty_worktree' });
    if (kind.includes('R') || kind.includes('C')) i++;
  }
  exclusions.push({ reason: 'ignored_not_enumerated' });
  return new RepositorySnapshot(options.workingCopyId ?? canonical, commit, files, manifest, exclusions, randomBytes(32), 'verified_git_tree');
}

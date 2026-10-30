import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { validateRelativePath } from '../repository/path-policy.js';
import type { RepositorySnapshot } from '../repository/snapshots.js';

export interface StaticInvestigation {
  snapshot: RepositorySnapshot;
  /** Trusted local configuration, resolved to an immutable Docker image ID. */
  imageId: string;
  paths: string[];
  patterns: string[];
  maxWallSeconds: number;
  maxOutputBytes: number;
}

export interface StaticInvestigationReceipt {
  snapshotRef: string;
  imageId: string;
  searchedPaths: string[];
  matches: string;
  outputTruncated: boolean;
  exitCode: number;
  toolReceipt: string;
  isolation: 'docker_readonly_network_none';
}

function valid(input: StaticInvestigation): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageId) || !Number.isInteger(input.maxWallSeconds) ||
      input.maxWallSeconds < 1 || input.maxWallSeconds > 600 || !Number.isInteger(input.maxOutputBytes) ||
      input.maxOutputBytes < 1 || input.maxOutputBytes > 256 * 1024 ||
      !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 64 ||
      !Array.isArray(input.patterns) || input.patterns.length < 1 || input.patterns.length > 64) throw new Error('INVALID_ARGUMENT');
  const included = new Set(input.snapshot.manifest.map(entry => entry.path));
  for (const path of input.paths) {
    validateRelativePath(path);
    if (!included.has(path)) throw new Error('INVALID_ARGUMENT');
  }
  for (const pattern of input.patterns) {
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.includes('\0') || pattern.includes('\n') ||
        Buffer.byteLength(pattern, 'utf8') > 256) throw new Error('INVALID_ARGUMENT');
  }
}

/** Used only with a trusted image and trusted command. External requests never supply executable or flags. */
export function sandboxArgs(name: string, snapshotDir: string, imageId: string, entrypoint: string, command: string[]): string[] {
  return ['create', '--name', name, '--pull=never', '--network=none', '--read-only', '--log-driver=none',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m',
    '--cpus=1', '--user=65534:65534', '--tmpfs=/scratch:rw,nosuid,nodev,size=16m,mode=1777',
    '--mount', `type=bind,"source=${snapshotDir}",target=/snapshot,readonly`,
    '--workdir=/snapshot', '--entrypoint', entrypoint, imageId, ...command];
}

function investigationName(name: string): void {
  if (!/^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) {
    throw new Error('INVALID_ARGUMENT');
  }
}

/** Remove one attempt's materialized source copy by its persisted exact name. */
export async function cleanupInvestigationScratch(name: string, root: string): Promise<void> {
  investigationName(name);
  if (!isAbsolute(root) || resolve(root) !== root || basename(root) !== name) throw new Error('INVALID_ARGUMENT');
  // Windows recursive path deletion can follow an ancestor junction replaced
  // between validation and rm. Until cleanup has a handle-anchored native API,
  // retain even an apparently absent root and keep the attempt unsettled.
  if (process.platform === 'win32') throw new Error('RECOVERY_REQUIRED');
  // A junction or symlink in any ancestor can redirect deletion outside the
  // persisted attempt root. Refuse it even when the final component is plain.
  let missingRoot = false;
  for (let path = root; ; path = dirname(path)) {
    let ancestor;
    try { ancestor = await lstat(path); }
    catch (error) {
      if (path === root && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        missingRoot = true;
        continue;
      }
      throw error;
    }
    if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) throw new Error('RECOVERY_REQUIRED');
    if (path === dirname(path)) break;
  }
  if (await realpath(dirname(root)) !== dirname(root)) throw new Error('RECOVERY_REQUIRED');
  if (missingRoot) return;
  let stat;
  try { stat = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('RECOVERY_REQUIRED');
  await rm(root, { recursive: true });
}

/** Remove only the exact Docker identity recorded for this attempt. An empty name
 * lookup cannot settle a create unless a prior observed ID was durably saved. */
export async function cleanupPersistedContainer(name: string, persistedId: string | null,
  persistObserved: (id: string) => void | Promise<void>, runDocker: typeof docker = docker): Promise<string> {
  investigationName(name);
  if (persistedId !== null && !/^[0-9a-f]{64}$/.test(persistedId)) throw new Error('INVALID_ARGUMENT');
  // Only Docker operations are normalized here. Persistence failures must stay
  // distinguishable and must stop cleanup before an irreversible rm.
  const cleanupDocker: typeof docker = async (args, limit, timeoutMs) => {
    try { return await runDocker(args, limit, timeoutMs); }
    catch { throw new Error('ISOLATION_TERMINATION_UNCONFIRMED'); }
  };
  const observed = await inspectCreatedContainer(name, cleanupDocker);
  if (observed && persistedId && observed !== persistedId) throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  const id = persistedId ?? observed;
  if (!id) throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  if (!persistedId) await persistObserved(id);
  if (observed === id) {
    const removed = await cleanupDocker(['rm', '-f', id], 4096, 5000);
    if (removed.code !== 0) throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  }
  const byId = await cleanupDocker(['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'], 4096, 5000);
  if (byId.code !== 0 || byId.stdout.trim() !== '' || await inspectCreatedContainer(name, cleanupDocker) !== null) {
    throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  }
  return id;
}

async function inspectCreatedContainer(name: string, runDocker: typeof docker = docker): Promise<string | null> {
  const listed = await runDocker(['ps', '-a', '--no-trunc', '--filter', `name=^/${name}$`,
    '--format', '{{.ID}} {{.Names}}'], 4096, 5000);
  if (listed.code !== 0) throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  const rows = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  const [id, actualName] = rows[0]!.split(' ');
  if (!/^[0-9a-f]{64}$/.test(id ?? '') || actualName !== name) throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  return id!;
}

/** Reconciles a create whose daemon-side success may have outlived the client response. */
export async function reconcileCreatedContainer(name: string): Promise<void> {
  investigationName(name);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const id = await inspectCreatedContainer(name);
      if (id === null) continue;
      const removed = await docker(['rm', '-f', id], 4096, 5000);
      if (removed.code !== 0) continue;
      if (await inspectCreatedContainer(name) === null) return;
    } catch { /* A transient daemon/client failure is retried and never accepted as termination. */ }
  }
  // An empty listing alone cannot rule out a late daemon-side create.
  throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
}

export async function docker(args: string[], limit: number, timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const executable = process.platform === 'win32' ? String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe` : 'docker';
    if (process.platform === 'win32') {
      try {
        const file = lstatSync(executable);
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('ISOLATION_UNAVAILABLE');
      } catch { throw new Error('ISOLATION_UNAVAILABLE'); }
    }
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: environment });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    const append = (chunk: Buffer, target: Buffer[]) => {
      bytes += chunk.length;
      if (bytes > limit) { exceeded = true; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, chunks));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, errors));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (exceeded) reject(new Error('OUTPUT_LIMIT_EXCEEDED'));
      else if (child.killed) reject(new Error('TIME_LIMIT_EXCEEDED'));
      else resolvePromise({ code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
    });
  });
}

/** Executes a fixed, literal grep over a materialized immutable snapshot. This is a tool worker, not an AI agent. */
export async function runStaticInvestigation(input: StaticInvestigation,
  reserveCreateName: (name: string, scratchRoot: string) => void | Promise<void>,
  persistObservedContainerId?: (id: string) => void | Promise<void>): Promise<StaticInvestigationReceipt> {
  valid(input);
  if (typeof reserveCreateName !== 'function' || typeof persistObservedContainerId !== 'function') throw new Error('INVALID_ARGUMENT');
  const name = `rcac-investigator-${randomUUID()}`;
  const root = resolve(tmpdir(), name);
  const snapshotDir = join(root, 'snapshot');
  let scratchCreated = false;
  let createAttempted = false;
  let observedId: string | null = null;
  try {
    // This commits the attempt/name association before any source bytes are materialized.
    await reserveCreateName(name, root);
    await mkdir(root, { mode: 0o700 });
    scratchCreated = true;
    await mkdir(snapshotDir);
    for (const requestedPath of new Set(input.paths)) {
      const path = validateRelativePath(requestedPath);
      const entry = input.snapshot.manifest.find(item => item.path === path);
      if (!entry) throw new Error('INTEGRITY_ERROR');
      const bytes = input.snapshot.file(path);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256 || bytes.length !== entry.sizeBytes) throw new Error('INTEGRITY_ERROR');
      const destination = resolve(snapshotDir, ...path.split('/'));
      if (!destination.startsWith(resolve(snapshotDir) + '\\') && !destination.startsWith(resolve(snapshotDir) + '/')) throw new Error('INTEGRITY_ERROR');
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
    }
    const args = sandboxArgs(name, snapshotDir, input.imageId, '/bin/grep',
      ['-n', '-H', '-F', ...input.patterns.flatMap(pattern => ['-e', pattern]), '--', ...input.paths.map(path => `/snapshot/${path}`)]);
    const deadline = Date.now() + input.maxWallSeconds * 1000;
    createAttempted = true;
    const created = await docker(args, 4096, Math.max(1, deadline - Date.now()));
    if (created.code !== 0) throw new Error('ISOLATION_UNAVAILABLE');
    const id = created.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('ISOLATION_UNAVAILABLE');
    if (await inspectCreatedContainer(name) !== id) throw new Error('ISOLATION_UNAVAILABLE');
    // A normal run also needs a durable identity before start/removal. Its
    // caller must commit this under the still-current attempt lease.
    await persistObservedContainerId(id);
    observedId = id;
    const result = await docker(['start', '-a', id], input.maxOutputBytes, Math.max(1, deadline - Date.now()));
    if (result.code !== 0 && result.code !== 1) throw new Error('ISOLATION_UNAVAILABLE');
    const toolReceipt = createHash('sha256').update(JSON.stringify({ snapshotRef: input.snapshot.id,
      imageId: input.imageId, paths: input.paths, patterns: input.patterns, exitCode: result.code,
      stdout: result.stdout })).digest('hex');
    return { snapshotRef: input.snapshot.id, imageId: input.imageId, searchedPaths: [...input.paths],
      matches: result.stdout, outputTruncated: false, exitCode: result.code,
      toolReceipt, isolation: 'docker_readonly_network_none' };
  } finally {
    // A create may arrive after an empty Docker listing. Keep its persisted mount
    // available until recovery can confirm and remove the exact named container.
    if (createAttempted) await cleanupPersistedContainer(name, observedId, persistObservedContainerId);
    if (scratchCreated) await cleanupInvestigationScratch(name, root);
  }
}

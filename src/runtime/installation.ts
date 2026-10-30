import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireExclusiveMaintenanceGate, acquireRuntimeMaintenanceGate } from './maintenance-gate.js';
import { assertPrivateDataDirectory, assertPrivateInstallationDirectory } from './local-security.js';

export interface InstallationRuntime {
  readonly kind: 'flat' | 'managed';
  readonly installationDirectory: string;
  readonly dataDirectory: string;
  readonly maintenanceEligible: boolean;
  release(): void;
}

export interface InstallationMaintenance {
  readonly kind: 'maintenance';
  readonly installationDirectory: string;
  readonly dataDirectory: string;
  release(): void;
}

const active = new WeakSet<object>();
const activeMaintenance = new WeakSet<object>();
// Cleanup failure must not let garbage collection release a still-owned gate.
const uncertainLifecycleLeases = new Set<InstallationRuntime>();
const uncertainLifecycleGates = new Set<{ release(): void }>();
const uncertainMaintenanceOwners = new Set<InstallationMaintenance>();
const uncertainMaintenanceGates = new Set<{ release(): void }>();

class InstallationFileCloseUnconfirmed extends AggregateError {
  constructor(primary: unknown, closeError: unknown, failed: boolean) {
    super(failed ? [primary, closeError] : [closeError], 'Installation file close unconfirmed',
      { cause: closeError });
  }
}

export function retainInstallationRuntime(runtime: InstallationRuntime): void {
  assertActiveInstallation(runtime);
  uncertainLifecycleLeases.add(runtime);
}
export function assertActiveInstallationMaintenance(owner: InstallationMaintenance): void {
  if (!owner || !activeMaintenance.has(owner)) unsafe();
}
export function retainInstallationMaintenance(owner: InstallationMaintenance): void {
  assertActiveInstallationMaintenance(owner);
  uncertainMaintenanceOwners.add(owner);
}
function unsafe(stage = 'validation', detail?: Readonly<Record<string, string>>): never {
  throw new Error('INSTALLATION_UNSAFE', { cause: Object.freeze({
    component: 'installation_runtime', stage, ...(detail ? { detail } : {}),
  }) });
}

function safeFailureDetail(error: unknown): Readonly<Record<string, string>> | undefined {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  if (!cause || typeof cause !== 'object') return;
  const value = cause as Record<string, unknown>;
  if (value.component === 'private_directory' &&
      ['protect', 'verify_data', 'verify_installation'].includes(String(value.operation)) &&
      ['timeout', 'output_limit', 'spawn_missing', 'spawn_denied', 'helper_rejected', 'unknown'].includes(String(value.reason))) {
    return Object.freeze({ component: 'private_directory', operation: String(value.operation), reason: String(value.reason) });
  }
  if (value.component === 'maintenance_gate' &&
      ['root_shape', 'root_lstat', 'root_realpath', 'root_acl', 'unknown'].includes(String(value.stage)) &&
      ['invalid', 'missing', 'io_failed', 'security_rejected', 'rejected'].includes(String(value.reason))) {
    return Object.freeze({ component: 'maintenance_gate', stage: String(value.stage), reason: String(value.reason) });
  }
}

function present(file: string, stage = 'validation'): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    return unsafe(stage);
  }
}

function assertNoManagedAncestor(path: string): void {
  let parent = dirname(path);
  while (parent !== path) {
    if (present(join(parent, 'managed.json'), 'managed_descendant') ||
        present(join(parent, 'lifecycle.sqlite'), 'managed_descendant')) unsafe('managed_descendant');
    path = parent;
    parent = dirname(path);
  }
}

/** Validate a caller-selected, nonexistent root before any managed-init filesystem write. */
export function assertFreshManagedInstallationDestination(directory: string): string {
  if (typeof directory !== 'string' || !directory || !isAbsolute(directory)) unsafe('fresh_destination');
  const root = resolve(directory);
  assertNoManagedAncestor(root);
  let canonicalParent: string;
  try {
    const parent = dirname(root);
    canonicalParent = realpathSync.native(parent);
    if (!statSync(parent).isDirectory()) unsafe('fresh_destination');
  } catch { return unsafe('fresh_destination'); }
  assertNoManagedAncestor(join(canonicalParent, basename(root)));
  if (present(root, 'fresh_destination')) unsafe('fresh_destination');
  return root;
}

function boundedJson(file: string, limit: number): unknown {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) unsafe();
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  let primary: unknown;
  let failed = false;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.nlink !== 1) unsafe();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd), pathAfter = lstatSync(file);
    if (size > limit || size !== before.size || after.size !== before.size || after.nlink !== 1 ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size ||
        pathAfter.isSymbolicLink()) unsafe();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
  } catch (error) { primary = error; failed = true; }
  let closeError: unknown;
  let closeFailed = false;
  try { closeSync(fd); } catch (error) { closeError = error; closeFailed = true; }
  if (closeFailed) throw new InstallationFileCloseUnconfirmed(primary, closeError, failed);
  if (failed) throw primary;
  return value;
}

/** Locate this running module's own package; cwd and environment are not package authority. */
export function currentInstallationPackageVersion(): string {
  try {
    const file = findPackageJSON(import.meta.url);
    if (!file) unsafe();
    const value = boundedJson(file, 64 * 1024) as { name?: unknown; version?: unknown } | null;
    if (!value || value.name !== 'repo-conduit' || typeof value.version !== 'string' ||
        !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)) unsafe();
    return value.version;
  } catch (error) {
    if (error instanceof InstallationFileCloseUnconfirmed) throw error;
    return unsafe();
  }
}

export function assertActiveInstallation(runtime: InstallationRuntime): void {
  if (!runtime || !active.has(runtime)) unsafe();
}

/** Parse the exact managed generation only while the caller owns the gate. */
function managedDataDirectory(root: string, manifestFile: string, setStage: (stage: string) => void): string {
  setStage('installation_manifest');
  if (present(join(root, 'state.sqlite'))) unsafe();
  assertPrivateInstallationDirectory(root, manifestFile);
  const value = boundedJson(manifestFile, 8 * 1024);
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsafe();
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).sort().join(',') !== 'activeGeneration,dataFormatVersion,packageVersion,schemaVersion' ||
      manifest.schemaVersion !== 1 || manifest.dataFormatVersion !== 1 ||
      manifest.packageVersion !== currentInstallationPackageVersion() ||
      typeof manifest.activeGeneration !== 'string' ||
      !/^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.activeGeneration)) unsafe();
  const generations = join(root, 'generations');
  const generation = join(generations, manifest.activeGeneration);
  const data = join(generation, 'data');
  setStage('generation_path');
  for (const path of [generations, generation, data]) {
    const stat = lstatSync(path);
    const canonical = realpathSync.native(path);
    const equal = process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') === path.toLocaleLowerCase('en-US') : canonical === path;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equal) unsafe();
    assertPrivateInstallationDirectory(path);
  }
  return data;
}

/** Acquire before reading a managed manifest or opening any writable product store. */
export function acquireInstallationRuntime(directory: string): InstallationRuntime {
  let gate: ReturnType<typeof acquireRuntimeMaintenanceGate> | undefined;
  let stage = 'installation_root';
  try {
    if (!directory || !isAbsolute(directory)) unsafe();
    const root = resolve(directory);
    stage = 'managed_descendant';
    assertNoManagedAncestor(root);
    assertNoManagedAncestor(realpathSync.native(root));
    stage = 'installation_root';
    const manifestFile = join(root, 'managed.json');
    const managed = present(manifestFile) || present(join(root, 'lifecycle.sqlite'));
    let data = root;
    if (managed) {
      stage = 'installation_gate';
      gate = acquireRuntimeMaintenanceGate(root);
      data = managedDataDirectory(root, manifestFile, next => { stage = next; });
    }
    stage = 'data_acl';
    assertPrivateDataDirectory(data);
    let released = false;
    const held = gate;
    const runtime: InstallationRuntime = Object.freeze({ kind: managed ? 'managed' : 'flat',
      installationDirectory: root, dataDirectory: data, maintenanceEligible: managed,
      release(): void {
        if (released) return;
        held?.release();
        released = true;
        active.delete(runtime);
      } });
    active.add(runtime);
    return runtime;
  } catch (error) {
    if (error instanceof InstallationFileCloseUnconfirmed && gate) {
      uncertainLifecycleGates.add(gate);
      throw error;
    }
    try { gate?.release(); } catch { throw new Error('INSTALLATION_RELEASE_FAILED'); }
    if (error instanceof Error && error.message === 'MAINTENANCE_GATE_BUSY') throw error;
    return unsafe(stage, safeFailureDetail(error));
  }
}

/** Acquire a distinct owner for managed-only maintenance; no runtime or recovery is opened. */
export function acquireInstallationMaintenance(directory: string): InstallationMaintenance {
  let gate: ReturnType<typeof acquireExclusiveMaintenanceGate> | undefined;
  let stage = 'installation_root';
  try {
    if (typeof directory !== 'string' || !directory || !isAbsolute(directory)) unsafe();
    const root = resolve(directory);
    stage = 'managed_descendant';
    assertNoManagedAncestor(root);
    assertNoManagedAncestor(realpathSync.native(root));
    stage = 'installation_gate';
    gate = acquireExclusiveMaintenanceGate(root);
    const data = managedDataDirectory(root, join(root, 'managed.json'), next => { stage = next; });
    stage = 'data_acl';
    assertPrivateDataDirectory(data);
    let released = false;
    const held = gate;
    const owner: InstallationMaintenance = Object.freeze({ kind: 'maintenance',
      installationDirectory: root, dataDirectory: data,
      release(): void {
        if (released) return;
        try { held.release(); }
        catch (error) { uncertainMaintenanceOwners.add(owner); throw error; }
        released = true;
        activeMaintenance.delete(owner);
        uncertainMaintenanceOwners.delete(owner);
      } });
    activeMaintenance.add(owner);
    return owner;
  } catch (error) {
    if (error instanceof InstallationFileCloseUnconfirmed && gate) {
      uncertainMaintenanceGates.add(gate);
      throw error;
    }
    if (gate) {
      try { gate.release(); }
      catch (releaseError) {
        uncertainMaintenanceGates.add(gate);
        throw new AggregateError([error, releaseError], 'Installation maintenance acquisition cleanup unconfirmed',
          { cause: releaseError });
      }
    }
    if (error instanceof Error && error.message === 'MAINTENANCE_GATE_BUSY') throw error;
    return unsafe(stage, safeFailureDetail(error));
  }
}

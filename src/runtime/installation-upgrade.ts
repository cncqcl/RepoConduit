import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { backupInstallationWithinMaintenance, copyInstallationBackupIntoGeneration,
  inspectInstallationGenerationWithinMaintenance, assertFreshInactiveGenerationDestination } from './installation-backup.js';
import { acquireInstallationMaintenance, assertActiveInstallationMaintenance,
  assertFreshManagedInstallationDestination, currentInstallationPackageVersion,
  retainInstallationMaintenance, type InstallationMaintenance } from './installation.js';
import { inspectInstallationPackageArchive, type InspectedInstallationPackage } from './installation-package-preflight.js';
import { installCandidatePackage, executeInstallationCandidateMigration } from './installation-npm.js';
import { assertPrivateInstallationDirectory, protectNewDataDirectory } from './local-security.js';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_MANIFEST = 8 * 1024;
const MAX_BACKUP_MANIFEST = 2 * 1024 * 1024;
function unsafe(): never { throw new Error('INSTALLATION_UPGRADE_UNSAFE'); }
function equal(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}
function ordinary(file: string, limit: number): Stats {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit ||
      !equal(realpathSync.native(file), file)) unsafe();
  return stat;
}
function readBounded(file: string, limit: number): Buffer {
  const before = ordinary(file, limit);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let result: Buffer | undefined;
  let primary: unknown;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.nlink !== 1 || opened.size !== before.size) unsafe();
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count <= before.size) {
      const part = readSync(fd, bytes, count, bytes.length - count, count);
      if (!part) break;
      count += part;
    }
    const after = fstatSync(fd), pathAfter = ordinary(file, limit);
    if (count !== before.size || after.size !== before.size || after.nlink !== 1 ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) unsafe();
    result = bytes.subarray(0, count);
  } catch (error) { primary = error; }
  try { closeSync(fd); }
  catch (closeError) { throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
    'Installation upgrade source close unconfirmed', { cause: closeError }); }
  if (primary !== undefined) throw primary;
  return result!;
}
function writeExclusive(file: string, bytes: Uint8Array): void {
  const fd = openSync(file, 'wx', 0o600);
  let primary: unknown;
  try {
    let written = 0;
    while (written < bytes.length) {
      const part = writeSync(fd, bytes, written, bytes.length - written);
      if (part < 1) unsafe();
      written += part;
    }
    fsyncSync(fd);
  } catch (error) { primary = error; }
  try { closeSync(fd); }
  catch (closeError) { throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
    'Installation upgrade publication close unconfirmed', { cause: closeError }); }
  if (primary !== undefined) throw primary;
}
function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  protectNewDataDirectory(path);
  assertPrivateInstallationDirectory(path);
}
function selectedManifest(root: string, owner: InstallationMaintenance): Buffer {
  assertActiveInstallationMaintenance(owner);
  const path = join(root, 'managed.json');
  assertPrivateInstallationDirectory(root, path);
  const bytes = readBounded(path, MAX_MANIFEST);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return unsafe(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsafe();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'activeGeneration,dataFormatVersion,packageVersion,schemaVersion' ||
      record.schemaVersion !== 1 || record.dataFormatVersion !== 1 ||
      record.packageVersion !== currentInstallationPackageVersion() ||
      typeof record.activeGeneration !== 'string' ||
      !/^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.activeGeneration) ||
      record.activeGeneration !== owner.dataDirectory.split(sep).at(-2)) unsafe();
  return bytes;
}
function disallowInsideInstallation(root: string, path: string): void {
  if (!isAbsolute(path)) unsafe();
  const candidate = resolve(path);
  const child = relative(root, candidate);
  if (child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) unsafe();
}
function overlaps(left: string, right: string): boolean {
  const child = relative(left, right);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function preflightUpgrade(owner: InstallationMaintenance, archiveAbsolute: string, backupAbsolute: string): {
  oldBytes: Buffer;
  old: { activeGeneration: string; packageVersion: string };
  archiveBytes: Buffer;
  packageInfo: InspectedInstallationPackage;
} {
  const root = owner.installationDirectory;
  const oldBytes = selectedManifest(root, owner);
  const old = JSON.parse(oldBytes.toString('utf8')) as { activeGeneration: string; packageVersion: string };
  if (old.packageVersion !== '0.1.0') unsafe();
  disallowInsideInstallation(root, archiveAbsolute);
  disallowInsideInstallation(root, backupAbsolute);
  const backup = assertFreshManagedInstallationDestination(backupAbsolute);
  const canonicalParent = realpathSync.native(dirname(backup));
  if (!equal(canonicalParent, dirname(backup))) unsafe();
  const canonicalBackup = join(canonicalParent, basename(backup));
  if (overlaps(root, canonicalBackup) || overlaps(canonicalBackup, root)) unsafe();
  const archiveBytes = readBounded(archiveAbsolute, MAX_ARCHIVE);
  const packageInfo = inspectInstallationPackageArchive(archiveBytes);
  if (packageInfo.packageVersion !== '0.1.1') unsafe();
  return { oldBytes, old, archiveBytes, packageInfo };
}
function assertQuietCandidateDatabase(data: string, stage: 'migration' | 'final_inspection'): void {
  for (const name of ['state.sqlite', 'issuer.sqlite']) {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (lstatSync(join(data, `${name}${suffix}`), { throwIfNoEntry: false }) !== undefined) {
        throw new Error('INSTALLATION_UPGRADE_UNSAFE',
          { cause: Object.freeze({ component: 'installation_upgrade', stage }) });
      }
    }
  }
}
function cliFile(prefix: string): string {
  const installed = join(prefix, 'node_modules', 'repo-conduit');
  const file = join(installed, 'dist', 'src', 'cli', 'main.js');
  for (const directory of [prefix, join(prefix, 'node_modules'), installed,
    join(installed, 'dist'), join(installed, 'dist', 'src'), join(installed, 'dist', 'src', 'cli')]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equal(realpathSync.native(directory), directory)) unsafe();
  }
  ordinary(file, 32 * 1024 * 1024);
  return file;
}
function installedPackage(prefix: string, expected: InspectedInstallationPackage): string {
  const installed = join(prefix, 'node_modules', 'repo-conduit');
  const candidateCli = cliFile(prefix);
  let packageJson: unknown, shrinkwrap: unknown;
  try {
    packageJson = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(readBounded(join(installed, 'package.json'), 2 * 1024 * 1024))) as unknown;
    shrinkwrap = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(readBounded(join(installed, 'npm-shrinkwrap.json'), 2 * 1024 * 1024))) as unknown;
  } catch (error) {
    if (error instanceof AggregateError) throw error;
    return unsafe();
  }
  if (!isDeepStrictEqual(packageJson, expected.packageJson) ||
      !isDeepStrictEqual(shrinkwrap, expected.shrinkwrap)) unsafe();
  return candidateCli;
}

/** Bounded local preflight. Its result does not attest data, dependencies, or migration readiness. */
export function dryRunInstallationUpgrade(rootAbsolute: string, archiveAbsolute: string, backupAbsolute: string): {
  dryRun: true;
  status: 'preflight_passed';
  scope: 'package_version_paths_and_maintenance';
  fromVersion: string;
  packageVersion: string;
  archiveSha256: string;
  sourceGeneration: string;
  notChecked: readonly ['registered_workspace_overlap', 'dataset_backup_and_integrity',
    'offline_dependency_availability', 'migration_and_activation'];
} {
  const owner = acquireInstallationMaintenance(rootAbsolute);
  let report: ReturnType<typeof dryRunInstallationUpgrade> | undefined;
  let primary: unknown;
  try {
    const { oldBytes, old, packageInfo } = preflightUpgrade(owner, archiveAbsolute, backupAbsolute);
    assertActiveInstallationMaintenance(owner);
    if (!readBounded(join(owner.installationDirectory, 'managed.json'), MAX_MANIFEST).equals(oldBytes)) unsafe();
    report = { dryRun: true, status: 'preflight_passed', scope: 'package_version_paths_and_maintenance',
      fromVersion: old.packageVersion, packageVersion: packageInfo.packageVersion,
      archiveSha256: packageInfo.sha256, sourceGeneration: old.activeGeneration,
      notChecked: ['registered_workspace_overlap', 'dataset_backup_and_integrity',
        'offline_dependency_availability', 'migration_and_activation'] };
  } catch (error) { primary = error; }
  if (primary instanceof AggregateError) {
    retainInstallationMaintenance(owner);
    throw primary;
  }
  try { owner.release(); }
  catch (closeError) {
    retainInstallationMaintenance(owner);
    throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
      'Installation upgrade dry-run owner close unconfirmed', { cause: closeError });
  }
  if (primary !== undefined) throw primary;
  return report!;
}

/** Trusted local coordinator. The old installed CLI owns EXCLUSIVE until the new manifest is published. */
export async function upgradeInstallation(rootAbsolute: string, archiveAbsolute: string, backupAbsolute: string):
  Promise<{ upgraded: true; packageVersion: string; candidateCli: string; activeGeneration: string }> {
  const owner = acquireInstallationMaintenance(rootAbsolute);
  let result: { upgraded: true; packageVersion: string; candidateCli: string; activeGeneration: string } | undefined;
  let primary: unknown;
  let publishing = false;
  try {
    const root = owner.installationDirectory;
    const { oldBytes, old, archiveBytes, packageInfo } = preflightUpgrade(owner, archiveAbsolute, backupAbsolute);
    await backupInstallationWithinMaintenance(owner, backupAbsolute);
    const backupManifest = readBounded(join(backupAbsolute, 'backup.json'), MAX_BACKUP_MANIFEST);
    const generation = `gen_${randomUUID()}`;
    const candidate = assertFreshInactiveGenerationDestination(owner, generation);
    privateDirectory(candidate);
    const copied = copyInstallationBackupIntoGeneration(owner, backupAbsolute, generation);
    if (!equal(copied.dataDirectory, join(candidate, 'data'))) unsafe();
    const packagePrefix = join(candidate, 'package');
    privateDirectory(packagePrefix);
    const archived = join(candidate, 'candidate.tgz');
    writeExclusive(archived, archiveBytes);
    if (createHash('sha256').update(readBounded(archived, MAX_ARCHIVE)).digest('hex') !== packageInfo.sha256) unsafe();
    await installCandidatePackage(archived, packagePrefix);
    const candidateCli = installedPackage(packagePrefix, packageInfo);
    const migrated = await executeInstallationCandidateMigration(packagePrefix, root, generation, old.packageVersion);
    if (migrated.migrated !== true || migrated.dataFormatVersion !== 1 ||
        migrated.packageVersion !== packageInfo.packageVersion) unsafe();
    assertQuietCandidateDatabase(copied.dataDirectory, 'migration');
    inspectInstallationGenerationWithinMaintenance(owner, generation);
    assertQuietCandidateDatabase(copied.dataDirectory, 'final_inspection');
    assertActiveInstallationMaintenance(owner);
    if (!readBounded(join(root, 'managed.json'), MAX_MANIFEST).equals(oldBytes)) unsafe();
    const completion = { schemaVersion: 1, dataFormatVersion: 1, sourceGeneration: old.activeGeneration,
      candidateGeneration: generation, fromVersion: old.packageVersion, packageVersion: packageInfo.packageVersion,
      archiveSha256: packageInfo.sha256, backupManifestSha256: createHash('sha256').update(backupManifest).digest('hex') };
    writeExclusive(join(candidate, 'upgrade-complete.json'), Buffer.from(JSON.stringify(completion)));
    assertPrivateInstallationDirectory(candidate, join(candidate, 'upgrade-complete.json'));
    assertActiveInstallationMaintenance(owner);
    if (!readBounded(join(root, 'managed.json'), MAX_MANIFEST).equals(oldBytes)) unsafe();
    const updated = Buffer.from(JSON.stringify({ schemaVersion: 1, activeGeneration: generation,
      packageVersion: packageInfo.packageVersion, dataFormatVersion: 1 }));
    const pending = join(root, `managed.json.upgrade-${randomUUID()}.pending`);
    publishing = true;
    writeExclusive(pending, updated);
    assertPrivateInstallationDirectory(root, pending);
    if (!readBounded(join(root, 'managed.json'), MAX_MANIFEST).equals(oldBytes)) unsafe();
    renameSync(pending, join(root, 'managed.json'));
    if (!readBounded(join(root, 'managed.json'), MAX_MANIFEST).equals(updated)) unsafe();
    assertPrivateInstallationDirectory(root, join(root, 'managed.json'));
    result = { upgraded: true, packageVersion: packageInfo.packageVersion,
      candidateCli, activeGeneration: generation };
  } catch (error) { primary = error; }
  if (primary instanceof AggregateError || (publishing && primary !== undefined)) {
    retainInstallationMaintenance(owner);
    throw primary;
  }
  try { owner.release(); }
  catch (closeError) {
    retainInstallationMaintenance(owner);
    throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
      'Installation upgrade owner close unconfirmed', { cause: closeError });
  }
  if (primary !== undefined) throw primary;
  return result!;
}

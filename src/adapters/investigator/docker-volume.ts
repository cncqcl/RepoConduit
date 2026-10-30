import { createHash } from 'node:crypto';
import { portablePathKey, validateRelativePath } from '../repository/path-policy.js';
import type { RepositorySnapshot } from '../repository/snapshots.js';

const maxFileBytes = 16 * 1024 * 1024;
const maxTarBytes = 128 * 1024 * 1024;
const containerName = /^rcac-investigator-(?:owner|reader)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fullId = /^[0-9a-f]{64}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/;

function requireName(value: string): void { if (!containerName.test(value)) throw new Error('INVALID_ARGUMENT'); }
function requireRoleName(value: string, role: 'owner' | 'reader'): void {
  requireName(value);
  if (!value.startsWith(`rcac-investigator-${role}-`)) throw new Error('INVALID_ARGUMENT');
}
function requireId(value: string): void { if (!fullId.test(value)) throw new Error('INVALID_ARGUMENT'); }
function requireImage(value: string): void { if (!imageId.test(value)) throw new Error('INVALID_ARGUMENT'); }
function requireVolume(value: string): void { if (!volumeName.test(value)) throw new Error('INVALID_ARGUMENT'); }

function tarName(path: string): string {
  validateRelativePath(path);
  // This narrow USTAR writer intentionally refuses PAX/longname and non-ASCII encodings.
  if (!/^[\x20-\x7e]+$/.test(path) || Buffer.byteLength(path) > 100) throw new Error('INVALID_ARGUMENT');
  return path;
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) throw new Error('LIMIT_EXCEEDED');
  header.write(digits.padStart(length - 1, '0'), offset, length - 1, 'ascii');
}

function header(path: string, type: '0' | '5', size: number): Buffer {
  const result = Buffer.alloc(512);
  result.write(path, 0, 100, 'ascii');
  octal(result, 100, 8, type === '5' ? 0o755 : 0o644);
  octal(result, 108, 8, 0);
  octal(result, 116, 8, 0);
  octal(result, 124, 12, size);
  octal(result, 136, 12, 0);
  result.fill(0x20, 148, 156);
  result.write(type, 156, 1, 'ascii');
  result.write('ustar\0', 257, 6, 'ascii');
  result.write('00', 263, 2, 'ascii');
  const checksum = result.reduce((sum, byte) => sum + byte, 0);
  octal(result, 148, 7, checksum);
  result[155] = 0x20;
  return result;
}

/** A bounded, deterministic archive from already captured bytes. No host path is opened. */
export function buildSnapshotTar(snapshot: RepositorySnapshot, paths: string[],
  limits: { maxFileBytes?: number; maxTarBytes?: number } = {}): Buffer {
  const fileLimit = limits.maxFileBytes ?? maxFileBytes;
  const tarLimit = limits.maxTarBytes ?? maxTarBytes;
  if (!Number.isSafeInteger(fileLimit) || fileLimit < 1 || fileLimit > maxFileBytes ||
      !Number.isSafeInteger(tarLimit) || tarLimit < 1024 || tarLimit > maxTarBytes ||
      !Array.isArray(paths) || paths.length < 1 || paths.length > 64) throw new Error('INVALID_ARGUMENT');
  const seen = new Set<string>();
  const directories = new Set<string>();
  const directoryKeys = new Map<string, string>();
  const files: { path: string; bytes: Buffer }[] = [];
  for (const path of paths) {
    tarName(path);
    const key = portablePathKey(path);
    if (seen.has(key)) throw new Error('INVALID_ARGUMENT');
    seen.add(key);
    const entries = snapshot.manifest.filter(entry => entry.path === path);
    if (entries.length !== 1) throw new Error('INTEGRITY_ERROR');
    const entry = entries[0]!;
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > fileLimit) throw new Error('LIMIT_EXCEEDED');
    const bytes = snapshot.file(path);
    if (!bytes || bytes.length !== entry.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('INTEGRITY_ERROR');
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const directory = tarName(parts.slice(0, i).join('/'));
      if (Buffer.byteLength(directory) + 1 > 100) throw new Error('INVALID_ARGUMENT');
      const directoryKey = portablePathKey(directory);
      const previous = directoryKeys.get(directoryKey);
      if (previous && previous !== directory) throw new Error('INTEGRITY_ERROR');
      directoryKeys.set(directoryKey, directory);
      directories.add(`${directory}/`);
    }
    files.push({ path, bytes });
  }
  if (files.some(file => directoryKeys.has(portablePathKey(file.path)))) throw new Error('INTEGRITY_ERROR');
  const orderedDirs = [...directories].sort();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let length = 1024 + 512 * (orderedDirs.length + files.length);
  for (const file of files) {
    length += Math.ceil(file.bytes.length / 512) * 512;
    if (length > tarLimit) throw new Error('LIMIT_EXCEEDED');
  }
  if (length > tarLimit) throw new Error('LIMIT_EXCEEDED');
  const result = Buffer.alloc(length);
  let offset = 0;
  for (const path of orderedDirs) { header(path, '5', 0).copy(result, offset); offset += 512; }
  for (const file of files) {
    header(file.path, '0', file.bytes.length).copy(result, offset);
    offset += 512;
    file.bytes.copy(result, offset);
    offset += Math.ceil(file.bytes.length / 512) * 512;
  }
  return result;
}

/** Verify a complete Docker cp archive against selected immutable snapshot bytes. */
export function verifySnapshotTarReadback(tar: Buffer, snapshot: RepositorySnapshot,
  paths: string[]): true {
  if (!Buffer.isBuffer(tar) || tar.length < 1024 || tar.length > maxTarBytes || tar.length % 512 !== 0 ||
      !Array.isArray(paths) || paths.length < 1 || paths.length > 64) throw new Error('INTEGRITY_ERROR');
  const expected = new Map<string, Buffer>();
  const directories = new Set<string>();
  for (const path of paths) {
    tarName(path);
    const bytes = snapshot.file(path);
    if (!bytes || expected.has(path)) throw new Error('INTEGRITY_ERROR');
    expected.set(path, bytes);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
  }
  const seen = new Set<string>();
  let offset = 0;
  let ended = false;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) {
        throw new Error('INTEGRITY_ERROR');
      }
      ended = true;
      break;
    }
    const field = (start: number, length: number) => {
      const value = block.subarray(start, start + length);
      const nul = value.indexOf(0);
      return value.subarray(0, nul < 0 ? value.length : nul).toString('ascii');
    };
    const raw = field(0, 100);
    const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
    const type = block[156];
    const sizeField = field(124, 12).trim();
    const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : NaN;
    const statedChecksum = field(148, 8).trim();
    const checksum = block.reduce((sum, byte, index) => sum +
      (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes ||
        block.some(byte => byte > 0x7f) ||
        !/^[0-7]+$/.test(statedChecksum) || Number.parseInt(statedChecksum, 8) !== checksum ||
        !/^[\x20-\x7e]+$/.test(raw) ||
        (type !== 0 && type !== 48 && type !== 53) ||
        block.subarray(345, 500).some(byte => byte !== 0) ||
        block.subarray(157, 257).some(byte => byte !== 0) ||
        block.subarray(329, 345).some(byte => byte !== 0)) throw new Error('INTEGRITY_ERROR');
    const isDir = type === 53;
    if (path !== '') validateRelativePath(path);
    if ((path === '' && !isDir) || seen.has(path) ||
        (isDir ? (path !== '' && (!directories.has(path) || size !== 0)) : !expected.has(path))) {
      throw new Error('INTEGRITY_ERROR');
    }
    seen.add(path);
    offset += 512;
    const next = offset + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error('INTEGRITY_ERROR');
    if (!isDir && !tar.subarray(offset, offset + size).equals(expected.get(path)!)) {
      throw new Error('INTEGRITY_ERROR');
    }
    offset = next;
  }
  if (!ended || [...expected.keys()].some(path => !seen.has(path))) throw new Error('INTEGRITY_ERROR');
  return true;
}

const isolationFlags = ['--pull=never', '--network=none', '--read-only', '--log-driver=none',
  '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--cpus=1'];

/** Create a materializer with one empty anonymous source volume. Start only after ID persistence. */
export function ownerCreateArgs(name: string, trustedImageId: string): string[] {
  requireRoleName(name, 'owner'); requireImage(trustedImageId);
  return ['create', '--name', name, ...isolationFlags, '--user=0:0', '-i',
    '--mount', 'type=volume,target=/snapshot,volume-nocopy',
    '--workdir=/snapshot', '--entrypoint', '/bin/tar', trustedImageId, '-x', '-f', '-', '-C', '/snapshot'];
}

/** The caller must verify the owner and volume inspection before creating this reader. */
export function readerCreateArgs(name: string, ownerId: string, trustedImageId: string,
  patterns: string[], paths: string[]): string[] {
  requireRoleName(name, 'reader'); requireId(ownerId); requireImage(trustedImageId);
  if (!Array.isArray(patterns) || patterns.length < 1 || patterns.length > 64 ||
      !Array.isArray(paths) || paths.length < 1 || paths.length > 64) throw new Error('INVALID_ARGUMENT');
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.includes('\0') || pattern.includes('\n') ||
        Buffer.byteLength(pattern) > 256) throw new Error('INVALID_ARGUMENT');
  }
  for (const path of paths) tarName(path);
  return ['create', '--name', name, ...isolationFlags, '--user=65534:65534',
    '--tmpfs=/scratch:rw,nosuid,nodev,size=16m,mode=1777', '--volumes-from', `${ownerId}:ro`,
    '--workdir=/snapshot', '--entrypoint', '/bin/grep', trustedImageId,
    '-n', '-H', '-F', ...patterns.flatMap(pattern => ['-e', pattern]), '--',
    ...paths.map(path => `/snapshot/${path}`)];
}

type Mount = { Type?: unknown; Name?: unknown; Destination?: unknown; RW?: unknown };
type Inspection = { Id?: unknown; Name?: unknown; Mounts?: unknown; HostConfig?: { VolumesFrom?: unknown } };

export function inspectContainerArgs(id: string): string[] {
  requireId(id);
  return ['inspect', '--type', 'container', id];
}

function inspection(json: string, name: string, id: string): Inspection {
  requireName(name); requireId(id);
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('ISOLATION_UNCONFIRMED'); }
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' || value[0] === null) {
    throw new Error('ISOLATION_UNCONFIRMED');
  }
  const row = value[0] as Inspection;
  if (row.Id !== id || row.Name !== `/${name}` || !Array.isArray(row.Mounts) || row.Mounts.length !== 1) {
    throw new Error('ISOLATION_UNCONFIRMED');
  }
  return row;
}

/** Parse `docker inspect --type container <exact-id>` JSON; fail closed on extra mounts. */
export function parseOwnerInspection(json: string, name: string, id: string): string {
  requireRoleName(name, 'owner');
  const row = inspection(json, name, id);
  const mount = row.Mounts as Mount[];
  const source = mount[0]!;
  if (source.Type !== 'volume' || source.Destination !== '/snapshot' || source.RW !== true ||
      typeof source.Name !== 'string' || !volumeName.test(source.Name)) throw new Error('ISOLATION_UNCONFIRMED');
  return source.Name;
}

export function parseReaderInspection(json: string, name: string, id: string, ownerId: string,
  expectedVolume: string): true {
  requireRoleName(name, 'reader');
  requireId(ownerId); requireVolume(expectedVolume);
  const row = inspection(json, name, id);
  const mount = (row.Mounts as Mount[])[0]!;
  if (mount.Type !== 'volume' || mount.Destination !== '/snapshot' || mount.RW !== false ||
      mount.Name !== expectedVolume || !Array.isArray(row.HostConfig?.VolumesFrom) ||
      row.HostConfig.VolumesFrom.length !== 1 || row.HostConfig.VolumesFrom[0] !== `${ownerId}:ro`) {
    throw new Error('ISOLATION_UNCONFIRMED');
  }
  return true;
}

/** Call in order. A caller must persist all identities before invoking any removal. */
export function cleanupArgs(readerId: string, ownerId: string, volume: string): string[][] {
  requireId(readerId); requireId(ownerId); requireVolume(volume);
  if (readerId === ownerId) throw new Error('INVALID_ARGUMENT');
  return [['rm', '-f', '-v', readerId], ['rm', '-f', '-v', ownerId]];
}

export function cleanupListingArgs(): string[][] {
  return [['ps', '-a', '--no-trunc', '--format', '{{.ID}}'],
    ['volume', 'ls', '--format', '{{.Name}}']];
}

/** Parse complete, successful `ps -a --no-trunc --format {{.ID}}` and `volume ls --format {{.Name}}` outputs. */
export function verifyCleanupListing(containerIds: string, volumeNames: string,
  expectedContainerIds: string[], expectedVolume: string): true {
  if (!Array.isArray(expectedContainerIds) || expectedContainerIds.length !== 2) throw new Error('INVALID_ARGUMENT');
  expectedContainerIds.forEach(requireId); requireVolume(expectedVolume);
  const ids = containerIds.trim() ? containerIds.trim().split(/\r?\n/) : [];
  const volumes = volumeNames.trim() ? volumeNames.trim().split(/\r?\n/) : [];
  if (ids.some(id => !fullId.test(id)) || volumes.some(volume => !volumeName.test(volume)) ||
      ids.some(id => expectedContainerIds.includes(id)) || volumes.includes(expectedVolume)) {
    throw new Error('ISOLATION_TERMINATION_UNCONFIRMED');
  }
  return true;
}

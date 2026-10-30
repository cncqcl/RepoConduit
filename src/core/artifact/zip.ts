import { inflateRawSync } from 'node:zlib';
import { validateArtifactPaths } from './paths.js';

const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;

function u16(bytes: Buffer, offset: number): number { if (offset + 2 > bytes.length) throw new Error('Truncated ZIP'); return bytes.readUInt16LE(offset); }
function u32(bytes: Buffer, offset: number): number { if (offset + 4 > bytes.length) throw new Error('Truncated ZIP'); return bytes.readUInt32LE(offset); }

function validateExtra(bytes: Buffer, start: number, end: number): void {
  if (end > bytes.length) throw new Error('Truncated ZIP extra field');
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw new Error('Truncated ZIP extra field');
    const field = u16(bytes, offset);
    const size = u16(bytes, offset + 2);
    offset += 4 + size;
    if (offset > end) throw new Error('Truncated ZIP extra field');
    if (field === 0x7075) throw new Error('Ambiguous ZIP filename encoding');
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInspection { paths: string[]; expandedBytes: number; entryCount: number }

/** Validates a simple ZIP archive in memory; extraction is deliberately unavailable. */
export function inspectZip(bytes: Buffer): ZipInspection {
  if (bytes.length < 22) throw new Error('Invalid ZIP');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50 && i + 22 + u16(bytes, i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0) throw new Error('Unsupported ZIP structure');
  const count = u16(bytes, end + 10);
  if (count !== u16(bytes, end + 8) || count > 256) throw new Error('ZIP file count exceeded');
  const centralSize = u32(bytes, end + 12);
  const centralOffset = u32(bytes, end + 16);
  if (centralOffset + centralSize !== end) throw new Error('Invalid ZIP central directory');
  let offset = centralOffset;
  let total = 0;
  const paths: string[] = [];
  const localRanges: Array<readonly [number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const checksum = u32(bytes, offset + 16);
    const compressed = u32(bytes, offset + 20);
    const size = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const externalAttributes = u32(bytes, offset + 38);
    const localOffset = u32(bytes, offset + 42);
    const endOfEntry = offset + 46 + nameLength + extraLength + commentLength;
    if (endOfEntry > end || (flags & ~0x800) || ![0, 8].includes(method)) throw new Error('Unsupported ZIP entry');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    validateExtra(bytes, offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    if (!(flags & 0x800) && rawName.some(byte => byte < 0x20 || byte > 0x7e)) throw new Error('Invalid ZIP filename encoding');
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName)) throw new Error('Invalid ZIP filename encoding');
    const kind = (externalAttributes >>> 16) & 0xf000;
    if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error('ZIP link or device entry rejected');
    if (name.endsWith('/')) throw new Error('ZIP directory entries are unsupported');
    paths.push(name);
    if (size > MAX_FILE || total + size > MAX_TOTAL || (compressed === 0 ? size > 0 : size > compressed * 100)) throw new Error('ZIP expansion budget exceeded');
    if (localOffset >= centralOffset || u32(bytes, localOffset) !== 0x04034b50 || u16(bytes, localOffset + 6) !== flags || u16(bytes, localOffset + 8) !== method || u32(bytes, localOffset + 14) !== checksum || u32(bytes, localOffset + 18) !== compressed || u32(bytes, localOffset + 22) !== size) throw new Error('ZIP local entry mismatch');
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(offset + 46, offset + 46 + nameLength))) throw new Error('ZIP filename mismatch');
    validateExtra(bytes, localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + localExtraLength);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > centralOffset) throw new Error('ZIP data overlaps central directory');
    localRanges.push([localOffset, dataStart + compressed]);
    const compressedBytes = bytes.subarray(dataStart, dataStart + compressed);
    const content = method === 0 ? compressedBytes : inflateRawSync(compressedBytes, { maxOutputLength: MAX_FILE + 1 });
    if (content.length !== size || crc32(content) !== checksum) throw new Error('ZIP content mismatch');
    total += size;
    offset = endOfEntry;
  }
  if (offset !== end) throw new Error('ZIP central directory trailing data');
  localRanges.sort((a, b) => a[0] - b[0]);
  let next = 0;
  for (const [start, finish] of localRanges) {
    if (start !== next || finish > centralOffset) throw new Error('ZIP local entry boundary mismatch');
    next = finish;
  }
  if (next !== centralOffset) throw new Error('ZIP local entry boundary mismatch');
  return { paths: validateArtifactPaths(paths), expandedBytes: total, entryCount: count };
}

export function validateZip(bytes: Buffer): string[] { return inspectZip(bytes).paths; }

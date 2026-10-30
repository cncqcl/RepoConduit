import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateRelativePath } from './path-policy.ts';
import type { RepositorySnapshot } from './snapshots.ts';
import { detectRecognizedMediaType } from '../../core/artifact/media.js';

export type QueryContext = { principal: string; scopePaths: string[] };
type CursorPayload = { snapshot: string; principal: string; scope: string[]; query: string; position: number };
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LINES = 2000;

function scope(context: QueryContext): string[] {
  if (!context.principal) throw new Error('NOT_AVAILABLE');
  return [...new Set(context.scopePaths)].sort();
}

function permitted(path: string, allowed: string[]): boolean {
  return allowed.some(item => item === path || item.endsWith('/') && path.startsWith(item));
}

function sign(snapshot: RepositorySnapshot, payload: CursorPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', snapshot.cursorKey).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function position(snapshot: RepositorySnapshot, context: QueryContext, query: string, cursor?: string): number {
  if (!cursor) return 0;
  const [data, signature, extra] = cursor.split('.');
  if (!data || !signature || extra) throw new Error('STALE_CURSOR');
  const expected = createHmac('sha256', snapshot.cursorKey).update(data).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('STALE_CURSOR'); }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('STALE_CURSOR');
  let parsed: CursorPayload;
  try { parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as CursorPayload; } catch { throw new Error('STALE_CURSOR'); }
  if (parsed.snapshot !== snapshot.id || parsed.principal !== context.principal || JSON.stringify(parsed.scope) !== JSON.stringify(scope(context)) || parsed.query !== query || !Number.isSafeInteger(parsed.position) || parsed.position < 0) throw new Error('STALE_CURSOR');
  return parsed.position;
}

function next(snapshot: RepositorySnapshot, context: QueryContext, query: string, offset: number): string {
  return sign(snapshot, { snapshot: snapshot.id, principal: context.principal, scope: scope(context), query, position: offset });
}

function countNewlines(bytes: Buffer, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i++) if (bytes[i] === 10) count++;
  return count;
}

function decodeEnd(bytes: Buffer, start: number, target: number): number {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (let end = target; end >= Math.max(start + 1, target - 3); end--) {
    try { decoder.decode(bytes.subarray(start, end)); return end; } catch { /* cut before incomplete code point */ }
  }
  throw new Error('INVALID_ARGUMENT');
}

export function readSnapshot(snapshot: RepositorySnapshot, context: QueryContext, options: { path: string; maxBytes?: number; maxLines?: number; cursor?: string | undefined }) {
  let path: string;
  try { path = validateRelativePath(options.path); } catch { throw new Error('NOT_AVAILABLE'); }
  if (!permitted(path, scope(context))) throw new Error('NOT_AVAILABLE');
  const bytes = snapshot.file(path);
  if (!bytes) throw new Error('NOT_AVAILABLE');
  if (bytes.includes(0)) throw new Error('UNSUPPORTED_CAPABILITY');
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxLines = options.maxLines ?? 400;
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > MAX_READ_BYTES || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_READ_LINES) throw new Error('LIMIT_EXCEEDED');
  const query = JSON.stringify({ op: 'read', path, maxBytes, maxLines });
  const start = position(snapshot, context, query, options.cursor);
  if (start >= bytes.length && options.cursor) throw new Error('STALE_CURSOR');
  let rawEnd = Math.min(start + maxBytes, bytes.length);
  let lines = 0;
  for (let i = start; i < rawEnd; i++) {
    if (bytes[i] === 10 && ++lines >= maxLines) { rawEnd = i + 1; break; }
  }
  const end = rawEnd === bytes.length ? rawEnd : decodeEnd(bytes, start, rawEnd);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end)); } catch { throw new Error('UNSUPPORTED_CAPABILITY'); }
  const entry = snapshot.manifest.find(item => item.path === path)!;
  return {
    snapshotId: snapshot.id, path, content, contentHash: entry.sha256,
    lineRange: { start: countNewlines(bytes, start) + 1, end: countNewlines(bytes, Math.max(start, end - 1)) + 1 },
    byteRange: { start, end }, decoding: 'utf-8',
    completeness: end === bytes.length ? 'complete' as const : 'partial' as const,
    continuation: end === bytes.length ? undefined : next(snapshot, context, query, end),
  };
}

/** Whole original bytes for file transport; encoding is computed here, never rewritten by a model. */
export function readSnapshotOriginal(snapshot: RepositorySnapshot, context: QueryContext,
  options: { path: string; maxBytes?: number }) {
  let path: string;
  try { path = validateRelativePath(options.path); } catch { throw new Error('NOT_AVAILABLE'); }
  if (!permitted(path, scope(context))) throw new Error('NOT_AVAILABLE');
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED');
  const bytes = snapshot.file(path);
  if (!bytes) throw new Error('NOT_AVAILABLE');
  if (bytes.length > maxBytes) throw new Error('LIMIT_EXCEEDED');
  const entry = snapshot.manifest.find(item => item.path === path);
  if (!entry || entry.sizeBytes !== bytes.length) throw new Error('INTEGRITY_ERROR');
  return { snapshotId: snapshot.id, path, contentHash: entry.sha256, byteLength: bytes.length,
    encoding: 'base64' as const, data: bytes.toString('base64'),
    mediaType: detectRecognizedMediaType(bytes) ?? 'application/octet-stream', completeness: 'complete' as const };
}

export function listSnapshot(snapshot: RepositorySnapshot, context: QueryContext, options: { maxEntries?: number; cursor?: string | undefined } = {}) {
  const maxEntries = options.maxEntries ?? 50;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 200) throw new Error('LIMIT_EXCEEDED');
  const query = JSON.stringify({ op: 'list', maxEntries });
  const entries = snapshot.manifest.filter(item => permitted(item.path, scope(context)));
  const start = position(snapshot, context, query, options.cursor);
  if (start >= entries.length && options.cursor) throw new Error('STALE_CURSOR');
  const end = Math.min(entries.length, start + maxEntries);
  return { snapshotId: snapshot.id, entries: entries.slice(start, end), excludedCategories: [...new Set(snapshot.exclusions.map(item => item.reason))], completeness: end === entries.length ? 'complete' as const : 'partial' as const, continuation: end === entries.length ? undefined : next(snapshot, context, query, end) };
}

export function inspectSnapshot(snapshot: RepositorySnapshot, context: QueryContext) {
  const visible = snapshot.manifest.filter(item => permitted(item.path, scope(context)));
  return {
    snapshotId: snapshot.id, workingCopyId: snapshot.workingCopyId, baseCommit: snapshot.baseCommit,
    sourceConsistency: snapshot.sourceConsistency, visibleFileCount: visible.length,
    visibleBytes: visible.reduce((sum, item) => sum + item.sizeBytes, 0),
    excludedCategories: [...new Set(snapshot.exclusions.map(item => item.reason))],
  };
}

/** Compare two fixed trees by content hash. No live worktree contents are consulted. */
export function diffSnapshots(before: RepositorySnapshot, after: RepositorySnapshot, context: QueryContext, options: { maxEntries?: number; cursor?: string | undefined } = {}) {
  if (before.workingCopyId !== after.workingCopyId) throw new Error('NOT_AVAILABLE');
  const maxEntries = options.maxEntries ?? 50;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 200) throw new Error('LIMIT_EXCEEDED');
  const prior = new Map(before.manifest.filter(item => permitted(item.path, scope(context))).map(item => [item.path, item.sha256]));
  const current = new Map(after.manifest.filter(item => permitted(item.path, scope(context))).map(item => [item.path, item.sha256]));
  const paths = [...new Set([...prior.keys(), ...current.keys()])].sort();
  const changes = paths.flatMap(path => prior.get(path) === current.get(path) ? [] : [{ path, state: !prior.has(path) ? 'added' as const : !current.has(path) ? 'deleted' as const : 'modified' as const, beforeHash: prior.get(path), afterHash: current.get(path) }]);
  const query = JSON.stringify({ op: 'diff', before: before.id, after: after.id, maxEntries });
  const start = position(after, context, query, options.cursor);
  if (start >= changes.length && options.cursor) throw new Error('STALE_CURSOR');
  const end = Math.min(changes.length, start + maxEntries);
  return { beforeSnapshotId: before.id, afterSnapshotId: after.id, changes: changes.slice(start, end), completeness: end === changes.length ? 'complete' as const : 'partial' as const, continuation: end === changes.length ? undefined : next(after, context, query, end) };
}

export function searchSnapshot(snapshot: RepositorySnapshot, context: QueryContext, options: { term: string; maxBytes?: number; maxMatches?: number; cursor?: string | undefined }) {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxMatches = options.maxMatches ?? 50;
  if (!options.term || options.term.includes('\0') || Buffer.byteLength(options.term) > 1024 || !Number.isInteger(maxBytes) || maxBytes < Buffer.byteLength(options.term) || maxBytes > 64 * 1024 || !Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 200) throw new Error('LIMIT_EXCEEDED');
  const query = JSON.stringify({ op: 'search', term: options.term });
  const entries = snapshot.manifest.filter(item => permitted(item.path, scope(context)));
  const total = entries.reduce((sum, item) => sum + item.sizeBytes, 0);
  let offset = position(snapshot, context, query, options.cursor);
  if (offset >= total && options.cursor) throw new Error('STALE_CURSOR');
  const needle = Buffer.from(options.term);
  const matches: { path: string; line: number; contentHash: string; byteOffset: number }[] = [];
  const start = offset;
  const endBudget = Math.min(total, start + maxBytes);
  let fileStart = 0;
  for (const entry of entries) {
    const bytes = snapshot.file(entry.path)!;
    const fileEnd = fileStart + bytes.length;
    const from = Math.max(0, offset - fileStart);
    const to = Math.min(bytes.length, endBudget - fileStart);
    if (to > from) {
      let found = bytes.indexOf(needle, from);
      while (found >= 0 && found < to && found + needle.length <= to && matches.length < maxMatches) {
        matches.push({ path: entry.path, line: countNewlines(bytes, found) + 1, contentHash: entry.sha256, byteOffset: found });
        if (matches.length >= maxMatches) {
          offset = fileStart + found + 1;
          break;
        }
        found = bytes.indexOf(needle, found + Math.max(1, needle.length));
      }
      if (matches.length < maxMatches) offset = fileStart + (to === bytes.length ? to : Math.max(from, to - needle.length + 1));
    }
    fileStart = fileEnd;
    if (fileStart >= endBudget || matches.length >= maxMatches) break;
  }
  const complete = offset >= total;
  return {
    snapshotId: snapshot.id, searchedScope: scope(context), excludedCategories: [...new Set(snapshot.exclusions.map(item => item.reason))],
    matches, completeness: complete ? 'complete' as const : 'partial' as const,
    unsearchedReason: complete ? undefined : matches.length >= maxMatches ? 'match_limit' : 'byte_limit',
    continuation: complete ? undefined : next(snapshot, context, query, offset),
  };
}

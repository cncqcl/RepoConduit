import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedLocalFile } from './local-source.js';

const MAX_ENTRIES = 1024;
const MAX_RELEVANT = 128;
const MAX_BYTES = 32 * 1024 * 1024;

export type BrowserDownloadCaptureCategory = 'invalid_input' | 'protected_root' | 'root_changed' |
  'entry_budget' | 'ambiguous' | 'unsafe_file' | 'file_budget' | 'io_error';

/** Fixed-category failure: never include paths or raw OS errors in public messages. */
export class BrowserDownloadCaptureError extends Error {
  constructor(readonly category: BrowserDownloadCaptureCategory) {
    super(`Browser download capture: ${category}`);
    this.name = 'BrowserDownloadCaptureError';
  }
}

type FileMark = { dev: string; ino: string; size: number; mtimeMs: number; ctimeMs: number;
  mtimeNs: string; ctimeNs: string; nlink: number };
type RootMark = { path: string; canonical: string; dev: string; ino: string };
/** Persist only metadata; this record alone confers no collection authorization or source authenticity. */
export type BrowserDownloadBaseline = {
  root: string;
  expectedFilename: string;
  ancestors: RootMark[];
  entries: Record<string, FileMark>;
};
export type BrowserDownloadDelta = { state: 'pending' } | {
  /** A bounded filesystem candidate only; this says nothing about browser completion or source ownership. */
  state: 'candidate'; completion: 'unverified'; bytes: Buffer; sha256: string; identity: string; candidateFingerprint: string;
};

function fail(category: BrowserDownloadCaptureCategory): never { throw new BrowserDownloadCaptureError(category); }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function normalized(path: string): string { return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path; }
function within(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..' + sep) && child !== '..' && !isAbsolute(child));
}
function filenameValid(name: string): boolean {
  if (Array.from(name).some(char => char.charCodeAt(0) < 32)) return false;
  return name.length > 0 && name.length <= 255 && basename(name) === name && name !== '.' && name !== '..' &&
    !/[\\/<>:"|?*]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}
function relevant(name: string, expected: string): 'complete' | 'temporary' | null {
  const dot = expected.lastIndexOf('.');
  const stem = dot > 0 ? expected.slice(0, dot) : expected;
  const extension = dot > 0 ? expected.slice(dot) : '';
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const complete = new RegExp(`^${escaped(stem)}(?: \\([1-9][0-9]*\\))?${escaped(extension)}$`, process.platform === 'win32' ? 'iu' : 'u');
  if (complete.test(name)) return 'complete';
  const suffix = name.match(/^(.*)\.(?:crdownload|part)$/iu);
  return suffix && complete.test(suffix[1]!) ? 'temporary' : null;
}
function mark(path: string): FileMark {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('unsafe_file');
  if (stat.size < 0n || stat.size > BigInt(MAX_BYTES)) fail('file_budget');
  if (stat.mtimeMs < 0n || stat.ctimeMs < 0n ||
      stat.mtimeMs > BigInt(Number.MAX_SAFE_INTEGER) || stat.ctimeMs > BigInt(Number.MAX_SAFE_INTEGER)) fail('unsafe_file');
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), nlink: Number(stat.nlink) };
}
function rootMarks(root: string): RootMark[] {
  const paths: string[] = [];
  let current = root;
  for (;;) {
    paths.push(current);
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  paths.reverse();
  return paths.map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('root_changed');
    return { path, canonical: path === parse(path).root ? path : realpathSync(path),
      dev: stat.dev.toString(), ino: stat.ino.toString() };
  });
}
function sameRoot(a: RootMark[], b: RootMark[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return other !== undefined && normalized(item.path) === normalized(other.path) &&
      normalized(item.canonical) === normalized(other.canonical) && item.dev === other.dev && item.ino === other.ino;
  });
}
function checkProtection(root: string, forbiddenRoots: readonly string[]): void {
  const canonical = normalized(realpathSync(root));
  for (const forbidden of forbiddenRoots) {
    if (!isAbsolute(forbidden)) fail('invalid_input');
    const protectedRoot = normalized(realpathSync(forbidden));
    if (within(canonical, protectedRoot)) fail('protected_root');
  }
}
function scan(root: string, expected: string): { entries: Record<string, FileMark>; temporary: boolean } {
  const entries: Record<string, FileMark> = Object.create(null) as Record<string, FileMark>;
  let temporary = false;
  let count = 0;
  let relevantCount = 0;
  const dir = opendirSync(root);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (++count > MAX_ENTRIES) fail('entry_budget');
      const kind = relevant(entry.name, expected);
      if (kind === null) continue;
      if (++relevantCount > MAX_RELEVANT) fail('entry_budget');
      const path = join(root, entry.name);
      if (kind === 'temporary') {
        mark(path);
        temporary = true;
      } else entries[entry.name] = mark(path);
    }
  } finally { dir.closeSync(); }
  return { entries, temporary };
}
function guarded<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof BrowserDownloadCaptureError) throw error;
    return fail('io_error');
  }
}

/** Call immediately before the authorized browser action. Caller must serialize use of this root. */
export function establishBrowserDownloadBaseline(root: string, expectedFilename: string,
  forbiddenRoots: readonly string[]): BrowserDownloadBaseline {
  return guarded(() => {
    if (!isAbsolute(root) || !filenameValid(expectedFilename)) fail('invalid_input');
    const absolute = resolve(root);
    const ancestors = rootMarks(absolute);
    checkProtection(absolute, forbiddenRoots);
    const { entries, temporary } = scan(absolute, expectedFilename);
    // A preexisting partial could be renamed after the action and appear new.
    if (temporary) fail('ambiguous');
    if (!sameRoot(ancestors, rootMarks(absolute))) fail('root_changed');
    return { root: absolute, expectedFilename, ancestors, entries };
  });
}

/** Bounded candidate bytes only. The application must bind intent, account, chat, message and grant,
 * then require a completion signal or trusted expected size/hash before accepting a download. */
export function captureBrowserDownloadDelta(baseline: BrowserDownloadBaseline,
  forbiddenRoots: readonly string[]): BrowserDownloadDelta {
  return guarded(() => {
    if (!isAbsolute(baseline.root) || !filenameValid(baseline.expectedFilename)) fail('invalid_input');
    if (!sameRoot(baseline.ancestors, rootMarks(baseline.root))) fail('root_changed');
    checkProtection(baseline.root, forbiddenRoots);
    const { entries, temporary } = scan(baseline.root, baseline.expectedFilename);
    if (!sameRoot(baseline.ancestors, rootMarks(baseline.root))) fail('root_changed');
    const newNames: string[] = [];
    for (const [name, current] of Object.entries(entries)) {
      const old = baseline.entries[name];
      if (old === undefined) newNames.push(name);
      else if (!isDeepStrictEqual(old, current)) fail('ambiguous');
    }
    for (const name of Object.keys(baseline.entries)) if (entries[name] === undefined) fail('ambiguous');
    if (newNames.length > 1) fail('ambiguous');
    if (temporary || newNames.length === 0) return { state: 'pending' };
    const name = newNames[0]!;
    const selectedPath = join(baseline.root, name);
    const first = mark(selectedPath);
    const canonical = realpathSync(selectedPath);
    if (!within(normalized(canonical), normalized(realpathSync(baseline.root)))) fail('unsafe_file');
    const fd = openSync(selectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.dev.toString() !== first.dev || before.ino.toString() !== first.ino ||
          before.size !== BigInt(first.size) || before.mtimeNs.toString() !== first.mtimeNs ||
          before.ctimeNs.toString() !== first.ctimeNs) fail('unsafe_file');
      const bytes = readBoundedLocalFile(fd);
      const after = fstatSync(fd, { bigint: true });
      if (bytes.length !== first.size || after.size !== BigInt(first.size) ||
          after.dev.toString() !== first.dev || after.ino.toString() !== first.ino ||
          after.mtimeNs.toString() !== first.mtimeNs || after.ctimeNs.toString() !== first.ctimeNs) fail('unsafe_file');
      if (!isDeepStrictEqual(mark(selectedPath), first)) fail('unsafe_file');
      if (!sameRoot(baseline.ancestors, rootMarks(baseline.root))) fail('root_changed');
      const identity = digest(normalized(canonical));
      return { state: 'candidate', completion: 'unverified', bytes, sha256: digest(bytes), identity,
        candidateFingerprint: digest(JSON.stringify({ identity, ...first })) };
    } finally { closeSync(fd); }
  });
}

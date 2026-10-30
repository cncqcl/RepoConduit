import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_FILE_BYTES = 32 * 1024 * 1024;

type ReadChunk = (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;

/** Read one byte beyond the limit at most; a concurrently growing file cannot trigger an unbounded allocation. */
export function readBoundedLocalFile(fd: number, readChunk: ReadChunk = readSync): Buffer {
  const chunks: Buffer[] = [];
  const scratch = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (total <= MAX_FILE_BYTES) {
    const length = Math.min(scratch.length, MAX_FILE_BYTES + 1 - total);
    const count = readChunk(fd, scratch, 0, length, null);
    if (!Number.isInteger(count) || count < 0 || count > length) throw new Error('Local source read failed');
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > MAX_FILE_BYTES) throw new Error('File budget exceeded');
    chunks.push(Buffer.from(scratch.subarray(0, count)));
  }
  throw new Error('File budget exceeded');
}

function within(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

/** A local transport selection. The path never enters a command envelope or persisted receipt. */
export class LocalArtifactSource {
  constructor(private readonly selectedPath: string) {}

  read(forbiddenRoots: readonly string[]): { bytes: Buffer; identity: string; sha256: string } {
    if (!isAbsolute(this.selectedPath)) throw new Error('Local source must be absolute');
    const path = resolve(this.selectedPath);
    const selected = lstatSync(path);
    if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1 || selected.size > MAX_FILE_BYTES) {
      throw new Error('Local source is not an eligible regular file');
    }
    const canonical = realpathSync.native(path);
    const normalized = process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
    for (const root of forbiddenRoots) {
      const canonicalRoot = realpathSync.native(root);
      const normalizedRoot = process.platform === 'win32' ? canonicalRoot.toLocaleLowerCase('en-US') : canonicalRoot;
      if (within(normalized, normalizedRoot)) throw new Error('Local source is inside a protected root');
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES ||
          before.dev !== selected.dev || before.ino !== selected.ino) throw new Error('Local source changed');
      const bytes = readBoundedLocalFile(fd);
      const after = fstatSync(fd);
      if (bytes.length > MAX_FILE_BYTES || bytes.length !== before.size || after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error('Local source changed');
      }
      return { bytes, identity: createHash('sha256').update(canonical).digest('hex'),
        sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally { closeSync(fd); }
  }
}

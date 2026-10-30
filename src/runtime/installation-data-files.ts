import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { assertActiveInstallationMaintenance, type InstallationMaintenance } from './installation.js';

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface InstallationDataEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly device: number;
  readonly inode: number;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}

/** Read-only inventory of the owned active dataset; it never traverses registered workspaces.
 * The caller still must revalidate identity while opening/copying each file.
 * Optional limits can only reduce the fixed release bounds.
 */
export function inventoryInstallationData(owner: InstallationMaintenance,
  limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {}):
  Readonly<{ entries: readonly InstallationDataEntry[]; totalBytes: number }> {
  assertActiveInstallationMaintenance(owner);
  return inspectInstallationDataFiles(owner.dataDirectory, limits);
}

/** Metadata validation only. Caller selects and validates the private dataset; no write authority is granted. */
export function inspectInstallationDataFiles(directory: string,
  limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {}):
  Readonly<{ entries: readonly InstallationDataEntry[]; totalBytes: number }> {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  if (Object.keys(limits).some(key => key !== 'maxEntries' && key !== 'maxBytes') ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw new Error('INSTALLATION_DATA_LIMIT');
  }
  const root = resolve(directory);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(realpathSync.native(root), root)) {
    throw new Error('INSTALLATION_DATA_UNSAFE');
  }
  const entries: InstallationDataEntry[] = [];
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const opened = opendirSync(directory);
    let failure: unknown;
    try {
      for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
        if (entries.length >= maxEntries) throw new Error('INSTALLATION_DATA_LIMIT');
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        const relativePath = relative(root, path).split(sep).join('/');
        if (!relativePath || relativePath === '..' || relativePath.startsWith('../') ||
            stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
            stat.dev !== rootStat.dev || !samePath(realpathSync.native(path), path) ||
            (stat.isFile() && stat.nlink !== 1)) throw new Error('INSTALLATION_DATA_UNSAFE');
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('INSTALLATION_DATA_UNSAFE');
        const size = stat.isFile() ? stat.size : 0;
        if (size > maxBytes - totalBytes) throw new Error('INSTALLATION_DATA_LIMIT');
        totalBytes += size;
        entries.push(Object.freeze({ relativePath, kind: stat.isFile() ? 'file' : 'directory',
          size, device: stat.dev, inode: stat.ino }));
        if (stat.isDirectory()) pending.push(path);
      }
    } catch (error) { failure = error; }
    try { opened.closeSync(); }
    catch (closeError) {
      throw new AggregateError(failure === undefined ? [closeError] : [failure, closeError],
        'Installation data directory close unconfirmed', { cause: closeError });
    }
    if (failure !== undefined) throw failure;
  }
  return Object.freeze({ entries: Object.freeze(entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)), totalBytes });
}

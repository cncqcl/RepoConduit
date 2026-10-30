import { lstatSync, mkdirSync, opendirSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function present(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw new Error('Unsafe default installation', { cause: error });
  }
}

function directory(stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe default installation');
}

function installationCandidate(root: string): boolean {
  let found = false;
  for (const name of ['state.sqlite', 'managed.json', 'lifecycle.sqlite']) {
    const stat = present(join(root, name));
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe default installation');
    found = true;
  }
  return found;
}

/** Select a location, never trust, migrate, repair or initialize the selected installation. */
export function resolveDailyDataDirectory(home: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new TypeError('Absolute path required');
    return resolve(explicit);
  }
  if (!isAbsolute(home)) throw new TypeError('Absolute path required');
  const base = resolve(home, '.repo-conduit'), data = join(base, 'data');
  const container = present(base);
  if (!container) return data;
  directory(container);
  const legacy = installationCandidate(base), nested = present(data);
  if (legacy) {
    if (nested) throw new Error('Conflicting default installations; preserve both and select the intended --data-dir');
    return base;
  }
  const entries = opendirSync(base);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (entry.name !== 'data') throw new Error('Unrecognized default installation; existing contents preserved');
    }
  } finally { entries.closeSync(); }
  if (!nested) return data;
  directory(nested);
  if (!installationCandidate(data)) throw new Error('Unrecognized default installation; existing contents preserved');
  return data;
}

/** Only setup creates the empty default container; init still owns private data creation. */
export function prepareDefaultDailyContainer(home: string, expectedRoot: string): void {
  const unchanged = () => {
    if (resolveDailyDataDirectory(home) !== expectedRoot) throw new Error('Default installation changed during setup');
  };
  unchanged();
  const base = resolve(home, '.repo-conduit');
  if (expectedRoot !== join(base, 'data')) return;
  if (!present(base)) {
    try { mkdirSync(base, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
  }
  unchanged();
}

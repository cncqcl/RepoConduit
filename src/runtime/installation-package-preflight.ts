import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { satisfies, valid, validRange } from 'semver';

const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_DEPENDENCY_EDGES = 50_000;
const MAX_METADATA = 2 * 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const FORBIDDEN_SCRIPTS = new Set([
  'preinstall', 'install', 'postinstall', 'prepublish', 'prepublishonly',
  'prepack', 'pack', 'postpack', 'prepare', 'preprepare', 'postprepare'
]);
const REQUIRED_FILES = [
  'package/package.json', 'package/npm-shrinkwrap.json',
  'package/dist/src/cli/main.js', 'package/dist/src/cli/migrate-installation.js'
];

export interface InspectedInstallationPackage {
  readonly packageVersion: string;
  readonly sha256: string;
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly shrinkwrap: Readonly<Record<string, unknown>>;
}

function invalid(): never { throw new Error('Invalid upgrade package archive'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function exactVersion(value: unknown): string {
  const version = string(value);
  if (!VERSION.test(version) || valid(version) !== version) invalid();
  return version;
}
function namedDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const source = record(value);
  const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
  if (Object.keys(source).length > MAX_ENTRIES) invalid();
  for (const [name, spec] of Object.entries(source)) {
    if (!validPackageName(name) || typeof spec !== 'string' || spec.length > 128 || !spec ||
      !/^[0-9A-Za-z.*^~<>=| +-]+$/.test(spec) || validRange(spec) === null) invalid();
    dependencies[name] = spec;
  }
  return dependencies;
}
function validPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !name.includes('..') && !name.endsWith('.') && !name.endsWith(' ');
}
function json(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > MAX_METADATA) invalid();
  try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown); }
  catch { return invalid(); }
}
function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some(byte => byte !== 0)) invalid();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(end >= 0 ? bytes.subarray(0, end) : bytes); }
  catch { return invalid(); }
}
function octal(header: Buffer, start: number, length: number): number {
  const text = header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) invalid();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function portablePath(path: string): string {
  if (!path.startsWith('package/') || path.length > 1024 || path.includes('\\') ||
    [...path].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) invalid();
  const clean = path.endsWith('/') ? path.slice(0, -1) : path;
  const components = clean.split('/');
  if (components.some(component => !component || component === '.' || component === '..' ||
    component.includes(':') || component.endsWith('.') || component.endsWith(' ') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))) invalid();
  if (components.slice(1).some(component =>
    component.toLowerCase() === 'node_modules' || component.toLowerCase() === '.npmrc')) invalid();
  return clean.normalize('NFC').toLowerCase();
}
function archiveEntries(expanded: Buffer): Map<string, Buffer> {
  if (expanded.length % 512 !== 0 || expanded.length < 1024) invalid();
  const seen = new Map<string, 'file' | 'directory'>();
  const files = new Map<string, Buffer>();
  let cursor = 0;
  let count = 0;
  while (cursor < expanded.length) {
    const header = expanded.subarray(cursor, cursor + 512);
    if (header.length !== 512) invalid();
    if (header.every(byte => byte === 0)) {
      if (cursor + 1024 > expanded.length ||
        !expanded.subarray(cursor).every(byte => byte === 0)) invalid();
      break;
    }
    if (++count > MAX_ENTRIES) invalid();
    const checksum = octal(header, 148, 8);
    let actual = 0;
    for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (checksum !== actual || field(header, 257, 6) !== 'ustar') invalid();
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const key = portablePath(path);
    const type = header[156];
    const isDirectory = type === 53;
    if (!(type === 0 || type === 48 || isDirectory) ||
      field(header, 157, 100) !== '') invalid();
    const size = octal(header, 124, 12);
    if (octal(header, 100, 8) & ~0o777) invalid();
    if (isDirectory && (size !== 0 || !path.endsWith('/'))) invalid();
    if (!isDirectory && path.endsWith('/')) invalid();
    if (seen.has(key)) invalid();
    const kind = isDirectory ? 'directory' : 'file';
    seen.set(key, kind);
    const bodyStart = cursor + 512;
    const padded = Math.ceil(size / 512) * 512;
    const next = bodyStart + padded;
    if (next > expanded.length || size > MAX_EXPANDED ||
      expanded.subarray(bodyStart + size, next).some(byte => byte !== 0)) invalid();
    if (!isDirectory) files.set(path, expanded.subarray(bodyStart, bodyStart + size));
    cursor = next;
  }
  if (cursor >= expanded.length) invalid();
  for (const [path] of seen) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (seen.get(parts.slice(0, index).join('/')) === 'file') invalid();
    }
  }
  for (const path of REQUIRED_FILES) if (!files.has(path)) invalid();
  return files;
}
function strictObjectStringMap(value: unknown): Record<string, string> {
  const map = record(value);
  for (const item of Object.values(map)) if (typeof item !== 'string') invalid();
  return map as Record<string, string>;
}
function sameMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every(name => left[name] === right[name]);
}
function packageLockPath(path: string): string | null {
  if (!path) return '';
  const parts = path.split('/');
  let packageName = '';
  for (let index = 0; index < parts.length;) {
    if (parts[index++] !== 'node_modules') invalid();
    let name = parts[index++];
    if (!name) invalid();
    if (name.startsWith('@')) name += `/${parts[index++] ?? ''}`;
    if (!validPackageName(name)) invalid();
    packageName = name;
  }
  return packageName;
}
function lockGraph(packageJson: Record<string, unknown>, shrinkwrap: Record<string, unknown>): void {
  if (packageJson.name !== 'repo-conduit' ||
    exactVersion(packageJson.version) !== shrinkwrap.version ||
    shrinkwrap.name !== 'repo-conduit' || shrinkwrap.lockfileVersion !== 3 ||
    shrinkwrap.requires !== true) invalid();
  const bin = strictObjectStringMap(packageJson.bin);
  if (Object.keys(bin).length !== 1 || bin.rcac !== 'dist/src/cli/main.js') invalid();
  const scripts = packageJson.scripts === undefined ? {} : record(packageJson.scripts);
  if (Object.keys(scripts).some(script => FORBIDDEN_SCRIPTS.has(script.toLowerCase()))) invalid();
  if (packageJson.bundledDependencies !== undefined || packageJson.bundleDependencies !== undefined ||
    packageJson.workspaces !== undefined || packageJson.overrides !== undefined ||
    packageJson.optionalDependencies !== undefined || packageJson.peerDependencies !== undefined) invalid();
  const direct = namedDependencies(packageJson.dependencies);
  for (const spec of Object.values(direct)) exactVersion(spec);
  const packages = record(shrinkwrap.packages);
  if (Object.keys(packages).length > MAX_ENTRIES || !Object.hasOwn(packages, '')) invalid();
  const root = record(packages['']);
  if (root.name !== packageJson.name || root.version !== packageJson.version ||
    !sameMap(direct, namedDependencies(root.dependencies)) ||
    !sameMap(bin, strictObjectStringMap(root.bin)) ||
    !sameMap(namedDependencies(packageJson.devDependencies),
      namedDependencies(root.devDependencies))) invalid();
  const parsed = new Map<string, Record<string, unknown>>();
  const pathKeys = new Set<string>();
  for (const [path, value] of Object.entries(packages)) {
    const key = path.normalize('NFC').toLowerCase();
    if (pathKeys.has(key)) invalid();
    pathKeys.add(key);
    const name = packageLockPath(path);
    const node = record(value);
    if (path !== '') {
      if (!name) invalid();
      const version = exactVersion(node.version);
      if (node.link === true || node.inBundle === true || node.bundled === true ||
        typeof node.resolved !== 'string' ||
        !node.resolved.startsWith('https://registry.npmjs.org/') ||
        !/^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9@._~%+/-]+\.tgz$/.test(node.resolved) ||
        !INTEGRITY.test(node.integrity as string)) invalid();
      if (node.name !== undefined && node.name !== name) invalid();
      if (version.length > 128) invalid();
      namedDependencies(node.dependencies);
      namedDependencies(node.optionalDependencies);
      namedDependencies(node.peerDependencies);
    }
    parsed.set(path, node);
  }
  const resolveMaybe = (parentPath: string, name: string): string | undefined => {
    let parent = parentPath;
    while (true) {
      const candidate = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`;
      if (parsed.has(candidate)) return candidate;
      if (!parent) return undefined;
      const boundary = parent.lastIndexOf('/node_modules/');
      parent = boundary < 0 ? '' : parent.slice(0, boundary);
    }
  };
  const resolve = (parentPath: string, name: string): string =>
    resolveMaybe(parentPath, name) ?? invalid();
  const pending: [string, string][] = Object.entries(direct).map(([name, version]) => [resolve('', name), version]);
  const inspected = new Set<string>();
  let edges = pending.length;
  while (pending.length) {
    const [packagePath, spec] = pending.pop()!;
    const node = parsed.get(packagePath)!;
    if (node.dev === true || node.devOptional === true || node.link === true) invalid();
    if (!satisfies(string(node.version), spec)) invalid();
    if (inspected.has(packagePath)) continue;
    inspected.add(packagePath);
    const add = (target: string, range: string): void => {
      if (++edges > MAX_DEPENDENCY_EDGES) invalid();
      pending.push([target, range]);
    };
    for (const [dependency, range] of Object.entries(namedDependencies(node.dependencies))) {
      add(resolve(packagePath, dependency), range);
    }
    for (const [dependency, range] of Object.entries(namedDependencies(node.optionalDependencies))) {
      const target = resolveMaybe(packagePath, dependency);
      if (target) add(target, range);
    }
    const peers = namedDependencies(node.peerDependencies);
    const peerMeta = node.peerDependenciesMeta === undefined ? {} : record(node.peerDependenciesMeta);
    for (const [name, meta] of Object.entries(peerMeta)) {
      const fields = record(meta);
      if (!validPackageName(name) || Object.keys(fields).length !== 1 || fields.optional !== true) invalid();
    }
    const peerParentBoundary = packagePath.lastIndexOf('/node_modules/');
    const peerParent = peerParentBoundary < 0 ? '' : packagePath.slice(0, peerParentBoundary);
    for (const [dependency, range] of Object.entries(peers)) {
      const target = resolveMaybe(peerParent, dependency);
      if (!target) {
        if (!Object.hasOwn(peerMeta, dependency)) invalid();
        continue;
      }
      add(target, range);
    }
  }
}

export function inspectInstallationPackageArchive(bytes: Uint8Array): InspectedInstallationPackage {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 20 || bytes.byteLength > MAX_COMPRESSED) invalid();
  let expanded: Buffer;
  try { expanded = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED, rejectGarbageAfterEnd: true }); }
  catch { return invalid(); }
  const files = archiveEntries(expanded);
  const packageJson = json(files.get('package/package.json')!);
  const shrinkwrap = json(files.get('package/npm-shrinkwrap.json')!);
  lockGraph(packageJson, shrinkwrap);
  return Object.freeze({
    packageVersion: exactVersion(packageJson.version),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    packageJson: Object.freeze(packageJson), shrinkwrap: Object.freeze(shrinkwrap)
  });
}

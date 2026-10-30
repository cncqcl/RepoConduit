import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { inspectInstallationPackageArchive } from '../../src/runtime/installation-package-preflight.js';

const packageJson = {
  name: 'repo-conduit', version: '1.2.3', type: 'module',
  bin: { rcac: 'dist/src/cli/main.js' },
  dependencies: { zod: '4.2.0' }, scripts: { typecheck: 'tsc --noEmit' }
};
const shrinkwrap = {
  name: 'repo-conduit', version: '1.2.3', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'repo-conduit', version: '1.2.3', dependencies: { zod: '4.2.0' },
      bin: { rcac: 'dist/src/cli/main.js' } },
    'node_modules/zod': { version: '4.2.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.2.0.tgz',
      integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' }
  }
};

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}
function tar(entries: readonly { path: string; body?: Uint8Array; type?: string; rawSize?: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? []);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, Math.min(100, Buffer.byteLength(entry.path)), 'utf8');
    octal(entry.type === '5' ? 0o755 : 0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116);
    octal(entry.rawSize ?? body.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii'); header.write('00', 263, 'ascii');
    octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function entry(path: string, data: unknown): { path: string; body: Buffer } {
  return { path, body: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) };
}
function completeEntries() {
  return [entry('package/package.json', packageJson),
    entry('package/npm-shrinkwrap.json', shrinkwrap),
    entry('package/dist/src/cli/main.js', 'main'),
    entry('package/dist/src/cli/migrate-installation.js', 'migrate')];
}
function valid(): Buffer {
  return tar(completeEntries());
}
function replace(path: string, data: unknown): Buffer {
  return tar([entry('package/package.json', path === 'package/package.json' ? data : packageJson),
    entry('package/npm-shrinkwrap.json', path === 'package/npm-shrinkwrap.json' ? data : shrinkwrap),
    entry('package/dist/src/cli/main.js', 'main'),
    entry('package/dist/src/cli/migrate-installation.js', 'migrate')]);
}

test('actual local npm pack archive is accepted without install or lifecycle scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-pack-preflight-'));
  let packExitConfirmed = true;
  try {
    mkdirSync(join(root, 'dist', 'src', 'cli'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
    writeFileSync(join(root, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap));
    writeFileSync(join(root, 'dist', 'src', 'cli', 'main.js'), 'main');
    writeFileSync(join(root, 'dist', 'src', 'cli', 'migrate-installation.js'), 'migrate');
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, 'run through npm to use the installed npm CLI');
    packExitConfirmed = false;
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts',
      '--offline', '--pack-destination', root], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    packExitConfirmed = !packed.error && packed.signal === null && typeof packed.status === 'number';
    assert.ok(packExitConfirmed, 'npm pack exit unconfirmed; fixture retained');
    assert.equal(packed.status, 0, packed.stderr || String(packed.error));
    const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0]?.filename;
    assert.ok(filename);
    const inspected = inspectInstallationPackageArchive(readFileSync(join(root, filename)));
    assert.equal(inspected.packageVersion, '1.2.3');
    assert.match(inspected.sha256, /^[a-f0-9]{64}$/);
    assert.equal(inspected.packageJson.name, 'repo-conduit');
  } finally {
    if (packExitConfirmed) {
      assert.ok(root.startsWith(join(tmpdir(), 'rcac-pack-preflight-')));
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('archive rejects path and tar structure ambiguity before files are extracted', () => {
  assert.equal(inspectInstallationPackageArchive(valid()).packageVersion, '1.2.3');
  const cases = [
    tar([...completeEntries(), entry('package/../escape', 'x')]),
    tar([...completeEntries(), entry('package/Package.JSON', packageJson)]),
    tar([...completeEntries(), { path: 'package/link', type: '2' }]),
    tar([...completeEntries(), entry('package/node_modules/hidden/index.js', 'x')]),
    tar([...completeEntries(), { path: 'package/broken', rawSize: 64 * 1024 * 1024 + 1,
      body: Buffer.from('x') }])
  ];
  for (const candidate of cases) assert.throws(() => inspectInstallationPackageArchive(candidate));
  const changed = Buffer.from(valid()); changed[changed.length - 10] = changed[changed.length - 10]! ^ 1;
  assert.throws(() => inspectInstallationPackageArchive(changed));
  const tamperedHeader = gunzipSync(valid());
  tamperedHeader[0] = tamperedHeader[0]! ^ 1;
  assert.throws(() => inspectInstallationPackageArchive(gzipSync(tamperedHeader)));
  assert.throws(() => inspectInstallationPackageArchive(Buffer.concat([valid(), Buffer.from('junk')])));
  assert.throws(() => inspectInstallationPackageArchive(Buffer.concat([valid(), valid()])));
  assert.throws(() => inspectInstallationPackageArchive(gzipSync(Buffer.concat([Buffer.alloc(512 * 2), Buffer.from('x')]))));
});

test('every production edge checks the resolved locked version', () => {
  const x = { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
    integrity: shrinkwrap.packages['node_modules/zod'].integrity };
  for (const edge of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const lock = { ...shrinkwrap, packages: { ...shrinkwrap.packages,
      'node_modules/zod': { ...shrinkwrap.packages['node_modules/zod'], [edge]: { x: '^9.0.0' } },
      'node_modules/x': x } };
    assert.throws(() => inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json', lock)),
      `${edge} must not accept locked x@1 for ^9`);
  }
  const missingPeer = { ...shrinkwrap, packages: { ...shrinkwrap.packages,
    'node_modules/zod': { ...shrinkwrap.packages['node_modules/zod'],
      peerDependencies: { absent: '^1.0.0' } } } };
  assert.throws(() => inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json', missingPeer)));
});

test('valid transitive, optional, and peer ranges follow the installed lock graph', () => {
  const x = { version: '9.1.0', resolved: 'https://registry.npmjs.org/x/-/x-9.1.0.tgz',
    integrity: shrinkwrap.packages['node_modules/zod'].integrity };
  for (const edge of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const lock = { ...shrinkwrap, packages: { ...shrinkwrap.packages,
      'node_modules/zod': { ...shrinkwrap.packages['node_modules/zod'], [edge]: { x: '^9.0.0' } },
      'node_modules/x': x } };
    assert.equal(inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json', lock))
      .packageVersion, '1.2.3');
  }
  const optionalMissing = { ...shrinkwrap, packages: { ...shrinkwrap.packages,
    'node_modules/zod': { ...shrinkwrap.packages['node_modules/zod'],
      optionalDependencies: { missing: '^9.0.0' }, peerDependencies: { absent: '^1.0.0' },
      peerDependenciesMeta: { absent: { optional: true } } } } };
  assert.equal(inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json', optionalMissing))
    .packageVersion, '1.2.3');
});

test('archive refuses executable lifecycle hooks, mutable direct dependencies and incoherent lock graph', () => {
  assert.throws(() => inspectInstallationPackageArchive(replace('package/package.json',
    { ...packageJson, scripts: { preinstall: 'node evil.js' } })));
  assert.throws(() => inspectInstallationPackageArchive(replace('package/package.json',
    { ...packageJson, dependencies: { zod: '^4.2.0' } })));
  assert.throws(() => inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json',
    { ...shrinkwrap, packages: { ...shrinkwrap.packages,
      'node_modules/zod': { version: '4.2.0', resolved: 'http://evil.test/zod.tgz', integrity: 'sha512-test' } } })));
  assert.throws(() => inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json',
    { ...shrinkwrap, packages: { '': shrinkwrap.packages[''] } })));
  assert.throws(() => inspectInstallationPackageArchive(replace('package/npm-shrinkwrap.json',
    { ...shrinkwrap, packages: { ...shrinkwrap.packages,
      'node_modules/zod': { ...shrinkwrap.packages['node_modules/zod'], dev: true } } })));
});

test('the current pinned project lock graph satisfies candidate constraints', () => {
  const currentPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as unknown;
  const currentLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as unknown;
  const candidate = tar([entry('package/package.json', currentPackage),
    entry('package/npm-shrinkwrap.json', currentLock),
    entry('package/dist/src/cli/main.js', 'main'),
    entry('package/dist/src/cli/migrate-installation.js', 'migrate')]);
  assert.equal(inspectInstallationPackageArchive(candidate).packageVersion, '0.1.0');
});

test('compressed and expanded budgets reject bombs before materialization', () => {
  assert.throws(() => inspectInstallationPackageArchive(Buffer.alloc(32 * 1024 * 1024 + 1)));
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1));
  assert.throws(() => inspectInstallationPackageArchive(bomb));
});

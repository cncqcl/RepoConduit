import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { pinRetainedInstallationArchive } from '../support/retained-installation-archive.js';

function archive(version: string): Buffer {
  const bin = { rcac: 'dist/src/cli/main.js' };
  const pkg = { name: 'repo-conduit', version, type: 'module', bin };
  const lock = { name: pkg.name, version, lockfileVersion: 3, requires: true,
    packages: { '': { name: pkg.name, version, bin } } };
  const entries = [['package/package.json', JSON.stringify(pkg)],
    ['package/npm-shrinkwrap.json', JSON.stringify(lock)],
    ['package/dist/src/cli/main.js', 'main'], ['package/dist/src/cli/migrate-installation.js', 'migrate']];
  const blocks: Buffer[] = [];
  for (const [path, text] of entries) {
    const body = Buffer.from(text!), header = Buffer.alloc(512);
    header.write(path!);
    for (const [offset, value, width] of [[100, 0o644, 8], [108, 0, 8], [116, 0, 8],
      [124, body.length, 12], [136, 0, 12]] as const)
      header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset);
    header.fill(0x20, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(7, '0') + '\0', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('retained installation copies the inspected bytes once and survives source replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-retained-input-'));
  try {
    const input = join(root, 'input.tgz'), fixture = join(root, 'fixture'); mkdirSync(fixture);
    const bytes = archive('0.1.0'); writeFileSync(input, bytes);
    const pinned = pinRetainedInstallationArchive(input, fixture, '0.1.0');
    assert.equal(pinned, join(fixture, 'retained-0.1.0.tgz'));
    writeFileSync(input, archive('0.1.1'));
    assert.deepEqual(readFileSync(pinned), bytes);
    assert.equal(createHash('sha256').update(readFileSync(pinned)).digest('hex'),
      createHash('sha256').update(bytes).digest('hex'));
    assert.throws(() => pinRetainedInstallationArchive(input, fixture, '0.1.0'));
    assert.deepEqual(readFileSync(pinned), bytes);
    writeFileSync(input, bytes);
    assert.throws(() => pinRetainedInstallationArchive(input, fixture, '0.1.0'));
    assert.deepEqual(readFileSync(pinned), bytes);
  } finally { rmSync(root, { recursive: true }); }
});

test('retained installation refuses wrong versions, invalid archives and linked input before copying', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-retained-refusal-'));
  try {
    const input = join(root, 'input.tgz'), fixture = join(root, 'fixture'); mkdirSync(fixture);
    writeFileSync(input, archive('0.1.1'));
    assert.throws(() => pinRetainedInstallationArchive(input, fixture, '0.1.0'));
    assert.equal(existsSync(join(fixture, 'retained-0.1.0.tgz')), false);
    writeFileSync(input, 'invalid');
    assert.throws(() => pinRetainedInstallationArchive(input, fixture, '0.1.0'));
    writeFileSync(input, archive('0.1.0')); linkSync(input, join(root, 'linked.tgz'));
    assert.throws(() => pinRetainedInstallationArchive(input, fixture, '0.1.0'));
    assert.throws(() => pinRetainedInstallationArchive('relative.tgz', fixture, '0.1.0'));
    assert.equal(existsSync(join(fixture, 'retained-0.1.0.tgz')), false);
  } finally { rmSync(root, { recursive: true }); }
});

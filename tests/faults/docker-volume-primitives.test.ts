import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSnapshotFromFiles, RepositorySnapshot } from '../../src/adapters/repository/snapshots.js';
import {
  buildSnapshotTar, ownerCreateArgs, readerCreateArgs, parseOwnerInspection,
  parseReaderInspection, inspectContainerArgs, cleanupArgs, cleanupListingArgs, verifyCleanupListing,
} from '../../src/adapters/investigator/docker-volume.js';

const name = (role: 'owner' | 'reader') => `rcac-investigator-${role}-${randomUUID()}`;
const id = 'a'.repeat(64);
const readerId = 'b'.repeat(64);
const image = `sha256:${'c'.repeat(64)}`;
const volume = 'd'.repeat(64);

test('bounded tar contains only selected regular snapshot bytes and inferred directories', () => {
  const snapshot = createSnapshotFromFiles('wc', 'commit', {
    'src/one.txt': Buffer.from('one'), 'src/two.txt': Buffer.from('two'),
  });
  const tar = buildSnapshotTar(snapshot, ['src/one.txt']);
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.subarray(0, 100).toString('ascii').replace(/\0.*$/, ''), 'src/');
  assert.equal(tar.subarray(512, 612).toString('ascii').replace(/\0.*$/, ''), 'src/one.txt');
  assert.equal(tar.subarray(1024, 1027).toString(), 'one');
  assert.equal(tar.includes(Buffer.from('two')), false);
  assert.equal(tar.subarray(-1024).every(byte => byte === 0), true);
});

test('tar rejects mismatched bytes, unsafe or unsupported names, duplicates and bounded size', () => {
  const bytes = Buffer.from('one');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const tampered = new RepositorySnapshot('wc', 'commit', new Map([['ok.txt', Buffer.from('bad')]]),
    [{ path: 'ok.txt', sizeBytes: 3, sha256: digest }], []);
  assert.throws(() => buildSnapshotTar(tampered, ['ok.txt']), /INTEGRITY_ERROR/);
  const snapshot = createSnapshotFromFiles('wc', 'commit', { 'ok.txt': bytes });
  for (const path of ['../ok.txt', '/ok.txt', 'bad\\name', 'missing.txt']) {
    assert.throws(() => buildSnapshotTar(snapshot, [path]), /INVALID_ARGUMENT|INTEGRITY_ERROR/);
  }
  assert.throws(() => buildSnapshotTar(snapshot, ['ok.txt', 'ok.txt']), /INVALID_ARGUMENT/);
  assert.throws(() => buildSnapshotTar(snapshot, ['ok.txt'], { maxFileBytes: 2 }), /LIMIT_EXCEEDED/);
  assert.throws(() => buildSnapshotTar(snapshot, ['ok.txt'], { maxTarBytes: 1024 }), /LIMIT_EXCEEDED/);
  const unicode = createSnapshotFromFiles('wc', 'commit', { 'é.txt': bytes });
  assert.throws(() => buildSnapshotTar(unicode, ['é.txt']), /INVALID_ARGUMENT/);
  const long = `${'a'.repeat(101)}.txt`;
  const longName = createSnapshotFromFiles('wc', 'commit', { [long]: bytes });
  assert.throws(() => buildSnapshotTar(longName, [long]), /INVALID_ARGUMENT/);
  const longDir = `${'d'.repeat(100)}/x`;
  const longDirectory = createSnapshotFromFiles('wc', 'commit', { [longDir]: bytes });
  assert.throws(() => buildSnapshotTar(longDirectory, [longDir]), /INVALID_ARGUMENT/);
  const clashingDirs = createSnapshotFromFiles('wc', 'commit', { 'Src/a': bytes, 'src/b': bytes });
  assert.throws(() => buildSnapshotTar(clashingDirs, ['Src/a', 'src/b']), /INTEGRITY_ERROR/);
});

test('owner and reader CLI arguments bind exact identities with only anonymous source volume', () => {
  const owner = name('owner');
  const reader = name('reader');
  const ownerArgs = ownerCreateArgs(owner, image);
  assert.deepEqual(ownerArgs.slice(0, 4), ['create', '--name', owner, '--pull=never']);
  assert.equal(ownerArgs.includes('/snapshot'), true);
  assert.equal(ownerArgs[ownerArgs.indexOf('--mount') + 1], 'type=volume,target=/snapshot,volume-nocopy');
  assert.equal(ownerArgs.includes('--user=0:0'), true);
  assert.equal(ownerArgs.includes('-i'), true);
  assert.deepEqual(ownerArgs.slice(-6), [image, '-x', '-f', '-', '-C', '/snapshot']);
  const readerArgs = readerCreateArgs(reader, id, image, ['needle'], ['src/one.txt']);
  assert.equal(readerArgs[readerArgs.indexOf('--volumes-from') + 1], `${id}:ro`);
  assert.equal(readerArgs.includes('--volume'), false);
  assert.equal(readerArgs.includes('--mount'), false);
  assert.equal(readerArgs.includes('--network=none'), true);
  assert.deepEqual(readerArgs.slice(-7), [image, '-n', '-H', '-F', '-e', 'needle', '--', '/snapshot/src/one.txt'].slice(-7));
  assert.throws(() => readerCreateArgs(reader, 'a'.repeat(12), image, ['needle'], ['src/one.txt']), /INVALID_ARGUMENT/);
});

test('inspection requires exact owner ID/name and one writable anonymous snapshot volume', () => {
  const owner = name('owner');
  const inspection = JSON.stringify([{ Id: id, Name: `/${owner}`, Mounts: [
    { Type: 'volume', Name: volume, Destination: '/snapshot', RW: true },
  ] }]);
  assert.equal(parseOwnerInspection(inspection, owner, id), volume);
  assert.throws(() => parseOwnerInspection(inspection.replace('"RW":true', '"RW":false'), owner, id), /ISOLATION_UNCONFIRMED/);
  assert.throws(() => parseOwnerInspection(inspection.replace('"volume"', '"bind"'), owner, id), /ISOLATION_UNCONFIRMED/);
  assert.throws(() => parseOwnerInspection(inspection, owner, readerId), /ISOLATION_UNCONFIRMED/);
  assert.throws(() => parseOwnerInspection('[]', owner, id), /ISOLATION_UNCONFIRMED/);
});

test('reader inspection requires the same volume, read-only mount and exact source ID', () => {
  const reader = name('reader');
  const inspection = JSON.stringify([{ Id: readerId, Name: `/${reader}`, HostConfig: { VolumesFrom: [`${id}:ro`] }, Mounts: [
    { Type: 'volume', Name: volume, Destination: '/snapshot', RW: false },
  ] }]);
  assert.equal(parseReaderInspection(inspection, reader, readerId, id, volume), true);
  assert.deepEqual(inspectContainerArgs(readerId), ['inspect', '--type', 'container', readerId]);
  assert.throws(() => parseReaderInspection(inspection.replace('"RW":false', '"RW":true'), reader, readerId, id, volume), /ISOLATION_UNCONFIRMED/);
  assert.throws(() => parseReaderInspection(inspection, reader, readerId, id, 'other'), /ISOLATION_UNCONFIRMED/);
  assert.throws(() => parseReaderInspection(inspection.replace(`${id}:ro`, `${id}:rw`), reader, readerId, id, volume), /ISOLATION_UNCONFIRMED/);
});

test('cleanup removes exact reader, owner and anonymous volume; listing must prove all absent', () => {
  assert.deepEqual(cleanupArgs(readerId, id, volume), [
    ['rm', '-f', '-v', readerId], ['rm', '-f', '-v', id],
  ]);
  assert.deepEqual(cleanupListingArgs(), [
    ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'],
    ['volume', 'ls', '--format', '{{.Name}}'],
  ]);
  assert.equal(verifyCleanupListing('', '', [readerId, id], volume), true);
  assert.throws(() => verifyCleanupListing(`${readerId}\n`, '', [readerId, id], volume), /ISOLATION_TERMINATION_UNCONFIRMED/);
  assert.throws(() => verifyCleanupListing('', `${volume}\n`, [readerId, id], volume), /ISOLATION_TERMINATION_UNCONFIRMED/);
  assert.equal(verifyCleanupListing(`${'e'.repeat(64)}\n`, '', [readerId, id], volume), true);
});

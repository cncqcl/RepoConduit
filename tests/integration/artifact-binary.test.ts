import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';

function emptyFileZip(): Buffer {
  const name = Buffer.from('nested/report.txt');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}

function manyEmptyFilesZip(count: number): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const name = Buffer.from(`nested/file-${i}.txt`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x80000000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name);
    centrals.push(central, name);
    offset += local.length + name.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('collector supplied bytes and ZIP originals join the same immutable bundle publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-'));
  const objects = new ArtifactObjects(root);
  try {
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b', contextRevision: 'ctx', snapshotRefs: [], expectedPaths: ['raw.bin', 'bundle.zip'] });
    const bytes = Buffer.from([0, 255, 19, 0, 128]);
    const file = objects.putBytes('b', 'raw.bin', bytes, 'application/octet-stream', 'authorized_local_collector');
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(objects.putBytes('b', 'raw.bin', bytes, 'application/octet-stream', 'authorized_local_collector'), file);
    assert.throws(() => objects.putBytes('b', 'bundle.zip', Buffer.from('not zip'), 'application/zip', 'authorized_local_collector'), /ZIP|media/i);
    assert.deepEqual(objects.status('b').files, [file]);
    const archive = emptyFileZip();
    const zipFile = objects.putBytes('b', 'bundle.zip', archive, 'application/zip', 'authorized_local_collector');
    const manifest = objects.finalize('b', () => {});
    assert.deepEqual(manifest.files, [zipFile, file]);
    assert.deepEqual(objects.readFile('b', 'raw.bin'), bytes);
    assert.deepEqual(objects.readFile('b', 'bundle.zip'), archive);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two individually valid ZIP files cannot exceed the bundle expanded entry budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-budget-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [], expectedPaths: ['one.zip', 'two.zip'] });
    const archive = manyEmptyFilesZip(128);
    objects.putBytes('b', 'one.zip', archive, 'application/zip', 'authorized_local_collector');
    assert.throws(() => objects.putBytes('b', 'two.zip', archive, 'application/zip', 'authorized_local_collector'), /Bundle budget/);
    assert.equal(objects.status('b').files.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('file and directory paths cannot collide in a receiver observed bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-path-conflict-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [] });
    objects.putBytes('b', 'Report', Buffer.from('one'), 'text/plain', 'text_set_mcp');
    assert.throws(() => objects.putBytes('b', 'report/detail.txt', Buffer.from('two'),
      'text/plain', 'text_set_mcp'), /conflict/i);
    assert.deepEqual(objects.status('b').files.map(file => file.normalizedRelativePath), ['Report']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('case variants of one directory cannot enter a receiver observed bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-dir-case-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [] });
    objects.putBytes('b', 'Report/one.txt', Buffer.from('one'), 'text/plain', 'text_set_mcp');
    assert.throws(() => objects.putBytes('b', 'report/two.txt', Buffer.from('two'),
      'text/plain', 'text_set_mcp'), /conflict/i);
    assert.deepEqual(objects.status('b').files.map(file => file.normalizedRelativePath), ['Report/one.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unpaired surrogate cannot be staged as a file path', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-surrogate-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [] });
    assert.throws(() => objects.putBytes('b', '\ud800.txt', Buffer.from('one'),
      'text/plain', 'text_set_mcp'), /Invalid artifact path/);
    assert.deepEqual(objects.status('b').files, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalize refuses an existing staging marker with conflicting paths before commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-old-staging-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [] });
    const first = objects.putBytes('b', 'a', Buffer.from('one'), 'text/plain', 'text_set_mcp');
    const marker = join(root, 'staging', 'b.json');
    const record = JSON.parse(readFileSync(marker, 'utf8')) as { files: typeof first[] };
    record.files.push({ ...first, normalizedRelativePath: 'a/b' });
    writeFileSync(marker, JSON.stringify(record));
    let committed = false;
    assert.throws(() => objects.finalize('b', () => { committed = true; }), /conflict/i);
    assert.equal(committed, false);
    assert.equal(objects.status('b').state, 'staging');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalize refuses an extra staged file beyond the declared set', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-extra-staging-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [], expectedPaths: ['a'] });
    const first = objects.putText('b', 'a', 'one', 'text/plain', 'text_set_mcp');
    const marker = join(root, 'staging', 'b.json');
    const record = JSON.parse(readFileSync(marker, 'utf8')) as { files: typeof first[] };
    record.files.push({ ...first, normalizedRelativePath: 'b' });
    writeFileSync(marker, JSON.stringify(record));
    let committed = false;
    assert.throws(() => objects.finalize('b', () => { committed = true; }), /declared|unexpected|conflict/i);
    assert.equal(committed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('historically published structural path collision cannot be replayed or read as valid', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-old-published-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [] });
    objects.putBytes('b', 'a', Buffer.from('one'), 'text/plain', 'text_set_mcp');
    objects.putBytes('b', 'b', Buffer.from('two'), 'text/plain', 'text_set_mcp');
    objects.finalize('b', () => {});
    const marker = join(root, 'staging', 'b.json');
    const record = JSON.parse(readFileSync(marker, 'utf8')) as {
      files: Array<{ normalizedRelativePath: string }>;
      manifest: { files: Array<{ normalizedRelativePath: string }> };
    };
    record.files[1]!.normalizedRelativePath = 'a/b';
    record.manifest.files[1]!.normalizedRelativePath = 'a/b';
    const manifestBytes = Buffer.from(JSON.stringify(record.manifest));
    const hash = createHash('sha256').update(manifestBytes).digest('hex');
    const object = objects.objectPath(hash);
    mkdirSync(dirname(object), { recursive: true });
    writeFileSync(object, manifestBytes);
    writeFileSync(marker, JSON.stringify(record));
    assert.throws(() => objects.finalize('b', () => {}), /integrity|conflict/i);
    assert.throws(() => objects.reconcilePublished('b', record.manifest as Parameters<typeof objects.reconcilePublished>[1]), /integrity|conflict/i);
    assert.throws(() => objects.readFile('b', 'a'), /integrity|conflict/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('historically published bundle missing a declared file cannot be replayed as complete', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-binary-old-incomplete-'));
  try {
    const objects = new ArtifactObjects(root);
    objects.begin({ workspaceId: 'ws', collaborationId: 'col', bundleId: 'b',
      contextRevision: 'ctx', snapshotRefs: [], expectedPaths: ['a', 'b'] });
    objects.putText('b', 'a', 'one', 'text/plain', 'text_set_mcp');
    objects.putText('b', 'b', 'two', 'text/plain', 'text_set_mcp');
    objects.finalize('b', () => {});
    const marker = join(root, 'staging', 'b.json');
    const record = JSON.parse(readFileSync(marker, 'utf8')) as {
      files: Array<{ normalizedRelativePath: string }>;
      manifest: { files: Array<{ normalizedRelativePath: string }> };
    };
    record.files = record.files.filter(file => file.normalizedRelativePath !== 'b');
    record.manifest.files = record.manifest.files.filter(file => file.normalizedRelativePath !== 'b');
    const manifestBytes = Buffer.from(JSON.stringify(record.manifest));
    const hash = createHash('sha256').update(manifestBytes).digest('hex');
    const object = objects.objectPath(hash);
    mkdirSync(dirname(object), { recursive: true });
    writeFileSync(object, manifestBytes);
    writeFileSync(marker, JSON.stringify(record));
    assert.throws(() => objects.finalize('b', () => {}), /integrity|missing/i);
    assert.throws(() => objects.reconcilePublished('b', record.manifest as Parameters<typeof objects.reconcilePublished>[1]), /integrity|missing/i);
    assert.throws(() => objects.readFile('b', 'a'), /integrity|missing/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

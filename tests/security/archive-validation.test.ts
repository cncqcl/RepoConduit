import assert from 'node:assert/strict';
import test from 'node:test';
import { validateZip } from '../../src/core/artifact/zip.js';

function archive(paths: string[], sizes?: number[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  paths.forEach((path, index) => {
    const name = Buffer.from(path);
    const content = Buffer.alloc(sizes?.[index] ?? 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x80000000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, content);
    centrals.push(central, name);
    offset += local.length + name.length + content.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(paths.length, 8);
  end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('malformed and unsafe ZIP files are rejected without extraction', () => {
  assert.throws(() => validateZip(Buffer.from('not zip')));
  assert.deepEqual(validateZip(archive(['docs/readme.md'])), ['docs/readme.md']);
  assert.throws(() => validateZip(archive(['../escape.txt'])), /Invalid artifact path/);
  assert.throws(() => validateZip(archive(['a.md', 'A.md'])), /Duplicate/);
  assert.throws(() => validateZip(archive(['CON.txt'])), /Invalid artifact path/);
  assert.throws(() => validateZip(archive(['huge.bin'], [32 * 1024 * 1024 + 1])), /budget/);
  const link = archive(['link']);
  link.writeUInt32LE(0xa0000000, 30 + 4 + 38);
  assert.throws(() => validateZip(link), /link or device/);
});

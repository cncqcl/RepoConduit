import assert from 'node:assert/strict';
import test from 'node:test';
import { validateArtifactBytes } from '../../src/core/artifact/media.js';
import { validateZip } from '../../src/core/artifact/zip.js';

function zip(name: string, data = Buffer.alloc(0), mode = 0x8000, extra = Buffer.alloc(0)): Buffer {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(data.length, 20);
  central.writeUInt16LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length + extra.length, 12);
  end.writeUInt32LE(local.length + filename.length + extra.length + data.length, 16);
  return Buffer.concat([local, filename, extra, data, central, filename, extra, end]);
}

test('binary media declarations are checked against original bytes', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  assert.doesNotThrow(() => validateArtifactBytes('plot.png', png, 'image/png'));
  assert.throws(() => validateArtifactBytes('plot.png', Buffer.from('text'), 'image/png'), /media/i);
  assert.throws(() => validateArtifactBytes('archive.zip', Buffer.from('text'), 'application/zip'), /ZIP|media/i);
  assert.throws(() => validateArtifactBytes('archive.bin', zip('a.txt'), 'application/octet-stream'), /media/i);
  assert.throws(() => validateArtifactBytes('archive.zip', zip('../escape'), 'application/zip'), /path/i);
});

test('ZIP validation rejects unsafe entry kinds and malformed local boundaries', () => {
  assert.throws(() => validateZip(zip('link', Buffer.from('x'), 0xa000)), /link or device/);
  assert.throws(() => validateZip(zip('device', Buffer.from('x'), 0x2000)), /link or device/);
  assert.throws(() => validateZip(zip('e\u0301.txt')), /NFC/);
  const archive = zip('ok.txt');
  const centralOffset = archive.readUInt32LE(archive.length - 6);
  const withHidden = Buffer.from(archive);
  withHidden.writeUInt32LE(centralOffset + 1, centralOffset + 42);
  assert.throws(() => validateZip(withHidden));
});

test('standard Python ZIP with an ASCII name and no UTF-8 flag is accepted', () => {
  // Python 3.13 zipfile, ZIP_DEFLATED, writestr('nested/report.txt', 'synthetic report').
  const archive = Buffer.from('UEsDBBQAAAAIAIQbPV20N7uzEgAAABAAAAARAAAAbmVzdGVkL3JlcG9ydC50eHQrrswryUgtyUxWKEotyC8qAQBQSwECFAAUAAAACACEGz1dtDe7sxIAAAAQAAAAEQAAAAAAAAAAAAAAgAEAAAAAbmVzdGVkL3JlcG9ydC50eHRQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');
  assert.equal(archive.readUInt16LE(6), 0);
  assert.deepEqual(validateZip(archive), ['nested/report.txt']);
  const nonAscii = Buffer.from(archive);
  const centralOffset = nonAscii.readUInt32LE(nonAscii.length - 6);
  nonAscii[30] = 0xe9;
  nonAscii[centralOffset + 46] = 0xe9;
  assert.throws(() => validateZip(nonAscii), /encoding|ASCII|Unsupported/);
});

test('ZIP rejects alternate Unicode paths and malformed extra fields in either header', () => {
  const unicodePath = Buffer.from([0x75, 0x70, 0x01, 0x00, 0x00]);
  assert.throws(() => validateZip(zip('ok.txt', Buffer.alloc(0), 0x8000, unicodePath)), /Ambiguous ZIP filename/);
  const truncated = Buffer.from([0x01, 0x00, 0x04, 0x00, 0x00]);
  assert.throws(() => validateZip(zip('ok.txt', Buffer.alloc(0), 0x8000, truncated)), /Truncated ZIP extra/);
  const centralOnly = zip('ok.txt', Buffer.alloc(0), 0x8000, Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00]));
  const centralOffset = centralOnly.readUInt32LE(centralOnly.length - 6);
  centralOnly.writeUInt16LE(0x7075, centralOffset + 46 + Buffer.byteLength('ok.txt'));
  assert.throws(() => validateZip(centralOnly), /Ambiguous ZIP filename/);
  const localOnly = zip('ok.txt', Buffer.alloc(0), 0x8000, Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00]));
  localOnly.writeUInt16LE(0x7075, 30 + Buffer.byteLength('ok.txt'));
  assert.throws(() => validateZip(localOnly), /Ambiguous ZIP filename/);
});

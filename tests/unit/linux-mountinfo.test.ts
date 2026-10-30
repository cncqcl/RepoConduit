import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinuxMountinfo } from '../../src/adapters/secondary-investigator/linux-mountinfo.js';

const line = '42 24 8:1 / / rw,nosuid shared:5 master:2 - ext4 /dev/sda1 rw,relatime\n';

test('parses a real mountinfo shape and kernel path escapes without normalizing paths', () => {
  assert.deepEqual(parseLinuxMountinfo(line), [{
    mountId: 42, parentId: 24, major: 8, minor: 1, root: '/', mountPoint: '/',
    mountOptions: ['rw', 'nosuid'], optionalFields: ['shared:5', 'master:2'],
    filesystemType: 'ext4', mountSource: '/dev/sda1', superOptions: ['rw', 'relatime'],
  }]);
  const escaped = String.raw`43 42 0:39 /a\040b\134c\011d\012e /mount\040point rw - tmpfs /source\134name rw` + '\n';
  const entry = parseLinuxMountinfo(escaped)[0]!;
  assert.equal(entry.root, '/a b\\c\td\ne');
  assert.equal(entry.mountPoint, '/mount point');
  assert.equal(entry.mountSource, '/source\\name');
  assert.equal(parseLinuxMountinfo(line + escaped).length, 2);
});

test('keeps frozen WSL drvfs option values opaque while decoding the mount source', () => {
  const c = String.raw`132 82 0:70 / /mnt/c rw,noatime - 9p C:\134 rw,aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=0x5,access=client,msize=65536,trans=fd,rfd=6,wfd=6` + '\n';
  const d = String.raw`133 82 0:71 / /mnt/d rw,noatime - 9p D:\134 rw,aname=drvfs;path=D:\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=0x5,access=client,msize=65536,trans=fd,rfd=6,wfd=6` + '\n';
  const parsed = parseLinuxMountinfo(c + d);
  assert.deepEqual(parsed.map(item => item.mountSource), ['C:\\', 'D:\\']);
  assert.deepEqual(parsed.map(item => item.superOptions[1]),
    [String.raw`aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/`,
      String.raw`aname=drvfs;path=D:\;uid=1000;gid=1000;symlinkroot=/mnt/`]);
  assert.throws(() => parseLinuxMountinfo(c.replace(' / /mnt/c ', String.raw` /bad\041 /mnt/c `)));
});

test('rejects malformed framing, excess fields, duplicate IDs and invalid numbers', () => {
  for (const raw of [
    '', line.slice(0, -1), '\n', line + '\n', line.replace(/\n$/, '\r\n'),
    line.replace(' - ', ' - x - '), line.replace(' - ', ' - ext4 /other rw - '),
    line.replace(' - ext4', ' - ext4 extra'), line.replace('rw,nosuid shared', 'rw,nosuid  shared'),
    line + line, line.replace(/^42 /, '0 '), line.replace(/^42 /, '042 '),
    line.replace(/^42 /, '9007199254740992 '), line.replace(' 24 ', ' -1 '),
    line.replace(' 8:1 ', ' 08:1 '), line.replace(' 8:1 ', ' 8:9007199254740992 '),
  ]) assert.throws(() => parseLinuxMountinfo(raw), raw.slice(0, 50));
});

test('rejects bad escapes, non-absolute paths, empty or duplicate options', () => {
  for (const raw of [
    line.replace(' / / ', ' relative / '), line.replace(' / / ', ' / relative '),
    line.replace(' / / ', String.raw` /bad\041 / `),
    line.replace(' / / ', String.raw` /bad\04 / `),
    line.replace(' / / ', String.raw` /bad\ / `),
    line.replace('rw,nosuid shared', 'rw,,nosuid shared'),
    line.replace('rw,nosuid shared', 'rw,rw shared'),
    line.replace('shared:5 master:2', 'shared:5 shared:5'),
    line.replace(' /dev/sda1 rw,relatime', ' /dev/sda1 rw,rw'),
    line.replace(' / / ', ' /\u0000 / '),
  ]) assert.throws(() => parseLinuxMountinfo(raw), raw.slice(0, 50));
});

test('enforces UTF-8, line and total byte bounds and mount count', () => {
  assert.throws(() => parseLinuxMountinfo(line.replace(' /dev/sda1 ', ` /${'x'.repeat(4096)} `)));
  assert.throws(() => parseLinuxMountinfo(line.replace(' /dev/sda1 ', ` /${'é'.repeat(2050)} `)));
  assert.throws(() => parseLinuxMountinfo(line.replace(' / / ', ' /\ud800 / ')));
  const many = Array.from({ length: 129 }, (_, index) => line.replace(/^42 /, `${index + 1} `)).join('');
  assert.throws(() => parseLinuxMountinfo(many));
  assert.throws(() => parseLinuxMountinfo('x'.repeat(128 * 1024 + 1) + '\n'));
});

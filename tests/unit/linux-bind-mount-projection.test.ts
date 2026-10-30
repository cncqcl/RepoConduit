import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinuxMountinfo } from '../../src/adapters/secondary-investigator/linux-mountinfo.js';
import { projectLinuxBindMounts } from '../../src/adapters/secondary-investigator/linux-bind-mount-projection.js';

const host = () => parseLinuxMountinfo(
  '1 0 8:48 / / rw - ext4 /dev/sdd rw\n' +
  '2 1 0:36 / /usr/lib/wsl/drivers ro,nosuid,nodev - 9p drivers ro\n' +
  '3 1 0:57 / /usr/lib/wsl/lib rw - overlay none rw\n');

test('bind projection handles resolved aliases and nested system mount roots', () => {
  assert.deepEqual(projectLinuxBindMounts(host(), '/usr/lib', '/lib'), [
    { source: '/usr/lib', target: '/lib', major: 8, minor: 48, root: '/usr/lib',
      filesystemType: 'ext4', mountSource: '/dev/sdd' },
    { source: '/usr/lib/wsl/drivers', target: '/lib/wsl/drivers', major: 0, minor: 36, root: '/',
      filesystemType: '9p', mountSource: 'drivers' },
    { source: '/usr/lib/wsl/lib', target: '/lib/wsl/lib', major: 0, minor: 57, root: '/',
      filesystemType: 'overlay', mountSource: 'none' },
  ]);
});

test('bind source inside a mount uses the mount root plus the relative path', () => {
  const mounts = parseLinuxMountinfo('5 0 8:48 /home/fixture /home rw - ext4 /dev/sdd rw\n');
  assert.equal(projectLinuxBindMounts(mounts, '/home/runtime/deps', '/runtime/deps')[0]!.root,
    '/home/fixture/runtime/deps');
  assert.equal(projectLinuxBindMounts(host(), '/usr/bin', '/bin').length, 1,
    'path sibling prefixes do not inherit mounts from /usr/lib');
});

test('projection rejects ambiguous stacked mounts and noncanonical source/target paths', () => {
  const stacked = parseLinuxMountinfo(
    '1 0 8:48 / / rw - ext4 /dev/sdd rw\n2 1 8:49 / / rw - ext4 /dev/sde rw\n');
  assert.throws(() => projectLinuxBindMounts(stacked, '/usr', '/usr'));
  const duplicateChild = parseLinuxMountinfo(
    '1 0 8:48 / / rw - ext4 /dev/sdd rw\n' +
    '2 1 0:36 / /usr/lib/wsl ro - 9p drivers ro\n' +
    '3 1 0:57 / /usr/lib/wsl ro - overlay none ro\n');
  assert.throws(() => projectLinuxBindMounts(duplicateChild, '/usr', '/usr'));
  for (const path of ['/usr/../etc', '/usr//lib', 'usr', '/usr/', '/usr\0']) {
    assert.throws(() => projectLinuxBindMounts(host(), path, '/usr'));
    assert.throws(() => projectLinuxBindMounts(host(), '/usr', path));
  }
  assert.throws(() => projectLinuxBindMounts([], '/usr', '/usr'));
});

test('rejects child mounts hidden by a later ancestor overmount', () => {
  const hidden = parseLinuxMountinfo(
    '1 0 8:48 / / rw - ext4 /dev/sdd rw\n' +
    '2 1 0:36 / /usr/lib ro - 9p drivers ro\n' +
    '3 1 8:49 / /usr ro - ext4 /dev/sde ro\n');
  assert.throws(() => projectLinuxBindMounts(hidden, '/usr/lib', '/lib'));
  assert.throws(() => projectLinuxBindMounts(hidden, '/usr', '/usr'));
});

test('accepts a self-parent root but rejects genuine mount parent cycles', () => {
  const root = parseLinuxMountinfo('1 1 8:48 / / rw - ext4 /dev/sdd rw\n');
  assert.equal(projectLinuxBindMounts(root, '/usr', '/usr')[0]!.root, '/usr');
  const cycle = parseLinuxMountinfo(
    '1 2 8:48 / / rw - ext4 /dev/sdd rw\n2 1 0:36 / /usr ro - 9p drivers ro\n');
  assert.throws(() => projectLinuxBindMounts(cycle, '/usr', '/usr'));
});

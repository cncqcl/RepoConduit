import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { assertPrivateDataDirectory, protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('local permission check never executes a powershell.exe placed in the current project', { skip: process.platform !== 'win32' }, () => {
  const parent = homedir();
  const dir = mkdtempSync(join(parent, 'rcac-acl-hijack-'));
  const prior = process.cwd();
  try {
    copyFileSync('C:\\Windows\\System32\\whoami.exe', join(dir, 'powershell.exe'));
    process.chdir(dir);
    assert.throws(() => assertPrivateDataDirectory(dir), /permissions unavailable or unsafe/);
  } finally {
    process.chdir(prior);
    const child = relative(resolve(parent), resolve(dir));
    assert.ok(child.startsWith('rcac-acl-hijack-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protected data root is refused when an untrusted account can replace it through its parent', { skip: process.platform !== 'win32' }, () => {
  const home = homedir();
  const parent = mkdtempSync(join(home, 'rcac-acl-parent-'));
  const data = join(parent, 'data');
  try {
    execFileSync('C:\\Windows\\System32\\icacls.exe', [parent, '/grant', '*S-1-1-0:(OI)(CI)F'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    mkdirSync(data);
    protectNewDataDirectory(data);
    const store = new SqliteStore(join(data, 'state.sqlite'));
    store.close();
    assert.throws(() => assertPrivateDataDirectory(data), /permissions unavailable or unsafe/);
  } finally {
    const child = relative(resolve(home), resolve(parent));
    assert.ok(child.startsWith('rcac-acl-parent-') && !child.includes('..') && !child.includes('\\'));
    rmSync(parent, { recursive: true, force: true });
  }
});

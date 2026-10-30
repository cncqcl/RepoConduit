import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli/main.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { addDailyFileOriginsWithinInstallation } from '../../src/cli/daily-binding.js';

function fixture() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-origin-'));
  const root = join(dir, 'data');
  const path = join(root, 'daily-binding.json');
  return { root, path, setup: () => main(['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills')]),
    add: (...origins: string[]) => main(['add-file-origin', '--data-dir', root,
      ...origins.flatMap(origin => ['--file-origin', origin])]),
    close: (passed = true) => { if (passed) rmSync(dir, { recursive: true, force: true });
      else process.stderr.write(`Preserved failed daily binding fixture: ${dir}\n`); } };
}

test('local add-file-origin appends exact approved origins and duplicate is byte-for-byte idempotent', async () => {
  const f = fixture(); let passed = false; try {
    await f.setup();
    const before = JSON.parse(readFileSync(f.path, 'utf8')) as Record<string, unknown>;
    const result = await f.add('https://files.example.test', 'https://cdn.example.test', 'https://files.example.test') as
      { allowedFileOrigins: string[]; restartRequired: boolean };
    assert.deepEqual(result.allowedFileOrigins, ['https://files.example.test', 'https://cdn.example.test']);
    assert.equal(result.restartRequired, true);
    const after = JSON.parse(readFileSync(f.path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual({ ...after, allowedFileOrigins: [] }, before);
    const bytes = readFileSync(f.path, 'utf8');
    await f.add('https://files.example.test');
    assert.equal(readFileSync(f.path, 'utf8'), bytes);
    await f.setup(); // setup without a new policy remains compatible.
    passed = true;
  } finally { f.close(passed); }
});

test('add-file-origin rejects missing binding, invalid input and absent local grant without changing bytes', async () => {
  const f = fixture(); let passed = false; try {
    await main(['--data-dir', f.root, 'init']);
    await assert.rejects(f.add('https://files.example.test'));
    await f.setup();
    const before = readFileSync(f.path, 'utf8');
    await assert.rejects(f.add());
    await assert.rejects(f.add('http://files.example.test'));
    await assert.rejects(f.add('https://files.example.test/path?secret=1'));
    await assert.rejects(f.add(...Array.from({ length: 33 }, (_, index) => `https://file${index}.example.test`)));
    assert.equal(readFileSync(f.path, 'utf8'), before);
    const store = new SqliteStore(join(f.root, 'state.sqlite'));
    try {
      const principal = `${hostname()}\\${userInfo().username}`;
      const management = store.grantsFor(principal, 'local-os').find(grant =>
        grant.workspaceId === 'management' && grant.permissions.includes('admin.grant'));
      assert.ok(management);
      store.revokeGrant(management.id, new Date().toISOString());
    } finally { store.close(); }
    await assert.rejects(f.add('https://files.example.test'));
    assert.equal(readFileSync(f.path, 'utf8'), before);
    passed = true;
  } finally { f.close(passed); }
});

test('failure before atomic rename preserves binding and removes only its temporary file', async () => {
  const f = fixture(); let passed = false; try {
    await f.setup();
    const before = readFileSync(f.path, 'utf8');
    const runtime = acquireInstallationRuntime(f.root);
    try {
      const principal = `${hostname()}\\${userInfo().username}`;
      assert.throws(() => addDailyFileOriginsWithinInstallation(runtime,
        { principal, audience: 'local-os', recipient: principal, surface: 'local_admin', now: new Date() },
        ['https://files.example.test'], { beforeRename: () => { throw new Error('synthetic before rename'); } }), /synthetic before rename/);
      assert.equal(readFileSync(f.path, 'utf8'), before);
      assert.equal(readdirSync(f.root).some(name => name.startsWith('daily-binding.') && name.endsWith('.tmp')), false);
      const after = addDailyFileOriginsWithinInstallation(runtime,
        { principal, audience: 'local-os', recipient: principal, surface: 'local_admin', now: new Date() },
        ['https://files.example.test'], { afterRename: () => { throw new Error('synthetic after rename'); } });
      assert.equal(after.saveStatus, 'saved-but-cleanup-unconfirmed');
      assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).allowedFileOrigins, ['https://files.example.test']);
    } finally { runtime.release(); }
    passed = true;
  } finally { f.close(passed); }
});

test('failed wx open never deletes another file and uncertain close does not replace binding', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup();
    const before = readFileSync(f.path, 'utf8');
    const runtime = acquireInstallationRuntime(f.root);
    try {
      const principal = `${hostname()}\\${userInfo().username}`;
      const admin = { principal, audience: 'local-os', recipient: principal,
        surface: 'local_admin' as const, now: new Date() };
      let foreign: string | undefined;
      assert.throws(() => addDailyFileOriginsWithinInstallation(runtime, admin,
        ['https://files.example.test'], { beforeOpen: path => {
          foreign = path; writeFileSync(path, 'foreign', { flag: 'wx', mode: 0o600 });
        } }), /EEXIST/);
      assert.ok(foreign);
      assert.equal(readFileSync(foreign, 'utf8'), 'foreign');
      assert.equal(readFileSync(f.path, 'utf8'), before);
      unlinkSync(foreign);
      assert.throws(() => addDailyFileOriginsWithinInstallation(runtime, admin,
        ['https://files.example.test'], { beforeClose: fd => closeSync(fd) }),
      (error: unknown) => error instanceof AggregateError && /close unconfirmed/.test(error.message));
      assert.equal(readFileSync(f.path, 'utf8'), before);
      assert.equal(readdirSync(f.root).some(name => name.startsWith('daily-binding.') && name.endsWith('.tmp')), false);
    } finally { runtime.release(); }
    passed = true;
  } finally { f.close(passed); }
});

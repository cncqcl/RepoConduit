import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareDefaultDailyContainer, resolveDailyDataDirectory } from '../../src/cli/daily-data-directory.js';

function fixture(run: (home: string, base: string, data: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'rcac-default-layout-'));
  try { run(home, join(home, '.repo-conduit'), join(home, '.repo-conduit', 'data')); }
  catch (error) { process.stderr.write(`Default layout fixture retained: ${home}\n`); throw error; }
  assert.equal(dirname(home), resolve(tmpdir()));
  assert.ok(basename(home).startsWith('rcac-default-layout-'));
  rmSync(home, { recursive: true, force: true });
}

test('a new default installation selects protected data below the profile container', () => fixture((home, base, data) => {
  assert.equal(resolveDailyDataDirectory(home), data);
  mkdirSync(base);
  assert.equal(resolveDailyDataDirectory(home), data);
}));

for (const marker of ['state.sqlite', 'managed.json', 'lifecycle.sqlite']) {
  test(`an existing legacy ${marker} selects the original root without reading or changing state`, () => fixture((home, base) => {
    mkdirSync(base); writeFileSync(join(base, marker), 'Invalid or private state stays untouched');
    assert.equal(resolveDailyDataDirectory(home), base);
    assert.equal(readFileSync(join(base, marker), 'utf8'), 'Invalid or private state stays untouched');
  }));
}

test('an existing nested installation is selected without a migration', () => fixture((home, _base, data) => {
  mkdirSync(data, { recursive: true }); writeFileSync(join(data, 'state.sqlite'), 'Original state');
  assert.equal(resolveDailyDataDirectory(home), data);
  assert.equal(readFileSync(join(data, 'state.sqlite'), 'utf8'), 'Original state');
}));

test('legacy and nested entries conflict even when the nested directory is empty', () => fixture((home, base, data) => {
  mkdirSync(data, { recursive: true }); writeFileSync(join(base, 'state.sqlite'), 'Legacy state');
  assert.throws(() => resolveDailyDataDirectory(home), /Conflicting default installations/);
  assert.equal(readFileSync(join(base, 'state.sqlite'), 'utf8'), 'Legacy state');
}));

test('unknown container content does not create a shadow installation', () => fixture((home, base) => {
  mkdirSync(base); writeFileSync(join(base, 'daily-binding.json'), 'Orphan binding');
  assert.throws(() => resolveDailyDataDirectory(home), /Unrecognized default installation/);
}));

test('an existing empty or unrecognized data directory is preserved and refused', () => fixture((home, _base, data) => {
  mkdirSync(data, { recursive: true });
  assert.throws(() => resolveDailyDataDirectory(home), /Unrecognized default installation/);
  writeFileSync(join(data, 'notes.txt'), 'User file');
  assert.throws(() => resolveDailyDataDirectory(home), /Unrecognized default installation/);
}));

test('a malformed installation marker is refused without probing another layout', () => fixture((home, base) => {
  mkdirSync(join(base, 'state.sqlite'), { recursive: true });
  assert.throws(() => resolveDailyDataDirectory(home), /Unsafe default installation/);
}));

test('a linked container or nested data root is refused', () => fixture((home, base, data) => {
  const target = join(home, 'target'); mkdirSync(target);
  symlinkSync(target, base, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveDailyDataDirectory(home), /Unsafe default installation/);
  unlinkSync(base); mkdirSync(base);
  symlinkSync(target, data, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveDailyDataDirectory(home), /Unsafe default installation/);
}));

test('an explicit absolute data directory bypasses automatic layout selection', () => fixture((home, base, data) => {
  mkdirSync(data, { recursive: true }); writeFileSync(join(base, 'state.sqlite'), 'Legacy state');
  assert.equal(resolveDailyDataDirectory(home, base), base);
  assert.equal(resolveDailyDataDirectory(home, data), data);
  assert.throws(() => resolveDailyDataDirectory(home, 'relative'), /Absolute path required/);
}));

test('only setup preparation creates the container and leaves private data creation to init', () => fixture((home, base, data) => {
  assert.equal(resolveDailyDataDirectory(home), data);
  assert.equal(existsSync(base), false);
  prepareDefaultDailyContainer(home, data);
  assert.equal(existsSync(base), true);
  assert.equal(existsSync(data), false);
  prepareDefaultDailyContainer(home, data);
}));

test('setup preparation refuses a legacy installation appearing after initial selection', () => fixture((home, base, data) => {
  assert.equal(resolveDailyDataDirectory(home), data);
  mkdirSync(base); writeFileSync(join(base, 'state.sqlite'), 'Concurrent legacy installation');
  assert.throws(() => prepareDefaultDailyContainer(home, data), /changed during setup/);
  assert.equal(existsSync(data), false);
  assert.equal(readFileSync(join(base, 'state.sqlite'), 'utf8'), 'Concurrent legacy installation');
}));

test('setup preparation refuses a linked container appearing after initial selection', () => fixture((home, base, data) => {
  assert.equal(resolveDailyDataDirectory(home), data);
  const target = join(home, 'other'); mkdirSync(target);
  symlinkSync(target, base, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareDefaultDailyContainer(home, data), /Unsafe default installation/);
  assert.equal(existsSync(join(target, 'data')), false);
}));

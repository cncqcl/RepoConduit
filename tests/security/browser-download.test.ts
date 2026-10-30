import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserDownloadCaptureError, captureBrowserDownloadDelta, establishBrowserDownloadBaseline } from '../../src/adapters/transfers/browser-download.js';

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(process.cwd(), 'rcac-browser-download-'));
  try { run(root); } finally { assert.ok(root.startsWith(process.cwd() + '\\')); rmSync(root, { recursive: true, force: true }); }
}
function category(action: () => unknown, expected: string): void {
  assert.throws(action, error => error instanceof BrowserDownloadCaptureError && error.category === expected &&
    !error.message.includes('rcac-browser-download-'));
}

test('baseline ignores old file and collision, yields only one new binary candidate', () => fixture(root => {
  writeFileSync(join(root, 'report.bin'), 'old');
  writeFileSync(join(root, 'report (1).bin'), 'older');
  const baseline = JSON.parse(JSON.stringify(establishBrowserDownloadBaseline(root, 'report.bin', [])));
  assert.deepEqual(captureBrowserDownloadDelta(baseline, []), { state: 'pending' });
  const bytes = Buffer.from([0, 255, 128, 1]);
  writeFileSync(join(root, 'report (2).bin'), bytes);
  const result = captureBrowserDownloadDelta(baseline, []);
  assert.equal(result.state, 'candidate');
  if (result.state === 'candidate') {
    assert.equal(result.completion, 'unverified');
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.match(result.identity, /^[a-f0-9]{64}$/);
    assert.match(result.candidateFingerprint, /^[a-f0-9]{64}$/);
  }
}));

test('preexisting temporary file cannot be renamed into a falsely new candidate', () => fixture(root => {
  writeFileSync(join(root, 'report.bin.crdownload'), 'old partial bytes');
  category(() => establishBrowserDownloadBaseline(root, 'report.bin', []), 'ambiguous');
}));

test('split write with a pause yields unverified candidate bytes, never completed capture', () => fixture(root => {
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  const path = join(root, 'report.bin');
  writeFileSync(path, 'first');
  const first = captureBrowserDownloadDelta(baseline, []);
  assert.equal(first.state, 'candidate');
  if (first.state === 'candidate') {
    assert.equal(first.completion, 'unverified');
    assert.deepEqual(first.bytes, Buffer.from('first'));
  }
  appendFileSync(path, '-second');
  const second = captureBrowserDownloadDelta(baseline, []);
  assert.equal(second.state, 'candidate');
  if (second.state === 'candidate') {
    assert.equal(second.completion, 'unverified');
    assert.deepEqual(second.bytes, Buffer.from('first-second'));
  }
}));

test('changed old file and multiple new candidates reject ambiguity', () => fixture(root => {
  writeFileSync(join(root, 'report.bin'), 'old');
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  writeFileSync(join(root, 'report.bin'), 'changed');
  category(() => captureBrowserDownloadDelta(baseline, []), 'ambiguous');
  const clean = establishBrowserDownloadBaseline(root, 'report.bin', []);
  writeFileSync(join(root, 'report (1).bin'), 'one');
  writeFileSync(join(root, 'report (2).bin'), 'two');
  category(() => captureBrowserDownloadDelta(clean, []), 'ambiguous');
}));

test('matching temporary download keeps result pending, including alongside complete candidate', () => fixture(root => {
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  writeFileSync(join(root, 'report.bin.crdownload'), 'partial');
  assert.deepEqual(captureBrowserDownloadDelta(baseline, []), { state: 'pending' });
  writeFileSync(join(root, 'report (1).bin'), 'complete');
  assert.deepEqual(captureBrowserDownloadDelta(baseline, []), { state: 'pending' });
}));

test('protected root, unsafe filename and oversize reject', () => fixture(root => {
  category(() => establishBrowserDownloadBaseline(root, '../report.bin', []), 'invalid_input');
  category(() => establishBrowserDownloadBaseline(root, 'CON.txt', []), 'invalid_input');
  category(() => establishBrowserDownloadBaseline(root, 'report.bin', [root]), 'protected_root');
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  writeFileSync(join(root, 'report.bin'), ''); truncateSync(join(root, 'report.bin'), 32 * 1024 * 1024 + 1);
  category(() => captureBrowserDownloadDelta(baseline, []), 'file_budget');
}));

test('hardlink candidate rejects', t => fixture(root => {
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  const other = join(root, 'other'); writeFileSync(other, 'secret');
  try { linkSync(other, join(root, 'report.bin')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') {
    t.skip('Windows fixture hardlink creation EPERM'); return;
  } throw error; }
  category(() => captureBrowserDownloadDelta(baseline, []), 'unsafe_file');
}));

test('647 unrelated entries preserve a bounded baseline and allow one new candidate', () => fixture(root => {
  for (let i = 0; i < 647; i++) writeFileSync(join(root, `unrelated-${i}`), 'x');
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  assert.deepEqual(captureBrowserDownloadDelta(baseline, []), { state: 'pending' });
  writeFileSync(join(root, 'report.bin'), 'candidate');
  const result = captureBrowserDownloadDelta(baseline, []);
  assert.equal(result.state, 'candidate');
  if (result.state === 'candidate') assert.deepEqual(result.bytes, Buffer.from('candidate'));
}));

test('directory entry budget rejects before unbounded scan', () => fixture(root => {
  for (let i = 0; i < 1025; i++) writeFileSync(join(root, `unrelated-${i}`), 'x');
  category(() => establishBrowserDownloadBaseline(root, 'report.bin', []), 'entry_budget');
}));

test('root replacement rejects', () => fixture(root => {
  const downloads = join(root, 'downloads'); mkdirSync(downloads);
  const baseline = establishBrowserDownloadBaseline(downloads, 'report.bin', []);
  renameSync(downloads, join(root, 'old-downloads')); mkdirSync(downloads);
  writeFileSync(join(downloads, 'report.bin'), 'replacement');
  category(() => captureBrowserDownloadDelta(baseline, []), 'root_changed');
}));

test('symlink candidate rejects', t => fixture(root => {
  const downloads = join(root, 'downloads'); mkdirSync(downloads);
  const baseline = establishBrowserDownloadBaseline(downloads, 'report.bin', []);
  const source = join(root, 'source'); writeFileSync(source, 'secret');
  try { symlinkSync(source, join(downloads, 'report.bin')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') {
    t.skip('Windows fixture symlink creation EPERM'); return;
  } throw error; }
  category(() => captureBrowserDownloadDelta(baseline, []), 'unsafe_file');
}));



test('relevant candidate budget and temporary byte limit reject', () => fixture(root => {
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  writeFileSync(join(root, 'report.bin.part'), '');
  truncateSync(join(root, 'report.bin.part'), 32 * 1024 * 1024 + 1);
  category(() => captureBrowserDownloadDelta(baseline, []), 'file_budget');
  rmSync(join(root, 'report.bin.part'));
  for (let i = 1; i <= 129; i++) writeFileSync(join(root, `report (${i}).bin`), 'x');
  category(() => captureBrowserDownloadDelta(baseline, []), 'entry_budget');
}));

test('baseline rejects relative root and protected root at capture time', () => fixture(root => {
  category(() => establishBrowserDownloadBaseline('relative-downloads', 'report.bin', []), 'invalid_input');
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  category(() => captureBrowserDownloadDelta(baseline, [root]), 'protected_root');
}));


test('junction or symlink in download root chain rejects', t => fixture(root => {
  const actual = join(root, 'actual'); mkdirSync(actual);
  const linked = join(root, 'linked');
  try { symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') {
    t.skip('Windows fixture junction creation EPERM'); return;
  } throw error; }
  category(() => establishBrowserDownloadBaseline(linked, 'report.bin', []), 'root_changed');
}));

test('baseline records exact bigint filesystem identities as decimal strings', () => fixture(root => {
  const file = join(root, 'report.bin'); writeFileSync(file, 'old');
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  assert.equal(baseline.ancestors.at(-1)?.ino, lstatSync(root, { bigint: true }).ino.toString());
  assert.equal(baseline.entries['report.bin']?.ino, lstatSync(file, { bigint: true }).ino.toString());
  assert.match(baseline.entries['report.bin']!.dev, /^(0|[1-9][0-9]*)$/u);
}));

test('canonical JSON key order does not make an unchanged old file ambiguous', () => fixture(root => {
  writeFileSync(join(root, 'report.bin'), 'old');
  const baseline = establishBrowserDownloadBaseline(root, 'report.bin', []);
  const sorted = JSON.parse(JSON.stringify(baseline, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ?
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
  assert.deepEqual(captureBrowserDownloadDelta(sorted, []), { state: 'pending' });
  writeFileSync(join(root, 'report (1).bin'), 'new');
  const result = captureBrowserDownloadDelta(sorted, []);
  assert.equal(result.state, 'candidate');
  if (result.state === 'candidate') assert.deepEqual(result.bytes, Buffer.from('new'));
}));

// Test-only wrapper around the actual installed old CLI. It records only calls made
// by this coordinator, then pauses at a real call boundary for its parent to kill it.
import childProcess from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [phase, entry, root, archive, backup] = process.argv.slice(2);
if (!['after_backup_first_data_write', 'after_candidate_first_data_write',
  'before_npm_spawn', 'before_migration_spawn', 'before_manifest_rename',
  'after_manifest_rename'].includes(phase) || ![entry, root, archive, backup].every(Boolean)) {
  throw new Error('Invalid test-only crash harness arguments');
}
const same = (left, right) => process.platform === 'win32' ?
  resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US') :
  resolve(left) === resolve(right);
const started = [];
const closed = [];
const active = new Set();
const actualSpawn = childProcess.spawn;
const actualRename = fs.renameSync;
const actualOpenSync = fs.openSync;
const actualWriteSync = fs.writeSync;
const actualCloseSync = fs.closeSync;
const trackedOutputs = new Map();
function pause(at, details = {}) {
  if (at !== phase) return;
  const observation = { phase: at, active: active.size, started, closed, ...details };
  actualWriteSync(1, `RCAC_CRASH_HOOK:${JSON.stringify(observation)}\n`);
  // Blocking the coordinator is intentional: no mocked return or filesystem
  // result can let product code advance past the selected real boundary.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Crash boundary unexpectedly resumed');
}
function dataWritePhase(path) {
  if (typeof path !== 'string') return;
  if (same(path, join(backup, 'data', 'copy-interruption.bin'))) return 'after_backup_first_data_write';
  const parts = relative(join(root, 'generations'), resolve(path)).split(sep);
  if (parts.length === 3 && /^gen_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parts[0]) &&
      parts[1] === 'data' && parts[2] === 'copy-interruption.bin') return 'after_candidate_first_data_write';
}
fs.openSync = function observedOpen(path, flags) {
  const fd = actualOpenSync.apply(this, arguments);
  const selected = flags === 'wx' ? dataWritePhase(path) : undefined;
  if (selected) trackedOutputs.set(fd, { phase: selected, written: false });
  return fd;
};
fs.writeSync = function observedWrite(fd) {
  const written = actualWriteSync.apply(this, arguments);
  const tracked = trackedOutputs.get(fd);
  if (tracked && !tracked.written && written > 0) {
    tracked.written = true;
    pause(tracked.phase, { writeBytes: written });
  }
  return written;
};
fs.closeSync = function observedClose(fd) {
  const result = actualCloseSync.apply(this, arguments);
  trackedOutputs.delete(fd);
  return result;
};
childProcess.spawn = function observedSpawn(program, args) {
  const values = Array.isArray(args) ? args : [];
  const kind = String(values[0]).endsWith('migrate-installation.js') ? 'migration' :
    String(values[1]) === 'install' ? 'npm' : 'other';
  if (kind === 'npm') pause('before_npm_spawn');
  if (kind === 'migration') pause('before_migration_spawn');
  const child = actualSpawn.apply(this, arguments);
  const record = { kind, pid: child.pid ?? -1 };
  started.push(record);
  active.add(child);
  child.once('close', (code, signal) => {
    active.delete(child);
    closed.push({ ...record, code, signal });
  });
  return child;
};
fs.renameSync = function observedRename(source, target) {
  const selected = typeof source === 'string' && typeof target === 'string' &&
    same(target, resolve(root, 'managed.json')) &&
    resolve(source).startsWith(resolve(root, 'managed.json.upgrade-')) &&
    resolve(source).endsWith('.pending');
  if (selected) pause('before_manifest_rename');
  const result = actualRename.apply(this, arguments);
  if (selected) pause('after_manifest_rename');
  return result;
};
syncBuiltinESMExports();

const { main } = await import(pathToFileURL(resolve(entry)).href);
const result = await main(['--data-dir', resolve(root), 'upgrade', '--package', resolve(archive),
  '--backup', resolve(backup)]);
actualWriteSync(1, `RCAC_UNEXPECTED_COMPLETION:${JSON.stringify(result)}\n`);
process.exitCode = 9;

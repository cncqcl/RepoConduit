import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('initialization transaction failure retains a safe stage and partial gate', () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-gate-diagnostic-'));
  const original = DatabaseSync.prototype.exec;
  const secret = 'sensitive SQL and path C:\\private\\owner';
  try {
    protectNewDataDirectory(root);
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (sql === 'BEGIN EXCLUSIVE') throw new Error(secret);
      return original.call(this, sql);
    };
    let caught: unknown;
    try { initializeMaintenanceGate(root); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, 'MAINTENANCE_GATE_UNSAFE');
    assert.deepEqual(caught.cause, {
      component: 'maintenance_gate', stage: 'init_begin', reason: 'io_failed',
    });
    assert.equal(JSON.stringify(caught.cause).includes(secret), false);
    assert.equal(existsSync(join(root, 'lifecycle.sqlite')), true);
  } finally {
    DatabaseSync.prototype.exec = original;
    const child = relative(resolve(base), resolve(root));
    assert.ok(child.startsWith('rcac-gate-diagnostic-') && !child.includes('..') && !child.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('final gate file check retains its sanitized header stage', () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const root = mkdtempSync(join(base, 'rcac-gate-diagnostic-'));
  const original = DatabaseSync.prototype.close;
  try {
    protectNewDataDirectory(root);
    DatabaseSync.prototype.close = function (): void {
      original.call(this);
      writeFileSync(join(root, 'lifecycle.sqlite'), 'bad header');
    };
    let caught: unknown;
    try { initializeMaintenanceGate(root); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, 'MAINTENANCE_GATE_UNSAFE');
    assert.deepEqual(caught.cause, {
      component: 'maintenance_gate', stage: 'gate_header', reason: 'rejected',
    });
  } finally {
    DatabaseSync.prototype.close = original;
    const child = relative(resolve(base), resolve(root));
    assert.ok(child.startsWith('rcac-gate-diagnostic-') && !child.includes('..') && !child.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
});

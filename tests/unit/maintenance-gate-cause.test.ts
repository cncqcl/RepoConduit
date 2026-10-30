import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { acquireExclusiveMaintenanceGate, extractPrivateDirectoryDetail,
  initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');

const reasons = ['timeout', 'output_limit', 'spawn_missing', 'spawn_denied',
  'helper_rejected', 'unknown'] as const;

test('ACL failures retain only the fixed private-directory cause before SQLite',
  { skip: process.platform !== 'win32' }, () => {
    const original = childProcess.execFileSync;
    const originalPrepare = DatabaseSync.prototype.prepare;
    let calls = 0, prepares = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      prepares++;
      return originalPrepare.apply(this, args);
    };
    try {
      for (const stage of ['root_acl', 'gate_acl'] as const) {
        for (const reason of reasons) {
          const root = mkdtempSync(join(homedir(), 'rcac-gate-cause-'));
          const header = Buffer.alloc(100);
          header.write('SQLite format 3\0', 0, 'ascii');
          header[18] = 1; header[19] = 1;
          writeFileSync(join(root, 'lifecycle.sqlite'), header);
          calls = 0;
          childProcess.execFileSync = (() => {
            calls++;
            if (stage === 'gate_acl' && calls === 1) return Buffer.alloc(0);
            const error = new Error('SECRET_PATH_AND_OUTPUT') as Error &
              { code?: string; status?: number };
            if (reason === 'timeout') error.code = 'ETIMEDOUT';
            if (reason === 'output_limit') error.code = 'ENOBUFS';
            if (reason === 'spawn_missing') error.code = 'ENOENT';
            if (reason === 'spawn_denied') error.code = 'EACCES';
            if (reason === 'helper_rejected') error.status = 1;
            throw error;
          }) as unknown as typeof childProcess.execFileSync;
          syncBuiltinESMExports();
          try {
            let caught: unknown;
            try {
              if (stage === 'root_acl') initializeMaintenanceGate(root);
              else acquireExclusiveMaintenanceGate(root);
            } catch (error) { caught = error; }
            assert.ok(caught instanceof Error);
            assert.equal(caught.message, 'MAINTENANCE_GATE_UNSAFE');
            assert.deepEqual(caught.cause, {
              component: 'maintenance_gate', stage, reason: 'security_rejected',
              detail: { component: 'private_directory', operation: 'verify_installation', reason },
            });
            assert.equal(Object.isFrozen(caught.cause), true);
            assert.equal(Object.isFrozen((caught.cause as { detail: object }).detail), true);
            assert.equal(JSON.stringify(caught.cause).includes('SECRET'), false);
            assert.equal(calls, stage === 'root_acl' ? 1 : 2);
            assert.equal(prepares, 0, 'ACL rejection must precede SQLite');
          } finally {
            const child = relative(resolve(homedir()), resolve(root));
            assert.match(child, /^rcac-gate-cause-[A-Za-z0-9_-]{6}$/);
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    } finally {
      childProcess.execFileSync = original;
      DatabaseSync.prototype.prepare = originalPrepare;
      syncBuiltinESMExports();
    }
  });

test('only exact fixed Error cause is admitted as detail', () => {
  const fixed = { component: 'private_directory', operation: 'verify_installation', reason: 'timeout' };
  const message = 'Data directory permissions unavailable or unsafe';
  assert.deepEqual(extractPrivateDirectoryDetail(new Error(message, { cause: fixed })), fixed);
  for (const cause of [
    { ...fixed, secret: 'SECRET' },
    { ...fixed, reason: { toString: () => 'timeout' } },
    { ...fixed, reason: 'SECRET' },
    { ...fixed, operation: 'verify_data' },
    { ...fixed, component: 'SECRET' },
  ]) assert.equal(extractPrivateDirectoryDetail(new Error(message, { cause })), undefined);
  assert.equal(extractPrivateDirectoryDetail(new Error('wrong message', { cause: fixed })), undefined);
  assert.equal(extractPrivateDirectoryDetail({ cause: fixed }), undefined);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { assertPrivateDataDirectory, protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('profile container RX inheritance does not expose protected data, but direct RX does',
  { skip: process.platform !== 'win32' }, () => {
    const home = homedir();
    const container = mkdtempSync(join(home, 'rcac-private-container-'));
    const data = join(container, 'data');
    const icacls = 'C:\\Windows\\System32\\icacls.exe';
    let stage = 'fixture.created';
    let store: SqliteStore | undefined;
    let completed = false;
    process.stderr.write(`${JSON.stringify({ case: 'profile-container-private-data', stage, fixture: container })}\n`);
    try {
      stage = 'container.rx';
      execFileSync(icacls, [container, '/grant', '*S-1-1-0:(OI)(CI)RX'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
      stage = 'data.protect';
      mkdirSync(data);
      protectNewDataDirectory(data);
      store = new SqliteStore(join(data, 'state.sqlite'));
      store.close();
      store = undefined;
      stage = 'data.private';
      assert.doesNotThrow(() => assertPrivateDataDirectory(data));
      stage = 'data.rx';
      execFileSync(icacls, [data, '/grant', '*S-1-1-0:(OI)(CI)RX'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
      assert.throws(() => assertPrivateDataDirectory(data), /permissions unavailable or unsafe/);
      // Verification must leave the added access rule in place, not silently repair it.
      assert.throws(() => assertPrivateDataDirectory(data), /permissions unavailable or unsafe/);
      completed = true;
    } finally {
      let closed = false;
      try { store?.close(); closed = true; } finally {
        if (completed && closed) {
          const child = relative(resolve(home), resolve(container));
          assert.ok(child.startsWith('rcac-private-container-') && !child.includes('..') && !child.includes('\\'));
          rmSync(container, { recursive: true, force: true });
        } else {
          process.stderr.write(`${JSON.stringify({ case: 'profile-container-private-data',
            stage: `${stage}.retained`, fixture: container })}\n`);
        }
      }
    }
  });

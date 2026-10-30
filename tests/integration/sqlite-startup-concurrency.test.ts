import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';

for (const [className, moduleName] of [
  ['SqliteStore', 'sqlite'],
  ['SqliteInvestigationStore', 'investigation-sqlite'],
] as const) {
for (const phase of ['startup', 'runtime'] as const) {
test(`${className} ${phase} ${phase === 'startup' ? 'waits for' : 'rejects'} a competing short write transaction`, { timeout: 15_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'rcac-startup-contention-'));
  const file = join(fixture, 'state.sqlite');
  const initial = new SqliteStore(file);
  initial.close();
  if (className === 'SqliteInvestigationStore') new SqliteInvestigationStore(file).close();
  const writer = new DatabaseSync(file);
  let locked = false;
  const acquire = () => { writer.exec('BEGIN IMMEDIATE'); locked = true; };
  const release = () => { if (locked) { writer.exec('ROLLBACK'); locked = false; } };
  if (phase === 'startup') acquire();
  const program = phase === 'startup' ? `
    import { ${className} as Store } from './src/adapters/storage/${moduleName}.ts';
    process.send({kind:'ready'});
    try {
      const store = new Store(process.argv[1]);
      store.close();
      process.stdout.write(JSON.stringify({opened:true}));
    } catch (error) {
      process.stdout.write(JSON.stringify({opened:false,code:error.code,
        errcode:error.errcode,message:error.message}));
      process.exitCode = 1;
    } finally { process.disconnect(); }
  ` : `
    import { ${className} as Store } from './src/adapters/storage/${moduleName}.ts';
    const store = new Store(process.argv[1]${className === 'SqliteInvestigationStore' ? `, {
      verifyIsolation: () => false, verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
    }` : ''});
    process.once('message', () => {
      try {
        ${className === 'SqliteStore' ? `
          store.runIdempotent({principal:'fixture-owner',audience:'fixture-host',workspaceId:'fixture-ws',
            operation:'fixture-write',idempotencyKey:'runtime-no-wait'}, {}, () => ({written:true}));
        ` : `
          store.claimNext({workerId:'fixture-worker',isolationEvidence:'unverified',
            profileRevision:'fixture-profile',permissionEpoch:0,now:new Date()});
        `}
        process.stdout.write(JSON.stringify({busy:false}));
      } catch (error) {
        process.stdout.write(JSON.stringify({busy:true,code:error.code,errcode:error.errcode}));
      } finally { store.close(); process.disconnect(); }
    });
    process.send({kind:'ready'});
  `;
  const child = spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, file],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Both streams are pipes in the exact spawn options above.
  const stdout = child.stdout!, stderr = child.stderr!;
  let output = '', errorOutput = '', spawnError: Error | undefined, closed = false;
  let readySeen = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (part: string) => { output = (output + part).slice(0, 4096); });
  stderr.on('data', (part: string) => { errorOutput = (errorOutput + part).slice(0, 4096); });
  child.once('error', error => { spawnError = error; });
  child.once('message', message => {
    if (!message || typeof message !== 'object' || !('kind' in message) || message.kind !== 'ready') return;
    readySeen = true;
    if (phase === 'runtime') acquire();
    releaseTimer = setTimeout(release, 300);
    if (phase === 'runtime') child.send({kind:'go'}, error => { if (error) spawnError = error; });
  });
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(fulfill => {
    child.once('close', (code, signal) => { closed = true; fulfill({ code, signal }); });
  });
  let deadline: NodeJS.Timeout | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    const result = await Promise.race([terminal, new Promise<undefined>(fulfill => {
      deadline = setTimeout(() => fulfill(undefined), 5_000);
    })]);
    assert.ok(result, 'SQLite startup child exceeded its deadline');
    assert.equal(spawnError, undefined);
    assert.equal(readySeen, true, `Child must reach the requested contention boundary: ${output} ${errorOutput}`);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, `Startup failed: ${output} ${errorOutput}`);
    if (phase === 'startup') {
      assert.deepEqual(JSON.parse(output), { opened: true });
      assert.equal(locked, false, 'Startup must finish after the competing writer releases');
    } else {
      assert.deepEqual(JSON.parse(output), { busy: true, code: 'ERR_SQLITE_ERROR', errcode: 5 });
      assert.equal(locked, true, 'Runtime transaction must reject before the competing writer releases');
    }
  } catch (error) { primaryError = error; }
  finally {
    try {
    if (deadline) clearTimeout(deadline);
    if (releaseTimer) clearTimeout(releaseTimer);
    release();
    writer.close();
    if (!closed) {
      child.kill();
      let cleanupDeadline: NodeJS.Timeout | undefined;
      await Promise.race([terminal, new Promise<void>(fulfill => {
        cleanupDeadline = setTimeout(fulfill, 2_000);
      })]);
      if (cleanupDeadline) clearTimeout(cleanupDeadline);
    }
    if (!closed) {
      stdout.destroy(); stderr.destroy(); child.unref();
      if (child.connected) child.disconnect();
      cleanupError = new Error('SQLite startup child close unconfirmed; fixture retained');
    } else {
      const childPath = relative(resolve(tmpdir()), resolve(fixture));
      assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath));
      rmSync(fixture, { recursive: true, force: true });
    }
    } catch (error) { cleanupError = error; }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Startup and cleanup failed');
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
});
}
}

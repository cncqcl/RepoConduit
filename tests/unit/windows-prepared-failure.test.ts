import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { openOwnedWindowsAppServer, getPreparedWindowsFailure,
  verifyPreparedWindowsNotStarted } from '../../src/adapters/codex/investigator/windows-prepared-session.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');
const launch = { runtimeRoot: resolve('D:/rcac-fixed/runtime'),
  sourceCwd: resolve('D:/rcac-fixed/runtime/check'), configSha256: 'a'.repeat(64), maxWallSeconds: 2 };

async function failedOpen(mode: 'natural' | 'natural-crlf' | 'partial' | 'contradictory' |
  'unknown-stderr' | 'oversized-stderr' | 'post-start-code' | 'prepared-then-config' |
  'missing-close' | 'signalled' | 'zero-exit' | 'spawn-error') {
  const original = childProcess.spawn;
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(),
    stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; } });
  let nativeArgs: readonly string[] = [];
  childProcess.spawn = ((_binary: string, args: readonly string[]) => {
    nativeArgs = args; return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const pending = openOwnedWindowsAppServer(launch);
    setImmediate(() => {
      if (mode === 'spawn-error') child.emit('error', Object.assign(
        new Error('SPAWN_SECRET command and path'), { code: 'EACCES' }));
      if (mode === 'partial') child.stdout.write('{bad');
      if (mode === 'contradictory') child.stdout.write('impossible\n');
      if (mode === 'prepared-then-config') {
        const [recipe, hostScopeId, executionInstanceId] = nativeArgs;
        child.stdout.write(`${JSON.stringify({ protocol: 'windows_job_stdio_v1', helperVersion: '3',
          recipe, hostScopeId, executionInstanceId, sequence: 1, kind: 'prepared', childPresent: false,
          writer: { helperPid: child.pid, helperCreationFiletime: '133900000000000002',
            pipeName: `\\\\.\\pipe\\RepoConduit-prepared-${hostScopeId}-${executionInstanceId}`,
            handle: '42', deadlineUtcTicks: '638000000000000000', deadlineUptimeMs: '100000' } })}\n`);
      }
      if (mode === 'natural-crlf') { child.stderr.write('CONFIG_'); child.stderr.write('HASH\r\n'); }
      else child.stderr.write(mode === 'unknown-stderr' ? 'TOKEN_SECRET\n' :
        mode === 'oversized-stderr' ? `${'S'.repeat(200)}\n` :
          mode === 'post-start-code' ? 'PROCESS_CREATE\n' : 'CONFIG_HASH\n');
      child.stderr.end(); child.stdout.end();
      if (mode !== 'missing-close') setImmediate(() => child.emit('close', mode === 'zero-exit' ? 0 : 1,
        mode === 'signalled' ? 'SIGTERM' : null));
    });
    let failure: unknown;
    try { await pending; } catch (error) { failure = error; }
    assert.ok(failure);
    return { failure, child };
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

test('natural helper failure preserves bounded diagnostic and private not-started identity', async () => {
  const { failure } = await failedOpen('natural');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.helperStage, 'CONFIG_HASH');
  assert.equal(found?.diagnostic.helperCloseObserved, true);
  assert.equal(found?.diagnostic.exitCode, 1);
  assert.equal(found?.diagnostic.startWriteAttempted, false);
  assert.ok(found?.notStarted);
  assert.equal(verifyPreparedWindowsNotStarted(found.notStarted, launch), true);
  assert.equal(verifyPreparedWindowsNotStarted({ ...found.notStarted }, launch), false);
  assert.equal(verifyPreparedWindowsNotStarted(found.notStarted,
    { ...launch, sourceCwd: resolve('D:/other') }), false);
  assert.equal(getPreparedWindowsFailure(new Error('WINDOWS_PREPARED_UNKNOWN')), undefined);
});

test('partial or contradictory stdout and unknown stderr cannot create not-started proof', async () => {
  for (const mode of ['partial', 'contradictory', 'unknown-stderr', 'oversized-stderr', 'signalled'] as const) {
    const { failure } = await failedOpen(mode);
    const found = getPreparedWindowsFailure(failure);
    assert.ok(found?.diagnostic);
    assert.equal(found.notStarted, undefined);
    assert.equal(JSON.stringify(found).includes('TOKEN_SECRET'), false);
  }
});

test('a returned session with an uncertain start write has no not-started failure proof', async () => {
  const original = childProcess.spawn;
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(),
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { return true; } });
  childProcess.spawn = ((_binary: string, args: readonly string[]) => {
    const [recipe, hostScopeId, executionInstanceId] = args;
    setImmediate(() => child.stdout.write(`${JSON.stringify({ protocol: 'windows_job_stdio_v1',
      helperVersion: '3', recipe, hostScopeId, executionInstanceId, sequence: 1,
      kind: 'prepared', childPresent: false, writer: { helperPid: child.pid,
        helperCreationFiletime: '133900000000000002',
        pipeName: `\\\\.\\pipe\\RepoConduit-prepared-${hostScopeId}-${executionInstanceId}`,
        handle: '42', deadlineUtcTicks: '638000000000000000', deadlineUptimeMs: '100000' } })}\n`));
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const session = await openOwnedWindowsAppServer(launch);
    const firstRemaining=session.remainingWallMs();
    assert.ok(firstRemaining>0&&firstRemaining<=launch.maxWallSeconds*1000);
    await new Promise<void>(resolve=>setTimeout(resolve,5));
    assert.ok(session.remainingWallMs()<=firstRemaining);
    child.stdin.write = () => { throw new Error('uncertain write'); };
    let failure: unknown;
    try { await session.start(); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(getPreparedWindowsFailure(failure), undefined);
    child.stdout.end(); child.stderr.end(); child.emit('close', 1, null);
    await session.stop().catch(() => undefined);
  } finally {
    childProcess.spawn = original; syncBuiltinESMExports();
  }
});

test('fragmented Windows CRLF helper code remains a fixed diagnostic', async () => {
  const { failure } = await failedOpen('natural-crlf');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.helperStage, 'CONFIG_HASH');
  assert.ok(found?.notStarted);
});

test('a post-start helper stage without a local start opportunity cannot prove not started', async () => {
  const { failure } = await failedOpen('post-start-code');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.helperStage, 'PROCESS_CREATE');
  assert.equal(found?.diagnostic.startWriteAttempted, false);
  assert.equal(found?.notStarted, undefined);
});

test('a pre-start code after a prepared stdout event is contradictory', async () => {
  const { failure } = await failedOpen('prepared-then-config');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.helperStage, 'CONFIG_HASH');
  assert.equal(found?.notStarted, undefined);
});

test('a helper failure code with zero exit cannot prove not started', async () => {
  const { failure } = await failedOpen('zero-exit');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.exitCode, 0);
  assert.equal(found?.notStarted, undefined);
});

test('missing original helper close causes force kill and no not-started proof', async () => {
  const { failure, child } = await failedOpen('missing-close');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.helperCloseObserved, false);
  assert.equal(found?.diagnostic.forcedKill, true);
  assert.equal(child.killed, true);
  assert.equal(found?.notStarted, undefined);
});

test('spawn error records only a fixed code and never its message', async () => {
  const { failure } = await failedOpen('spawn-error');
  const found = getPreparedWindowsFailure(failure);
  assert.equal(found?.diagnostic.spawnError, 'EACCES');
  assert.equal(found?.notStarted, undefined);
  assert.equal(JSON.stringify(found).includes('SPAWN_SECRET'), false);
});

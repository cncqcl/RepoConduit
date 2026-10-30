import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { getPreparedWindowsFailure, openOwnedWindowsAppServer } from
  '../../src/adapters/codex/investigator/windows-prepared-session.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');

for (const fault of ['timeout', 'buffer', 'exit', 'receipt', 'stderr', 'cancel', 'unknown_code'] as const) {
  test(`native frame rejection is diagnosed without restoring send authority: ${fault}`,
    { skip: process.platform !== 'win32' }, async () => {
      const originalSpawn = childProcess.spawn, originalSync = childProcess.spawnSync;
      const controller = new AbortController();
      const desktopTarget = resolve('D:/synthetic/codex.exe');
      const root = { pid: 42, creationFiletime: '133900000000000001' };
      const child = Object.assign(new EventEmitter(), { pid: 4242,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { return true; } });
      let sequence = 0, closed = false, writes = 0;
      childProcess.spawn = ((_binary: string, args: readonly string[]) => {
        const [recipe, hostScopeId, executionInstanceId] = args;
        assert.equal(args[7], desktopTarget);
        assert.equal(args.length, 8);
        const emit = (value: object) => child.stdout.write(`${JSON.stringify({
          protocol: 'windows_job_stdio_v1', helperVersion: '3', recipe, hostScopeId,
          executionInstanceId, sequence: ++sequence, ...value })}\n`);
        child.stdin.on('data', (bytes: Buffer) => {
          if (bytes.toString() === 'start\n') setImmediate(() => emit({ kind: 'started', root,
            createdSuspended: true, jobMemberBeforeResume: true }));
          if (bytes.toString() === 'stop\n') setImmediate(() => {
            emit({ kind: 'stdout_eof' }); emit({ kind: 'stderr_eof' }); emit({ kind: 'root_exit' });
            emit({ kind: 'job_closed', root, rootExited: true,
              members: { complete: true, assigned: 0, listed: 0, pids: [] } });
            child.stdout.end(); child.stderr.end(); closed = true; child.emit('close', 0, null);
          });
        });
        setImmediate(() => emit({ kind: 'prepared', childPresent: false, writer: {
          helperPid: child.pid, helperCreationFiletime: '133900000000000002',
          pipeName: `\\\\.\\pipe\\RepoConduit-prepared-${hostScopeId}-${executionInstanceId}`,
          handle: '42', deadlineUtcTicks: '638000000000000000', deadlineUptimeMs: '100000' } }));
        return child;
      }) as unknown as typeof childProcess.spawn;
      childProcess.spawnSync = (() => {
        writes++;
        if (fault === 'cancel') controller.abort();
        return { pid: 4243, status: fault === 'exit' ? 1 : 0, signal: null, output: [],
          stdout: fault === 'receipt' ? 'SENSITIVE_RECEIPT' : '{"accepted":true}',
          stderr: fault === 'stderr' ? 'WRITER_DEADLINE\r\n' : '','error':
            ['timeout', 'buffer', 'unknown_code'].includes(fault) ? Object.assign(
              new Error('SENSITIVE_PAYLOAD_AND_PATH'), { code: fault === 'timeout' ? 'ETIMEDOUT' :
                fault === 'buffer' ? 'ENOBUFS' : 'SENSITIVE_ERROR_CODE' }) : undefined };
      }) as unknown as typeof childProcess.spawnSync;
      syncBuiltinESMExports();
      let session: Awaited<ReturnType<typeof openOwnedWindowsAppServer>> | undefined;
      try {
        session = await openOwnedWindowsAppServer({ runtimeRoot: resolve('D:/synthetic/runtime'),
          sourceCwd: resolve('D:/synthetic/source'), desktopTarget, configSha256: 'a'.repeat(64),
          maxWallSeconds: 2, signal: controller.signal });
        await session.start();
        let failure: unknown;
        try { session.send('{"synthetic":true}\n'); } catch (error) { failure = error; }
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, 'WINDOWS_PREPARED_UNKNOWN');
        const diagnostic = failure.cause as Record<string, unknown>;
        assert.ok(diagnostic);
        assert.equal(diagnostic.stage, 'frame_write');
        assert.equal(diagnostic.reason, ['timeout', 'buffer', 'unknown_code'].includes(fault) ?
          'spawn_error' : fault === 'exit' ? 'native_exit' : fault === 'receipt' ?
            'receipt_mismatch' : fault === 'stderr' ? 'native_stderr' : 'cancelled');
        assert.equal(diagnostic.spawnError, fault === 'timeout' ? 'ETIMEDOUT' :
          fault === 'buffer' ? 'ENOBUFS' : fault === 'unknown_code' ? 'unknown' : null);
        assert.equal(diagnostic.helperStage, fault === 'stderr' ? 'WRITER_DEADLINE' : 'unknown');
        assert.equal(Object.isFrozen(diagnostic), true);
        assert.equal(JSON.stringify(diagnostic).includes('SENSITIVE'), false);
        assert.equal(getPreparedWindowsFailure(failure), undefined);
        assert.throws(() => session!.send('{}\n'), /WINDOWS_PREPARED_UNKNOWN/);
        assert.equal(writes, 1, 'uncertain writes must not be retried');
        await assert.rejects(session.stop(), /WINDOWS_PREPARED_UNKNOWN/);
      } finally {
        if (!closed) { child.stdout.end(); child.stderr.end(); child.emit('close', 1, null); }
        await session?.stop().catch(() => undefined);
        childProcess.spawn = originalSpawn; childProcess.spawnSync = originalSync;
        syncBuiltinESMExports();
      }
    });
}

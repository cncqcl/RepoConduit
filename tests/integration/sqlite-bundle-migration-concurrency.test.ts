import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

test('bundle reference migration reserves write access before reading an existing bundle',
  { timeout: 15_000 }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'rcac-migration-contention-'));
    const file = join(fixture, 'state.sqlite');
    const continuation = join(fixture, 'continue');
    const original = new SqliteStore(file);
    try {
      original.insertWorkspace({ id: 'ws', name: 'Original', canonicalRoot: fixture, registeredBy: 'owner' });
      original.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner',
        purpose: 'migration contention', hostThreadId: null, state: 'open' });
      const { snapshotId } = await seedBundleProvenance(original, file, { workspaceId: 'ws',
        collaborationId: 'col', workingCopyId: 'copy', root: fixture, revisionIds: ['ctx'] });
      original.saveBundle({ input: { bundleId: 'bundle', workspaceId: 'ws', collaborationId: 'col',
        contextRevision: 'ctx', snapshotRefs: [snapshotId], expectedPaths: ['report.txt'] } });
    } finally { original.close(); }

    // Only a disposable copy is instrumented. Its real SQLite reads and writes remain unchanged.
    const sourceUrl = new URL('../../src/adapters/storage/sqlite.ts', import.meta.url);
    const source = readFileSync(sourceUrl, 'utf8');
    const marker = '      const insertContext = this.db.prepare(`INSERT OR IGNORE INTO bundle_context_refs';
    assert.equal(source.split(marker).length, 2, 'Expected one migration read barrier');
    const resolvedSource = source.replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
      (_match, prefix: string, _quote: string, specifier: string) =>
        prefix + JSON.stringify(new URL(specifier.replace(/\.js$/, '.ts'), sourceUrl).href));
    const instrumented = `import { existsSync as diagnosticExistsSync } from 'node:fs';\n` +
      resolvedSource
        .replace(marker, `
      process.send?.({kind:'bundle-read'});
      const diagnosticDeadline = Date.now() + 5_000;
      const diagnosticWait = new Int32Array(new SharedArrayBuffer(4));
      while (!diagnosticExistsSync(process.argv[3]!)) {
        if (Date.now() >= diagnosticDeadline) throw new Error('Migration read barrier timed out');
        Atomics.wait(diagnosticWait, 0, 0, 10);
      }
${marker}`);
    const copy = join(fixture, 'sqlite-instrumented.ts');
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(copy, instrumented);
    const writer = new DatabaseSync(file);
    const program = `
      const { SqliteStore } = await import(process.argv[1]);
      try {
        const store = new SqliteStore(process.argv[2]);
        store.close();
        process.stdout.write(JSON.stringify({opened:true}));
      } catch (error) {
        process.stdout.write(JSON.stringify({opened:false,code:error.code,errcode:error.errcode,
          message:error.message,stack:error.stack}));
        process.exitCode = 1;
      } finally { process.disconnect(); }
    `;
    const child = spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', program, pathToFileURL(copy).href, file, continuation],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const stdout = child.stdout!, stderr = child.stderr!;
    let output = '', errorOutput = '', closed = false, barrierSeen = false;
    let writerCommitted = false, writerError: unknown, spawnError: unknown;
    stdout.setEncoding('utf8'); stderr.setEncoding('utf8');
    stdout.on('data', (part: string) => { output = (output + part).slice(0, 8192); });
    stderr.on('data', (part: string) => { errorOutput = (errorOutput + part).slice(0, 4096); });
    child.once('error', error => { spawnError = error; });
    child.once('message', message => {
      if (!message || typeof message !== 'object' || !('kind' in message) || message.kind !== 'bundle-read') return;
      barrierSeen = true;
      try {
        writer.prepare('UPDATE workspaces SET name=? WHERE id=?').run('Concurrent', 'ws');
        writerCommitted = true;
      } catch (error) { writerError = error; }
      finally { writeFileSync(continuation, 'continue'); }
    });
    const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(fulfill => {
      child.once('close', (code, signal) => { closed = true; fulfill({ code, signal }); });
    });
    let deadline: NodeJS.Timeout | undefined;
    let primaryError: unknown, cleanupError: unknown;
    try {
      const result = await Promise.race([terminal, new Promise<undefined>(fulfill => {
        deadline = setTimeout(() => fulfill(undefined), 7_000);
      })]);
      assert.ok(result, 'Migration child exceeded its deadline');
      assert.equal(spawnError, undefined);
      assert.equal(barrierSeen, true, `Migration child must reach the read barrier: ${output} ${errorOutput}`);
      assert.equal(result.signal, null);
      assert.equal(result.code, 0, `Migration failed: ${output} ${errorOutput}`);
      assert.deepEqual(JSON.parse(output), { opened: true });
      assert.equal(writerCommitted, false, 'Competing writer cannot commit between migration read and write');
      assert.equal((writerError as { code?: string } | undefined)?.code, 'ERR_SQLITE_ERROR');
      assert.equal((writerError as { errcode?: number } | undefined)?.errcode, 5);
      writer.prepare('UPDATE workspaces SET name=? WHERE id=?').run('After migration', 'ws');
      assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM bundle_context_refs').get()?.count, 1);
      assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM bundle_snapshot_refs').get()?.count, 1);
    } catch (error) { primaryError = error; }
    finally {
      try {
        if (deadline) clearTimeout(deadline);
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
          cleanupError = new Error('Migration child close unconfirmed; fixture retained');
        } else {
          const childPath = relative(resolve(tmpdir()), resolve(fixture));
          assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath));
          rmSync(fixture, { recursive: true, force: true });
        }
      } catch (error) { cleanupError = error; }
    }
    if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Migration and cleanup failed');
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  });

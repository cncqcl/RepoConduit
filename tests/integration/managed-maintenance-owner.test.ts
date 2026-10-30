import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createManagedInstallation } from '../../src/cli/install.js';
import { openApplicationWithinInstallation } from '../../src/runtime/application.js';
import { acquireInstallationMaintenance, acquireInstallationRuntime, assertActiveInstallation,
  assertActiveInstallationMaintenance, type InstallationRuntime } from '../../src/runtime/installation.js';
import { acquireExclusiveMaintenanceGate, initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

async function fixture(run: (root: string, base: string, retain: () => void) => Promise<void>): Promise<void> {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-maint-owner-'));
  let primary: unknown;
  let retained = false;
  try {
    protectNewDataDirectory(base);
    const root = join(base, 'installation');
    createManagedInstallation(root);
    await run(root, base, () => { retained = true; });
  } catch (error) { primary = error;retained=true; }
  if (retained) {
    console.error('Retained maintenance owner fixture:',base);
    if (primary !== undefined) throw primary;
    throw new Error('Maintenance owner fixture retained after unconfirmed child close');
  }
  let cleanup: unknown;
  try {
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-maint-owner-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Maintenance owner assertion and cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

test('real runtime and maintenance owners exclude each other and release permits reacquisition', async () => {
  await fixture(async root => {
    const runtime = acquireInstallationRuntime(root);
    try {
      assert.throws(() => assertActiveInstallationMaintenance(runtime as unknown as
        Parameters<typeof assertActiveInstallationMaintenance>[0]), /INSTALLATION_UNSAFE/);
      assert.throws(() => acquireInstallationMaintenance(root), /MAINTENANCE_GATE_BUSY/);
    }
    finally { runtime.release(); }
    const maintenance = acquireInstallationMaintenance(root);
    try {
      assertActiveInstallationMaintenance(maintenance);
      assert.equal(maintenance.installationDirectory, root);
      assert.equal(maintenance.kind, 'maintenance');
      assert.throws(() => acquireInstallationRuntime(root), /MAINTENANCE_GATE_BUSY/);
      assert.throws(() => acquireInstallationMaintenance(root), /MAINTENANCE_GATE_BUSY/);
      assert.throws(() => assertActiveInstallation(maintenance as unknown as InstallationRuntime), /INSTALLATION_UNSAFE/);
      assert.throws(() => openApplicationWithinInstallation(maintenance as unknown as InstallationRuntime), /INSTALLATION_UNSAFE/);
      assert.throws(() => assertActiveInstallationMaintenance({ ...maintenance }), /INSTALLATION_UNSAFE/);
    } finally { maintenance.release(); }
    maintenance.release();
    assert.throws(() => assertActiveInstallationMaintenance(maintenance), /INSTALLATION_UNSAFE/);
    const again = acquireInstallationRuntime(root);
    again.release();
  });
});

test('controlled native file close error keeps runtime and maintenance gates until owner process closes',
  // Four child windows (25s each), native setup and gate checks cannot fit in
  // the old 60-second whole-case bound. Child and cleanup bounds remain fixed.
  { timeout: 240_000 }, async t => {
    const started=performance.now();
    const phase=(stage:string,extra:Record<string,unknown>={})=>t.diagnostic(JSON.stringify({
      case:'maintenance-file-close',stage,elapsedMs:Math.round(performance.now()-started),...extra}));
    await fixture(async (root, _base, retain) => {
      phase('installation_ready');t.signal.throwIfAborted();
      for (const mode of ['runtime', 'maintenance', 'package', 'malformed'] as const) {
        t.signal.throwIfAborted();phase('mode_begin',{mode});
        if (mode === 'malformed') writeFileSync(join(root, 'managed.json'), '{');
        const moduleUrl = new URL('../../src/runtime/installation.ts', import.meta.url).href;
        const script = `import fs from 'node:fs';
          import { findPackageJSON, syncBuiltinESMExports } from 'node:module';
          import { join } from 'node:path';
          const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
          const moduleUrl = ${JSON.stringify(moduleUrl)};
          const targetPath = mode === 'package' ? findPackageJSON(moduleUrl) : join(root, 'managed.json');
          const originalOpen = fs.openSync, originalClose = fs.closeSync;
          let targetFd = -1, injected = 0;
          fs.openSync = (path, ...args) => {
            const fd = originalOpen(path, ...args);
            if (String(path) === targetPath) targetFd = fd;
            return fd;
          };
          fs.closeSync = fd => {
            if (fd === targetFd) {
              targetFd = -1;
              originalClose(fd);
              injected++;
              throw new Error('controlled native-close aftermath');
            }
            return originalClose(fd);
          };
          syncBuiltinESMExports();
          const api = await import(moduleUrl);
          let aggregate = false, message = '', errors = 0, firstErrorName = '';
          try {
            if (mode === 'runtime') api.acquireInstallationRuntime(root);
            else if (mode === 'package') api.currentInstallationPackageVersion();
            else api.acquireInstallationMaintenance(root);
          } catch (error) {
            aggregate = error instanceof AggregateError;
            message = error?.message ?? '';
            errors = aggregate ? error.errors.length : 0;
            firstErrorName = aggregate ? error.errors[0]?.constructor?.name ?? '' : '';
          }
          let exclusive = 'not_checked';
          if (mode !== 'package') {
            const { acquireExclusiveMaintenanceGate } = await import(${JSON.stringify(new URL('../../src/runtime/maintenance-gate.ts', import.meta.url).href)});
            try { const held = acquireExclusiveMaintenanceGate(root); held.release(); exclusive = 'acquired'; }
            catch (error) { exclusive = error?.message ?? 'unknown'; }
          }
          process.stdout.write(JSON.stringify({ injected, aggregate, message, errors, firstErrorName, exclusive }) + '\\n');`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
          { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
        phase('child_started',{mode,pid:child.pid??null});
        const abortChild=()=>{try{child.kill();}catch{phase('child_kill_unconfirmed',{mode});}};
        t.signal.addEventListener('abort',abortChild,{once:true});
        if(t.signal.aborted)abortChild();
        let stdout = '', stderr = '';
        child.stdout!.on('data', chunk => { stdout += String(chunk).slice(0, 4096 - stdout.length); });
        child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 4096 - stderr.length); });
        const closed = new Promise<number | null>(resolveClosed => { child.once('close', resolveClosed); });
        let spawnError: unknown;
        child.once('error', error => { spawnError = error; });
        let timeout: NodeJS.Timeout | undefined;
        let code: number | null;
        try {
          code = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('installation file fault child close unconfirmed')), 25_000);
          })]);
          phase('child_closed',{mode,exitCode:code});t.signal.throwIfAborted();
        } catch (error) {
          retain();
          abortChild();
          let cleanupTimer:NodeJS.Timeout|undefined;
          try{
            const cleanup=await Promise.race([closed.then(exitCode=>({exitCode})),
              new Promise<null>(resolveCleanup=>{cleanupTimer=setTimeout(()=>resolveCleanup(null),5000);})]);
            phase('failed_child_cleanup',{mode,closeConfirmed:cleanup!==null,exitCode:cleanup?.exitCode??null});
            if(cleanup===null){child.unref();child.stdout?.destroy();child.stderr?.destroy();}
          }finally{if(cleanupTimer)clearTimeout(cleanupTimer);}
          throw error;
        } finally {
          if (timeout) clearTimeout(timeout);
          t.signal.removeEventListener('abort',abortChild);
        }
        assert.equal(spawnError, undefined);
        assert.equal(code, 0, stderr.slice(0, 512));
        const result = JSON.parse(stdout.trim()) as { injected: number; aggregate: boolean;
          message: string; errors: number; firstErrorName: string; exclusive: string };
        assert.equal(result.injected, 1, `Fault was not reached for ${mode}: ${JSON.stringify(result)}`);
        assert.equal(result.aggregate, true, `Expected cleanup aggregate for ${mode}: ${JSON.stringify(result)}`);
        assert.equal(result.message, 'Installation file close unconfirmed');
        assert.equal(result.errors, mode === 'malformed' ? 2 : 1);
        if (mode === 'malformed') assert.equal(result.firstErrorName, 'SyntaxError');
        assert.equal(stdout.includes(root), false);
        if (mode !== 'package') {
          assert.equal(result.exclusive, 'MAINTENANCE_GATE_BUSY');
          t.signal.throwIfAborted();
          const gate = acquireExclusiveMaintenanceGate(root);
          gate.release();
        }
        phase('mode_verified',{mode});
      }
    });
  });

test('invalid managed manifest releases exclusive acquisition and flat roots remain untouched', async () => {
  await fixture(async (root, base) => {
    const manifestFile = join(root, 'managed.json');
    const original = readFileSync(manifestFile);
    const invalid = { ...(JSON.parse(original.toString('utf8')) as Record<string, unknown>), packageVersion: '999.0.0' };
    writeFileSync(manifestFile, JSON.stringify(invalid));
    assert.throws(() => acquireInstallationMaintenance(root), /INSTALLATION_UNSAFE/);
    const exclusive = acquireExclusiveMaintenanceGate(root);
    exclusive.release();
    writeFileSync(manifestFile, original);
    const owner = acquireInstallationMaintenance(root);
    owner.release();

    const flat = join(base, 'flat');
    mkdirSync(flat, { mode: 0o700 });
    protectNewDataDirectory(flat);
    const store = new SqliteStore(join(flat, 'state.sqlite'));
    store.close();
    assert.throws(() => acquireInstallationMaintenance(flat), /INSTALLATION_UNSAFE/);
    assert.equal(existsSync(join(flat, 'lifecycle.sqlite')), false);

    const partial = join(base, 'partial');
    mkdirSync(partial, { mode: 0o700 });
    protectNewDataDirectory(partial);
    initializeMaintenanceGate(partial);
    assert.throws(() => acquireInstallationMaintenance(partial), /INSTALLATION_UNSAFE/);
    const partialGate = acquireExclusiveMaintenanceGate(partial);
    partialGate.release();
    assert.equal(existsSync(join(partial, 'managed.json')), false);
  });
});

test('generation data cannot masquerade as a separate maintenance installation', async () => {
  await fixture(async root => {
    const manifest = JSON.parse(readFileSync(join(root, 'managed.json'), 'utf8')) as { activeGeneration: string };
    const data = join(root, 'generations', manifest.activeGeneration, 'data');
    assert.throws(() => acquireInstallationMaintenance(data), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'INSTALLATION_UNSAFE');
      assert.deepEqual(error.cause, { component: 'installation_runtime', stage: 'managed_descendant' });
      return true;
    });
  });
});

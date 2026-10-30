import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { exportJWK, generateKeyPair } from 'jose';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireExclusiveMaintenanceGate } from '../../src/runtime/maintenance-gate.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

async function options() {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const salt = randomBytes(16);
  const issuer = 'https://issuer.example.test', resource = 'https://mcp.example.test/api/mcp';
  const clientId = 'approved-chatgpt', subject = 'operator';
  return { issuer: { issuer, resource, clientId, redirectUris: ['https://chatgpt.example.test/callback'],
    scopes: ['collab.read'], operator: { subject, saltHex: salt.toString('hex'),
      hashHex: scryptSync('fixture-secret', salt, 64).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')],
    jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] } },
  bindings: [{ issuer, clientId, subject, principal: 'external', recipient: clientId,
    workspaceId: 'workspace-a', scopes: { 'collab.read': { delegatedPermissions: ['collab.read'],
      visibleOperations: ['collab.get'] } } }] };
}

test('actual native issuer file close followed by controlled error retains the public managed gate',
  // Native setup, the 25-second child bound, and gate verification are separate
  // work. The former 45-second whole-case limit could cancel before the fault.
  { timeout: 120_000 }, async t => {
    const started=performance.now();
    const phase=(stage:string,extra:Record<string,unknown>={})=>t.diagnostic(JSON.stringify({
      case:'issuer-file-close',stage,elapsedMs:Math.round(performance.now()-started),...extra}));
    const parent = process.platform === 'win32' ? homedir() : tmpdir();
    const base = mkdtempSync(join(parent, 'rcac-issuer-close-'));
    let primary: unknown;
    let retain = false;
    try {
      protectNewDataDirectory(base);
      phase('root_protected');t.signal.throwIfAborted();
      const root = join(base, 'installation');
      createManagedInstallation(root);
      phase('installation_ready');t.signal.throwIfAborted();
      const script = `import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        const root = ${JSON.stringify(root)};
        const issuerFile = join(root, 'generations',
          (await import('node:fs')).readdirSync(join(root, 'generations'))[0], 'data', 'issuer.sqlite');
        const originalOpen = fs.openSync, originalClose = fs.closeSync;
        let target = -1, injected = 0;
        fs.openSync = (path, ...args) => {
          const fd = originalOpen(path, ...args);
          if (String(path) === issuerFile) target = fd;
          return fd;
        };
        fs.closeSync = (fd) => {
          if (fd === target) {
            target = -1;
            originalClose(fd);
            injected++;
            throw new Error('controlled close error after native close');
          }
          return originalClose(fd);
        };
        syncBuiltinESMExports();
        const { startSelfHostedOAuthHttp } = await import(${JSON.stringify(new URL('../../src/runtime/self-hosted-oauth-http.ts', import.meta.url).href)});
        const { acquireExclusiveMaintenanceGate } = await import(${JSON.stringify(new URL('../../src/runtime/maintenance-gate.ts', import.meta.url).href)});
        let aggregate = false, message = '';
        try { await startSelfHostedOAuthHttp(root, ${JSON.stringify(await options())}); }
        catch (error) { aggregate = error instanceof AggregateError; message = error?.message ?? ''; }
        let exclusive = 'busy';
        try { const gate = acquireExclusiveMaintenanceGate(root); gate.release(); exclusive = 'acquired'; }
        catch (error) { exclusive = error?.message ?? 'unknown'; }
        process.stdout.write(JSON.stringify({ injected, aggregate, message, exclusive }) + '\\n');`;
      t.signal.throwIfAborted();
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
      phase('child_started',{pid:child.pid??null});
      const abortChild=()=>{try{child.kill();}catch{phase('child_kill_unconfirmed');}};
      t.signal.addEventListener('abort',abortChild,{once:true});
      if(t.signal.aborted)abortChild();
      let stdout = '', stderr = '';
      child.stdout!.on('data', chunk => { stdout += String(chunk).slice(0, 4096 - stdout.length); });
      child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 4096 - stderr.length); });
      const closed = new Promise<{ code: number | null }>(resolveClosed => {
        child.once('close', code => resolveClosed({ code }));
      });
      let spawnError: unknown;
      child.once('error', error => { spawnError = error; });
      let timeout: NodeJS.Timeout | undefined;
      let terminal: { code: number | null } | undefined;
      try {
        terminal = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('issuer fault child close unconfirmed')), 25_000);
        })]);
        phase('child_closed',{exitCode:terminal.code});t.signal.throwIfAborted();
      } catch (error) {
        retain = true;
        abortChild();
        let cleanupTimer:NodeJS.Timeout|undefined;
        try{
          const cleanup=await Promise.race([closed,new Promise<null>(resolveCleanup=>{
            cleanupTimer=setTimeout(()=>resolveCleanup(null),5000);
          })]);
          phase('failed_child_cleanup',{closeConfirmed:cleanup!==null,exitCode:cleanup?.code??null});
          if(cleanup===null){child.unref();child.stdout?.destroy();child.stderr?.destroy();}
        }finally{if(cleanupTimer)clearTimeout(cleanupTimer);}
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        t.signal.removeEventListener('abort',abortChild);
      }
      assert.equal(spawnError, undefined);
      assert.equal(terminal.code, 0, stderr.slice(0, 512));
      const result = JSON.parse(stdout.trim()) as { injected: number; aggregate: boolean;
        message: string; exclusive: string };
      assert.equal(result.injected, 1);
      assert.equal(result.aggregate, true);
      assert.equal(result.message, 'Issuer file close unconfirmed');
      assert.equal(result.exclusive, 'MAINTENANCE_GATE_BUSY');
      phase('fault_verified');t.signal.throwIfAborted();
      const gate = acquireExclusiveMaintenanceGate(root);
      gate.release();
    } catch (error) { primary = error;retain=true; }
    if (retain) {
      console.error('Retained issuer close fixture:',base);
      if (primary !== undefined) throw primary;
      throw new Error('Issuer fault fixture retained after unconfirmed child close');
    }
    let cleanup: unknown;
    try {
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-issuer-close-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    } catch (error) { cleanup = error; }
    if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Issuer test and cleanup failed');
    if (primary !== undefined) throw primary;
    if (cleanup !== undefined) throw cleanup;
  });

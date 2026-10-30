import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('application startup waits for a short writer acquired only at the recovery boundary', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-startup-recovery-'));
  const data = join(root, 'data');
  mkdirSync(data);
  protectNewDataDirectory(root); protectNewDataDirectory(data);
  const file = join(data, 'state.sqlite'), continuation = join(root, 'continue');
  new SqliteStore(file).close(); new SqliteInvestigationStore(file).close();
  const writer = new DatabaseSync(file);
  let locked = false, boundarySeen = false, closed = false, passed = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  const release = () => { if (locked) { writer.exec('ROLLBACK'); locked = false; } };
  const program = `
    import {existsSync} from 'node:fs';
    import {openApplication} from './src/runtime/application.ts';
    import {SqliteInvestigationStore} from './src/adapters/storage/investigation-sqlite.ts';
    const original=SqliteInvestigationStore.prototype.recoverCodexOwnedSessions;
    let calls=0;
    SqliteInvestigationStore.prototype.recoverCodexOwnedSessions=function(...args){
      if(++calls===1){process.send({kind:'recovery-boundary'});const limit=Date.now()+5000;
        while(!existsSync(process.argv[2])){if(Date.now()>limit)throw new Error('Recovery barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
      return original.apply(this,args);
    };
    let app;
    try{app=openApplication(process.argv[1]);await app.ready;console.log(JSON.stringify({opened:true,calls}));}
    catch(error){console.log(JSON.stringify({opened:false,code:error.code,errcode:error.errcode,message:error.message,stack:error.stack}));process.exitCode=1;}
    finally{await app?.close();process.disconnect();}
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, data, continuation],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', errors = '';
  child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { errors += b; });
  child.on('message', message => {
    if (message && typeof message === 'object' && 'kind' in message && message.kind === 'recovery-boundary') {
      boundarySeen = true; writer.exec('BEGIN IMMEDIATE'); locked = true;
      writeFileSync(continuation, 'continue'); releaseTimer = setTimeout(release, 300);
    }
  });
  const terminal = new Promise<number | null>(resolve => child.once('close', code => { closed = true; resolve(code); }));
  const watchdog = setTimeout(() => child.kill(), 12_000);
  try {
    assert.equal(await terminal, 0, `${output} ${errors}`);
    assert.equal(boundarySeen, true);
    assert.equal(locked, false, 'The competing writer must release before successful recovery');
    assert.deepEqual(JSON.parse(output), { opened: true, calls: 1 });
    passed = true;
  } finally {
    clearTimeout(watchdog); if (releaseTimer) clearTimeout(releaseTimer); release(); writer.close();
    if (!closed) child.kill();
    if (passed && closed) rmSync(root, { recursive: true, force: true });
    else console.error('retained-startup-recovery-fixture', root, 'continuation', existsSync(continuation));
  }
});

for (const mode of ['released', 'exhausted'] as const) {
  test(`startup recovery ${mode} restores immediate runtime write rejection`, { timeout: 12_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcac-recovery-wait-')), file = join(root, 'state.sqlite');
    new SqliteStore(file).close(); new SqliteInvestigationStore(file).close();
    const writer = new DatabaseSync(file);
    let locked = false, closed = false, passed = false, runtimeLocked = false;
    let releaseTimer: NodeJS.Timeout | undefined;
    const acquire = () => { writer.exec('BEGIN IMMEDIATE'); locked = true; };
    const release = () => { if (locked) { writer.exec('ROLLBACK'); locked = false; } };
    const program = `
      import {SqliteInvestigationStore} from './src/adapters/storage/investigation-sqlite.ts';
      const store=new SqliteInvestigationStore(process.argv[1]);
      const wait=()=>new Promise(resolve=>process.once('message',resolve));
      const errorValue=e=>({code:e.code,errcode:e.errcode,message:e.message});
      process.send({kind:'ready'});await wait();
      let startup;try{store.recoverStartupAttempts();startup={ok:true};}catch(error){startup={ok:false,...errorValue(error)};}
      process.send({kind:'startup-result',startup});await wait();
      let runtime;try{store.recoverCodexOwnedSessions();runtime={busy:false};}catch(error){runtime={busy:true,...errorValue(error)};}
      process.send({kind:'runtime-result',runtime});console.log(JSON.stringify({startup,runtime}));store.close();process.disconnect();
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, file],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', errors = '';
    child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { errors += b; });
    child.on('message', message => {
      if (!message || typeof message !== 'object' || !('kind' in message)) return;
      if (message.kind === 'ready') {
        acquire(); child.send({ kind: 'go' });
        if (mode === 'released') releaseTimer = setTimeout(release, 300);
      } else if (message.kind === 'startup-result') {
        if (releaseTimer) clearTimeout(releaseTimer); release(); acquire();
        child.send({ kind: 'runtime-go' }); releaseTimer = setTimeout(release, 500);
      } else if (message.kind === 'runtime-result') runtimeLocked = locked;
    });
    const terminal = new Promise<number | null>(resolve => child.once('close', code => { closed = true; resolve(code); }));
    const watchdog = setTimeout(() => child.kill(), 8_000);
    try {
      assert.equal(await terminal, 0, `${output} ${errors}`);
      const observed = JSON.parse(output);
      if (mode === 'released') assert.deepEqual(observed.startup, { ok: true });
      else { assert.equal(observed.startup.ok, false); assert.equal(observed.startup.code, 'ERR_SQLITE_ERROR'); assert.equal(observed.startup.errcode, 5); }
      assert.equal(observed.runtime.busy, true); assert.equal(observed.runtime.code, 'ERR_SQLITE_ERROR'); assert.equal(observed.runtime.errcode, 5);
      assert.equal(runtimeLocked, true, 'Runtime rejection must precede the competing writer release');
      const inspection = new DatabaseSync(file, { readOnly: true });
      try { for (const table of ['investigation_requests', 'investigation_active_attempts', 'investigation_outbox'])
        assert.equal(inspection.prepare('SELECT count(*) n FROM '+table).get()?.n, 0); }
      finally { inspection.close(); }
      passed = true;
    } finally {
      clearTimeout(watchdog); if (releaseTimer) clearTimeout(releaseTimer); release(); writer.close();
      if (!closed) child.kill();
      if (passed && closed) rmSync(root, { recursive: true, force: true });
      else console.error('retained-recovery-wait-fixture', root);
    }
  });
}

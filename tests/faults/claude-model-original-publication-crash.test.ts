import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { publicationRows } from '../helpers/claude-model-original-publication-fixture.js';

type Stage = 'tree'|'provenance'|'record'|'outbox'|'slot'|'committed';
const workerPath = resolve('tests/helpers/claude-model-original-publication-worker.ts');
const prefix = 'rcac-original-publication-crash-';

function readMarker(path: string): {pid:number;stage:Stage;file?:string;dir?:string;requestId?:string} {
  return JSON.parse(readFileSync(path,'utf8')) as
    {pid:number;stage:Stage;file?:string;dir?:string;requestId?:string};
}

async function waitForMarker(path: string, child: ReturnType<typeof spawn>,
  stderr: () => string) {
  for(let n=0;n<750;n++) {
    if(existsSync(path)) return readMarker(path);
    if(child.exitCode!==null || child.signalCode!==null)
      throw new Error(`Owned worker exited before marker: code=${child.exitCode}, `+
        `signal=${child.signalCode}, stderr=${stderr()}`);
    await new Promise<void>(done=>setTimeout(done,20));
  }
  throw new Error(`Timed out waiting for owned worker marker ${basename(path)}: ${stderr()}`);
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((done,fail) => {
    const timer=setTimeout(()=>fail(new Error(`Owned worker exit timeout after ${ms}ms`)),ms);
    promise.then(value=>{clearTimeout(timer);done(value);},
      error=>{clearTimeout(timer);fail(error);});
  });
}

function validateOwnedFixture(root: string, originalRoot: string, parent: string,
  ready?: ReturnType<typeof readMarker>) {
  const actualRoot=realpathSync.native(root);
  assert.equal(resolve(actualRoot),resolve(originalRoot));
  assert.equal(resolve(dirname(root)),resolve(parent));
  assert.equal(resolve(dirname(actualRoot)),resolve(parent));
  assert.ok(basename(root).startsWith(prefix));
  assert.ok(basename(actualRoot).startsWith(prefix));
  if(ready) {
    assert.ok(ready.dir && ready.file && ready.requestId);
    const actualFixture=realpathSync.native(ready.dir);
    assert.equal(resolve(dirname(ready.dir)),resolve(actualRoot));
    assert.equal(resolve(dirname(actualFixture)),resolve(actualRoot));
    assert.equal(resolve(ready.file),resolve(join(actualFixture,'state.sqlite')));
    assert.ok(basename(actualFixture).startsWith('rcac-model-outer-db-'));
  }
  return actualRoot;
}

test('owned Node death rolls back each original publication stage; normal exit preserves commit', async t => {
  const parent=realpathSync.native(tmpdir());
  for(const stage of ['tree','provenance','record','outbox','slot','committed'] as const) {
    await t.test(stage,async () => {
      const root=mkdtempSync(join(parent,prefix));
      const originalRoot=realpathSync.native(root);
      const child=spawn(process.execPath,['--import','tsx',workerPath,stage,root],
        {cwd:process.cwd(),stdio:['ignore','pipe','pipe'],windowsHide:true});
      let stderr='';
      child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-2000);});
      let exitObserved=false;
      const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,fail)=>{
        child.once('exit',(code,signal)=>{exitObserved=true;done({code,signal});});
        child.once('error',fail);
      });
      void exit.catch(()=>{});
      let ready: ReturnType<typeof readMarker>|undefined;
      let passed=false;
      try {
        ready=await waitForMarker(join(root,'ready.json'),child,()=>stderr);
        assert.equal(ready.pid,child.pid);
        assert.equal(ready.stage,stage);
        validateOwnedFixture(root,originalRoot,parent,ready);
        if(stage==='committed') {
          const committed=await waitForMarker(join(root,'committed.json'),child,()=>stderr);
          assert.equal(committed.pid,child.pid);
          const result=await bounded(exit,5000);
          assert.equal(result.code,0,stderr);
          assert.equal(result.signal,null);
          t.diagnostic(`committed child pid=${child.pid} exitCode=${result.code} signal=${result.signal}`);
        } else {
          const marker=await waitForMarker(join(root,'stage.json'),child,()=>stderr);
          assert.deepEqual(marker,{pid:child.pid,stage});
          assert.equal(child.kill('SIGKILL'),true);
          const result=await bounded(exit,5000);
          assert.ok(result.signal!==null || result.code!==0,
            `expected killed worker, got code=${result.code}, signal=${result.signal}`);
          t.diagnostic(`stage=${stage} owned child pid=${child.pid} kill=SIGKILL `+
            `exitCode=${result.code} signal=${result.signal}`);
        }
        assert.equal(exitObserved,true);
        const file=ready.file!;
        const requestId=ready.requestId!;
        if(stage!=='committed') {
          const db=new DatabaseSync(file);
          try { db.exec('DROP TRIGGER test_original_crash_stage'); }
          finally { db.close(); }
        }
        const reopened=new SqliteInvestigationStore(file);
        try {
          if(stage==='committed') {
            assert.deepEqual(publicationRows(file,requestId),
              {tree:1,provenance:1,slot:0,outbox:0});
            assert.equal(reopened.get(requestId)?.state,'completed');
            assert.equal(reopened.get(requestId)?.result?.evidence.length,1);
            assert.equal(reopened.get(requestId)?.attempts[0]?.terminationConfirmed,true);
          } else {
            assert.deepEqual(publicationRows(file,requestId),
              {tree:0,provenance:0,slot:1,outbox:1});
            assert.equal(reopened.get(requestId)?.state,'running');
            assert.equal(reopened.get(requestId)?.result,null);
            assert.equal(reopened.get(requestId)?.attempts[0]?.terminationConfirmed,false);
            assert.equal(reopened.listUnsettled().length,1);
          }
        } finally { reopened.close(); }
        passed=true;
      } finally {
        if(!exitObserved && child.exitCode===null && child.signalCode===null) {
          child.kill('SIGKILL');
          try { await bounded(exit,5000); } catch { /* preserve fixture if termination is unknown */ }
        }
        if(exitObserved && passed) {
          const safeRoot=validateOwnedFixture(root,originalRoot,parent,ready);
          rmSync(safeRoot,{recursive:true,force:true});
        } else t.diagnostic(`preserved ${root}: test failed or owned child termination unconfirmed`);
      }
    });
  }
});

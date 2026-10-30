import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const source=resolve('native/windows/WindowsJobHost.cs');

async function builtHelper() {
  const dir=mkdtempSync(join(tmpdir(),'rcac-windows-stdio-'));
  const exe=join(dir,'WindowsJobHost.exe');
  const result=spawnSync(compiler,['/nologo','/target:exe',`/out:${exe}`,source],
    {encoding:'utf8',timeout:30_000});
  assert.equal(result.status,0,`${result.stdout} ${result.stderr}`);
  return {exe,close:async()=>{
    for(let attempt=0;attempt<30;attempt++) {
      try {rmSync(dir,{recursive:true,force:true});return;}
      catch(error) {
        if(attempt===29) throw error;
        await new Promise(resolveValue=>setTimeout(resolveValue,100));
      }
    }
  }};
}

function canary(exe:string,recipe='stdio_fixture_v1') {
  const hostScopeId=randomUUID(); const executionInstanceId=randomUUID();
  const child=spawn(exe,[recipe,hostScopeId,executionInstanceId],{
    stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'},
  });
  const events:Array<Record<string,unknown>>=[]; let text=''; let finished=false;
  const waiters:Array<{after:number;resolve:(event:Record<string,unknown>)=>void;
    reject:(error:Error)=>void}>=[];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
    text+=chunk;
    for(;;) {
      const end=text.indexOf('\n'); if(end<0) break;
      const event=JSON.parse(text.slice(0,end)) as Record<string,unknown>;
      text=text.slice(end+1); events.push(event);
      for(const waiter of [...waiters]) if(events.length>waiter.after) {
        waiters.splice(waiters.indexOf(waiter),1); waiter.resolve(event);
      }
    }
  });
  child.on('close',()=>{
    finished=true;
    for(const waiter of waiters.splice(0)) waiter.reject(new Error('CLOSED'));
  });
  const next=(after=events.length):Promise<Record<string,unknown>>=>{
    if(events.length>after) return Promise.resolve(events[after]!);
    if(finished) return Promise.reject(new Error('CLOSED'));
    return new Promise((resolveValue,reject)=>waiters.push({after,resolve:resolveValue,reject}));
  };
  const exit=()=>new Promise<number|null>(resolveValue=>{
    if(finished) {resolveValue(child.exitCode);return;}
    child.once('close',(code:number|null)=>resolveValue(code));
  });
  return {child,events,next,exit,hostScopeId,executionInstanceId};
}

function assertFrame(event:Record<string,unknown>,kind:string,sequence:number,
  run:ReturnType<typeof canary>) {
  assert.equal(event.protocol,'windows_job_stdio_v1');
  assert.equal(event.helperVersion,'3');
  assert.equal(event.recipe,'stdio_fixture_v1');
  assert.equal(event.hostScopeId,run.hostScopeId);
  assert.equal(event.executionInstanceId,run.executionInstanceId);
  assert.equal(event.sequence,sequence);
  assert.equal(event.kind,kind);
}

test('fixed stdio fixture sends scoped readiness bytes through real inherited pipes',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=await builtHelper();
    try {
      const run=canary(built.exe);
      try {
        const started=await run.next(0);
        assertFrame(started,'started',1,run);
        assert.deepEqual(Object.keys(started).sort(),[
          'createdSuspended','executionInstanceId','helperVersion','hostScopeId',
          'jobMemberBeforeResume','kind','protocol','recipe','root','sequence',
        ]);
        assert.equal(started.createdSuspended,true);
        assert.equal(started.jobMemberBeforeResume,true);
        const root=started.root as {pid:number;creationFiletime:string};
        assert.ok(root.pid>0); assert.match(root.creationFiletime,/^[1-9][0-9]{0,19}$/);
        for(const command of ['readiness-initialize','readiness-initialized','readiness-query'])
          run.child.stdin.write(`${command}\n`);
        let stdout=Buffer.alloc(0); let stderr=Buffer.alloc(0);
        let cursor=1;
        while(!stdout.toString('utf8').includes('"status":"notConfigured"') ||
          !stderr.toString('utf8').includes('fixture')) {
          const event=await run.next(cursor); cursor++;
          assertFrame(event,event.kind as string,cursor,run);
          if(event.kind==='stdout'||event.kind==='stderr') {
            assert.deepEqual(Object.keys(event).sort(),[
              'dataBase64','executionInstanceId','helperVersion','hostScopeId','kind',
              'protocol','recipe','sequence',
            ]);
            const data=Buffer.from(event.dataBase64 as string,'base64');
            assert.equal(data.toString('base64'),event.dataBase64);
            assert.ok(data.length>0&&data.length<=4096);
            if(event.kind==='stdout') stdout=Buffer.concat([stdout,data]);
            else stderr=Buffer.concat([stderr,data]);
          }
        }
        const decoded=new TextDecoder('utf-8',{fatal:true}).decode(stdout);
        assert.match(decoded,/"id":1/);
        assert.match(decoded,/"id":2/);
        assert.match(decoded,/fixture π/);
        assert.match(stderr.toString('utf8'),/fixture/);
        run.child.stdin.write('stdin-close\n');
        run.child.stdin.write('stop\n');
        await run.exit();
        assert.equal(run.child.exitCode,0);
        assert.deepEqual(run.events.map(event=>event.sequence),
          run.events.map((_,index)=>index+1));
        assert.equal(run.events.filter(event=>event.kind==='stdout_eof').length,1);
        assert.equal(run.events.filter(event=>event.kind==='stderr_eof').length,1);
        assert.equal(run.events.filter(event=>event.kind==='root_exit').length,1);
        const terminal=run.events.at(-1)!;
        assertFrame(terminal,'job_closed',run.events.length,run);
        assert.equal(terminal.rootExited,true);
        assert.deepEqual(terminal.members,{complete:true,assigned:0,listed:0,pids:[]});
      } finally {if(run.child.exitCode===null) run.child.kill();}
    } finally {await built.close();}
  });

test('unknown and out-of-order control commands never create a normal Job closure',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=await builtHelper();
    try {
      for(const input of ['unknown\n','readiness-query\n','readiness-initialize\nreadiness-initialize\n']) {
        const run=canary(built.exe);
        try {
          await run.next(0);
          run.child.stdin.write(input);
          assert.notEqual(await run.exit(),0);
          assert.equal(run.events.some(event=>event.kind==='job_closed'),false);
        } finally {if(run.child.exitCode===null) run.child.kill();}
      }
    } finally {await built.close();}
  });

test('early stdin-close is allowed, and only explicit stop can report Job closure',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=await builtHelper();
    try {
      const run=canary(built.exe);
      try {
        await run.next(0);
        run.child.stdin.write('stdin-close\n');
        let cursor=1;
        while(!run.events.some(event=>event.kind==='root_exit')) {
          await run.next(cursor); cursor++;
        }
        assert.equal(run.events.some(event=>event.kind==='job_closed'),false);
        run.child.stdin.write('stop\n');
        assert.equal(await run.exit(),0);
        assert.equal(run.events.at(-1)?.kind,'job_closed');
      } finally {if(run.child.exitCode===null) run.child.kill();}
    } finally {await built.close();}
  });

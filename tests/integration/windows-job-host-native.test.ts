import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openWindowsJobCanary } from '../../src/adapters/codex/investigator/windows-job-host.js';

const source=resolve('native/windows/WindowsJobHost.cs');
const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const protocol='windows_job_canary_observation_v1';

interface Observation {
  protocol:string; helperVersion:string; scenario:string; hostScopeId:string;
  executionInstanceId:string; sequence:number; phase:string;
  root:{pid:number;creationFiletime:string}; createdSuspended:boolean;
  jobMemberBeforeResume:boolean; resumed:boolean; rootExited:boolean;
  members:{complete:boolean;assigned:number;listed:number;pids:number[];fixturePids:number[]};
  stopRequested:boolean; stopCallSucceeded:boolean;
}

function buildFixture():{exe:string;close:()=>Promise<void>} {
  const dir=mkdtempSync(join(tmpdir(),'rcac-windows-job-'));
  const exe=join(dir,'WindowsJobHost.exe');
  const result=spawnSync(compiler,['/nologo','/target:exe',`/out:${exe}`,source],
    {encoding:'utf8',timeout:30_000});
  if (result.status!==0) {
    rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});
    throw new Error(`NATIVE_BUILD_FAILED ${result.status}: ${result.stdout} ${result.stderr}`);
  }
  return {exe,close:async()=>{
    for(let attempt=0;attempt<30;attempt++) {
      try {rmSync(dir,{recursive:true,force:true}); return;}
      catch(error) {
        if(attempt===29) throw error;
        await new Promise(resolveValue=>setTimeout(resolveValue,100));
      }
    }
  }};
}

function runFixture(exe:string,scenario:string) {
  const hostScopeId=randomUUID(); const executionInstanceId=randomUUID();
  const child=spawn(exe,[scenario,hostScopeId,executionInstanceId],
    {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot ?? 'C:\\Windows'}});
  const observations:Observation[]=[]; const errors:string[]=[];
  const waiters:Array<{resolve:(value:Observation)=>void;reject:(error:Error)=>void;after:number}>=[];
  let buffer=''; let finished=false; let exitCode:number|null=null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;
    for (;;) {
      const newline=buffer.indexOf('\n'); if(newline<0) break;
      const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1);
      const value=JSON.parse(line) as Observation; observations.push(value);
      for (const waiter of [...waiters]) if (observations.length>waiter.after) {
        waiters.splice(waiters.indexOf(waiter),1); waiter.resolve(value);
      }
    }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data',(chunk:string)=>errors.push(chunk));
  child.on('close',(code:number|null)=>{
    finished=true; exitCode=code;
    for(const waiter of waiters.splice(0)) waiter.reject(new Error(`NATIVE_CLOSED ${code}`));
  });
  function next(after=observations.length):Promise<Observation> {
    if(observations.length>after) return Promise.resolve(observations[after]!);
    if(finished) return Promise.reject(new Error(`NATIVE_CLOSED ${exitCode}`));
    return new Promise((resolveValue,reject)=>waiters.push({resolve:resolveValue,reject,after}));
  }
  async function waitExit():Promise<number|null> {
    if(finished) return exitCode;
    return new Promise(resolveValue=>child.once('close',(code:number|null)=>resolveValue(code)));
  }
  return {child,hostScopeId,executionInstanceId,observations,errors,next,waitExit};
}

function assertObservation(o:Observation,scenario:string,hostScopeId:string,executionInstanceId:string,
  sequence:number) {
  assert.deepEqual(Object.keys(o).sort(),[
    'createdSuspended','executionInstanceId','helperVersion','hostScopeId','jobMemberBeforeResume',
    'members','phase','protocol','resumed','root','rootExited','scenario','sequence',
    'stopCallSucceeded','stopRequested',
  ]);
  assert.equal(o.protocol,protocol); assert.equal(o.helperVersion,'2');
  assert.equal(o.scenario,scenario); assert.equal(o.hostScopeId,hostScopeId);
  assert.equal(o.executionInstanceId,executionInstanceId); assert.equal(o.sequence,sequence);
  assert.equal(o.createdSuspended,true); assert.equal(o.jobMemberBeforeResume,true);
  assert.equal(o.resumed,true);
  assert.ok(Number.isInteger(o.root.pid)&&o.root.pid>0&&o.root.pid<=0xffff_ffff);
  assert.match(o.root.creationFiletime,/^[1-9][0-9]{0,19}$/);
  assert.ok(BigInt(o.root.creationFiletime)<=0xffff_ffff_ffff_ffffn);
  assert.deepEqual(Object.keys(o.members).sort(),['assigned','complete','fixturePids','listed','pids']);
  assert.equal(o.members.complete,true);
  assert.equal(o.members.listed,o.members.pids.length);
  assert.equal(new Set(o.members.pids).size,o.members.pids.length);
  for(const pid of o.members.pids) assert.ok(Number.isInteger(pid)&&pid>0&&pid<=0xffff_ffff);
  assert.equal(new Set(o.members.fixturePids).size,o.members.fixturePids.length);
  for(const pid of o.members.fixturePids) assert.ok(o.members.pids.includes(pid));
}

test('fixed native Job host proves atomic membership, descendants and complete empty stop',
  {skip:process.platform!=='win32',timeout:30_000},async()=>{
    const built=buildFixture();
    try {
      for(const scenario of ['single','tree','parent_exits']) {
        const run=runFixture(built.exe,scenario);
        try {
          const first=await run.next(0);
          assertObservation(first,scenario,run.hostScopeId,run.executionInstanceId,1);
          assert.equal(first.phase,'running'); assert.equal(first.stopRequested,false);
          assert.equal(first.stopCallSucceeded,false); assert.ok(first.members.pids.includes(first.root.pid));
          assert.ok(first.members.fixturePids.includes(first.root.pid));
          assert.ok(first.members.fixturePids.length>= (scenario==='single'?1:3));
          if(scenario==='parent_exits') {
            let previous=first; let sawParentExit=false;
            for(let i=0;i<120;i++) {
              const after=run.observations.length;
              run.child.stdin.write('observe\n');
              previous=await run.next(after);
              assertObservation(previous,scenario,run.hostScopeId,run.executionInstanceId,i+2);
              if(previous.rootExited) {
                sawParentExit=true; assert.ok(previous.members.fixturePids.length>=2);
                assert.equal(previous.members.fixturePids.includes(previous.root.pid),false);
                break;
              }
              await new Promise(resolveValue=>setTimeout(resolveValue,25));
            }
            assert.equal(sawParentExit,true,'root exit cannot imply empty Job');
          } else {
            const after=run.observations.length;
            run.child.stdin.write('observe\n');
            const observed=await run.next(after);
            assert.equal(observed.phase,'running');
            assert.ok(observed.members.fixturePids.length>= (scenario==='single'?1:3));
          }
          const beforeStop=run.observations.length;
          run.child.stdin.write('stop\n');
          const closed=await run.next(beforeStop);
          assert.equal(closed.phase,'closed'); assert.equal(closed.stopRequested,true);
          assert.equal(closed.stopCallSucceeded,true); assert.equal(closed.rootExited,true);
          assert.deepEqual(closed.members,{complete:true,assigned:0,listed:0,pids:[],fixturePids:[]});
          assert.equal(await run.waitExit(),0);
        } finally {if(run.child.exitCode===null) run.child.kill();}
      }
    } finally {await built.close();}
  });

test('unknown input and EOF exit without a normal closed observation',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=buildFixture();
    try {
      for(const input of ['unknown\n',null]) {
        const run=runFixture(built.exe,'tree');
        try {
          const first=await run.next(0);
          assert.ok(first.members.fixturePids.length>=3);
          const originalPids=first.members.fixturePids;
          if(input===null) run.child.stdin.end(); else run.child.stdin.write(input);
          assert.notEqual(await run.waitExit(),0);
          assert.equal(run.observations.some(item=>item.phase==='closed'),false);
          assert.ok(run.errors.every(item=>!item.includes(built.exe)));
          // PID absence is a local cleanup diagnostic, never a persisted tree-closure receipt.
          let alive=originalPids;
          for(let i=0;i<100;i++) {
            alive=originalPids.filter(pid=>{
              try { process.kill(pid,0); return true; } catch { return false; }
            });
            if(alive.length===0) break;
            await new Promise(resolveValue=>setTimeout(resolveValue,25));
          }
          assert.deepEqual(alive,[],'original root and descendants should exit after helper closes Job');
        } finally {if(run.child.exitCode===null) run.child.kill();}
      }
    } finally {await built.close();}
  });

test('invalid launch arguments cannot start a fixed Job scenario',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=buildFixture();
    try {
      const child=spawn(built.exe,['arbitrary',randomUUID(),randomUUID()],
        {stdio:['pipe','pipe','pipe'],windowsHide:true});
      let output=''; child.stdout.setEncoding('utf8');
      child.stdout.on('data',(chunk:string)=>{output+=chunk;});
      const code=await new Promise<number|null>(resolveValue=>child.once('close',resolveValue));
      assert.notEqual(code,0); assert.equal(output,'');
    } finally {await built.close();}
  });

test('reviewed TS runner observes and closes the real native Job channel',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=spawnSync(process.execPath,['tools/build-windows-job-helper.mjs'],
      {encoding:'utf8',timeout:30_000});
    assert.equal(built.status,0,`fixed helper build failed: ${built.stdout} ${built.stderr}`);
    const session=await openWindowsJobCanary('tree');
    assert.equal(session.initial.phase,'running');
    assert.ok(session.initial.members.fixturePids.length>=3);
    const observed=await session.observe();
    assert.equal(observed.phase,'running');
    assert.ok(observed.members.fixturePids.length>=3);
    const closed=await session.stop();
    assert.equal(closed.phase,'closed');
    assert.deepEqual(closed.members,{complete:true,assigned:0,listed:0,pids:[],fixturePids:[]});
  });

test('TS runner abort retains unknown outcome and rejects later observations',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const built=spawnSync(process.execPath,['tools/build-windows-job-helper.mjs'],
      {encoding:'utf8',timeout:30_000});
    assert.equal(built.status,0,`fixed helper build failed: ${built.stdout} ${built.stderr}`);
    const controller=new AbortController();
    const session=await openWindowsJobCanary('single',{signal:controller.signal});
    assert.equal(session.initial.phase,'running');
    controller.abort();
    await session.abort();
    await assert.rejects(session.observe(),/WINDOWS_JOB_UNKNOWN/);
    await assert.rejects(session.stop(),/WINDOWS_JOB_UNKNOWN/);
  });

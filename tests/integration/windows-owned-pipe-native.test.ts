import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, resolve, sep} from 'node:path';
import {test} from 'node:test';

const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
type Started={kind:'started';root:{pid:number;creationFiletime:string};
 writer:{helperPid:number;helperCreationFiletime:string;pipeName:string;handle:string;
 deadlineUtcTicks:string;deadlineUptimeMs:string}};

async function cleanupFixture(dir:string):Promise<void>{
  const realRoot=realpathSync.native(tmpdir());
  const realDir=realpathSync.native(dir);
  if(!realDir.startsWith(realRoot+sep)||!basename(realDir).startsWith('rcac-owned-pipe-')||
    !lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink())
    throw new Error('FIXTURE_CLEANUP_SCOPE');
  for(let attempt=0;attempt<30;attempt++){
    try{rmSync(dir,{recursive:true,force:true});return;}
    catch(error){if(attempt===29)throw error;
      await new Promise(resolveValue=>setTimeout(resolveValue,100));}
  }
}

test('fixed owned fixture writes via the original helper pipe handle and rejects a false origin',
 {skip:process.platform!=='win32',timeout:20_000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rcac-owned-pipe-'));
  const exe=join(dir,'WindowsJobHost.exe');
  let closed=false;
  let failure:unknown;
  try {
    const built=spawnSync(compiler,['/nologo','/target:exe',`/out:${exe}`,
      resolve('native/windows/WindowsJobHost.cs')],{encoding:'utf8',timeout:30_000});
    assert.equal(built.status,0,`${built.stdout} ${built.stderr}`);
    const host=randomUUID(),execution=randomUUID();
    const helper=spawn(exe,['owned_pipe_fixture_v1',host,execution],{
      stdio:['pipe','pipe','pipe'],windowsHide:true,
      env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
    let helperClosed=false;
    const closePromise=new Promise<number|null>(resolveValue=>helper.once('close',(code:number|null)=>{
      helperClosed=true;resolveValue(code);
    }));
    const boundedClose=(ms:number)=>Promise.race([closePromise.then(()=>true),
      new Promise<false>(resolveValue=>{const timer=setTimeout(()=>resolveValue(false),ms);timer.unref();})]);
    const events:Record<string,unknown>[]=[];
    let partial='';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data',(chunk:string)=>{
      partial+=chunk;
      for(let end;(end=partial.indexOf('\n'))>=0;){
        events.push(JSON.parse(partial.slice(0,end)) as Record<string,unknown>);
        partial=partial.slice(end+1);
      }
    });
    const waitEvent=async(predicate:(event:Record<string,unknown>)=>boolean)=>{
      for(let i=0;i<200;i++){
        const found=events.find(predicate);if(found)return found;
        await new Promise(resolveValue=>setTimeout(resolveValue,25));
      }
      throw new Error('EVENT_TIMEOUT');
    };
    let stderr='';helper.stderr.setEncoding('utf8');helper.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
    try {
      const started=await waitEvent(event=>event.kind==='started') as Started;
      assert.equal(started.root.pid>0,true);
      assert.match(started.writer.handle,/^[1-9][0-9]*$/);
      const args=['__write_owned_pipe',host,execution,String(started.writer.helperPid),
        started.writer.helperCreationFiletime,started.writer.pipeName,started.writer.handle,
        started.writer.deadlineUtcTicks,started.writer.deadlineUptimeMs];
      const denied=spawnSync(exe,[...args.slice(0,3),'1',...args.slice(4)],
        {encoding:'utf8',timeout:1000,input:'owned-initialize\n'});
      assert.notEqual(denied.status,0);
      assert.equal(denied.stdout,'');
      for(const changed of [[...args.slice(0,4),String(BigInt(args[4]!)+1n),...args.slice(5)],
        [...args.slice(0,6),'1',...args.slice(7)]]){
        const rejected=spawnSync(exe,changed,{encoding:'utf8',timeout:1000,
          input:'owned-initialize\n'});
        assert.notEqual(rejected.status,0);
        assert.equal(rejected.stdout,'');
      }
      for(const command of ['owned-initialize','owned-initialized','owned-query']){
        const writer=spawnSync(exe,args,{encoding:'utf8',timeout:1000,input:`${command}\n`});
        assert.equal(writer.status,0,`${writer.stdout} ${writer.stderr}; helper: ${stderr}`);
        assert.deepEqual(JSON.parse(writer.stdout),{accepted:true});
      }
      await waitEvent(event=>event.kind==='stdout' &&
        Buffer.from(String(event.dataBase64),'base64').toString().includes('notConfigured'));
      helper.stdin.write('stop\n');
      assert.equal(await boundedClose(5000),true,'HELPER_EXIT_TIMEOUT');
      const code=await closePromise;
      assert.equal(code,0);
      assert.equal(events.at(-1)?.kind,'job_closed');
      assert.equal(events.filter(event=>event.kind==='stdout_eof').length,1);
      assert.equal(events.filter(event=>event.kind==='stderr_eof').length,1);
      assert.equal(events.filter(event=>event.kind==='root_exit').length,1);
      assert.deepEqual(events.map(event=>event.sequence),events.map((_,index)=>index+1));
      assert.deepEqual(events.at(-1)?.root,started.root);
      assert.deepEqual(events.at(-1)?.members,{complete:true,assigned:0,listed:0,pids:[]});
      const afterExit=spawnSync(exe,args,{encoding:'utf8',timeout:1000,
        input:'owned-initialize\n'});
      assert.notEqual(afterExit.status,0);
      assert.equal(afterExit.stdout,'');
      closed=true;
    } finally {
      if(!helperClosed){
        if(helper.stdin.writable&&!helper.stdin.destroyed)helper.stdin.write('stop\n');
        if(!await boundedClose(5000)){
          helper.kill();
          await boundedClose(1000);
        }
      }
    }
  } catch(error) {
    failure=error;
  } finally {
    // Unknown closure keeps the synthetic fixture for inspection.
    if(closed){
      try { await cleanupFixture(dir); }
      catch(error) { failure??=error; }
    }
  }
  if(failure)throw failure;
});

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {basename,join,relative,resolve,sep} from 'node:path';
import {test} from 'node:test';

test('failed installed smoke retains its created fixture and reports its exact root',
 {skip:process.platform!=='win32'},()=>{
  const home=realpathSync.native(homedir());
  const candidates=()=>new Set(readdirSync(home,{withFileTypes:true})
   .filter(item=>item.isDirectory()&&item.name.startsWith('rcac-windows-job-installed-'))
   .map(item=>item.name));
  const before=candidates();
  const missing=join(tmpdir(),`rcac-missing-npm-${randomUUID()}.cjs`);
  assert.equal(existsSync(missing),false);
  let created:string|undefined;
  try{
   const result=spawnSync(process.execPath,['tools/windows-job-installed-smoke.mjs'],{
    cwd:resolve('.'),env:{...process.env,npm_execpath:missing},encoding:'utf8',
    windowsHide:true,timeout:30_000,maxBuffer:128*1024});
   assert.equal(result.error,undefined);
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/offline npm operation failed/);
   const retained=/^retained Windows Job smoke fixture: ([^\r\n]+)\r?$/m.exec(result.stderr);
   assert.ok(retained);
   const reported=retained[1]!;
   assert.equal(resolve(reported),reported);
   const name=basename(reported);
   assert.ok(name.startsWith('rcac-windows-job-installed-'));
   assert.equal(relative(home,reported),name);
   assert.ok(reported.startsWith(home+sep));
   const added=[...candidates()].filter(item=>!before.has(item));
   assert.deepEqual(added,[name]);
   assert.equal(join(home,name),reported);
   const stat=lstatSync(reported);
   assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
   assert.equal(realpathSync.native(reported).toLowerCase(),reported.toLowerCase());
   created=reported;
  }finally{
   if(created){
    const absolute=resolve(created),name=basename(absolute);
    assert.ok(name.startsWith('rcac-windows-job-installed-'));
    assert.equal(relative(home,absolute),name);
    assert.ok(absolute.startsWith(home+sep));
    const stat=lstatSync(absolute);
    assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
    assert.equal(realpathSync.native(absolute).toLowerCase(),absolute.toLowerCase());
    rmSync(absolute,{recursive:true,force:true});
   }
  }
 });

test('installed smoke refuses existing retained archive before packing or overwriting',
 {skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'rcac-installed-retain-test-'));
  const archive=join(root,'existing.tgz');
  writeFileSync(archive,'keep original bytes');
  try{
   const result=spawnSync(process.execPath,
    ['tools/windows-job-installed-smoke.mjs','--retain-archive',archive],{
     cwd:resolve('.'),env:{...process.env,npm_execpath:undefined},encoding:'utf8',
     windowsHide:true,timeout:10_000,maxBuffer:128*1024});
   assert.equal(result.error,undefined);
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/WINDOWS_JOB_SMOKE_RETENTION_UNSAFE/);
   assert.deepEqual(readFileSync(archive),Buffer.from('keep original bytes'));
  }finally{
   const temp=realpathSync.native(tmpdir()),absolute=resolve(root),name=basename(absolute);
   assert.ok(name.startsWith('rcac-installed-retain-test-')&&absolute.startsWith(temp+sep));
   assert.equal(relative(temp,absolute),name);
   const stat=lstatSync(absolute);
   assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
   assert.equal(realpathSync.native(absolute).toLowerCase(),absolute.toLowerCase());
   rmSync(absolute,{recursive:true,force:true});
  }
 });

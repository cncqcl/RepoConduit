import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';

for(const pending of [false,true])
test(`actual CLI ${pending?'unsettled':'completed'} command cannot report false success`,{timeout:90_000},async()=>{
 const base=process.platform==='win32'?homedir():tmpdir();
 const root=mkdtempSync(join(base,'rcac-cli-pending-'));protectNewDataDirectory(root);
 const db=new SqliteStore(join(root,'state.sqlite'));db.close();
 const main=fileURLToPath(new URL('../../src/cli/main.ts',import.meta.url));
 const dispatch=new URL('../../src/application/dispatch.js',import.meta.url).href;
 // Only business dispatch is simulated. Exercise the real CLI main entry,
 // installation owner, stdin framing, application lifecycle and process exit.
 const script=`const {DispatchService}=await import(${JSON.stringify(dispatch)});
 DispatchService.prototype.dispatch=async()=>{console.error('SYNTHETIC_DISPATCH_ENTERED');
 return ${pending?'new Promise(()=>{})':'[]'};};
 process.argv=[process.execPath,${JSON.stringify(main)},'--data-dir',${JSON.stringify(root)},'request'];
 await import(${JSON.stringify(new URL('../../src/cli/main.ts',import.meta.url).href)});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],
  {stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='',timedOut=false,verified=false;
 child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
 const timer=setTimeout(()=>{timedOut=true;child.kill();},60_000);
 try{
  child.stdin.end(JSON.stringify({operation:'collab.list',scope:{workspaceId:'synthetic'},payload:{}}));
  const end=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{
   child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  assert.equal(timedOut,false,stderr);assert.equal(end.signal,null);
  assert.match(stderr,/SYNTHETIC_DISPATCH_ENTERED/);
  if(pending){assert.equal(end.code,13,`unsettled CLI exited ${end.code}: ${stderr}`);assert.equal(stdout,'');}
  else{assert.equal(end.code,0,stderr);assert.deepEqual(JSON.parse(stdout),[]);}
  verified=true;
 }finally{
  clearTimeout(timer);
  if(verified)rmSync(root,{recursive:true,force:true});
  else console.error('retained-cli-pending-fixture',root);
 }
});

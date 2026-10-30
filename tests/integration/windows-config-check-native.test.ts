import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {test} from 'node:test';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {windowsJobHelperPath} from '../../src/adapters/codex/investigator/windows-job-host.js';
import {resolveWindowsDesktopTarget} from '../../src/adapters/codex/investigator/windows-desktop-target.js';
import {prepareWindowsInvestigatorRuntime} from
 '../../src/runtime/windows-investigation-runtime-config.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';

function verifiedCleanupRoot(root:string){
 assert.match(basename(root),/^rcac-config-native-[A-Za-z0-9]{6}$/);
 assert.equal(lstatSync(root).isSymbolicLink(),false);
 const actual=realpathSync.native(root),home=realpathSync.native(homedir());
 assert.equal(dirname(actual).toLowerCase(),home.toLowerCase());
 assert.equal(basename(actual).toLowerCase(),basename(root).toLowerCase());
}

async function closeWithin(pending:Promise<unknown>,ms:number){
 let timer:NodeJS.Timeout|undefined;
 try{await Promise.race([pending,new Promise<never>((_resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error('NATIVE_HELPER_CLOSE_UNCONFIRMED')),ms);
 })]);}finally{if(timer)clearTimeout(timer);}
}

async function cleanupNative(root:string,store:SqliteStore|undefined,
 child:ReturnType<typeof spawn>|undefined,childClosed:Promise<number|null>|undefined,preserve=false){
 let closed=true;
 try{
  if(child){
   if(child.exitCode===null&&child.signalCode===null)child.kill();
   if(childClosed)await closeWithin(childClosed,10_000);
  }
 }catch{closed=false;}
 store?.close();
 if(!closed)throw new Error('NATIVE_HELPER_CLOSE_UNCONFIRMED');
 verifiedCleanupRoot(root);
 if(preserve){process.stderr.write(`Retained strict recipe fixture: ${root}\n`);return;}
 rmSync(root,{recursive:true,force:true});
}

test('native strict recipe rejects wrong hash and holds config against write/delete until Job closure',
 {skip:process.platform!=='win32'},async()=>{
 const root=mkdtempSync(join(homedir(),'rcac-config-native-'));
 let store:SqliteStore|undefined,passed=false;
 let child:ReturnType<typeof spawn>|undefined;
 let childClosed:Promise<number|null>|undefined;
 try{
  protectNewDataDirectory(root);
  store=new SqliteStore(join(root,'state.sqlite'));
  store.insertWorkspace({id:'ws',name:'workspace',canonicalRoot:root,registeredBy:'owner'});
  store.insertGrant({id:'admin',principal:'owner',audience:'local-os',recipient:'owner',
   workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  const revision=store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:null,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:60,maxTurns:1,maxToolCalls:1}},'owner',new Date());
  const context={principal:'owner',audience:'local-os',recipient:'owner',
   surface:'local_admin' as const,now:new Date()};
  const prepared=prepareWindowsInvestigatorRuntime(root,store,context,
   {workspaceId:'ws',profileRevision:revision.id,modelRef:'gpt-6-sol'});
  const configPath=join(prepared.home,'.codex','config.toml');
  const original=readFileSync(configPath);
  const helper=windowsJobHelperPath();
  const target=resolveWindowsDesktopTarget();
  const base=['desktop_config_check_v1',randomUUID(),randomUUID(),prepared.root];
  const wrong=spawnSync(helper,[...base,'0'.repeat(64),target],{shell:false,windowsHide:true,
   env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'},
   encoding:'utf8',timeout:5000,maxBuffer:4096});
  assert.equal(wrong.status,1);
  assert.equal(wrong.stdout,'');
  assert.equal(wrong.stderr.trim(),'CONFIG_HASH');
  child=spawn(helper,[...base,prepared.configSha256,target],{shell:false,windowsHide:true,
   stdio:['pipe','pipe','pipe'],
   env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
  childClosed=new Promise<number|null>(resolve=>child!.once('close',resolve));
  const events:Record<string,unknown>[]=[];
  let buffer='';
  const started=new Promise<void>((resolve,reject)=>{
   let done=false;
   const finish=(error?:Error)=>{
    if(done)return;done=true;clearTimeout(timer);
    child!.removeListener('error',onError);child!.removeListener('close',onClose);
    if(error)reject(error);else resolve();
   };
   const onError=(error:Error)=>finish(error);
   const onClose=()=>finish(new Error('NATIVE_HELPER_CLOSED_BEFORE_STARTED'));
   const timer=setTimeout(()=>finish(new Error('NATIVE_HELPER_START_TIMEOUT')),10_000);
   child!.once('error',onError);child!.once('close',onClose);
   child!.stdout!.on('data',(chunk:Buffer)=>{
    try{
     buffer+=chunk.toString('utf8');
     let end:number;
     while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      const event=JSON.parse(line) as Record<string,unknown>;events.push(event);
      if(event.kind==='started')finish();
     }
    }catch{finish(new Error('NATIVE_HELPER_FRAME_INVALID'));}
   });
  });
  await started;
  const startedEvent=events.find(event=>event.kind==='started')!;
  assert.throws(()=>writeFileSync(configPath,'drift'));
  assert.throws(()=>unlinkSync(configPath));
  assert.deepEqual(readFileSync(configPath),original);
  child.stdin!.write('stop\n');
  await closeWithin(childClosed,10_000);
  assert.equal(child.exitCode,0);
  assert.equal(events.at(-1)?.kind,'job_closed');
  assert.deepEqual(events.at(-1)?.root,startedEvent.root);
  assert.equal(events.some(event=>event.kind==='stdout_eof'),true);
  assert.equal(events.some(event=>event.kind==='stderr_eof'),true);
  assert.equal(events.some(event=>event.kind==='root_exit'),true);
  assert.equal((events.at(-1)?.members as {assigned:number;listed:number}).assigned,0);
  assert.equal((events.at(-1)?.members as {assigned:number;listed:number}).listed,0);
  writeFileSync(configPath,'after-closure');
  assert.equal(readFileSync(configPath,'utf8'),'after-closure');
  console.log(JSON.stringify({recipe:'desktop_config_check_v1',startedRoot:startedEvent.root,
   wrongHashRejected:wrong.status===1,lockedWriteRejected:true,lockedDeleteRejected:true,
   stdoutEof:true,stderrEof:true,rootExited:true,jobAssigned:0,jobListed:0,
   helperExitCode:0,writeAfterClosure:true}));
  passed=true;
 }finally{
  await cleanupNative(root,store,child,childClosed,!passed);
 }
});

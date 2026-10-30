import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {observeWindowsPrepareOnly} from
 '../../src/adapters/codex/investigator/windows-prepare-only-observation.js';
import {windowsJobHelperPath} from '../../src/adapters/codex/investigator/windows-job-host.js';
import {resolveWindowsDesktopTarget} from '../../src/adapters/codex/investigator/windows-desktop-target.js';

function fixture(){
 const root=mkdtempSync(join(homedir(),'rcac-prepare-only-'));
 protectNewDataDirectory(root);
 for(const relative of ['runtime','runtime/home','runtime/home/.codex','runtime/AppDataLocal',
  'runtime/AppDataRoaming','runtime/temp','runtime/check','source']) mkdirSync(join(root,relative));
 writeFileSync(join(root,'runtime/home/.codex/config.toml'),'# RepoConduit prepare-only synthetic fixture\n');
 writeFileSync(join(root,'source/README.md'),'RepoConduit prepare-only synthetic source\n');
 return {root,close:()=>rmSync(root,{recursive:true,force:true}),
  retain:()=>console.log('RETAINED_PREPARE_ONLY_FIXTURE',root)};
}

test('actual production-recipe prepare-only helper closes empty Job without an AppServer child or launch qualification',
 {skip:process.platform!=='win32',timeout:45_000},async()=>{
  const f=fixture();let closed=false;try{
   const value=await observeWindowsPrepareOnly({fixtureRoot:f.root,maxWallSeconds:10});
   closed=true;
   assert.equal(value.recipe,'windows_app_server_readonly_v1');
   assert.ok(value.helper.pid>0);assert.match(value.helper.creationFiletime,/^[1-9][0-9]{0,19}$/);
   assert.deepEqual(value.prepared,{kind:'prepared',sequence:1,childPresent:false});
   assert.deepEqual(value.preparedClosed,{kind:'prepared_closed',sequence:2,childPresent:false,
    members:{complete:true,assigned:0,listed:0,pids:[]}});
   assert.equal(value.helperExitCode,0);assert.match(value.configSha256,/^[0-9a-f]{64}$/);
   for(const key of ['launchId','start','send','stop','writer','verified','root']) assert.equal(key in value,false);
   console.log('NATIVE_PREPARE_ONLY_COMPONENT',JSON.stringify(value));
  }finally{if(closed)f.close();else f.retain();}
 });

test('prepare-only fixture refuses authentication/non-synthetic configuration without launching',
 {skip:process.platform!=='win32',timeout:45_000},async()=>{
  const f=fixture();try{
   writeFileSync(join(f.root,'runtime/home/.codex/auth.json'),'synthetic forbidden auth');
   await assert.rejects(observeWindowsPrepareOnly({fixtureRoot:f.root,maxWallSeconds:5}),
    /WINDOWS_PREPARE_ONLY_UNKNOWN/);
  }finally{f.retain();}
 });

test('cancelled prepare-only execution never returns successful closure observation',
 {skip:process.platform!=='win32',timeout:45_000},async()=>{
  const f=fixture();try{
   const controller=new AbortController();
   const pending=observeWindowsPrepareOnly({fixtureRoot:f.root,maxWallSeconds:5,signal:controller.signal});
   controller.abort();
   await assert.rejects(pending,/WINDOWS_PREPARE_ONLY_UNKNOWN/);
  }finally{f.retain();}
 });

test('actual production prepare helper refuses wrong configuration hash before prepared or AppServer child creation',
 {skip:process.platform!=='win32',timeout:15_000},()=>{
  const f=fixture();let exited=false;try{
   const result=spawnSync(windowsJobHelperPath(),['windows_app_server_readonly_v1',randomUUID(),randomUUID(),
    join(f.root,'runtime'),'0'.repeat(64),join(f.root,'source'),'5',resolveWindowsDesktopTarget()],
   {shell:false,windowsHide:true,input:'stop\n',encoding:'utf8',timeout:7000,maxBuffer:4096,
    env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}});
   exited=result.error===undefined&&typeof result.status==='number';
   assert.equal(result.error,undefined);assert.notEqual(result.status,0);
   assert.equal(result.stdout,'');assert.match(result.stderr,/CONFIG_HASH/);
  }finally{if(exited)f.close();else f.retain();}
 });

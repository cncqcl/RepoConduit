import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,symlinkSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import type {RequestContext} from '../../src/core/policy/authorize.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {prepareWindowsInvestigatorRuntime,checkWindowsInvestigatorRuntime,
 checkWindowsInvestigatorRuntimeStrict,loadWindowsInvestigatorModelRuntime} from
  '../../src/runtime/windows-investigation-runtime-config.js';

function fixture(){
 const root=mkdtempSync(join(homedir(),'rcac-windows-runtime-'));
 protectNewDataDirectory(root);
 const store=new SqliteStore(join(root,'state.sqlite'));
 const context:RequestContext={principal:'owner',audience:'local-os',recipient:'owner',surface:'local_admin',now:new Date()};
 store.insertWorkspace({id:'ws',name:'workspace',canonicalRoot:root,registeredBy:'owner'});
 store.insertGrant({id:'admin',principal:'owner',audience:'local-os',recipient:'owner',
  workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
 const revision=store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:null,
  presetRef:'static_readonly_v1',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:4}},'owner',new Date());
 return {root,store,context,revision,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}

test('0.163 reuses only the exact prior logged-in configuration without rewriting identity or auth',()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  assert.equal(prepared.protocolTarget,'windows-desktop-codex-0.163.0-alpha.11');
  const metadataPath=join(prepared.root,'runtime.json'),configPath=join(prepared.home,'.codex','config.toml');
  const authPath=join(prepared.home,'.codex','auth.json'),auth=Buffer.from('synthetic credential sentinel only');
  writeFileSync(authPath,auth);
  const saved=JSON.parse(readFileSync(metadataPath,'utf8')) as {protocolTarget:string};
  saved.protocolTarget='windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2';
  writeFileSync(metadataPath,JSON.stringify(saved));
  const metadata=readFileSync(metadataPath),config=readFileSync(configPath);
  const reopened=loadWindowsInvestigatorModelRuntime(f.root,'ws',f.revision.id);
  assert.equal(reopened.runtimeId,prepared.runtimeId);assert.equal(reopened.home,prepared.home);
  assert.equal(reopened.protocolTarget,saved.protocolTarget);assert.equal(reopened.configSha256,prepared.configSha256);
  assert.deepEqual(readFileSync(metadataPath),metadata);assert.deepEqual(readFileSync(configPath),config);
  assert.deepEqual(readFileSync(authPath),auth);
  saved.protocolTarget='windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2';
  writeFileSync(metadataPath,JSON.stringify(saved));
  const previous0163=readFileSync(metadataPath);
  const reopened0163=loadWindowsInvestigatorModelRuntime(f.root,'ws',f.revision.id);
  assert.equal(reopened0163.runtimeId,prepared.runtimeId);
  assert.equal(reopened0163.protocolTarget,saved.protocolTarget);
  assert.deepEqual(readFileSync(metadataPath),previous0163);
  assert.deepEqual(readFileSync(authPath),auth);
  saved.protocolTarget='windows-desktop-26.1013.4894.0-codex-0.163.0-alpha.10.2';
  writeFileSync(metadataPath,JSON.stringify(saved));
  assert.equal(loadWindowsInvestigatorModelRuntime(f.root,'ws',f.revision.id).protocolTarget,saved.protocolTarget);
  assert.deepEqual(readFileSync(authPath),auth);
  writeFileSync(configPath,'model = "changed"\n');
  assert.throws(()=>loadWindowsInvestigatorModelRuntime(f.root,'ws',f.revision.id),/NOT_AVAILABLE/);
  writeFileSync(configPath,config);
  saved.protocolTarget='windows-desktop-any';writeFileSync(metadataPath,JSON.stringify(saved));
  assert.throws(()=>loadWindowsInvestigatorModelRuntime(f.root,'ws',f.revision.id),/NOT_AVAILABLE/);
 }finally{f.close();}
});

test('prepare creates exact private HOME/config/metadata and duplicate refuses unchanged',()=>{
 const f=fixture();try{
  const first=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  const config=readFileSync(join(first.home,'.codex','config.toml'),'utf8');
  const metadata=readFileSync(join(first.root,'runtime.json'),'utf8');
  assert.match(config,/approval_policy = "never"/);
  assert.match(config,/cli_auth_credentials_store = "file"/);
  assert.match(config,/shell_tool = false/);
  assert.equal(first.productionAvailable,false);
  assert.throws(()=>prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'}));
  assert.equal(readFileSync(join(first.root,'runtime.json'),'utf8'),metadata);
  assert.equal(readFileSync(join(first.home,'.codex','config.toml'),'utf8'),config);
  assert.match(first.runtimeId,/^[0-9a-f-]{36}$/i);
  const reopened=new SqliteStore(join(f.root,'state.sqlite'));
  let checked:ReturnType<typeof checkWindowsInvestigatorRuntime>;
  try{checked=checkWindowsInvestigatorRuntime(f.root,reopened,f.context,
   {workspaceId:'ws',runtimeId:first.runtimeId,profileRevision:f.revision.id});}
  finally{reopened.close();}
  assert.equal(checked.productionAvailable,false);
  assert.equal(checked.strictConfigVerified,false);
  assert.equal(checked.authentication,'not_verified');
  assert.equal(checked.modelTurn,'not_run');
  if(process.platform==='win32'){
   assert.equal(checked.versionMatch,true);
   assert.equal(checked.configParseObserved,true);
   assert.equal(checked.featureFlagsMatch,true);
  }
 }finally{f.close();}
});

test('check rejects changed revision, config drift and reparse without repairing',()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  const configPath=join(prepared.home,'.codex','config.toml');
  const original=readFileSync(configPath,'utf8');
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'other',runtimeId:prepared.runtimeId,profileRevision:f.revision.id}));
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:'00000000-0000-4000-8000-000000000000',profileRevision:f.revision.id}));
  const metadataPath=join(prepared.root,'runtime.json');
  const metadata=readFileSync(metadataPath,'utf8');
  writeFileSync(metadataPath,metadata.replace('windows_app_server_readonly_v1','desktop_readiness_v1'));
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id}));
  writeFileSync(metadataPath,metadata);
  writeFileSync(configPath,'model = "unsafe"\n');
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id}));
  writeFileSync(configPath,original);
  const checkPath=join(prepared.root,'check');
  const target=join(prepared.root,'check-target');renameSync(checkPath,target);
  symlinkSync(target,checkPath,'junction');
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id}));
 }finally{f.close();}
});

test('old profile revision and revoked administrator cannot check or prepare',()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  const next=f.store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:f.revision.id,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:1}},'owner',new Date());
  assert.ok(next.id);
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id}));
  assert.throws(()=>prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'}));
  f.store.revokeGrant('admin',new Date().toISOString());
  assert.throws(()=>prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:next.id,modelRef:'gpt-6-sol'}));
 }finally{f.close();}
});

test('diagnostic failure uses closed private environment and never reports qualification',()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  let observed:Record<string,string>|undefined;
  const result=checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id},command=>{
    observed=command.env;
    assert.deepEqual(command.args,['--version']);
    assert.equal(command.cwd,join(prepared.root,'check'));
    return {status:1,stdout:'untrusted diagnostic output'};
   });
  assert.deepEqual(Object.keys(observed!).sort(),['APPDATA','CODEX_HOME','HOME','LOCALAPPDATA',
   'PATH','SystemRoot','TEMP','TMP','USERPROFILE'].sort());
  assert.equal(observed!.HOME,prepared.home);
  assert.equal(observed!.CODEX_HOME,join(prepared.home,'.codex'));
  assert.equal(result.failureCause,'version');
  assert.equal(result.configParseObserved,false);
  assert.equal(result.productionAvailable,false);
  assert.equal(JSON.stringify(result).includes('untrusted diagnostic output'),false);
 }finally{f.close();}
});

test('diagnostic callback cannot outlive administrative grant or config bytes',()=>{
 for(const changed of ['grant','config'] as const){
  const f=fixture();try{
   const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
    {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
   assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
    {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id},()=>{
     if(changed==='grant') f.store.revokeGrant('admin',new Date().toISOString());
     else writeFileSync(join(prepared.home,'.codex','config.toml'),'model = "drift"\n');
     return {status:1,stdout:''};
    }));
  }finally{f.close();}
 }
});

test('expired grant with stale context time cannot start a diagnostic',()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  const db=new DatabaseSync(join(f.root,'state.sqlite'));
  try{db.prepare('UPDATE grants SET expires_at=? WHERE id=?').run('2021-01-01T00:00:00.000Z','admin');}
  finally{db.close();}
  let calls=0;
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,
   {...f.context,now:new Date('2020-01-01T00:00:00.000Z')},
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id},()=>{
    calls++;return {status:1,stdout:''};
   }));
  assert.equal(calls,0);
 }finally{f.close();}
});

test('owned Desktop strict config exchange verifies selected config without model turn',
 {skip:process.platform!=='win32'},async()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  const result=await checkWindowsInvestigatorRuntimeStrict(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id});
  assert.equal(result.versionMatch,true);
  assert.equal(result.featureFlagsMatch,true);
  assert.equal(result.strictConfigVerified,true);
  assert.equal(result.productionAvailable,false);
  assert.equal(result.isolationVerified,false);
  assert.equal(result.modelTurn,'not_run');
  assert.equal(result.authentication,'not_verified');
 }finally{f.close();}
});

test('historical runtime stays byte-identical and never executes current diagnostic; new revision creates a new slot',()=>{
 const f=fixture();try{
  const prepared=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:f.revision.id,modelRef:'gpt-6-sol'});
  const metadataPath=join(prepared.root,'runtime.json'),configPath=join(prepared.home,'.codex','config.toml');
  const saved=JSON.parse(readFileSync(metadataPath,'utf8')) as {protocolTarget:string};
  saved.protocolTarget='windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1';
  writeFileSync(metadataPath,JSON.stringify(saved));
  const metadata=readFileSync(metadataPath),config=readFileSync(configPath);let calls=0;
  assert.throws(()=>checkWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',runtimeId:prepared.runtimeId,profileRevision:f.revision.id},()=>{
    calls++;return {status:0,stdout:'codex-cli 0.160.1\n'};
   }),/NOT_AVAILABLE/);
  assert.equal(calls,0);
  const revision=f.store.insertProfileRevision({workspaceId:'ws',expectedRevisionId:f.revision.id,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:4}},'owner',new Date());
  const next=prepareWindowsInvestigatorRuntime(f.root,f.store,f.context,
   {workspaceId:'ws',profileRevision:revision.id,modelRef:'gpt-6-sol'});
  assert.notEqual(next.runtimeId,prepared.runtimeId);assert.notEqual(next.root,prepared.root);
  assert.equal(next.protocolTarget,'windows-desktop-codex-0.163.0-alpha.11');
  assert.equal(next.productionAvailable,false);
  assert.deepEqual(readFileSync(metadataPath),metadata);assert.deepEqual(readFileSync(configPath),config);
 }finally{f.close();}
});

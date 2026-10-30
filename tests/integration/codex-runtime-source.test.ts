import { privateFixtureParent } from '../support/private-fixture-parent.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {hostname,userInfo} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {acquireInstallationRuntime} from '../../src/runtime/installation.js';
import {openApplication} from '../../src/runtime/application.js';
import {PreparedWindowsFixtureSession} from '../../src/adapters/codex/investigator/windows-prepared-session.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {prepareWindowsInvestigatorRuntime,loadAuthorizedWindowsRuntimeSource}
 from '../../src/runtime/windows-investigation-runtime-config.js';
import {authorizeCodexSelection,parseCodexStartupArguments} from '../../src/cli/codex-investigation.js';
import {seedBundleProvenance} from '../support/bundle-provenance.js';
import {PassThrough} from 'node:stream';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

const principal=`${hostname()}\\${userInfo().username}`;
const identity={principal,audience:'local-os',recipient:principal};
const budget={maxWallSeconds:30,maxTurns:1,maxToolCalls:2};
const targetBudget={maxWallSeconds:180,maxTurns:1,maxToolCalls:10};

test('runtime source flags are an explicit complete local trio paired with target selection',()=>{
 const base=['--data-dir','D:/target','mcp','--codex-workspace','new-ws','--codex-profile','new-rev'];
 const source=['--codex-runtime-data-dir','D:/source','--codex-runtime-workspace','old-ws',
  '--codex-runtime-profile','old-rev'];
 assert.deepEqual(parseCodexStartupArguments([...base,...source]),{argv:base.slice(0,3),
  selection:{workspaceId:'new-ws',profileRevision:'new-rev',runtimeSource:{dataDirectory:'D:/source',
   workspaceId:'old-ws',profileRevision:'old-rev'}}});
 for(const flags of [source.slice(0,4),source.concat(source.slice(0,2)),
  ['--codex-runtime-data-dir','relative','--codex-runtime-workspace','old-ws',
   '--codex-runtime-profile','old-rev']])
  assert.throws(()=>parseCodexStartupArguments([...base,...flags]),/NOT_AVAILABLE/);
 assert.throws(()=>parseCodexStartupArguments([...base.slice(0,3),...source]),/NOT_AVAILABLE/);
 assert.throws(()=>parseCodexStartupArguments(['--data-dir','D:/target','doctor',...source]),/NOT_AVAILABLE/);
});

test('source authority revoked during prepared open prevents native start and preserves source unknown',async()=>{
 const fixtures=privateFixtureParent();
 const source=mkdtempSync(join(fixtures,'rcac-source-race-old-'));
 const target=mkdtempSync(join(fixtures,'rcac-source-race-new-'));
 protectNewDataDirectory(source);protectNewDataDirectory(target);
 const old=new SqliteStore(join(source,'state.sqlite'));
 const fresh=new SqliteStore(join(target,'state.sqlite'));
 const originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const originalAdmission=PreparedWindowsFixtureSession.assertAppServerAvailable;
 PreparedWindowsFixtureSession.assertAppServerAvailable=()=> 'C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\0123456789abcdef\\codex.exe';
 let sourceApp:ReturnType<typeof openApplication>|undefined;
 let targetApp:ReturnType<typeof openApplication>|undefined;
 try{
  const setUp=async(store:SqliteStore,root:string,workspaceId:string,profileBudget=budget)=>{
   store.insertWorkspace({id:workspaceId,name:'Synthetic',canonicalRoot:root,registeredBy:'owner'});
   store.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'Read',hostThreadId:null,state:'open'});
   store.insertGrant({id:'admin',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
   store.insertGrant({id:'request',principal:'external',audience:'mcp',recipient:'user',workspaceId,
    collaborationId:'col',permissions:['investigation.request','investigation.read','investigation.cancel'],
    expiresAt:null,revokedAt:null});
   store.insertGrant({id:'read',principal:'external',audience:'mcp',recipient:'user',workspaceId,
    collaborationId:'col',permissions:['data.read'],dataPaths:['src/provenance.ts'],
    expiresAt:null,revokedAt:null});
   return store.insertProfileRevision({workspaceId,expectedRevisionId:null,
    presetRef:'static_readonly_v1',budget:profileBudget},'owner',new Date());
  };
  const oldProfile=await setUp(old,source,'old-ws');
  const newProfile=await setUp(fresh,target,'new-ws',targetBudget);
  const runtime=prepareWindowsInvestigatorRuntime(source,old,
   {...identity,surface:'local_admin',now:new Date()},
   {workspaceId:'old-ws',profileRevision:oldProfile.id,modelRef:'gpt-6-sol'});
  const oldSeed=await seedBundleProvenance(old,join(source,'state.sqlite'),
   {workspaceId:'old-ws',collaborationId:'col',workingCopyId:'copy',root:source,revisionIds:['ctx']});
  const newSeed=await seedBundleProvenance(fresh,join(target,'state.sqlite'),
   {workspaceId:'new-ws',collaborationId:'col',workingCopyId:'copy',root:target,revisionIds:['ctx']});
  const submit=async(app:ReturnType<typeof openApplication>,workspaceId:string,snapshotRef:string)=>
   await app.dispatch.dispatch({principal:'external',audience:'mcp',recipient:'user',surface:'external_mcp',now:new Date()},
    {operation:'investigate.submit',scope:{workspaceId,collaborationId:'col'},
     idempotencyKey:'source-race-submit',payload:{workingCopyId:'copy',input:{snapshotRef,
      contextRevisionId:'ctx',question:'Read synthetic source',
      scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
      requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  PreparedWindowsFixtureSession.openAppServer=async()=>{throw new Error('OLD_UNKNOWN_OWNER');};
  sourceApp=openApplication(source,{codexInvestigator:{workspaceId:'old-ws',profileRevision:oldProfile.id}});
  await sourceApp.ready;
  const oldRequest=await submit(sourceApp,'old-ws',oldSeed.snapshotId);
  assert.equal((await sourceApp.runCodexInvestigation(oldRequest.id))?.state,'recovery_required');
  await sourceApp.close();sourceApp=undefined;
  const oldState=new SqliteInvestigationStore(join(source,'state.sqlite'));
  const unknownBefore=oldState.listUnsettled();oldState.close();
  assert.equal(unknownBefore.length,1);
  let entered!:()=>void,release!:()=>void;
  const opened=new Promise<void>(resolve=>{entered=resolve;});
  const continueOpen=new Promise<void>(resolve=>{release=resolve;});
  let starts=0,stops=0;
  PreparedWindowsFixtureSession.openAppServer=async options=>{
   assert.equal(options.runtimeRoot,runtime.root);
   assert.equal(options.maxWallSeconds,targetBudget.maxWallSeconds);
   entered();await continueOpen;
   const output=new PassThrough(),errors=new PassThrough();
   return {output,errors,async start(){starts++;throw new Error('FORBIDDEN_START');},
    send(){throw new Error('FORBIDDEN_SEND');},async stop(){stops++;output.end();errors.end();
     return {kind:'prepared_closed'};}} as unknown as PreparedWindowsFixtureSession;
  };
  targetApp=openApplication(target,{codexInvestigator:{workspaceId:'new-ws',profileRevision:newProfile.id,
   runtimeSource:{dataDirectory:source,workspaceId:'old-ws',profileRevision:oldProfile.id}}});
  await targetApp.ready;
  const request=await submit(targetApp,'new-ws',newSeed.snapshotId);
  const pending=targetApp.runCodexInvestigation(request.id);
  await opened;
  old.revokeGrant('admin',new Date().toISOString());
  release();
  const result=await pending;
  assert.equal(starts,0);assert.equal(stops,1);
  assert.equal(result?.state,'failed');assert.equal(result.failureReason,'windows_launch_not_started');
  assert.equal(result.attempts[0]?.terminationConfirmed,false);
  const freshState=new SqliteInvestigationStore(join(target,'state.sqlite'));
  assert.equal(freshState.listUnsettled().length,0);freshState.close();
  const unchanged=new SqliteInvestigationStore(join(source,'state.sqlite'));
  assert.deepEqual(unchanged.listUnsettled(),unknownBefore);
  assert.equal(unchanged.get(oldRequest.id)?.state,'recovery_required');unchanged.close();
 }finally{
  PreparedWindowsFixtureSession.openAppServer=originalOpen;
  PreparedWindowsFixtureSession.assertAppServerAvailable=originalAdmission;
  await targetApp?.close();await sourceApp?.close();old.close();fresh.close();
  rmSync(source,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});
 }
});

test('target budget is independent while source identity and both current authorities stay bound',()=>{
 const fixtures=privateFixtureParent();
 const source=mkdtempSync(join(fixtures,'rcac-runtime-source-'));
 const target=mkdtempSync(join(fixtures,'rcac-runtime-target-'));
 protectNewDataDirectory(source);protectNewDataDirectory(target);
 const sourceStore=new SqliteStore(join(source,'state.sqlite'));
 const targetStore=new SqliteStore(join(target,'state.sqlite'));
 let runtime:ReturnType<typeof acquireInstallationRuntime>|undefined;
 try{
  sourceStore.insertWorkspace({id:'old-ws',name:'Old',canonicalRoot:source,registeredBy:'owner'});
  targetStore.insertWorkspace({id:'new-ws',name:'New',canonicalRoot:target,registeredBy:'owner'});
  sourceStore.insertGrant({id:'source-admin',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  targetStore.insertGrant({id:'target-admin',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  const sourceProfile=sourceStore.insertProfileRevision({workspaceId:'old-ws',expectedRevisionId:null,
   presetRef:'static_readonly_v1',budget},'owner',new Date());
  const targetProfile=targetStore.insertProfileRevision({workspaceId:'new-ws',expectedRevisionId:null,
   presetRef:'static_readonly_v1',budget:targetBudget},'owner',new Date());
  const prepared=prepareWindowsInvestigatorRuntime(source,sourceStore,
   {...identity,surface:'local_admin',now:new Date()},
   {workspaceId:'old-ws',profileRevision:sourceProfile.id,modelRef:'gpt-6-sol'});
  const auth=join(prepared.home,'.codex','auth.json');writeFileSync(auth,'SOURCE_AUTH_SECRET');
  const sourceDbBefore=readFileSync(join(source,'state.sqlite'));
  runtime=acquireInstallationRuntime(target);
  let selected={workspaceId:'new-ws',profileRevision:targetProfile.id,
   runtimeSource:{dataDirectory:source,workspaceId:'old-ws',profileRevision:sourceProfile.id}};
  assert.deepEqual(authorizeCodexSelection(runtime,identity,selected),selected);
  assert.equal(loadAuthorizedWindowsRuntimeSource(target,
   {workspaceId:selected.workspaceId,profileRevision:selected.profileRevision},
   selected.runtimeSource,identity).runtimeId,prepared.runtimeId);
  assert.equal(readFileSync(auth,'utf8'),'SOURCE_AUTH_SECRET');
  assert.deepEqual(readFileSync(join(source,'state.sqlite')),sourceDbBefore);
  assert.throws(()=>authorizeCodexSelection(runtime!,{...identity,principal:'external'},selected));
  targetStore.revokeGrant('target-admin',new Date().toISOString());
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selected));
  targetStore.insertGrant({id:'target-admin-2',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  const revised=targetStore.insertProfileRevision({workspaceId:'new-ws',expectedRevisionId:targetProfile.id,
   presetRef:'static_readonly_v1',budget:{...targetBudget,maxWallSeconds:120}},'owner',new Date());
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selected));
  selected={...selected,profileRevision:revised.id};
  assert.deepEqual(authorizeCodexSelection(runtime!,identity,selected),selected);
  const reused=loadAuthorizedWindowsRuntimeSource(target,
   {workspaceId:selected.workspaceId,profileRevision:selected.profileRevision},selected.runtimeSource,identity);
  assert.equal(reused.runtimeId,prepared.runtimeId);assert.equal(reused.home,prepared.home);
  assert.deepEqual(readFileSync(join(source,'state.sqlite')),sourceDbBefore);
  assert.equal(readFileSync(auth,'utf8'),'SOURCE_AUTH_SECRET');
  sourceStore.revokeGrant('source-admin',new Date().toISOString());
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selected));
  sourceStore.insertGrant({id:'source-admin-2',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  sourceStore.insertProfileRevision({workspaceId:'old-ws',expectedRevisionId:sourceProfile.id,
   presetRef:'static_readonly_v1',budget},'owner',new Date());
  assert.throws(()=>authorizeCodexSelection(runtime!,identity,selected));
 }finally{runtime?.release();sourceStore.close();targetStore.close();
  rmSync(source,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});

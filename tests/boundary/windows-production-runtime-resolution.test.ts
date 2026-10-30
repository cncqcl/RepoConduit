import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,relative,resolve,win32} from 'node:path';
import {test} from 'node:test';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';
import {buildInvestigationSourcePlan} from '../../src/application/investigation-source-plan.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {prepareWindowsInvestigatorRuntime,resolveWindowsInvestigationRuntime} from
 '../../src/runtime/windows-investigation-runtime-config.js';

async function fixture(){
 const parent=homedir();
 const root=mkdtempSync(join(parent,'rcac-production-resolution-'));
 protectNewDataDirectory(root);
 const file=join(root,'state.sqlite');
 const base=new SqliteStore(file),workspaceId=`ws_${randomUUID()}`,now=new Date();
 base.insertWorkspace({id:workspaceId,name:'fixture',canonicalRoot:root,registeredBy:'owner'});
 base.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'test',hostThreadId:null,state:'open'});
 base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:root});
 base.insertGrant({id:'admin',principal:'owner',audience:'local-os',recipient:'owner',workspaceId:'management',
  permissions:['admin.profile'],expiresAt:null,revokedAt:null});
 base.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
  collaborationId:'col',permissions:['investigation.request'],expiresAt:null,revokedAt:null});
 base.insertGrant({id:'read',principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
  collaborationId:'col',permissions:['data.read'],dataPaths:['src/'],expiresAt:null,revokedAt:null});
 const revision=base.insertProfileRevision({workspaceId,expectedRevisionId:null,
  presetRef:'static_readonly_v1',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:4}},'owner',now);
 const snapshot=createSnapshotFromFiles('copy','a'.repeat(40),{'src/a.ts':Buffer.from('A\n')});
 await base.saveSnapshot({workspaceId,collaborationId:'col',workingCopyId:'copy',snapshot:snapshot.toPersisted()},
  {workspaceId,collaborationId:'col',workingCopyId:'copy',commitRef:'a'.repeat(40)},'capture','owner','local-os');
 const record:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
  principal:'external',audience:'chatgpt',recipient:'remote',grantId:'request',
  profileRef:revision.id,budgetRef:revision.id,budget:{...revision.budget},
  contextRevisionId:'ctx',snapshotRef:snapshot.id,question:'trace',
  scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},requestedOutputs:['flow'],
  parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,
  createdAt:now.toISOString()};
 const investigations=new SqliteInvestigationStore(file,{verifyIsolation:()=>true,
  verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false});
 investigations.enqueue(record,'one','one');
 let claim=investigations.claimRequest('inv',{workerId:'worker',isolationEvidence:'test-only',
  profileRevision:revision.id,permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
 const plan=buildInvestigationSourcePlan({record:investigations.get('inv')!,claim,
  snapshot:snapshot.toPersisted(),expected:{workspaceId,collaborationId:'col',workingCopyId:'copy',
   snapshotRef:snapshot.id,contextRevisionId:'ctx',recipient:'remote',requestId:'inv',
   attemptId:claim.attemptId,workerEpoch:claim.workerEpoch}});
 const descriptor={attemptId:claim.attemptId,workspaceId,workerEpoch:claim.workerEpoch,
  sourceDigest:plan.digest};
 const privateRoot='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
 claim=investigations.reserveWindowsSourceView(claim,descriptor,privateRoot,['src/a.ts'],now);
 claim=investigations.confirmWindowsSourcePrepared(claim,{viewPath:win32.join(privateRoot,
  `${claim.attemptId}.view`),sourceDigest:descriptor.sourceDigest,isolationVerified:false},now);
 const runtime=prepareWindowsInvestigatorRuntime(root,base,
  {principal:'owner',audience:'local-os',recipient:'owner',surface:'local_admin',now},
  {workspaceId,profileRevision:revision.id,modelRef:'gpt-6-sol'});
 return {root,base,investigations,claim,runtime,revision,record,now,
  close(success:boolean){
   investigations.close();base.close();
   if(!success)return; // Keep unexpected assertion failures available for diagnosis.
   assert.match(relative(resolve(parent),resolve(root)),/^rcac-production-resolution-[A-Za-z0-9_-]{6}$/);
   rmSync(root,{recursive:true,force:true});
  }};
}

test('persisted inert runtime reaches the explicit unqualified gate without consuming start',async(t)=>{
 const f=await fixture();let success=false;try{
  // This case tests qualification, not expiry during slow ACL/config preparation.
  t.mock.timers.enable({apis:['Date'],now:f.now.getTime()});
  assert.equal(f.investigations.getWindowsLaunch(f.claim),null);
  await assert.rejects(resolveWindowsInvestigationRuntime(f.root,f.base,f.investigations,
   f.claim,f.runtime.runtimeId),/WINDOWS_RUNTIME_UNQUALIFIED/);
  assert.equal(f.investigations.getWindowsLaunch(f.claim),null);
  success=true;
 }finally{f.close(success);}
});

test('caller fields cannot supply identity or forged qualification',async()=>{
 const f=await fixture();let success=false;try{
  const forged={...f.claim,cwd:'C:\\other',modelRef:'other',productionAvailable:true,
   isolationVerified:true,authentication:'verified'};
  await assert.rejects(resolveWindowsInvestigationRuntime(f.root,f.base,f.investigations,
   forged,f.runtime.runtimeId),/NOT_AVAILABLE/);
  await assert.rejects(resolveWindowsInvestigationRuntime(f.root,f.base,f.investigations,
   f.claim,randomUUID()),/NOT_AVAILABLE/);
  success=true;
 }finally{f.close(success);}
});

test('stale profile, source or claim cannot reach production gate',async()=>{
 const f=await fixture();let success=false;try{
  await assert.rejects(resolveWindowsInvestigationRuntime(f.root,f.base,f.investigations,
   {...f.claim,windowsSource:{...f.claim.windowsSource!,preparedAt:null}},f.runtime.runtimeId),/NOT_AVAILABLE/);
  await assert.rejects(resolveWindowsInvestigationRuntime(f.root,f.base,f.investigations,
   {...f.claim,workerEpoch:f.claim.workerEpoch+1},f.runtime.runtimeId),/NOT_AVAILABLE/);
  f.base.insertProfileRevision({workspaceId:f.claim.workspaceId,expectedRevisionId:f.revision.id,
   presetRef:'static_readonly_v1',budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:1}},'owner',new Date());
  await assert.rejects(resolveWindowsInvestigationRuntime(f.root,f.base,f.investigations,
   f.claim,f.runtime.runtimeId),/NOT_AVAILABLE/);
  success=true;
 }finally{f.close(success);}
});

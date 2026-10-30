import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import * as targets from '../../src/adapters/codex/investigator/windows-launch-record.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

const historical='windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' as const;
const previous='windows-desktop-26.930.3930.0-codex-0.160.0' as const;
const prior='windows-desktop-26.930.4958.0-codex-0.160.0' as const;
const lastHistorical='windows-desktop-26.930.7945.0-codex-0.160.1' as const;
const replaced='windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2' as const;
const last='windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2' as const;
const previous0163='windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2' as const;
const last0163='windows-desktop-26.1013.4894.0-codex-0.163.0-alpha.10.2' as const;
const current='windows-desktop-codex-0.163.0-alpha.11' as const;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'rcac-sdk-history-')),file=join(root,'state.sqlite');
 const base=new SqliteStore(file),now=new Date(),workspaceId=randomUUID();
 base.insertWorkspace({id:workspaceId,name:'synthetic',canonicalRoot:root,registeredBy:'owner'});
 base.insertCollaboration({id:'col',workspaceId,openedBy:'owner',purpose:'investigate',hostThreadId:null,state:'open'});
 base.insertWorkingCopy({id:'copy',workspaceId,canonicalRoot:root});
 for(const [id,permissions] of [['request',['investigation.request']],['read',['data.read']]] as const)
  base.insertGrant({id,principal:'external',audience:'chatgpt',recipient:'remote',workspaceId,
   collaborationId:'col',permissions:[...permissions],...(id==='read'?{dataPaths:['src/a.ts']}:{}),expiresAt:null,revokedAt:null});
 const record:InvestigationRecord={id:'inv',workspaceId,collaborationId:'col',workingCopyId:'copy',
  principal:'external',audience:'chatgpt',recipient:'remote',grantId:'request',profileRef:'readonly',budgetRef:'bounded',
  budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:2},contextRevisionId:'ctx',snapshotRef:'snap',question:'Trace flow',
  scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},requestedOutputs:['flow'],parentInvestigationId:null,
  state:'queued',cancelRequested:false,attempts:[],result:null,createdAt:now.toISOString()};
 let qualifications=0;
 const authority={verifyIsolation:()=>true,verifyWindowsLaunch:()=>{qualifications++;return true;},
  verifyWindowsLaunchClosure:()=>true,verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false};
 const store=new SqliteInvestigationStore(file,authority);
 store.enqueue(record,'one','one');
 const claimed=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'component fixture only',
  profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
 const privateRoot='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator',sourceDigest='a'.repeat(64);
 const descriptor={attemptId:claimed.attemptId,workspaceId,workerEpoch:claimed.workerEpoch,sourceDigest};
 const reserved=store.reserveWindowsSourceView(claimed,descriptor,privateRoot,['src/a.ts'],now);
 const claim=store.confirmWindowsSourcePrepared(reserved,{viewPath:win32.join(privateRoot,`${claimed.attemptId}.view`),
  sourceDigest,isolationVerified:false},now);
 const binding={collaborationId:'col',sourceDigest,profileRevision:'readonly',permissionEpoch:0,
  protocolTarget:targets.WINDOWS_APP_SERVER_PROTOCOL_TARGET,recipe:targets.WINDOWS_APP_SERVER_RECIPE,
  hostScopeId:randomUUID(),executionInstanceId:randomUUID(),runtimeId:randomUUID(),configSha256:'b'.repeat(64)};
 const launch=store.beginWindowsAppServerLaunch(claim,binding,now),db=new DatabaseSync(file);
 return {file,store,base,claim,binding,launch,db,now,authority,get qualifications(){return qualifications;},
  close(){db.close();store.close();base.close();rmSync(root,{recursive:true,force:true});}};
}

test('new full target and historical full/legacy records have separate execution admission',()=>{
 const f=fixture();try{
  assert.equal(targets.WINDOWS_APP_SERVER_PROTOCOL_TARGET,current);
  assert.equal(targets.WINDOWS_PREVIOUS_APP_SERVER_PROTOCOL_TARGET,previous);
  assert.equal(targets.WINDOWS_PRIOR_APP_SERVER_PROTOCOL_TARGET,prior);
  const full={...f.binding,protocolTarget:historical};
  const previousFull={...f.binding,protocolTarget:previous};
  const priorFull={...f.binding,protocolTarget:prior};
  const lastHistoricalFull={...f.binding,protocolTarget:lastHistorical};
  const replacedFull={...f.binding,protocolTarget:replaced};
  const lastFull={...f.binding,protocolTarget:last};
  const previous0163Full={...f.binding,protocolTarget:previous0163};
  const legacy=Object.fromEntries(Object.entries(full).filter(([key])=>key!=='runtimeId'&&key!=='configSha256'));
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(full),true);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(previousFull),true);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(priorFull),true);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(lastHistoricalFull),true);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(replacedFull),true);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(lastFull),true);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding(previous0163Full),true);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(previousFull),false);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(priorFull),false);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(lastHistoricalFull),false);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(replacedFull),false);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(lastFull),false);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(previous0163Full),false);
  assert.equal(targets.validActiveWindowsAppServerLaunchBinding(f.binding),true);
  assert.equal(targets.validWindowsAppServerLaunchBinding(legacy),true);
  assert.equal(targets.validWindowsAppServerLaunchBinding({...legacy,protocolTarget:current}),false);
  assert.equal(targets.validWindowsAppServerLaunchBinding({...legacy,protocolTarget:previous}),false);
  assert.equal(targets.validWindowsAppServerLaunchBinding({...legacy,protocolTarget:prior}),false);
  assert.equal(targets.validWindowsAppServerLaunchBinding({...legacy,protocolTarget:lastHistorical}),false);
  assert.equal(targets.validWindowsAppServerLaunchBinding({...legacy,protocolTarget:replaced}),false);
  assert.equal(targets.validWindowsAppServerLaunchBinding({...legacy,protocolTarget:previous0163}),false);
  assert.equal(targets.validCurrentWindowsAppServerLaunchBinding({...full,protocolTarget:'unknown'}),false);
 }finally{f.close();}
});

test('reopened historical full record refuses new start/control/usable before any qualification or emit',()=>{
 for(const oldTarget of [historical,previous,prior,lastHistorical,replaced,last,previous0163,last0163]){
 const f=fixture();try{
  const old={...f.launch,binding:{...f.binding,protocolTarget:oldTarget}};
  const bytes=JSON.stringify(old);
  f.db.prepare('UPDATE investigation_windows_app_server_launches SET record_json=? WHERE launch_id=?').run(bytes,old.launchId);
  const intent=(f.db.prepare('SELECT record_json FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
   .get(old.launchId) as {record_json:string}).record_json;
  const before=f.qualifications;let emits=0;
  const peer=new SqliteInvestigationStore(f.file,f.authority);
  try{
   assert.deepEqual(peer.getWindowsLaunch(f.claim),old);
   assert.throws(()=>peer.beginWindowsAppServerLaunch(f.claim,old.binding,f.now));
   assert.throws(()=>peer.dispatchWindowsLaunchStartOnce(f.claim,old,f.now,()=>{emits++;}));
   assert.equal(emits,0);assert.equal(f.qualifications,before);
   assert.equal((f.db.prepare('SELECT record_json FROM investigation_windows_app_server_start_intents WHERE launch_id=?')
    .get(old.launchId) as {record_json:string}).record_json,intent);
   assert.equal((f.db.prepare('SELECT record_json FROM investigation_windows_app_server_launches WHERE launch_id=?')
    .get(old.launchId) as {record_json:string}).record_json,bytes);
   const identity={pid:1234,creationFiletime:'133000000000000000',hostScopeId:old.binding.hostScopeId,
    executionInstanceId:old.binding.executionInstanceId};
   const observed=peer.recordWindowsLaunchObservation(old,identity,f.now);
   assert.throws(()=>peer.sendWindowsLaunchControl(f.claim,{...observed,binding:old.binding},f.now,()=>{emits++;}));
   assert.throws(()=>peer.assertWindowsLaunchUsable(f.claim,old.launchId,f.now));
   assert.equal(emits,0);assert.equal(f.qualifications,before);
  }finally{peer.close();}
 }finally{f.close();}}
});

test('historical full origin retains exact late closure and closure-only cleanup eligibility',()=>{
 for(const oldTarget of [historical,previous,prior,lastHistorical,replaced,last,previous0163,last0163]){
 const f=fixture();try{
  const old={...f.launch,binding:{...f.binding,protocolTarget:oldTarget}};
  f.db.prepare('UPDATE investigation_windows_app_server_launches SET record_json=? WHERE launch_id=?')
   .run(JSON.stringify(old),old.launchId);
  const identity={pid:1234,creationFiletime:'133000000000000000',hostScopeId:old.binding.hostScopeId,
   executionInstanceId:old.binding.executionInstanceId};
  f.store.recordWindowsLaunchObservation(old,identity,f.now);
  assert.throws(()=>f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',new Date(f.now.getTime()+30_001)));
  const observation:targets.WindowsAppServerClosureObservation={protocol:'windows_job_stdio_v1',helperVersion:'3',
   kind:'job_closed',recipe:targets.WINDOWS_APP_SERVER_RECIPE,launchId:old.launchId,hostScopeId:identity.hostScopeId,
   executionInstanceId:identity.executionInstanceId,root:{pid:identity.pid,creationFiletime:identity.creationFiletime},
   rootExited:true,stdoutEof:true,stderrEof:true,members:{complete:true,assigned:0,listed:0,pids:[]},helperExitCode:0,sequence:9};
  const closure=f.store.recordWindowsLaunchClosure(old,observation,f.now);
  assert.deepEqual(f.store.getWindowsLaunchClosure(f.claim),closure);
  assert.ok(f.store.acquireClosedWindowsLaunchCleanupLease(f.claim,'cleanup',new Date(f.now.getTime()+30_001)));
 }finally{f.close();}}
});

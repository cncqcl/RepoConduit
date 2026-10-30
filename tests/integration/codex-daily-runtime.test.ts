import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {ContextDecisionSqlite} from '../../src/adapters/storage/context-decisions-sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {homedir,hostname,tmpdir,userInfo} from 'node:os';
import {PassThrough} from 'node:stream';
import {PreparedWindowsFixtureSession} from '../../src/adapters/codex/investigator/windows-prepared-session.js';
import {prepareWindowsInvestigatorRuntime} from '../../src/runtime/windows-investigation-runtime-config.js';
import type {PersonalCodexInvestigatorConfiguration} from '../../src/runtime/codex-owned-investigation.js';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {acceptContext,proposeContext} from '../../src/core/collaboration/context.js';
import {openApplication} from '../../src/runtime/application.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {createCodexInvestigationQueue} from '../../src/runtime/codex-investigation-queue.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

const queued=(id:string,workspaceId:string,profile='profile'):InvestigationRecord=>({id,workspaceId,
 collaborationId:`col-${workspaceId}`,profileRef:profile,budgetRef:profile,state:'queued',
 workingCopyId:`copy-${workspaceId}`,principal:'visitor',audience:'test',recipient:'approved',grantId:'fixture',
 budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:6},snapshotRef:'fixture-snapshot',contextRevisionId:'fixture-context',
 question:'Trace fixture',scope:{paths:[],symbols:[],relatedTests:[]},requestedOutputs:['flow'],
 parentInvestigationId:null,result:null,createdAt:'2026-10-25T00:00:00.000Z',cancelRequested:false,attempts:[]});
const fixtureRoot=(prefix:string)=>mkdtempSync(join(process.platform==='win32'?homedir():tmpdir(),prefix));

test('daily queue discovers newly enabled projects on the same serial owner queue',async()=>{
 const records=[queued('a','a'),queued('b','b'),queued('attempted','b'),queued('unknown','b')];
 records[2]!.attempts=[{id:'old'} as never];records[3]!.state='recovery_required';
 const enabled=new Set(['a']);const calls:string[]=[];let active=0;
 const queue=createCodexInvestigationQueue({matches:record=>enabled.has(record.workspaceId),
  listPending:()=>records.map(record=>({requestId:record.id,workspaceId:record.workspaceId,
   collaborationId:record.collaborationId})),get:id=>records.find(record=>record.id===id)??null,
  async run(id){assert.equal(++active,1);calls.push(id);await Promise.resolve();active--;
   const record=records.find(item=>item.id===id)!;record.state='completed';return record;}});
 await queue.tick();assert.deepEqual(calls,['a']);
 enabled.add('b');await queue.tick();assert.deepEqual(calls,['a','b']);
 await queue.close();
});

test('daily queue checks current project selection again before admitting each request',async()=>{
 const records=[queued('a','a'),queued('b','b')];let revoked=false;
 const calls:string[]=[];
 const queue=createCodexInvestigationQueue({matches:record=>record.workspaceId==='a'||!revoked,
  listPending:()=>records.map(record=>({requestId:record.id,workspaceId:record.workspaceId,
   collaborationId:record.collaborationId})),get:id=>records.find(record=>record.id===id)??null,
  async run(id){calls.push(id);revoked=true;return records[0]!;}});
 await queue.tick();await queue.close();assert.deepEqual(calls,['a']);
});

test('daily application accepts an inert trusted selector without selecting a runtime on startup',async()=>{
 const root=fixtureRoot('rcac-daily-selector-');
 protectNewDataDirectory(root);let selections=0;
 new SqliteStore(join(root,'state.sqlite')).close();
 let app:ReturnType<typeof openApplication>|undefined;let passed=false;
 try{
  app=openApplication(root,{codexManaged:true,selectCodexInvestigator(){selections++;return null;}});
  await app.ready;assert.equal(selections,0);
  await app.close();app=undefined;assert.equal(selections,0);passed=true;
 }finally{await app?.close();if(passed)rmSync(root,{recursive:true,force:true});else process.stderr.write(`Preserved failed selector fixture: ${root}\n`);}
});

test('daily application rejects ambiguous static and dynamic runtime authority',async()=>{
 const root=fixtureRoot('rcac-daily-selector-conflict-');
 protectNewDataDirectory(root);
 new SqliteStore(join(root,'state.sqlite')).close();
 let app:ReturnType<typeof openApplication>|undefined;let passed=false;
 try{assert.throws(()=>{app=openApplication(root,{codexInvestigator:{workspaceId:'a',profileRevision:'p'},
  selectCodexInvestigator:()=>null});},/NOT_AVAILABLE/);passed=true;}
 finally{await app?.close();if(passed)rmSync(root,{recursive:true,force:true});else process.stderr.write(`Preserved failed conflicting selector fixture: ${root}\n`);}
});

test('daily runtime admits later projects and retains original closure owner when profile changes during prepare',
 {skip:process.platform!=='win32'?'Windows runtime owner/source fixture requires Windows':false},async()=>{
 const root=fixtureRoot('rcac-daily-owners-');
 protectNewDataDirectory(root);const file=join(root,'state.sqlite'),db=new SqliteStore(file);
 const principal=`${hostname()}\\${userInfo().username}`;
 const identity={principal,audience:'local-os',recipient:principal};
 const external={principal:'external',audience:'mcp',recipient:'user',surface:'external_mcp' as const,now:new Date()};
 const budget={maxWallSeconds:30,maxTurns:1,maxToolCalls:2};
 const choices=new Map<string,PersonalCodexInvestigatorConfiguration>();
 const profiles=new Map<string,string>(),snapshots=new Map<string,string>();
 const originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const originalAdmission=PreparedWindowsFixtureSession.assertAppServerAvailable;
 let app:ReturnType<typeof openApplication>|undefined;
 let opens=0,starts=0,stops=0,passed=false;
 try{
  db.insertGrant({id:'admin',...identity,workspaceId:'management',permissions:['admin.profile'],expiresAt:null,revokedAt:null});
  db.insertWorkspace({id:'source',name:'Source',canonicalRoot:root,registeredBy:'owner'});
  const sourceProfile=db.insertProfileRevision({workspaceId:'source',expectedRevisionId:null,
   presetRef:'static_readonly_v1',budget},'owner',new Date());
  prepareWindowsInvestigatorRuntime(root,db,{...identity,surface:'local_admin',now:new Date()},
   {workspaceId:'source',profileRevision:sourceProfile.id,modelRef:'gpt-6-sol'});
  const runtimeSource={dataDirectory:root,workspaceId:'source',profileRevision:sourceProfile.id};
  const enable=async(workspaceId:string)=>{
   const collaborationId=`col-${workspaceId}`;
   const projectRoot=join(root,`project-${workspaceId}`);mkdirSync(projectRoot);
   db.insertWorkspace({id:workspaceId,name:workspaceId,canonicalRoot:projectRoot,registeredBy:'owner'});
   db.insertCollaboration({id:collaborationId,workspaceId,openedBy:'owner',purpose:'Read',hostThreadId:null,state:'open'});
   db.insertGrant({id:`request-${workspaceId}`,principal:external.principal,audience:external.audience,
    recipient:external.recipient,workspaceId,collaborationId,
    permissions:['investigation.request','investigation.read','investigation.cancel'],expiresAt:null,revokedAt:null});
   db.insertGrant({id:`read-${workspaceId}`,principal:external.principal,audience:external.audience,
    recipient:external.recipient,workspaceId,collaborationId,permissions:['data.read'],
    dataPaths:['src/provenance.ts'],expiresAt:null,revokedAt:null});
   const profile=db.insertProfileRevision({workspaceId,expectedRevisionId:null,presetRef:'static_readonly_v1',budget},'owner',new Date());
   const workingCopyId=`copy-${workspaceId}`,contextRevisionId=`ctx-${workspaceId}`;
   db.insertWorkingCopy({id:workingCopyId,workspaceId,canonicalRoot:projectRoot});
   const snapshot=createSnapshotFromFiles(workingCopyId,'daily-owner-fixture',
    {'src/provenance.ts':Buffer.from(`export const project = '${workspaceId}';`)}).toPersisted();
   await db.saveSnapshot({workspaceId,collaborationId,workingCopyId,snapshot},
    {workspaceId,collaborationId,workingCopyId,commitRef:'daily-owner-fixture'},`capture-${workspaceId}`,'owner','local_cli');
   const contexts=new ContextDecisionSqlite(file);
   try{
    const proposal=proposeContext({id:`proposal-${workspaceId}`,workspaceId,collaborationId,parentRevisionId:null,
     snapshotId:snapshot.id,proposedBy:'owner',sourceRefs:['fixture'],content:{goal:`Investigate ${workspaceId}`,
      constraints:[],acceptedDecisions:[],rejectedDecisions:[],currentQuestions:[],evidenceRefs:[],
      expectedDeliverables:[],unknowns:[],recentChanges:[]}});
    contexts.insertProposal(proposal);
    const permit={grantId:'fixture',operation:'context.accept',effect:'state_write' as const,
     scope:{workspaceId,collaborationId},principal:'owner',recipient:'owner'};
    contexts.insertRevision(acceptContext(proposal,contextRevisionId,permit,'local_host'),permit,'local_host');
   }finally{contexts.close();}
   profiles.set(workspaceId,profile.id);snapshots.set(workspaceId,snapshot.id);
   choices.set(workspaceId,{workspaceId,profileRevision:profile.id,runtimeSource});
  };
  await enable('a');
  PreparedWindowsFixtureSession.assertAppServerAvailable=()=> 'C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\0123456789abcdef\\codex.exe';
  PreparedWindowsFixtureSession.openAppServer=async()=>{
   opens++;
   if(opens===2){
    const profile=db.insertProfileRevision({workspaceId:'b',expectedRevisionId:profiles.get('b')!,
     presetRef:'static_readonly_v1',budget:{...budget,maxTurns:2}},'owner',new Date());
    choices.set('b',{workspaceId:'b',profileRevision:profile.id,runtimeSource});
   }
   const output=new PassThrough(),errors=new PassThrough();
   return {output,errors,remainingWallMs:()=>0,
    async start(){starts++;throw new Error('FORBIDDEN_NATIVE_START');},
    send(){throw new Error('FORBIDDEN_NATIVE_SEND');},
    async stop(){stops++;output.end();errors.end();return {kind:'prepared_closed'};}} as unknown as PreparedWindowsFixtureSession;
  };
  app=openApplication(root,{selectCodexInvestigator:workspaceId=>choices.get(workspaceId)??null});
  await app.ready;
  const submit=async(workspaceId:string,key:string)=>await app!.dispatch.dispatch(external,
   {operation:'investigate.submit',scope:{workspaceId,collaborationId:`col-${workspaceId}`},idempotencyKey:key,
    payload:{workingCopyId:`copy-${workspaceId}`,input:{snapshotRef:snapshots.get(workspaceId),contextRevisionId:`ctx-${workspaceId}`,
     question:'Read synthetic evidence',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
     requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  const a=await submit('a','a');assert.equal(a.state,'queued');
  const first=await app.runCodexInvestigation(a.id);
  assert.equal(first?.state,'failed');assert.equal(first.failureReason,'windows_launch_not_started');
  // A later project is enabled without recreating the application or connection.
  await enable('b');const b=await submit('b','b');assert.equal(b.state,'queued');
  const second=await app.runCodexInvestigation(b.id);
  assert.equal(second?.state,'failed');assert.equal(second.failureReason,'windows_launch_not_started');
  assert.equal(second.attempts[0]?.terminationConfirmed,false);
  assert.equal(second.workspaceId,'b');assert.equal(second.profileRef,profiles.get('b'));
  assert.equal(starts,0);assert.equal(stops,2);assert.equal(opens,2);
  const failedAgain=await app.runCodexInvestigation(b.id);
  assert.deepEqual(failedAgain,second);assert.equal(opens,2);
  const check=new SqliteInvestigationStore(file);
  try{assert.deepEqual(check.listUnsettled(),[]);assert.deepEqual(check.listPending(),[]);}
  finally{check.close();}
  db.revokeGrant('read-a',new Date().toISOString());
  await assert.rejects(submit('a','revoked'),/NOT_AVAILABLE|Resource or operation/);
  passed=true;
 }finally{
  PreparedWindowsFixtureSession.openAppServer=originalOpen;
  PreparedWindowsFixtureSession.assertAppServerAvailable=originalAdmission;
  await app?.close();db.close();if(passed)rmSync(root,{recursive:true,force:true});else process.stderr.write(`Preserved failed owner fixture: ${root}\n`);
 }
});

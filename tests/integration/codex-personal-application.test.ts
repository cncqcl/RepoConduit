import assert from 'node:assert/strict';
import {test} from 'node:test';
import {homedir} from 'node:os';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {openApplication,openApplicationWithinInstallation} from '../../src/runtime/application.js';
import {startProductExternalHttpWithinInstallation} from '../../src/runtime/external-http.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {prepareWindowsInvestigatorRuntime,loadWindowsInvestigatorModelRuntime} from '../../src/runtime/windows-investigation-runtime-config.js';
import {PreparedWindowsFixtureSession} from '../../src/adapters/codex/investigator/windows-prepared-session.js';
import {seedBundleProvenance} from '../support/bundle-provenance.js';
import {acquireInstallationRuntime} from '../../src/runtime/installation.js';
import {runCodexInvestigationCommand} from '../../src/cli/codex-investigation.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

async function fixture(){
 const base=process.env.RCAC_TEST_FIXTURE_ROOT??homedir();
 const outer=mkdtempSync(join(base,'rcac-personal-codex-app-'));
 const root=join(outer,'data');mkdirSync(root,{mode:0o700});protectNewDataDirectory(root);
 process.stderr.write(`${JSON.stringify({stage:'personal.fixture.created',root,outer})}\n`);
 const file=join(root,'state.sqlite'),security=new SqliteStore(file);
 security.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:root,registeredBy:'owner'});
 security.insertCollaboration({id:'col',workspaceId:'ws',openedBy:'owner',purpose:'Trace',hostThreadId:null,state:'open'});
 security.insertGrant({id:'admin',principal:'owner',audience:'os',recipient:'owner',workspaceId:'management',
  permissions:['admin.profile'],expiresAt:null,revokedAt:null});
 security.insertGrant({id:'request',principal:'external',audience:'mcp',recipient:'user',workspaceId:'ws',collaborationId:'col',
  permissions:['investigation.request','investigation.read','investigation.cancel'],expiresAt:null,revokedAt:null});
 security.insertGrant({id:'read',principal:'external',audience:'mcp',recipient:'user',workspaceId:'ws',collaborationId:'col',
  permissions:['data.read'],dataPaths:['src/provenance.ts'],expiresAt:null,revokedAt:null});
 writeFileSync(join(root,'synthetic.txt'),'Synthetic fixture only');
 const {snapshotId}=await seedBundleProvenance(security,file,{workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',root,revisionIds:['ctx']});
 const profile=security.insertProfileRevision({workspaceId:'ws',expectedRevisionId:null,presetRef:'static_readonly_v1',
  budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2}},'owner',new Date());
 const runtime=prepareWindowsInvestigatorRuntime(root,security,{principal:'owner',audience:'os',recipient:'owner',surface:'local_admin',now:new Date()},
  {workspaceId:'ws',profileRevision:profile.id,modelRef:'gpt-6-sol'});
 const check=new SqliteInvestigationStore(file);
 const context={principal:'external',audience:'mcp',recipient:'user',surface:'external_mcp' as const,now:new Date()};
 return {root,security,check,context,profile,runtime,snapshotId,close(preserve=false){check.close();security.close();
  if(!preserve){assert.match(relative(resolve(base),resolve(outer)),/^rcac-personal-codex-app-[A-Za-z0-9_-]{6}$/);
   rmSync(outer,{recursive:true,force:true});}}};
}

function allowProtocolFixtureAdmission(){
 const original=PreparedWindowsFixtureSession.assertAppServerAvailable;
 PreparedWindowsFixtureSession.assertAppServerAvailable=()=> 'C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\0123456789abcdef\\codex.exe';
 return ()=>{PreparedWindowsFixtureSession.assertAppServerAvailable=original;};
}

test('unavailable Desktop selection leaves a new request queued before any owner claim',async()=>{
 const originalAdmission=PreparedWindowsFixtureSession.assertAppServerAvailable;
 PreparedWindowsFixtureSession.assertAppServerAvailable=()=>{throw new Error('NOT_AVAILABLE');};
 const f=await fixture();
 const app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
 try{
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',
   scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'missing-fixed-codex',
   payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],
    parentInvestigationId:null}}}) as InvestigationRecord;
  await assert.rejects(app.runCodexInvestigation(record.id),/NOT_AVAILABLE/);
  const current=f.check.get(record.id);
  assert.equal(current?.state,'queued');
  assert.equal(current?.attempts.length,0);
  assert.deepEqual(f.check.listUnsettled(),[]);
 }finally{PreparedWindowsFixtureSession.assertAppServerAvailable=originalAdmission;await app.close();f.close();}
});

test('wrapping native open alone cannot bypass fixed startup admission',async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer,
  originalAdmission=PreparedWindowsFixtureSession.assertAppServerAvailable;
 let opens=0;
 PreparedWindowsFixtureSession.assertAppServerAvailable=()=>{throw new Error('NOT_AVAILABLE');};
 PreparedWindowsFixtureSession.openAppServer=async options=>{
  opens++;return originalOpen.call(PreparedWindowsFixtureSession,options);
 };
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',
   scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'wrapped-open',
   payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],
    parentInvestigationId:null}}}) as InvestigationRecord;
  await assert.rejects(app.runCodexInvestigation(record.id),/NOT_AVAILABLE/);
  assert.equal(opens,0);
  assert.equal(f.check.get(record.id)?.state,'queued');
  assert.equal(f.check.get(record.id)?.attempts.length,0);
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;
  PreparedWindowsFixtureSession.assertAppServerAvailable=originalAdmission;
  try{await app?.close();}finally{f.close();}}
});

for(const mode of ['success','managed','managed-cancel','managed-shutdown','cli','unknown','cancel','revoke','tail','shutdown'] as const)
test(`personal Codex application ${mode} uses actual handler and safe terminal settlement`,{timeout:300_000},async t=>{
 const started=performance.now();
 const stage=(name:string)=>process.stderr.write(JSON.stringify({case:'personal-codex-application',mode,stage:name,
  elapsedMs:Math.round(performance.now()-started)})+'\n');
 stage('fixture_start');
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 stage('fixture_ready');
 let passed=false;
 const restoreAdmission=allowProtocolFixtureAdmission();
 const output=new PassThrough(),errors=new PassThrough();
 let starts=0,stops=0,readCount=0,request:InvestigationRecord|undefined;
 let finishHeldTurn:()=>void=()=>{};
 let notifyRead!:()=>void;const readDone=new Promise<void>(resolve=>{notifyRead=resolve;});
 const frame=(value:unknown)=>output.write(JSON.stringify(value)+'\n');
 // Only the native boundary is a protocol fixture. SQLite, snapshots, handlers and all settlement code are real.
 PreparedWindowsFixtureSession.openAppServer=async options=>{
  assert.equal(options.runtimeRoot,f.runtime.root);assert.equal(options.sourceCwd,join(f.runtime.root,'check'));
  return {output,errors,remainingWallMs(){return options.maxWallSeconds*1000;},
   async start(){starts++;return {pid:42,creationFiletime:'123'};},
   send(line:string){const value=JSON.parse(line) as {id?:number|string;method?:string;result?:{contentItems:{text:string}[]}};
    if(value.method==='initialize')setImmediate(()=>frame({id:value.id,result:{}}));
    if(value.method==='thread/start')setImmediate(()=>frame({id:value.id,result:{thread:{id:'thread',cwd:options.sourceCwd},
     cwd:options.sourceCwd,model:'gpt-6-sol',modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',
     sandbox:{type:'readOnly'},runtimeWorkspaceRoots:[],activePermissionProfile:{id:'rcac_static'}}}));
    if(value.method==='turn/start')setImmediate(()=>{
     frame({id:value.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});
     frame({id:'read',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'read-one',
      namespace:'repo',tool:'read',arguments:{path:'src/provenance.ts'}}});
    });
    if(value.method==='turn/interrupt')setImmediate(()=>frame({id:value.id,result:{}}));
    if(value.id==='read'&&value.result){
     readCount++;const page=JSON.parse(value.result.contentItems[0]!.text) as {path:string;content:string;contentHash:string;
      toolReceipt:string;byteRange:{start:number;end:number};lineRange:{start:number;end:number}};
     assert.equal(page.content,'export const fixture = true;');notifyRead();
     if(mode==='shutdown'||mode==='managed-shutdown')return true;
     const claim=f.check.listUnsettled()[0]!;
     const raw=JSON.stringify({kind:'investigation_result_v1',requestId:request!.id,attemptId:claim.attemptId,resultState:'completed',
      snapshotRef:f.snapshotId,contextRevisionId:'ctx',findings:[],evidence:[{path:page.path,symbol:null,
       lineRange:[page.lineRange.start,page.lineRange.end],byteRange:[page.byteRange.start,page.byteRange.end],
       contentHash:page.contentHash,excerpt:page.content,toolReceipt:page.toolReceipt}],
      coverage:{searchedScope:[page.path],excludedCategories:[],truncated:false,missingDependencies:[]},openQuestions:[],limitsAndWarnings:[]});
     const finishTurn=()=>{
      if(mode==='cancel'||mode==='managed-cancel')f.check.requestCancel(f.check.get(request!.id)!,'cancel','request');
      if(mode==='revoke')f.security.revokeGrant('request',new Date().toISOString());
      frame({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',
       items:[{id:'final',type:'agentMessage',phase:'final_answer',text:raw}]}}});
     };
     if(mode==='success')finishHeldTurn=finishTurn;
     else setImmediate(finishTurn);
    }
    return true;
   },async stop(){stops++;if(mode==='unknown')throw new Error('fixture missing original terminal');
    if(mode==='tail')output.write('malformed tail\n');output.end();errors.end();
    return {kind:'job_closed'};}} as unknown as PreparedWindowsFixtureSession;
 };
 const managed=mode.startsWith('managed');
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},
   ...(managed?{codexManaged:true}:{})});
  await app.ready;
  const activeApp=app;
  const submit=()=>activeApp.dispatch.dispatch(f.context,{operation:'investigate.submit',scope:{workspaceId:'ws',collaborationId:'col'},
   idempotencyKey:'submit',payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],parentInvestigationId:null}}});
  request=await submit() as InvestigationRecord;
  assert.equal((await submit() as InvestigationRecord).id,request.id);
  const successful=mode==='success'||mode==='cli'||mode==='managed';
  stage('request_queued');
  const pending=mode==='cli'?(async()=>{
   const runtime=acquireInstallationRuntime(f.root);
   try{
    const summary=await runCodexInvestigationCommand(runtime,
     {principal:'owner',audience:'os',recipient:'owner'},
     {workspaceId:'ws',profileRevision:f.profile.id,requestId:request!.id});
    assert.deepEqual(summary,{requestId:request!.id,state:'completed',hasResult:true});
    assert.deepEqual(await runCodexInvestigationCommand(runtime,
     {principal:'owner',audience:'os',recipient:'owner'},
     {workspaceId:'ws',profileRevision:f.profile.id,requestId:request!.id}),summary);
    return f.check.get(request!.id);
   }finally{runtime.release();}
  })():managed?(async()=>{
    // Native runtime validation performs synchronous Windows ACL checks. Allow
    // the 10s admission tick and preparation to finish before judging settlement.
    const deadline=performance.now()+60_000;
    while(performance.now()<deadline){
      const saved=f.check.get(request!.id);
      if(saved&&saved.state!=='queued'&&saved.state!=='running')return saved;
      await new Promise<void>(resolve=>setTimeout(resolve,100));
    }
    throw new Error('managed queue did not settle');
  })():app.runCodexInvestigation(request.id);
  const waitForRead=async()=>{
   let abort!:()=>void;
   const aborted=new Promise<never>((_resolve,reject)=>{
    abort=()=>reject(t.signal.reason instanceof Error?t.signal.reason:new Error('case aborted'));
    if(t.signal.aborted)abort();else t.signal.addEventListener('abort',abort,{once:true});
   });
   try{await Promise.race([readDone,pending,aborted]);}
   finally{t.signal.removeEventListener('abort',abort);}
  };
  if(mode!=='cli'&&!managed)assert.equal(app.runCodexInvestigation(request.id),pending);
  if(mode==='success'){
   await waitForRead();
   const visible=await app.dispatch.dispatch(f.context,{operation:'investigate.get',
    scope:{workspaceId:'ws',collaborationId:'col'},payload:{workingCopyId:'copy',requestId:request.id}}) as InvestigationRecord;
   assert.equal(visible.state,'running');
   assert.equal(visible.attempts[0]?.state,'running');
   assert.equal(visible.attempts[0]?.nativeRef,null);
   assert.equal(visible.attempts[0]?.startedAt,null);
   assert.equal(visible.result,null);
   assert.equal(f.check.listUnsettled().length,1);
   finishHeldTurn();
  }
  if(mode==='shutdown'||mode==='managed-shutdown'){
   // Observe a failed run immediately while waiting for its first read; an
   // unobserved rejection must not escape before shutdown can clean up.
   await waitForRead();await app.close();
  }
  const result=await pending;
  stage('request_settled');
  assert.equal(starts,1);assert.equal(stops,1);assert.equal(readCount,1);
  assert.equal(result?.state,successful?'completed':mode==='unknown'?'recovery_required':
    mode==='cancel'||mode==='managed-cancel'?'cancelled':'failed');
  assert.equal(!!result?.result,successful);assert.equal(f.check.listUnsettled().length,mode==='unknown'?1:0);
  if(successful){
   const disclosed=await app.dispatch.dispatch(f.context,{operation:'investigate.result',scope:{workspaceId:'ws',collaborationId:'col'},
    payload:{requestId:request.id,workingCopyId:'copy'}});
   assert.deepEqual(disclosed,result?.result);
   assert.equal((await app.runCodexInvestigation(request.id))?.state,'completed');assert.equal(starts,1);
  }
  if(mode==='unknown'){
   assert.equal((await app.runCodexInvestigation(request.id))?.state,'recovery_required');assert.equal(starts,1);
   await app.close();
   const reopened=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},
    codexManaged:true});
   try{await reopened.ready;assert.equal((await reopened.runCodexInvestigation(request.id))?.state,'recovery_required');
    assert.equal(f.check.listUnsettled().length,1);assert.equal(starts,1);}
   finally{await reopened.close();}
  }
  passed=true;
 }finally{
  let closed=false;
  try{await app?.close();closed=true;}finally{
   PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
   output.destroy();errors.destroy();
   if(!passed||!closed){
    writeFileSync(join(f.root,'failed-case.json'),JSON.stringify({mode,
     elapsedMs:Math.round(performance.now()-started),request:request?f.check.get(request.id):null},null,2)+'\n');
    process.stderr.write(`PERSONAL_CODEX_FAILED_FIXTURE ${f.root}\n`);
   }
   f.close(!passed||!closed);stage('closed');
  }
 }
});

test('configured Codex runner refuses another workspace even for a queued request before any native start',async()=>{
 const f=await fixture();
 const app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
 try{
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',scope:{workspaceId:'ws',collaborationId:'col'},
   idempotencyKey:'scope-submit',payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  const other=openApplication(f.root,{codexInvestigator:{workspaceId:'other',profileRevision:f.profile.id}});
  try{await other.ready;await assert.rejects(other.runCodexInvestigation(record.id),/NOT_AVAILABLE/);}
  finally{await other.close();}
  assert.equal(f.check.get(record.id)?.state,'queued');assert.equal(f.check.get(record.id)?.attempts.length,0);
 }finally{await app.close();f.close();}
});

test('default Codex selection stays manual and malformed managed values fail closed',async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 let starts=0;
 PreparedWindowsFixtureSession.openAppServer=async()=>{starts++;throw new Error('unexpected native start');};
 try{
  for(const codexManaged of ['true',1])assert.throws(()=>openApplication(f.root,{
   codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},codexManaged:codexManaged as never,
  }),/NOT_AVAILABLE/);
  assert.throws(()=>openApplication(f.root,{codexManaged:true}),/NOT_AVAILABLE/);
  const app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  try{
   await app.ready;
   const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',
    scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'default-off',
    payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',
     question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
     requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
   await new Promise<void>(resolve=>setTimeout(resolve,50));
   assert.equal(f.check.get(record.id)?.state,'queued');
   assert.equal(f.check.get(record.id)?.attempts.length,0);
   assert.equal(starts,0);
  }finally{await app.close();}
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();f.close();}
});

test('managed admission leaves pre-cancelled and revoked queued SQLite records unclaimed',async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 let starts=0;
 PreparedWindowsFixtureSession.openAppServer=async()=>{starts++;throw new Error('unexpected native start');};
 let managed:ReturnType<typeof openApplication>|undefined;
 try{
  const setup=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  let cancelled!:InvestigationRecord,revoked!:InvestigationRecord;
  try{
   await setup.ready;
   const submit=(key:string)=>setup.dispatch.dispatch(f.context,{operation:'investigate.submit',
    scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:key,
    payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',
     question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
     requestedOutputs:['evidence'],parentInvestigationId:null}}}) as Promise<InvestigationRecord>;
   cancelled=await submit('managed-cancel-before-admission');
   revoked=await submit('managed-revoke-before-admission');
   f.check.requestCancel(cancelled,'cancel-before-admission','request');
   f.security.revokeGrant('request',new Date().toISOString());
  }finally{await setup.close();}
  managed=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},
   codexManaged:true});
  await managed.ready;
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.check.get(cancelled.id)?.attempts.length,0);
  assert.equal(f.check.get(revoked.id)?.state,'queued');
  assert.equal(f.check.get(revoked.id)?.attempts.length,0);
  assert.equal(starts,0);
 }finally{
  PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  await managed?.close();f.close();
 }
});

test('product HTTP shutdown stops managed admission while transport verifier drains',async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 const runtime=acquireInstallationRuntime(f.root);
 let starts=0,entered!:()=>void,release!:()=>void;
 const verifying=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 PreparedWindowsFixtureSession.openAppServer=async()=>{starts++;throw new Error('unexpected native start');};
 let http:Awaited<ReturnType<typeof startProductExternalHttpWithinInstallation>>|undefined;
 try{
  http=await startProductExternalHttpWithinInstallation(runtime,{expectedAudience:'https://fixture.example/mcp',
   verifyBearer:async()=>{entered();await gate;return undefined;},
   codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},codexManaged:true});
  // Establish the verifier hold before a queued investigation exists. Otherwise
  // synchronous setup can let the managed admission tick outrun this request.
  const request=fetch(http.url,{headers:{authorization:'Bearer fixture'}}).catch(()=>undefined);
  await Promise.race([verifying,new Promise<never>((_resolve,reject)=>
   setTimeout(()=>reject(new Error('HTTP verifier did not start')),2_000))]);
  const closing=http.close();
  const setup=openApplicationWithinInstallation(runtime,{codexInvestigator:{workspaceId:'ws',
   profileRevision:f.profile.id}});
  let record:InvestigationRecord;
  try{
   await setup.ready;
   record=await setup.dispatch.dispatch(f.context,{operation:'investigate.submit',
    scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'http-managed-shutdown',
    payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',
     question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
     requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  }finally{await setup.close();}
  await new Promise<void>(resolve=>setTimeout(resolve,10_500));
  assert.equal(f.check.get(record.id)?.state,'queued');
  assert.equal(f.check.get(record.id)?.attempts.length,0);
  assert.equal(starts,0);
  release();await closing;await request;
  http=undefined;
 }finally{
  release?.();
  PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  await http?.close();runtime.release();f.close();
 }
});

test('two managed applications share one SQLite claim and close the original runner',async()=>{
 const started=performance.now();let phase='fixture';let passed=false;
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 phase='fixture-ready';
 const restoreAdmission=allowProtocolFixtureAdmission();
 const output=new PassThrough(),errors=new PassThrough();
 let starts=0,entered!:()=>void;
 const active=new Promise<void>(resolve=>{entered=resolve;});
 PreparedWindowsFixtureSession.openAppServer=async options=>({output,errors,
  remainingWallMs(){return options.maxWallSeconds*1000;},
  async start(){starts++;entered();return new Promise<never>((_resolve,reject)=>{
    options.signal!.addEventListener('abort',()=>reject(new Error('fixture aborted')),{once:true});
  });},send(){throw new Error('FORBIDDEN_SEND');},
  async stop(){output.end();errors.end();return {kind:'job_closed'};}} as unknown as PreparedWindowsFixtureSession);
 let first:ReturnType<typeof openApplication>|undefined,second:ReturnType<typeof openApplication>|undefined;
 let request!:InvestigationRecord;
 try{
  phase='setup-open';
  const setup=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  try{
   await setup.ready;
    phase='setup-ready';
   request=await setup.dispatch.dispatch(f.context,{operation:'investigate.submit',
    scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'managed-two-owners',
    payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',
     question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
     requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
   assert.equal(f.check.get(request.id)?.state,'queued');
  }finally{await setup.close();}
  phase='setup-closed';
  first=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},codexManaged:true});
  second=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},codexManaged:true});
  await Promise.all([first.ready,second.ready]);
  phase='managed-ready';
  let admissionTimer:NodeJS.Timeout|undefined;
  try{
   await Promise.race([active,new Promise<never>((_resolve,reject)=>{
    admissionTimer=setTimeout(()=>reject(new Error(`managed apps did not admit: ${JSON.stringify({phase,
     elapsedMs:Math.round(performance.now()-started),starts,
     requestState:request&&f.check.get(request.id)?.state,
     attempts:request&&f.check.get(request.id)?.attempts.length})}`)),12_000);
   })]);
  }finally{if(admissionTimer)clearTimeout(admissionTimer);}
  phase='native-entered';
  assert.equal(starts,1);
  assert.equal(f.check.get(request.id)?.attempts.length,1);
  assert.equal(f.check.listUnsettled().length,1);
  await Promise.all([first.close(),second.close()]);
  assert.equal(starts,1);
  assert.notEqual(f.check.get(request.id)?.state,'queued');
  passed=true;
 }finally{
  PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  await Promise.allSettled([first?.close(),second?.close()]);
  output.destroy();errors.destroy();
  if(!passed){
   const diagnostic={phase,elapsedMs:Math.round(performance.now()-started),starts,
    requestState:request&&f.check.get(request.id)?.state,
    attempts:request&&f.check.get(request.id)?.attempts.length};
   writeFileSync(join(f.root,'failed-case.json'),JSON.stringify(diagnostic,null,2)+'\n');
   process.stderr.write(`PERSONAL_CODEX_FAILED_FIXTURE ${f.root} ${JSON.stringify(diagnostic)}\n`);
  }
  f.close(!passed);
 }
});

test('stale queued Codex admission rechecks after snapshot before loading another runtime',async()=>{
 let stage='fixture',passed=false;
 const f=await fixture();
 try{
 stage='submit';
 let first:ReturnType<typeof openApplication>|undefined,second:ReturnType<typeof openApplication>|undefined;
 const setup=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
 let record:InvestigationRecord;
 try{
  await setup.ready;
  record=await setup.dispatch.dispatch(f.context,{operation:'investigate.submit',
   scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'stale-queued-admission',
   payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',
    question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
 }finally{await setup.close();}
 const originalSnapshot=SqliteStore.prototype.getSnapshot;
 const originalClaim=SqliteInvestigationStore.prototype.claimRequest;
 const originalAdmission=PreparedWindowsFixtureSession.assertAppServerAvailable;
 const originalOpen=PreparedWindowsFixtureSession.openAppServer;
 let arrived=0,releaseFirst!:()=>void,releaseSecond!:()=>void,notifyBoth!:()=>void,notifyClaim!:()=>void,
  notifyStart!:()=>void;
 const both=new Promise<void>(resolve=>{notifyBoth=resolve;});
 const claimed=new Promise<void>(resolve=>{notifyClaim=resolve;});
 const started=new Promise<void>(resolve=>{notifyStart=resolve;});
 const firstGate=new Promise<void>(resolve=>{releaseFirst=resolve;});
 const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve;});
 let admissionChecks=0,starts=0;
 const waitFor=async<T>(promise:Promise<T>,name:string):Promise<T>=>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{
   timer=setTimeout(()=>reject(new Error(`${name} timeout at ${stage}: ${JSON.stringify({arrived,admissionChecks,starts})}`)),30_000);
  })]);}finally{if(timer)clearTimeout(timer);}
 };
 SqliteStore.prototype.getSnapshot=async function(...args){
  const saved=await originalSnapshot.apply(this,args);
  if(args[0]===f.snapshotId){
   const position=++arrived;
   if(position===2)notifyBoth();
   if(position===1)await firstGate;
   if(position===2)await secondGate;
  }
  return saved;
 };
 SqliteInvestigationStore.prototype.claimRequest=function(...args){
  const result=originalClaim.apply(this,args);
  if(result?.requestId===record.id)notifyClaim();
  return result;
 };
 PreparedWindowsFixtureSession.assertAppServerAvailable=()=>{
  admissionChecks++;return 'C:\\Users\\fixture\\codex.exe';
 };
 PreparedWindowsFixtureSession.openAppServer=async options=>{
  const output=new PassThrough(),errors=new PassThrough();
  return {output,errors,remainingWallMs(){return options.maxWallSeconds*1000;},
  async start(){starts++;notifyStart();return new Promise<never>((_resolve,reject)=>{
   options.signal!.addEventListener('abort',()=>reject(new Error('fixture aborted')),{once:true});
  });},send(){throw new Error('FORBIDDEN_SEND');},
  async stop(){output.end();errors.end();return {kind:'job_closed'};}
  } as unknown as PreparedWindowsFixtureSession;
 };
 try{
  stage='open';
  first=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  second=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  await Promise.all([first.ready,second.ready]);
  const firstRun=first.runCodexInvestigation(record.id);
  const secondRun=second.runCodexInvestigation(record.id);
  stage='both-snapshot';await waitFor(both,'both snapshot reads');
  releaseFirst();stage='claim';await waitFor(claimed,'first claim');
  releaseSecond();
  stage='second-result';
  const secondResult=await waitFor(secondRun,'second result');
  assert.equal(admissionChecks,1);
  assert.equal(secondResult?.state,'queued');
  assert.equal(secondResult?.attempts.length,1);
  assert.equal(secondResult?.attempts[0]?.state,'claimed');
  stage='native-start';await waitFor(started,'first native start');
  assert.equal(starts,1);
  await Promise.all([first.close(),second.close()]);
  await firstRun;
  passed=true;
 }finally{
  releaseFirst();releaseSecond();
  SqliteStore.prototype.getSnapshot=originalSnapshot;
  SqliteInvestigationStore.prototype.claimRequest=originalClaim;
  PreparedWindowsFixtureSession.assertAppServerAvailable=originalAdmission;
  PreparedWindowsFixtureSession.openAppServer=originalOpen;
  await Promise.allSettled([first?.close(),second?.close()]);
 }
 }finally{
  if(!passed){
   writeFileSync(join(f.root,'admission-race-failure.json'),JSON.stringify({stage,models:0})+'\n');
   process.stderr.write(`STALE_ADMISSION_FAILED_FIXTURE ${f.root} ${stage}\n`);
  }
  f.close(!passed);
 }
});

for(const ownerTime of ['reserve-exhausted','invalid'] as const)
test(`personal Codex prepared owner ${ownerTime} closes without native start`,async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 const output=new PassThrough(),errors=new PassThrough();let starts=0,stops=0;
 PreparedWindowsFixtureSession.openAppServer=async()=>{
  const fake={output,errors,
  remainingWallMs(){return ownerTime==='invalid'?Number.NaN:9_000;},
  async start(){starts++;throw new Error('FORBIDDEN_START');},
  send(){throw new Error('FORBIDDEN_SEND');},
  async stop(){stops++;output.end();errors.end();return {kind:'prepared_closed'};}};
  return fake as unknown as PreparedWindowsFixtureSession;
 };
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  await app.ready;
  const request=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',
   scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:`prepared-${ownerTime}`,
   payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',
    question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  const result=await app.runCodexInvestigation(request.id);
  assert.equal(starts,0);assert.equal(stops,1);
  assert.equal(result?.state,'failed');assert.equal(result.failureReason,'windows_launch_not_started');
  assert.equal(result.attempts[0]?.terminationConfirmed,false);
  assert.equal(result.result,null);assert.equal(f.check.listUnsettled().length,0);
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  try{await app?.close();}finally{output.destroy();errors.destroy();f.close();}}
});

test('personal runtime loader allows official auth presence without reading it, but refuses template drift',async()=>{
 const f=await fixture();try{
  writeFileSync(join(f.runtime.home,'.codex','auth.json'),'NOT_A_REAL_CREDENTIAL');
  assert.equal(loadWindowsInvestigatorModelRuntime(f.root,'ws',f.profile.id).runtimeId,f.runtime.runtimeId);
  writeFileSync(join(f.runtime.home,'.codex','config.toml'),'approval_policy = "never"');
  assert.throws(()=>loadWindowsInvestigatorModelRuntime(f.root,'ws',f.profile.id),/NOT_AVAILABLE/);
 }finally{f.close();}
});

for(const uncertain of [false,true])test(`prepared close ${uncertain?'after uncertain start stays unknown':'before start is not process termination'}`,async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 const output=new PassThrough(),errors=new PassThrough();let starts=0,stops=0;
 let request:InvestigationRecord;
 PreparedWindowsFixtureSession.openAppServer=async options=>{
  if(!uncertain)f.check.requestCancel(f.check.get(request.id)!,'before-start','request');
  return {output,errors,remainingWallMs(){return options.maxWallSeconds*1000;},
   start(){starts++;throw new Error('unknown start write');},
   async stop(){stops++;output.end();errors.end();return {kind:'prepared_closed'};}
  } as unknown as PreparedWindowsFixtureSession;
 };
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  await app.ready;
  request=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',scope:{workspaceId:'ws',collaborationId:'col'},
   idempotencyKey:`prepared-close-${uncertain}`,payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,
    contextRevisionId:'ctx',question:'Trace',scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},
    requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  const result=await app.runCodexInvestigation(request.id);
  assert.equal(result?.state,uncertain?'recovery_required':'cancelled');
  assert.equal(result?.attempts[0]?.terminationConfirmed,false);assert.equal(result?.result,null);
  assert.equal(starts,uncertain?1:0);assert.equal(stops,1);
  assert.equal(f.check.listUnsettled().length,uncertain?1:0);
  if(!uncertain)assert.equal(result?.failureReason,'windows_launch_not_started');
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  try{await app?.close();}finally{output.destroy();errors.destroy();f.close();}}
});

test('CLI retains sanitized native-open failure and does not replay unknown owner',async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 let opens=0;
 PreparedWindowsFixtureSession.openAppServer=async()=>{opens++;throw new Error('PRIVATE_NATIVE_ERROR');};
 let app:ReturnType<typeof openApplication>|undefined;
 let runtime:ReturnType<typeof acquireInstallationRuntime>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',scope:{workspaceId:'ws',collaborationId:'col'},
   idempotencyKey:'cli-open-failure',payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  runtime=acquireInstallationRuntime(f.root);
  const args={workspaceId:'ws',profileRevision:f.profile.id,requestId:record.id};
  const summary=await runCodexInvestigationCommand(runtime,{principal:'owner',audience:'os',recipient:'owner'},args);
  assert.deepEqual(summary,{requestId:record.id,state:'recovery_required',hasResult:false,
   diagnostic:{requestId:record.id,failure:{stage:'native_open',code:'INTERNAL_ERROR'}}});
  assert.equal(JSON.stringify(summary).includes('PRIVATE_NATIVE_ERROR'),false);
  assert.equal(f.check.listUnsettled().length,1);
  const reread=await runCodexInvestigationCommand(runtime,{principal:'owner',audience:'os',recipient:'owner'},args);
  assert.deepEqual(reread,{requestId:record.id,state:'recovery_required',hasResult:false});
  assert.equal(opens,1);
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  runtime?.release();try{await app?.close();}finally{f.close();}}
});

test('actual adapter error reaches application as not-started failure without model start',async t=>{
 const started=performance.now();let verified=false,closed=false;
 const f=await fixture();
 const restoreAdmission=allowProtocolFixtureAdmission();
 const require=createRequire(import.meta.url);
 const childProcess=require('node:child_process') as typeof import('node:child_process');
 const originalSpawn=childProcess.spawn;
 let opens=0,starts=0;
 childProcess.spawn=(()=>{
  opens++;
  const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();
  input.on('data',b=>{if(b.toString().includes('start'))starts++;});
  const child=Object.assign(new EventEmitter(),{pid:4242,stdin:input,stdout:output,stderr:errors,
   kill(){throw new Error('unexpected forced kill');}});
  setImmediate(()=>{errors.end('CONFIG_HASH\r\n');output.end();setImmediate(()=>child.emit('close',1,null));});
  return child;
 }) as unknown as typeof childProcess.spawn;
 syncBuiltinESMExports();
 const diagnostics:unknown[]=[];
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},
   onCodexDiagnostic(value){diagnostics.push(value);}});
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',scope:{workspaceId:'ws',collaborationId:'col'},
   idempotencyKey:'not-started-app',payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  const result=await app.runCodexInvestigation(record.id);
  t.diagnostic(JSON.stringify({phase:'not-started-adapter-result',
   elapsedMs:Math.round(performance.now()-started),diagnostics,state:result?.state,
   unsettled:f.check.listUnsettled()}));
  assert.equal(result?.state,'failed');assert.equal(result?.failureReason,'windows_launch_not_started');
  assert.equal(result?.attempts[0]?.terminationConfirmed,false);assert.equal(result?.result,null);
  assert.equal(f.check.listUnsettled().length,0);assert.equal(opens,1);assert.equal(starts,0);
  assert.equal((diagnostics[0] as {preparedFailure?:{helperStage:string}})?.preparedFailure?.helperStage,'CONFIG_HASH');
  assert.equal((await app.runCodexInvestigation(record.id))?.state,'failed');assert.equal(opens,1);
  verified=true;
 }finally{
  try{await app?.close();closed=true;}finally{
   childProcess.spawn=originalSpawn;syncBuiltinESMExports();restoreAdmission();
   if(!verified||!closed)t.diagnostic(`retained-not-started-adapter-fixture ${f.root}`);
   f.close(!verified||!closed);
  }
 }
});

for(const stage of ['prepare','start'] as const)
test(`application cancellation during owned ${stage} propagates abort without model sends`,async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 const restoreAdmission=allowProtocolFixtureAdmission();
 const output=new PassThrough(),errors=new PassThrough();let sends=0,stops=0;
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 PreparedWindowsFixtureSession.openAppServer=async options=>{
  const delayed=()=>new Promise<never>((_resolve,reject)=>{
   options.signal!.addEventListener('abort',()=>reject(new Error('fixture aborted')),{once:true});entered();
  });
  if(stage==='prepare')return delayed();
  return {output,errors,remainingWallMs(){return options.maxWallSeconds*1000;},
   start:delayed,send(){sends++;return true;},async stop(){stops++;output.end();errors.end();return {kind:'job_closed'};}} as
   unknown as PreparedWindowsFixtureSession;
 };
 const diagnostics:unknown[]=[];
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id},
   onCodexDiagnostic(value){diagnostics.push(value);throw new Error('diagnostic sink failed');}});
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',scope:{workspaceId:'ws',collaborationId:'col'},
   idempotencyKey:'delay-submit',payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],parentInvestigationId:null}}}) as InvestigationRecord;
  const pending=app.runCodexInvestigation(record.id);await waiting;
  f.check.requestCancel(f.check.get(record.id)!,'cancel-delayed','request');
  const start=Date.now();const result=await pending;
  assert.deepEqual(diagnostics,[{requestId:record.id,failure:{
   stage:stage==='prepare'?'native_open':'native_start',code:'INTERNAL_ERROR'}}]);
  assert.ok(Date.now()-start<2000);assert.equal(sends,0);
  assert.equal(result?.state,stage==='prepare'?'recovery_required':'cancelled');
  assert.equal(stops,stage==='prepare'?0:1);
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  try{await app?.close();}finally{f.close();}}
});

test('owned prepare retains its claim across the first lease and still stops on external revocation',
 {timeout:180_000},async()=>{
 const f=await fixture(),originalOpen=PreparedWindowsFixtureSession.openAppServer;
 process.stderr.write(JSON.stringify({case:'owned-prepare-lease',stage:'fixture.created',root:f.root})+'\n');
 let completed=false;
 const restoreAdmission=allowProtocolFixtureAdmission();
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 PreparedWindowsFixtureSession.openAppServer=async options=>new Promise<never>((_resolve,reject)=>{
  options.signal!.addEventListener('abort',()=>reject(new Error('fixture aborted')),{once:true});
  entered();
 });
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(f.root,{codexInvestigator:{workspaceId:'ws',profileRevision:f.profile.id}});
  await app.ready;
  const record=await app.dispatch.dispatch(f.context,{operation:'investigate.submit',
   scope:{workspaceId:'ws',collaborationId:'col'},idempotencyKey:'slow-prepare',
   payload:{workingCopyId:'copy',input:{snapshotRef:f.snapshotId,contextRevisionId:'ctx',question:'Trace',
    scope:{paths:['src/provenance.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],
    parentInvestigationId:null}}}) as InvestigationRecord;
  const pending=app.runCodexInvestigation(record.id);void pending.catch(()=>{});
  await Promise.race([waiting,pending.then(result=>{throw new Error(`prepare never entered: ${result?.state}`);}),
   new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error(
    `prepare wait timed out: ${f.check.get(record.id)?.state}`)),3000))]);
  // Compress only this synthetic claim's first 30-second lease to six seconds.
  // The real monitor runs, and a peer recovery pass must still see this owner at seven seconds.
  const db=new DatabaseSync(join(f.root,'state.sqlite'));
  try{assert.equal(db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?')
   .run(new Date(Date.now()+6000).toISOString(),record.id).changes,1);}finally{db.close();}
  const epoch=f.security.permissionEpoch('external','mcp','ws');
  f.security.insertGrant({id:'unrelated-local',principal:'owner',audience:'os',recipient:'owner',
   workspaceId:'ws',permissions:['data.read'],dataPaths:['src/provenance.ts'],expiresAt:null,revokedAt:null});
  f.security.revokeGrant('unrelated-local',new Date().toISOString());
  assert.equal(f.security.permissionEpoch('external','mcp','ws'),epoch);
  await new Promise<void>(resolve=>setTimeout(resolve,7000));
  const peer=new SqliteInvestigationStore(join(f.root,'state.sqlite'));
  try{peer.recoverCodexOwnedSessions(new Date());}finally{peer.close();}
  assert.equal(f.check.get(record.id)?.state,'queued');
  assert.equal(f.check.listUnsettled().length,1);
  f.security.revokeGrant('request',new Date().toISOString());
  const result=await pending;
  assert.equal(result?.state,'recovery_required');
  assert.equal(result?.result,null);
  assert.equal(f.check.listUnsettled().length,1);
  completed=true;
 }finally{PreparedWindowsFixtureSession.openAppServer=originalOpen;restoreAdmission();
  let closed=false;try{await app?.close();closed=true;}finally{f.close(!completed||!closed);}}
});

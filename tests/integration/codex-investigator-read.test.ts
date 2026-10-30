import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {RepositoryApplication} from '../../src/application/repository.js';
import {DispatchService} from '../../src/application/dispatch.js';
import {authorize} from '../../src/core/policy/authorize.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';
import {createCodexInvestigatorReadCapability} from '../../src/runtime/codex-investigator-read.js';
import {CodexJsonlTransport} from '../../src/adapters/codex/protocol/stdio.js';
import {runCodexModelInvestigation,WINDOWS_CODEX_PROTOCOL_TARGET} from '../../src/runtime/codex-model-investigation.js';
import type {ContextRevision} from '../../src/core/collaboration/context.js';

async function fixture(maxToolCalls=2,nativeReady=true) {
 const dir=mkdtempSync(join(tmpdir(),'rcac-codex-read-route-')),file=join(dir,'state.sqlite');
 const now=new Date(),base=new SqliteStore(file);
 base.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:dir,registeredBy:'owner'});
 base.insertCollaboration({id:'col',workspaceId:'ws',openedBy:'owner',purpose:'read',hostThreadId:null,state:'open'});
 base.insertWorkingCopy({id:'copy',workspaceId:'ws',canonicalRoot:dir});
 const snapshot=createSnapshotFromFiles('copy','synthetic',{'src/a.ts':Buffer.from('SYNTHETIC_READ\n')});
 await base.saveSnapshot({workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',snapshot:snapshot.toPersisted()},
  {workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',commitRef:'synthetic'},'capture','owner','local_cli');
 for(const grant of [{id:'request',principal:'external',audience:'chatgpt',recipient:'user',permissions:['investigation.request']},
  {id:'read',principal:'external',audience:'chatgpt',recipient:'user',permissions:['data.read'],dataPaths:['src/a.ts']},
  {id:'worker-read',principal:'worker',audience:'investigator',recipient:'codex-local',permissions:['data.read'],dataPaths:['src/a.ts']}])
  base.insertGrant({...grant,workspaceId:'ws',collaborationId:'col',revokedAt:null,
   expiresAt:grant.id==='worker-read'?new Date(now.getTime()+60_000).toISOString():null});
 const store=new SqliteInvestigationStore(file,{verifyIsolation:()=>true,verifyNativeReceipt:()=>false,verifyOutcomeReceipt:()=>false});
 const record:InvestigationRecord={id:'inv',workspaceId:'ws',collaborationId:'col',workingCopyId:'copy',
  principal:'external',audience:'chatgpt',recipient:'user',grantId:'request',profileRef:'synthetic-profile',
  budgetRef:'budget',budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls},contextRevisionId:'ctx',snapshotRef:snapshot.id,
  question:'Trace',scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},requestedOutputs:['flow'],
  parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,createdAt:now.toISOString()};
 store.enqueue(record,'submit','fingerprint');
 const claim=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'synthetic',profileRevision:'synthetic-profile',
  permissionEpoch:0,launchProtocol:'resource_reservation_v1',now})!;
 const binding={collaborationId:'col',workingCopyId:'copy',snapshotId:snapshot.id,paths:['src/a.ts'],
  workerGrantId:'worker-read',workerAudience:'investigator',workerRecipient:'codex-local'};
 if(nativeReady){
  store.prepareCodexReadSession(claim,binding,new Date(now.getTime()+60_000),now);
  store.beginNativeThreadIntent(claim,'col',now); store.observeNativeThread(claim,'col','thread');
  store.beginNativeTurnIntent(claim,'col','intent','thread',now); store.observeNativeTurn(claim,'col','intent','turn');
 }
 let afterDispatch:()=>void=()=>undefined;
 const repository=new RepositoryApplication({
  authorize:async({context,operation,workspaceId,collaborationId})=>{
   await context.assertFreshAuthority?.();
   return authorize({...context,now:new Date()},operation,{workspaceId,collaborationId},base.grantsFor(context.principal,context.audience));
  },getWorkingCopy:(ws,copy)=>base.getWorkingCopy(ws,copy),
  collaborationBelongsToWorkspace:(ws,col)=>base.collaborationBelongsToWorkspace(ws,col),
  lookupCapture:(input,key,p,a)=>base.lookupCapture(input,key,p,a),
  saveSnapshot:(value,input,key,p,a)=>base.saveSnapshot(value,input,key,p,a),
  getSnapshot:(id,ws,col)=>base.getSnapshot(id,ws,col),
 });
 const real=new DispatchService(base,undefined,undefined,{repository});
 const dispatcher={async dispatch(...args:Parameters<DispatchService['dispatch']>){
  const result=await real.dispatch(...args);afterDispatch();return result;
 }};
 const capability=createCodexInvestigatorReadCapability({store,claim,binding,dispatcher});
 const call=(callId='call',args:unknown={path:'src/a.ts'})=>({threadId:'thread',turnId:'turn',callId,arguments:args});
 return {store,base,claim,binding,call,capability,snapshot,dispatcher,dir,
  turn:{threadId:'thread',turnId:'turn',intentId:'intent'},
  after(callback:()=>void){afterDispatch=callback;},close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('fixed Codex read uses real application handler and durable receipt without a process nativeRef',async()=>{
 const f=await fixture();try{
  let text='';await f.capability.read(f.call(),response=>{assert.equal(response.success,true);text=response.contentItems[0]!.text;});
  const result=JSON.parse(text) as {content:string;toolReceipt:string};
  assert.equal(result.content,'SYNTHETIC_READ\n');
  const receipts=f.store.getSucceededCodexReadReceipts(f.claim,f.turn);
  assert.equal(receipts.length,1);assert.equal(receipts[0]?.id,result.toolReceipt);
  assert.equal(receipts[0]?.callId,'call');assert.equal('nativeRef' in receipts[0]!,false);
  assert.equal(f.store.get('inv')?.result,null);
 }finally{f.close();}
});

test('Codex read rejects foreign scope and duplicate calls; new calls consume the persistent budget',async()=>{
 const f=await fixture(1);try{
  for(const args of [{path:'src/other.ts'},{path:'src/a.ts',snapshotId:'other'},{path:'../secret'},
   {path:'src/a.ts',maxBytes:9000},{path:'src/a.ts',maxLines:0}])
   await assert.rejects(f.capability.read(f.call('invalid',args),()=>assert.fail('must not emit')));
  await f.capability.read(f.call(),()=>undefined);
  await assert.rejects(f.capability.read(f.call(),()=>assert.fail('duplicate')));
  await assert.rejects(f.capability.read(f.call('next'),()=>assert.fail('budget exhausted')));
  assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,1);
 }finally{f.close();}
});

test('transport argument errors spend no read reservation; correction uses the real remaining budget',async()=>{
 const f=await fixture(1),input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();
 const frames:Record<string,unknown>[]=[],cwd='C:\\synthetic',profileId='investigator';
 let callbacks=0,terminated=false;
 const transport=new CodexJsonlTransport({input,output,errors,exited:new EventEmitter(),
  terminate(){terminated=true;}},{maxFrameBytes:8192,maxTotalBytes:65536,maxNotifications:100,requestTimeoutMs:1000},
 WINDOWS_CODEX_PROTOCOL_TARGET);
 input.on('data',chunk=>frames.push(JSON.parse(String(chunk)) as Record<string,unknown>));
 transport.installRepoReadCapability({async read(call,emit){callbacks++;await f.capability.read(call,emit);}});
 const send=(frame:unknown)=>output.write(JSON.stringify(frame)+'\n');
 const reply=(result:unknown)=>send({id:frames.at(-1)!.id,result});
 const tool=async(id:string,args:unknown)=>{
  send({id,method:'item/tool/call',params:{...f.call(id,args),namespace:'repo',tool:'read'}});
  for(let i=0;i<100&&!frames.some(frame=>frame.id===id);i++)await new Promise<void>(resolve=>setImmediate(resolve));
  const frame=frames.find(frame=>frame.id===id);assert(frame,'tool reply missing');return frame.result as {success:boolean};
 };
 try{
  const init=transport.initialize();reply({});await init;
  const thread=transport.startRestrictedThread({cwd,profileId,model:'gpt-6-sol'});
  reply({thread:{id:'thread',cwd},cwd,model:'gpt-6-sol',modelProvider:'openai',approvalPolicy:'never',
   approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:[],
   activePermissionProfile:{id:profileId}});await thread;
  const turn=transport.startRestrictedTurn({threadId:'thread',profileId,text:'Inspect.'});
  reply({turn:{id:'turn',status:'inProgress',items:[]}});await turn;
  assert.equal((await tool('invalid',{path:'src/a.ts',maxBytes:20000,maxLines:500})).success,false);
  assert.equal(callbacks,0);assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,0);
  assert.equal((await tool('corrected',{path:'src/a.ts'})).success,true);
  assert.equal(callbacks,1);assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,1);
  assert.equal((await tool('budget-exhausted',{path:'src/a.ts'})).success,false);
  assert.equal(callbacks,2);assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,1);
  assert.equal(terminated,false);
 }finally{transport.close();f.close();}
});

test('worker revocation after handler response prevents native disclosure while preserving consumed receipt',async()=>{
 const f=await fixture();try{
  f.after(()=>f.base.revokeGrant('worker-read',new Date().toISOString()));
  await assert.rejects(f.capability.read(f.call(),()=>assert.fail('revoked body must not emit')));
  assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,1);
 }finally{f.close();}
});

test('work time exhausted while repo read is in flight cannot disclose a successful response',async()=>{
 const f=await fixture();let ownerLeft=60_000,emitted=false;
 try{
  const capability=createCodexInvestigatorReadCapability({...f,
   assertWorkFresh:()=>{if(ownerLeft<=10_000)throw new Error('NOT_AVAILABLE');}});
  f.after(()=>{ownerLeft=10_000;});
  await assert.rejects(capability.read(f.call(),()=>{emitted=true;}));
  assert.equal(emitted,false);
  assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,f.turn).length,1);
 }finally{f.close();}
});

test('work time exhausted inside durable disclosure callback cannot emit success',async()=>{
 const f=await fixture();let ownerLeft=60_000,emitted=false;
 const guardedStore=new Proxy(f.store,{get(target,key,receiver){
  if(key==='discloseCodexRead')return (...args:Parameters<typeof target.discloseCodexRead>)=>{
   ownerLeft=10_000;return target.discloseCodexRead(...args);
  };
  const value:unknown=Reflect.get(target,key,receiver);
  return typeof value==='function'?value.bind(target):value;
 }});
 try{
  const capability=createCodexInvestigatorReadCapability({store:guardedStore,claim:f.claim,
   binding:f.binding,dispatcher:f.dispatcher,
   assertWorkFresh:()=>{if(ownerLeft<=10_000)throw new Error('NOT_AVAILABLE');}});
  await assert.rejects(capability.read(f.call(),()=>{emitted=true;}));
  assert.equal(emitted,false);
 }finally{f.close();}
});

for(const mode of ['valid','retry','retry-revoked','forged','worker-revoked','corked'] as const)
test(`coordinator actual handler ${mode} preserves disclosure authority without publishing`,async()=>{
 const forged=mode==='forged';
 const f=await fixture(2,false);
 const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough(),exited=new EventEmitter();
 type Frame={id?:number|string;method?:string;params?:Record<string,unknown>;result?:Record<string,unknown>};
 const frames:Frame[]=[];let terminated=0;
 input.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')) frames.push(JSON.parse(line) as Frame);});
 const wait=async(predicate:(frame:Frame)=>boolean)=>{
  for(let i=0;i<100;i++){const frame=frames.find(predicate);if(frame)return frame;
   await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.fail('Expected protocol frame');
 };
 const reply=(frame:Frame,result:unknown)=>output.write(JSON.stringify({id:frame.id,result})+'\n');
 const contextRevision:ContextRevision={kind:'revision',id:'ctx',workspaceId:'ws',collaborationId:'col',
  parentRevisionId:null,snapshotId:f.snapshot.id,sourceProposalId:'proposal',sourceRefs:['synthetic'],
  content:{goal:'Trace',constraints:[],acceptedDecisions:[],rejectedDecisions:[],currentQuestions:[],
   evidenceRefs:[],expectedDeliverables:[],unknowns:[],recentChanges:[]},acceptedBy:'owner'};
 let pending:ReturnType<typeof runCodexModelInvestigation>|undefined;
 try{
  pending=runCodexModelInvestigation({store:f.store,claim:f.claim,contextRevision,snapshot:f.snapshot,
   connection:{input,output,errors,exited,terminate(){terminated++;}},
   runtime:{protocolTarget:WINDOWS_CODEX_PROTOCOL_TARGET,cwd:f.dir,profileId:'investigator',model:'gpt-6-sol'},
   read:{binding:f.binding,dispatcher:f.dispatcher}});
  reply(await wait(frame=>frame.method==='initialize'),{});
  const start=await wait(frame=>frame.method==='thread/start');
  assert.equal((start.params?.dynamicTools as {name:string}[])[0]?.name,'repo');
  reply(start,{thread:{id:'thread',cwd:f.dir},cwd:f.dir,model:'gpt-6-sol',modelProvider:'openai',
   approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly'},
   runtimeWorkspaceRoots:[],activePermissionProfile:{id:'investigator'}});
  const turn=await wait(frame=>frame.method==='turn/start');
  let handlerReturned=false;
  if(mode==='worker-revoked') f.after(()=>{handlerReturned=true;
    f.base.revokeGrant('worker-read',new Date().toISOString());});
  if(mode==='corked') f.after(()=>{handlerReturned=true;input.cork();});
  output.write(JSON.stringify({id:'server-read',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',
   callId:'native-read',namespace:'repo',tool:'read',arguments:{path:'src/a.ts'}}})+'\n');
  assert.equal(frames.some(frame=>frame.id==='server-read'),false);
  reply(turn,{turn:{id:'turn',status:'inProgress',items:[]}});
  if(mode==='worker-revoked'||mode==='corked') {
    for(let i=0;i<100&&!handlerReturned;i++)
      await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(handlerReturned,true);
    await new Promise<void>(resolve=>setImmediate(resolve));
    output.emit('error',new Error('controlled stop'));
    const observation=await pending;
    input.uncork();
    assert.equal(frames.some(frame=>frame.id==='server-read'),false);
    assert.equal(observation.candidate,null);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(terminated,1);
    return;
  }
  const readFrame=await wait(frame=>frame.id==='server-read');
  assert.equal(readFrame.result?.success,true);
  const boundTurn={...f.turn,intentId:f.store.getNativeJournal(f.claim,'col')!.turns[0]!.intentId};
  if(mode==='retry'||mode==='retry-revoked') {
    output.write(JSON.stringify({method:'error',params:{threadId:'thread',turnId:'turn',willRetry:true,
      error:{message:'private transient',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}}})+'\n');
    assert.equal(frames.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,boundTurn).length,1);
  }
  if(mode==='retry-revoked') {
    f.base.revokeGrant('worker-read',new Date().toISOString());
    output.write(JSON.stringify({id:'server-after-revocation',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',
      callId:'native-read-after-revocation',namespace:'repo',tool:'read',arguments:{path:'src/a.ts'}}})+'\n');
    assert.equal((await pending).candidate,null);
    assert.equal(frames.some(frame=>frame.id==='server-after-revocation'&&frame.result?.success===true),false);
    assert.equal(f.store.getSucceededCodexReadReceipts(f.claim,boundTurn).length,1);
    assert.equal(f.store.get('inv')?.result,null);return;
  }
  const page=JSON.parse((readFrame.result?.contentItems as {text:string}[])[0]!.text) as {
   path:string;content:string;contentHash:string;toolReceipt:string;byteRange:{start:number;end:number};
   lineRange:{start:number;end:number}};
  const raw=JSON.stringify({kind:'investigation_result_v1',requestId:'inv',attemptId:f.claim.attemptId,
   resultState:'completed',snapshotRef:f.snapshot.id,contextRevisionId:'ctx',findings:[],evidence:[{
    path:page.path,symbol:null,lineRange:[page.lineRange.start,page.lineRange.end],
    byteRange:[page.byteRange.start,page.byteRange.end],contentHash:page.contentHash,excerpt:page.content,
    toolReceipt:forged?'invented-receipt':page.toolReceipt}],coverage:{searchedScope:[page.path],
    excludedCategories:[],truncated:false,missingDependencies:[]},openQuestions:[],limitsAndWarnings:[]});
  output.write(JSON.stringify({method:'item/completed',params:{threadId:'thread',turnId:'turn',
   completedAtMs:1,item:{type:'agentMessage',id:'result',phase:'final_answer',text:raw}}})+'\n');
  output.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',
   status:'completed',items:[]}}})+'\n');
  const observation=await pending;
  assert.equal(observation.candidate?.evidenceStatus??null,forged?null:'receipt_verified');
  assert.equal(observation.terminalStatus,'completed');assert.equal(f.store.get('inv')?.result,null);
  assert.equal(f.store.get('inv')?.state,'recovery_required');assert.equal(terminated,0);
 }finally{
  output.emit('error',new Error('controlled fixture cleanup'));
  await pending?.catch(()=>undefined);input.uncork();f.close();input.destroy();output.destroy();errors.destroy();
 }
});

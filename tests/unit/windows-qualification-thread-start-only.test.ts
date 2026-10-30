import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FixedQualificationThreadStartOnly} from '../../tools/windows-qualification-turn-protocol.ts';
import {advanceThreadOnlyOutbound,captureThreadStartFailureFrame,decodeThreadOnlyRpcFrame,
 nextThreadStartFrame,ThreadStartFrameAssociation,threadStartCaptureOrStop,
 writeThreadStartPrivateError,writeThreadStartFailureFrame} from '../../tools/windows-qualification-preflight.ts';

const owner={hostScopeId:'scope',executionInstanceId:'instance',helperPid:41,
 helperCreationFiletime:'133000000000000000'};
const cwd='D:\\synthetic\\check';
const threadId='thread_1';
const response={id:6,result:{thread:{id:threadId,cwd},cwd,model:'gpt-6-sol',
 modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',
 sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:[],
 activePermissionProfile:{id:'rcac_static'}}};
const began=()=>{const trial=new FixedQualificationThreadStartOnly(owner,cwd);
 assert.equal(trial.start().method,'thread/start');return trial;};
const rejects=(run:()=>unknown)=>assert.throws(run,/QUALIFICATION_THREAD_START_PROTOCOL/);

test('single fixed thread request accepts only same owner and full policy projection',()=>{
 const trial=began();rejects(()=>trial.start());
 const accepted=began();assert.equal(accepted.accept(response,owner),'accepted');
 assert.equal(accepted.summary().status,'accepted');
 rejects(()=>accepted.accept(response,owner));
 const wrong=began();rejects(()=>wrong.accept(response,{...owner,helperPid:42}));
 for(const altered of [
  {...response,result:{...response.result,activePermissionProfile:{id:'other'}}},
  {...response,result:{...response.result,sandbox:{type:'workspaceWrite'}}},
  {...response,result:{...response.result,cwd:'D:\\other'}}]){
  const check=began();rejects(()=>check.accept(altered,owner));
 }
});

test('thread lifecycle before or after response must have original id; unknown early status refuses',()=>{
 const early=began();early.accept({method:'thread/started',params:{thread:{id:threadId,cwd}}},owner);
 early.accept({method:'thread/status/changed',params:{threadId,status:{type:'active',activeFlags:[]}}},owner);
 assert.equal(early.accept(response,owner),'accepted');
 const late=began();late.accept(response,owner);
 late.accept({method:'thread/started',params:{thread:{id:threadId,cwd}}},owner);
 const mismatch=began();mismatch.accept({method:'thread/started',params:{thread:{id:'other',cwd}}},owner);
 rejects(()=>mismatch.accept(response,owner));
 const unknown=began();rejects(()=>unknown.accept({method:'thread/status/changed',
  params:{threadId,status:{type:'active',activeFlags:[]}}},owner));
});

test('server refusal, timeout and forbidden RPC stay distinct with no second send',()=>{
 const rejected=began();assert.equal(rejected.accept({id:6,error:{code:-32000,message:'private server detail'}},owner),'rejected');
 assert.equal(JSON.stringify(rejected.summary()).includes('private server detail'),false);
 assert.equal(rejected.privateErrorMessage(),'private server detail');
 const capped=began();rejects(()=>capped.accept({id:6,error:{code:-32000,message:'界'.repeat(2000)}},owner));
 assert.equal(capped.privateErrorMessage(),null);
 const malformed=began();rejects(()=>malformed.accept({id:6,error:{code:'bad',message:'bad'}},owner));
 assert.equal(malformed.summary().status,'unknown');
 for(const data of [null,'private-data-sentinel',['array-sentinel'],42,true]){
  const withData=began();assert.equal(withData.accept({id:6,error:{code:-32000,
   message:'private server detail',data}},owner),'rejected');
  assert.equal(JSON.stringify(withData.summary()).includes('sentinel'),false);
 }
 const secret=began();secret.accept({id:6,error:{code:-32000,message:'private-sentinel'}},owner);
 assert.equal(JSON.stringify(secret.summary()).includes('private-sentinel'),false);
 const timeout=began();timeout.markUnknown();assert.equal(timeout.summary().status,'unknown');
 rejects(()=>timeout.start());rejects(()=>timeout.accept(response,owner));
 for(const forbidden of [
  {id:7,result:{}},{method:'turn/started',params:{}},
  {id:'ask',method:'item/tool/call',params:{}},
  {id:'approve',method:'item/commandExecution/requestApproval',params:{}}]){
  const trial=began();rejects(()=>trial.accept(forbidden,owner));
 }
});

test('actual outbound gate permits fixed sequence once and denies RPC after stop',()=>{
 let count=0;
 for(const [method,id] of [['initialize',1],['initialized',undefined],['config/read',2],
  ['windowsSandbox/readiness',3],['thread/start',6]] as const)
  count=advanceThreadOnlyOutbound({method,...(id===undefined?{}:{id})},count,false);
 assert.equal(count,5);
 assert.throws(()=>advanceThreadOnlyOutbound({id:6,method:'thread/start'},count,false),
  /QUALIFICATION_THREAD_START_PROTOCOL/);
 assert.throws(()=>advanceThreadOnlyOutbound({id:7,method:'turn/start'},0,false),
  /QUALIFICATION_THREAD_START_PROTOCOL/);
 assert.throws(()=>advanceThreadOnlyOutbound({id:1,method:'initialize'},0,true),
  /QUALIFICATION_THREAD_START_PROTOCOL/);
});

test('private error capture failure uses fixed stop reason',()=>{
 let reason='';
 assert.equal(threadStartCaptureOrStop(()=>{throw Error('private-sentinel');},code=>{reason=code;}),false);
 assert.equal(reason,'thread_error_capture_failed');
 assert.equal(threadStartCaptureOrStop(()=>{},()=>{throw Error('unexpected');}),true);
});

test('private error writer creates absent file with wx before verifying created file',()=>{
 const root=mkdtempSync(join(tmpdir(),'rcac-thread-unit-'));
 const file=join(root,'thread-start-error.private.json');
 const observed:string[]=[];
 try{
  assert.equal(existsSync(file),false);
  writeThreadStartPrivateError(root,{recipe:'windows_app_server_readonly_v1',
   hostScopeId:'scope',executionInstanceId:'instance'},'private-sentinel',(directory,created)=>{
   assert.equal(directory,root);observed.push(created?'file':'directory');
   assert.equal(existsSync(file),!!created);
  });
  assert.deepEqual(observed,['directory','file']);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).message,'private-sentinel');
  assert.throws(()=>writeThreadStartPrivateError(root,{recipe:'windows_app_server_readonly_v1',
   hostScopeId:'scope',executionInstanceId:'instance'},'second',()=>{}));
 }finally{if(existsSync(file))unlinkSync(file);rmdirSync(root);}
});

test('thread rejection reports only fixed reason categories',()=>{
 const wrong=began();rejects(()=>wrong.accept(response,{...owner,helperPid:42}));
 assert.equal(wrong.summary().failureReason,'wrong_owner');
 const method=began();rejects(()=>method.accept({method:'turn/started',params:{}},owner));
 assert.equal(method.summary().failureReason,'unexpected_method');
 const projection=began();rejects(()=>projection.accept({...response,
  result:{...response.result,model:'other'}},owner));
 assert.equal(projection.summary().failureReason,'result_projection');
 const envelope=began();rejects(()=>envelope.accept({id:6,error:{code:'bad',message:'secret'}},owner));
 assert.equal(envelope.summary().failureReason,'error_envelope');
});

test('first complete frame private capture is bounded, wx and public projection hides sentinel',()=>{
 const root=mkdtempSync(join(tmpdir(),'rcac-thread-frame-'));
 const file=join(root,'thread-start-failure-frame.private.json');
 const frame=Buffer.from('{"id":6,"secret":"private-sentinel"}');
 try{
  const projection=writeThreadStartFailureFrame(root,{recipe:'windows_app_server_readonly_v1',
   hostScopeId:'scope',executionInstanceId:'instance'},
   {frame,complete:true,nativeSequence:9,rpcOrdinal:4,outboundCount:5,
    preFailureState:'pending',stopSent:false,reason:'result_projection'},()=>{});
  assert.equal(projection.captured,true);
  assert.equal(projection.complete,true);
  assert.equal(projection.truncated,false);
  assert.equal(JSON.stringify(projection).includes('private-sentinel'),false);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).frameBase64,frame.toString('base64'));
  assert.throws(()=>writeThreadStartFailureFrame(root,{recipe:'windows_app_server_readonly_v1',
   hostScopeId:'scope',executionInstanceId:'instance'},
   {frame:Buffer.from('later'),complete:true,nativeSequence:10,rpcOrdinal:5,outboundCount:5,
    preFailureState:'unknown',stopSent:true,reason:'unexpected_method'},()=>{}));
  assert.equal(JSON.parse(readFileSync(file,'utf8')).rpcOrdinal,4);
 }finally{if(existsSync(file))unlinkSync(file);rmdirSync(root);}
});

test('complete frame above 4 KiB retains its full bounded bytes and hash',()=>{
 const root=mkdtempSync(join(tmpdir(),'rcac-thread-frame-'));
 const file=join(root,'thread-start-failure-frame.private.json');
 const frame=Buffer.alloc(12_000,65);
 try{
  const projection=writeThreadStartFailureFrame(root,{recipe:'windows_app_server_readonly_v1',
   hostScopeId:'scope',executionInstanceId:'instance'},
   {frame,complete:true,nativeSequence:9,rpcOrdinal:4,outboundCount:5,
    preFailureState:'pending',stopSent:true,reason:'result_projection'},()=>{});
  assert.equal(projection.complete,true);assert.equal(projection.truncated,false);
  assert.equal(projection.capturedBytes,frame.length);
  assert.deepEqual(Buffer.from(JSON.parse(readFileSync(file,'utf8')).frameBase64,'base64'),frame);
 }finally{if(existsSync(file))unlinkSync(file);rmdirSync(root);}
});

test('oversized incomplete frame reports observed bytes and bounded prefix accurately',()=>{
 const root=mkdtempSync(join(tmpdir(),'rcac-thread-frame-'));
 const file=join(root,'thread-start-failure-frame.private.json');
 try{
  const projection=writeThreadStartFailureFrame(root,{recipe:'windows_app_server_readonly_v1',
   hostScopeId:'scope',executionInstanceId:'instance'},
   {frame:Buffer.alloc(128*1024,65),observedBytes:128*1024+1,complete:false,nativeSequence:9,rpcOrdinal:4,
    outboundCount:5,preFailureState:'pending',stopSent:false,reason:'json'},()=>{});
  assert.equal(projection.observedBytes,128*1024+1);
  assert.equal(projection.capturedBytes,128*1024);
  assert.equal(projection.complete,false);
  assert.equal(projection.truncated,true);
  assert.equal(Buffer.from(JSON.parse(readFileSync(file,'utf8')).frameBase64,'base64').length,128*1024);
 }finally{if(existsSync(file))unlinkSync(file);rmdirSync(root);}
});

test('actual thread-only frame decoder distinguishes invalid UTF-8 from invalid JSON without echoing bytes',()=>{
 assert.deepEqual(decodeThreadOnlyRpcFrame(Buffer.from('{"id":6}')),{id:6});
 for(const [bytes,code] of [[Buffer.from([0xff]),'thread_frame_utf8'],
  [Buffer.from('{"secret":"private-sentinel"'),'thread_frame_json']] as const){
  assert.throws(()=>decodeThreadOnlyRpcFrame(bytes),(error:unknown)=>
   error instanceof Error&&error.message===code&&!error.message.includes('private-sentinel'));
 }
});

test('failed private frame capture is a separate fixed flag and never echoes secret',()=>{
 const result=captureThreadStartFailureFrame('D:\\synthetic',{recipe:'windows_app_server_readonly_v1',
  hostScopeId:'scope',executionInstanceId:'instance'},
  {frame:Buffer.from('private-sentinel'),complete:true,nativeSequence:9,rpcOrdinal:4,
   outboundCount:5,preFailureState:'pending',stopSent:true,reason:'unexpected_method'},
  ()=>{throw Error('private-sentinel');});
 assert.deepEqual(result,{projection:null,captureFailed:true});
 assert.equal(JSON.stringify(result).includes('private-sentinel'),false);
});

test('thread-only JSONL framing bounds each payload rather than aggregate bytes',()=>{
 const exact=Buffer.alloc(128*1024,65);
 const one=nextThreadStartFrame(Buffer.concat([exact,Buffer.from('\n')]));
 assert.equal(one.kind,'frame');assert.equal(one.frame?.length,128*1024);
 assert.equal(one.remaining.length,0);
 const a=Buffer.alloc(70_000,65),b=Buffer.alloc(70_000,66);
 const first=nextThreadStartFrame(Buffer.concat([a,Buffer.from('\n'),b,Buffer.from('\n')]));
 assert.equal(first.kind,'frame');assert.deepEqual(first.frame,a);
 const second=nextThreadStartFrame(first.remaining);
 assert.equal(second.kind,'frame');assert.deepEqual(second.frame,b);
 assert.equal(second.remaining.length,0);
 const oversized=nextThreadStartFrame(Buffer.concat([Buffer.alloc(128*1024+1,65),Buffer.from('\n')]));
 assert.equal(oversized.kind,'overflow');assert.equal(oversized.frame?.length,128*1024);
 assert.equal(oversized.observedBytes,128*1024+1);assert.equal(oversized.complete,false);
 const partial=nextThreadStartFrame(Buffer.alloc(128*1024+1,65));
 assert.equal(partial.kind,'overflow');assert.equal(partial.observedBytes,128*1024+1);
 assert.equal(partial.complete,false);
});

test('successful RPC context cannot be reused after a new data or native-line boundary',()=>{
 const current=new ThreadStartFrameAssociation();
 current.set(Buffer.from('successful-private-sentinel'));
 current.beginData();assert.equal(current.get(),null);
 current.set(Buffer.from('another-success'));
 current.beginNativeLine();assert.equal(current.get(),null);
});

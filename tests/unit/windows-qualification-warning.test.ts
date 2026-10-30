import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {FixedQualificationThreadStartOnly} from '../../tools/windows-qualification-turn-protocol.ts';
import * as preflight from '../../tools/windows-qualification-preflight.ts';
import type {PreparedWindowsEvent} from '../../src/adapters/codex/investigator/windows-prepared-session.ts';

const binding={recipe:'windows_app_server_readonly_v1' as const,
 hostScopeId:'11111111-1111-4111-8111-111111111111',
 executionInstanceId:'22222222-2222-4222-8222-222222222222'};
const owner={...binding,helperPid:41,helperCreationFiletime:'133000000000000001'};
const cwd='D:\\synthetic\\check',threadId='thread_1';
const result={id:6,result:{thread:{id:threadId,cwd},cwd,model:'gpt-6-sol',
 modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',
 sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:[],
 activePermissionProfile:{id:'rcac_static'}}};
const warning=(message:string,target:unknown=threadId)=>
 ({method:'warning',params:{message,threadId:target}});
const sha=(message:string)=>createHash('sha256').update(message).digest('hex');
const began=()=>{const trial=new FixedQualificationThreadStartOnly(owner,cwd);trial.start();return trial;};
const reject=(trial:FixedQualificationThreadStartOnly,event:unknown)=>
 assert.throws(()=>trial.accept(event,owner),/QUALIFICATION_THREAD_START_PROTOCOL/);

test('same-thread warning is diagnostic before and after reply; repeats retain only hash and bytes',()=>{
 const trial=began();
 assert.equal(trial.accept({method:'thread/started',params:{thread:{id:threadId,cwd}}},owner),'pending');
 for(const event of [warning('private-sentinel'),warning('private-sentinel')])
  assert.equal(trial.accept(event,owner),'pending');
 assert.equal(trial.accept(result,owner),'accepted');
 assert.equal(trial.accept({...warning('other'),emittedAtMs:0},owner),'accepted');
 const summary=trial.summary();
 assert.equal(summary.status,'accepted');
 assert.equal(summary.warningCount,3);
 assert.equal(summary.warningBytes,Buffer.byteLength('private-sentinel')*2+5);
 assert.deepEqual(summary.warningSha256,[sha('private-sentinel'),sha('private-sentinel'),sha('other')]);
 assert.equal(JSON.stringify(summary).includes('private-sentinel'),false);
});

test('warning needs a prior valid same-thread scope and an exact bounded envelope',()=>{
 reject(began(),warning('no scope'));
 for(const bad of [warning('x',null),{method:'warning',params:{message:'x'}},
  warning('x','other'),{...warning('x'),id:8},
  {...warning('x'),extra:true},
  {method:'warning',params:{message:'x',threadId,extra:true}},
  {...warning('x'),emittedAtMs:-1},{...warning('x'),emittedAtMs:1.5},
  {...warning('x'),emittedAtMs:Number.MAX_SAFE_INTEGER+1},
  {method:'warning',params:{message:null,threadId}},
  warning('界'.repeat(1366))]){
  const trial=began();trial.accept(result,owner);reject(trial,bad);
  assert.equal(trial.summary().status,'unknown');
  assert.equal(trial.summary().warningCount,0);
 }
 const wrongOwner=began();wrongOwner.accept(result,owner);
 assert.throws(()=>wrongOwner.accept(warning('x'),{...owner,helperPid:42}),
  /QUALIFICATION_THREAD_START_PROTOCOL/);
});

test('warning count and aggregate UTF-8 bytes are bounded independently',()=>{
 const four=began();four.accept(result,owner);
 for(let index=0;index<4;index++)four.accept(warning('a'.repeat(2048)),owner);
 assert.equal(four.summary().warningCount,4);
 assert.equal(four.summary().warningBytes,8192);
 reject(four,warning('fifth'));
 const bytes=began();bytes.accept(result,owner);
 bytes.accept(warning('a'.repeat(4096)),owner);
 bytes.accept(warning('b'.repeat(4096)),owner);
 reject(bytes,warning('overflow'));
});

const root={pid:52,creationFiletime:'133000000000000002'};
const line=(sequence:number,kind:string,extra:object={})=>Buffer.from(JSON.stringify({
 protocol:'windows_job_stdio_v1',helperVersion:'3',...binding,sequence,kind,...extra})+'\n');
const prepared=line(1,'prepared',{childPresent:false,writer:{helperPid:41,
 helperCreationFiletime:owner.helperCreationFiletime,
 pipeName:`\\\\.\\pipe\\RepoConduit-prepared-${binding.hostScopeId}-${binding.executionInstanceId}`,
 handle:'3',deadlineUtcTicks:'133000000000000010',deadlineUptimeMs:'99999'}});
const started=line(2,'started',{root,createdSuspended:true,jobMemberBeforeResume:true});
const stdout=(sequence:number,bytes:Buffer)=>line(sequence,'stdout',{dataBase64:bytes.toString('base64')});
const terminal=(sequence:number)=>Buffer.concat([line(sequence,'stdout_eof'),
 line(sequence+1,'stderr_eof'),line(sequence+2,'root_exit'),
 line(sequence+3,'job_closed',{root,rootExited:true,
  members:{complete:true,assigned:0,listed:0,pids:[]}})]);
const rpc=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');

function observer(){
 const trial=began();let outbound=0,stops=0,acceptedReplies=0,first:string|null=null;
 for(const [method,id] of [['initialize',1],['initialized',undefined],['config/read',2],
  ['windowsSandbox/readiness',3],['thread/start',6]] as const)
  outbound=preflight.advanceThreadOnlyOutbound({method,...(id===undefined?{}:{id})},outbound,false);
 const native:PreparedWindowsEvent[]=[];
 let partial:Buffer=Buffer.alloc(0);
 const dispatch=(preflight as unknown as {dispatchStoppedThreadStartFrame?:
  (reply:unknown,trial:FixedQualificationThreadStartOnly,source:typeof owner)=>void})
  .dispatchStoppedThreadStartFrame;
 assert.equal(typeof dispatch,'function');
 const stream=new preflight.ThreadOnlyCleanupStream(binding,41,()=>stops>0,()=>{},event=>{
  native.push(event);
  if(event.kind!=='stdout')return;
  partial=Buffer.concat([partial,Buffer.from(event.dataBase64,'base64')]);
  for(;;){
   const next=preflight.nextThreadStartBusinessFrame(partial,first!==null||
    ['rejected','unknown'].includes(trial.summary().status));
   if(next.kind==='partial')return;
   if(next.kind==='overflow')throw Error('rpc_limit');
   partial=next.remaining;
   if(next.kind==='drained')return;
   const reply=preflight.decodeThreadOnlyRpcFrame(next.frame);
   if(stops>0){dispatch!(reply,trial,owner);continue;}
   const outcome=trial.accept(reply,owner);
   if(outcome==='accepted'||outcome==='rejected'){
    acceptedReplies++;
    stops++;
   }
  }
 },error=>{first??=error instanceof Error?error.message:'parse_failure';if(stops===0)stops++;},
 ()=>{partial=preflight.drainStoppedThreadRpc(partial).remaining;});
 const closed=()=>preflight.ownedNativeClosureObserved({firstFailure:first,exitCode:0,
  stdoutEnded:true,stderrEnded:true,helperStderr:'',...stream.summary(),
  rpcPartialBytes:partial.length,startWriteSucceeded:true,stopWriteSucceeded:true,
  stopSent:stops>0,phase:4,readiness:'ready',root,terminal:native.at(-1),
  kinds:native.map(event=>event.kind)});
 return {trial,stream,closed,summary:()=>({outbound,stops,acceptedReplies,first,
  warningCount:trial.summary().warningCount,partialBytes:partial.length})};
}

test('same-frame and split-frame post-stop warning use real dispatch and preserve Job closure',()=>{
 for(const split of [false,true]){
  const run=observer();
  const frames=Buffer.concat([rpc(result),rpc(warning('private-sentinel'))]);
  const head=Buffer.concat([prepared,started]);
  if(split){
   run.stream.consume(Buffer.concat([head,stdout(3,frames.subarray(0,frames.length-8))]));
   run.stream.consume(Buffer.concat([stdout(4,frames.subarray(frames.length-8)),terminal(5)]));
  }else run.stream.consume(Buffer.concat([head,stdout(3,frames),terminal(4)]));
  assert.deepEqual(run.summary(),{outbound:5,stops:1,acceptedReplies:1,first:null,
   warningCount:1,partialBytes:0});
  assert.equal(run.trial.summary().status,'accepted');
  assert.equal(run.closed(),true);
 }
});

test('bad post-stop warning fixes failure while later frames only drain to valid closure',()=>{
 const run=observer();
 run.stream.consume(Buffer.concat([prepared,started,
  stdout(3,Buffer.concat([rpc(result),rpc(warning('bad','wrong')),
   rpc(warning('later'))])),terminal(4)]));
 assert.equal(run.summary().outbound,5);
 assert.equal(run.summary().stops,1);
 assert.equal(run.summary().acceptedReplies,1);
 assert.equal(run.summary().first,'QUALIFICATION_THREAD_START_PROTOCOL');
 assert.equal(run.trial.summary().status,'unknown');
 assert.equal(run.trial.summary().warningCount,0);
 assert.equal(run.closed(),true);
});

test('rejected thread-start drains a later warning without changing the original refusal',()=>{
 const run=observer();
 run.stream.consume(Buffer.concat([prepared,started,
  stdout(3,Buffer.concat([rpc({id:6,error:{code:-32000,message:'private refusal'}}),
   rpc(warning('later'))])),terminal(4)]));
 assert.equal(run.summary().outbound,5);
 assert.equal(run.summary().stops,1);
 assert.equal(run.summary().acceptedReplies,1);
 assert.equal(run.summary().first,null);
 assert.equal(run.trial.summary().status,'rejected');
 assert.equal(run.trial.summary().warningCount,0);
 assert.equal(run.closed(),true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {ThreadOnlyCleanupStream,drainStoppedThreadRpc,nextThreadStartBusinessFrame,
 threadStartCaptureOrStop,decodeThreadOnlyRpcFrame} from '../../tools/windows-qualification-preflight.ts';
import {FixedQualificationThreadStartOnly} from '../../tools/windows-qualification-turn-protocol.ts';

test('nonthrow private capture failure drains before every next RPC and retains rejected outcome',()=>{
 const binding={recipe:'windows_app_server_readonly_v1' as const,
  hostScopeId:'11111111-1111-4111-8111-111111111111',executionInstanceId:'22222222-2222-4222-8222-222222222222'};
 const owner={...binding,helperPid:41,helperCreationFiletime:'133000000000000001'};
 const trial=new FixedQualificationThreadStartOnly(owner,'D:\\synthetic\\check');trial.start();
 const root={pid:52,creationFiletime:'133000000000000002'};
 const line=(sequence:number,kind:string,extra:object={})=>JSON.stringify({protocol:'windows_job_stdio_v1',
  helperVersion:'3',...binding,sequence,kind,...extra})+'\n';
 let partial:Buffer=Buffer.alloc(0),first:string|null=null,stops=0,attempts=0,reducers=0;
 const fail=(code:string)=>{if(first===null){first=code;stops++;}};
 const stream=new ThreadOnlyCleanupStream(binding,41,()=>stops>0,()=>{},event=>{
  if(event.kind!=='stdout')return;
  partial=Buffer.concat([partial,Buffer.from(event.dataBase64,'base64')]);
  for(;;){
   const next=nextThreadStartBusinessFrame(partial,first!==null);
   if(next.kind==='partial')return;
   if(next.kind==='overflow')throw Error('rpc_limit');
   partial=next.remaining;
   // The repaired shared framing gate has no frame when the business path is stopped.
   if(next.kind==='drained')return;
   reducers++;
   const outcome=trial.accept(decodeThreadOnlyRpcFrame(next.frame),owner);
   if(outcome==='rejected'){
    if(!threadStartCaptureOrStop(()=>{attempts++;throw Error('private-sentinel');},fail))continue;
   }
  }
 },error=>fail(error instanceof Error?error.message:'unknown'),()=>{partial=drainStoppedThreadRpc(partial).remaining;});
 const rpc=JSON.stringify({id:6,error:{code:-32000,message:'private rejection'}})+'\n'+
  JSON.stringify({method:'thread/started',params:{thread:{id:'late',cwd:'D:\\synthetic\\check'}}})+'\n';
 stream.consume(Buffer.from(line(1,'prepared',{childPresent:false,writer:{helperPid:41,
  helperCreationFiletime:owner.helperCreationFiletime,pipeName:`\\\\.\\pipe\\RepoConduit-prepared-${binding.hostScopeId}-${binding.executionInstanceId}`,
  handle:'3',deadlineUtcTicks:'133000000000000010',deadlineUptimeMs:'99999'}})+
  line(2,'started',{root,createdSuspended:true,jobMemberBeforeResume:true})+
  line(3,'stdout',{dataBase64:Buffer.from(rpc).toString('base64')})+
  line(4,'stdout_eof')+line(5,'stderr_eof')+line(6,'root_exit')+
  line(7,'job_closed',{root,rootExited:true,members:{complete:true,assigned:0,listed:0,pids:[]}})));
 assert.equal(trial.summary().status,'rejected');assert.equal(reducers,1);
 assert.equal(first,'thread_error_capture_failed');assert.equal(stops,1);assert.equal(attempts,1);
 assert.equal(partial.length,0);assert.equal(stream.summary().drainError,null);
});

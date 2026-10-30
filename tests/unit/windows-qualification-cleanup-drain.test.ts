import assert from 'node:assert/strict';
import test from 'node:test';
import {ThreadOnlyCleanupStream,drainStoppedThreadRpc,ownedNativeClosureObserved} from '../../tools/windows-qualification-preflight.ts';
import type {PreparedWindowsEvent} from '../../src/adapters/codex/investigator/windows-prepared-session.ts';

const binding={recipe:'windows_app_server_readonly_v1' as const,
 hostScopeId:'11111111-1111-4111-8111-111111111111',executionInstanceId:'22222222-2222-4222-8222-222222222222'};
const root={pid:52,creationFiletime:'133000000000000002'};
const line=(sequence:number,kind:string,extra:object={})=>Buffer.from(JSON.stringify({
 protocol:'windows_job_stdio_v1',helperVersion:'3',...binding,sequence,kind,...extra})+'\n');
const prepared=line(1,'prepared',{childPresent:false,writer:{helperPid:41,
 helperCreationFiletime:'133000000000000001',pipeName:`\\\\.\\pipe\\RepoConduit-prepared-${binding.hostScopeId}-${binding.executionInstanceId}`,
 handle:'3',deadlineUtcTicks:'133000000000000010',deadlineUptimeMs:'99999'}});
const started=line(2,'started',{root,createdSuspended:true,jobMemberBeforeResume:true});
const stdout=(seq:number,data:Buffer|string)=>line(seq,'stdout',{dataBase64:Buffer.from(data).toString('base64')});
const terminal=(seq:number)=>Buffer.concat([line(seq,'stdout_eof'),line(seq+1,'stderr_eof'),
 line(seq+2,'root_exit'),line(seq+3,'job_closed',{root,rootExited:true,
 members:{complete:true,assigned:0,listed:0,pids:[]}})]);
function observer(){
 const native:PreparedWindowsEvent[]=[];
 let rpcPartial:Buffer=Buffer.alloc(0),first:string|null=null,stops=0,captures=0,reducers=0,rpcs=0;
 const stream=new ThreadOnlyCleanupStream(binding,41,()=>stops>0,()=>{},event=>{
  native.push(event);
  if(event.kind==='started'){rpcs++;return;}
  if(event.kind!=='stdout')return;
  rpcPartial=Buffer.concat([rpcPartial,Buffer.from(event.dataBase64,'base64')]);
  if(first!==null){rpcPartial=drainStoppedThreadRpc(rpcPartial).remaining;return;}
  for(let nl;(nl=rpcPartial.indexOf(10))>=0;){
   const frame=rpcPartial.subarray(0,nl);rpcPartial=rpcPartial.subarray(nl+1);
   reducers++;
   if(frame.toString()==='FAIL')throw Error('result_projection');
   rpcs++;
  }
 },error=>{if(first===null){first=error instanceof Error?error.message:'parse_failure';stops++;captures++;}},
 ()=>{rpcPartial=drainStoppedThreadRpc(rpcPartial).remaining;});
 const closed=()=>ownedNativeClosureObserved({firstFailure:first,exitCode:0,stdoutEnded:true,stderrEnded:true,
  helperStderr:'',...stream.summary(),rpcPartialBytes:rpcPartial.length,
  startWriteSucceeded:true,stopWriteSucceeded:true,stopSent:stops>0,phase:3,readiness:'ready',
  root,terminal:native.at(-1),kinds:native.map(e=>e.kind)});
 return {stream,closed,native,values:()=>({first,stops,captures,reducers,rpcs})};
}
test('business failure drains same-chunk RPC and terminal tail without another reducer/send',()=>{
 const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\nLATE\n'),terminal(4)]));
 assert.deepEqual(o.values(),{first:'result_projection',stops:1,captures:1,reducers:1,rpcs:1});
 assert.equal(o.closed(),true);assert.equal(o.stream.summary().drainError,null);
});
test('business failure and native terminal split across chunks still preserve the first failure',()=>{
 const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\nLA')]));
 const tail=Buffer.concat([stdout(4,'TE\n'),terminal(5)]);
 o.stream.consume(tail.subarray(0,27));o.stream.consume(tail.subarray(27));
 assert.equal(o.closed(),true);assert.equal(o.values().reducers,1);assert.equal(o.values().captures,1);
});
test('wrong owner or sequence poisons closure despite valid later tail',()=>{
 for(const bad of [line(4,'stdout_eof',{hostScopeId:'33333333-3333-4333-8333-333333333333'}),line(5,'stdout_eof')]){
  const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\n'),bad,terminal(4)]));
  assert.equal(o.closed(),false);assert.equal(o.values().first,'result_projection');assert.equal(o.values().captures,1);
  assert.equal(o.stream.summary().drainError,'native_envelope');
 }
});
test('duplicate, terminal disorder, changed root and stdout after EOF all reject closure',()=>{
 const bads=[Buffer.concat([line(4,'stdout_eof'),line(5,'stdout_eof'),terminal(6)]),
  Buffer.concat([line(4,'job_closed',{root,rootExited:true,members:{complete:true,assigned:0,listed:0,pids:[]}}),terminal(5)]),
  Buffer.concat([line(4,'stdout_eof'),stdout(5,'LATE\n'),terminal(6)]),
  Buffer.concat([line(4,'stdout_eof'),line(5,'stderr_eof'),line(6,'root_exit'),line(7,'job_closed',{
   root:{...root,pid:53},rootExited:true,members:{complete:true,assigned:0,listed:0,pids:[]}})])];
 for(const bad of bads){const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\n'),bad]));
  assert.equal(o.closed(),false);assert.equal(o.values().first,'result_projection');assert.equal(o.values().stops,1);}
});
test('missing Job and truncated native or RPC bytes cannot prove closure',()=>{
 for(const tail of [Buffer.concat([line(4,'stdout_eof'),line(5,'stderr_eof'),line(6,'root_exit')]),
  Buffer.concat([terminal(4),Buffer.from('{')])]){
  const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\n'),tail]));assert.equal(o.closed(),false);
 }
 const partial=observer();partial.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\nLATE'),terminal(4)]));
 assert.equal(partial.closed(),false);
});
test('invalid native UTF8 poisons cleanup independently of the immutable business cause',()=>{
 const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\n'),Buffer.from([255,10]),terminal(4)]));
 assert.equal(o.closed(),false);assert.equal(o.values().first,'result_projection');assert.equal(o.stream.summary().drainError,'native_utf8');
});
test('cleanup keeps RPC and outer output bounds without clearing overflow to manufacture closure',()=>{
 assert.throws(()=>drainStoppedThreadRpc(Buffer.alloc(128*1024+1,65)),/rpc_limit/);
 const o=observer();o.stream.consume(Buffer.concat([prepared,started,stdout(3,'FAIL\n')]));
 o.stream.consume(Buffer.alloc(32769,65));assert.equal(o.stream.summary().drainError,'output_limit');assert.equal(o.closed(),false);
 const exact=drainStoppedThreadRpc(Buffer.concat([Buffer.alloc(128*1024,65),Buffer.from('\nTAIL')]));
 assert.equal(exact.frames,1);assert.equal(exact.remaining.toString(),'TAIL');
});

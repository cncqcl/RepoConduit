import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FixedQualificationTurn,qualificationModelReadinessAllowsLogin,SYNTHETIC_TURN_PROMPT} from '../../tools/windows-qualification-turn-protocol.ts';

const owner={hostScopeId:'scope',executionInstanceId:'instance',helperPid:41,
 helperCreationFiletime:'133000000000000000'};
const cwd='D:\\synthetic\\check';
const thread='11111111-1111-4111-8111-111111111111';
const turn='22222222-2222-4222-8222-222222222222';
const threadResult={id:6,result:{thread:{id:thread,cwd},cwd,model:'gpt-6-sol',
 modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',
 sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:[],
 activePermissionProfile:{id:'rcac_static'}}};
const turnResult={id:7,result:{turn:{id:turn,status:'inProgress',items:[]}}};
const reject=(fn:()=>unknown)=>assert.throws(fn,/QUALIFICATION_TURN_PROTOCOL/);
const started=()=>{const p=new FixedQualificationTurn(owner,cwd);p.threadStartRequest();
 p.acceptThreadStart(threadResult,owner);p.turnStartRequest();return p;};

test('model mode readiness requires ready before login; fixed thread and turn requests have no fallback or shell',()=>{
 assert.equal(qualificationModelReadinessAllowsLogin('ready'),true);
 for(const value of ['updateRequired','notConfigured',null,'other'])
  assert.equal(qualificationModelReadinessAllowsLogin(value),false);
 const p=new FixedQualificationTurn(owner,cwd);
 const request=p.threadStartRequest();
 assert.equal(request.method,'thread/start');
 assert.deepEqual(request.params.dynamicTools[0]?.name,'repo');
 assert.deepEqual(request.params.environments,[]);
 assert.deepEqual(request.params.runtimeWorkspaceRoots,[cwd]);
 assert.equal(request.params.permissions,'rcac_static');
 assert.equal(request.params.allowProviderModelFallback,false);
 assert.equal(request.params.approvalPolicy,'never');
 assert.equal(request.params.ephemeral,true);
 assert.equal('sandbox' in request.params,false);
 p.acceptThreadStart(threadResult,owner);
 const next=p.turnStartRequest();
 assert.equal(next.method,'turn/start');
 assert.equal(next.params.effort,'medium');
 assert.equal(next.params.serviceTierForTurn,'default');
 assert.equal(next.params.permissions,'rcac_static');
 assert.equal(next.params.threadId,thread);
 assert.equal(next.params.input[0]?.type,'text');
 assert.doesNotMatch(JSON.stringify(next),/apiKey|chatgptAuthTokens|src\/private/);
});

test('only same owner and exact fixed thread/turn responses bind, duplicate and policy drift refuse',()=>{
 const wrong=new FixedQualificationTurn(owner,cwd);wrong.threadStartRequest();
 reject(()=>wrong.acceptThreadStart(threadResult,{...owner,helperPid:42}));
 for(const altered of [{...threadResult,result:{...threadResult.result,model:'other'}},
  {...threadResult,result:{...threadResult.result,sandbox:{type:'workspaceWrite'}}},
  {...threadResult,result:{...threadResult.result,activePermissionProfile:{id:'other'}}}]){
  const p=new FixedQualificationTurn(owner,cwd);p.threadStartRequest();reject(()=>p.acceptThreadStart(altered,owner));
 }
 const p=started();reject(()=>p.acceptTurnStart({...turnResult,id:8},owner));
 const q=started();q.acceptTurnStart(turnResult,owner);reject(()=>q.acceptTurnStart(turnResult,owner));
});

test('early repo.read remains queued until original turn response; only three fixed scoped calls',()=>{
 const p=started();
 const call=(id:string,path='README.md')=>({id,method:'item/tool/call',params:{threadId:thread,
  turnId:turn,callId:id,namespace:'repo',tool:'read',arguments:{path}}});
 assert.equal(p.acceptToolCall(call('srv-1'),owner).queued,true);
 assert.equal(p.queuedToolCalls().length,0);
 p.acceptTurnStart(turnResult,owner);
 assert.equal(p.queuedToolCalls().length,1);
 assert.equal(p.queuedToolCalls().length,0);
 assert.equal(p.acceptToolCall(call('srv-2'),owner).queued,false);
 assert.equal(p.acceptToolCall(call('srv-3'),owner).queued,false);
 reject(()=>p.acceptToolCall(call('srv-4'),owner));
 const wrong=started();wrong.acceptTurnStart(turnResult,owner);
 reject(()=>wrong.acceptToolCall(call('unknown','private.txt'),owner));
 const earlyWrong=started();earlyWrong.acceptToolCall({id:'srv',method:'item/tool/call',params:{
  threadId:thread,turnId:'foreign-turn',callId:'c1',namespace:'repo',tool:'read',
  arguments:{path:'README.md'}}},owner);
 reject(()=>earlyWrong.acceptTurnStart(turnResult,owner));
});

test('interrupt uses original bound IDs and ACK never equals terminal completion',()=>{
 const p=started();p.acceptTurnStart(turnResult,owner);
 assert.deepEqual(p.interruptRequest(),{id:8,method:'turn/interrupt',params:{threadId:thread,turnId:turn}});
 p.acceptInterrupt({id:8,result:{}},owner);
 assert.equal(p.summary().terminalStatus,null);
 reject(()=>p.acceptTurnCompleted({method:'turn/completed',params:{threadId:'other',
  turn:{id:turn,status:'interrupted',items:[]}}},owner));
 const q=started();q.acceptTurnStart(turnResult,owner);
 q.acceptTurnCompleted({method:'turn/completed',emittedAtMs:1790000000000,params:{threadId:thread,
  turn:{id:turn,status:'completed',items:[]}}},owner);
 assert.equal(q.summary().terminalStatus,'completed');
 assert.equal(JSON.stringify(q.summary()).includes(thread),false);
 reject(()=>q.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'completed',items:[]}}},owner));
 const lateAck=started();lateAck.acceptTurnStart(turnResult,owner);
 lateAck.interruptRequest();
 lateAck.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'interrupted',items:[]}}},owner);
 lateAck.acceptInterrupt({id:8,result:{}},owner);
 assert.equal(lateAck.summary().interruptAckObserved,true);
 reject(()=>lateAck.acceptInterrupt({id:8,result:{}},owner));
 for(const emittedAtMs of [null,'1790000000000',1.5,Number.MAX_SAFE_INTEGER+1]){
  const bad=started();bad.acceptTurnStart(turnResult,owner);
  reject(()=>bad.acceptTurnCompleted({method:'turn/completed',emittedAtMs,
   params:{threadId:thread,turn:{id:turn,status:'completed',items:[]}}},owner));
 }
});

test('empty terminal is not a successful inquiry; bounded final finding and actual read are separate',()=>{
 const p=started();p.acceptTurnStart(turnResult,owner);
 p.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'completed',items:[]}}},owner);
 assert.equal(p.summary().terminalStatus,'completed');
 assert.equal(p.summary().findingStatus,'missing');
 assert.equal(p.summary().successfulReads,0);
 const q=started();q.acceptTurnStart(turnResult,owner);
 const call=q.acceptToolCall({id:'server-read',method:'item/tool/call',params:{threadId:thread,turnId:turn,
  callId:'call-1',namespace:'repo',tool:'read',arguments:{path:'README.md'}}},owner).call;
 const response=q.completeToolCall(call,{content:'synthetic'});
 assert.equal((response as {result:{success:boolean}}).result.success,true);
 q.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'completed',items:[{id:'message-1',type:'agentMessage',phase:'final_answer',
   text:'{"finding":"Synthetic README only"}'}]}}},owner);
 assert.equal(q.summary().findingStatus,'valid');
 assert.equal(q.summary().successfulReads,1);
 assert.doesNotMatch(JSON.stringify(q.summary()),/Synthetic README|server-read|call-1/);
});

test('documented lifecycle notifications may precede replies but must bind the original IDs',()=>{
 const p=new FixedQualificationTurn(owner,cwd);p.threadStartRequest();
 p.observeLifecycle({method:'thread/started',emittedAtMs:1790000000000,
  params:{thread:{id:thread,cwd}}},owner);
 p.acceptThreadStart(threadResult,owner);p.turnStartRequest();
 p.observeLifecycle({method:'turn/started',params:{threadId:thread,
  turn:{id:turn,status:'inProgress',items:[]}}},owner);
 p.acceptTurnStart(turnResult,owner);
 const bad=new FixedQualificationTurn(owner,cwd);bad.threadStartRequest();
 bad.observeLifecycle({method:'thread/started',params:{thread:{id:'foreign',cwd}}},owner);
 reject(()=>bad.acceptThreadStart(threadResult,owner));
 const wrong=started();wrong.observeLifecycle({method:'turn/started',params:{threadId:thread,
  turn:{id:'foreign',status:'inProgress',items:[]}}},owner);
 reject(()=>wrong.acceptTurnStart(turnResult,owner));
});

test('bounded message item notifications bind the same turn and reject unknown native items',()=>{
 const p=started();p.acceptTurnStart(turnResult,owner);
 p.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1790000000000,
  item:{id:'message-1',type:'agentMessage',text:''}}},owner);
 p.observeItem({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,
  itemId:'message-1',delta:'{"finding":'}},owner);
 p.observeItem({method:'item/completed',params:{threadId:thread,turnId:turn,
  completedAtMs:1790000000001,item:{id:'message-1',type:'agentMessage',text:'{"finding":"ok"}'}}},owner);
 const bad=started();bad.acceptTurnStart(turnResult,owner);
 reject(()=>bad.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,
  startedAtMs:1790000000000,item:{id:'command-1',type:'commandExecution',command:'dir'}}},owner));
});

test('fixed dynamic repo read and bounded status, usage, reasoning notifications stay observational',()=>{
 const p=started();p.acceptTurnStart(turnResult,owner);
 p.observeStatus({method:'thread/status/changed',params:{threadId:thread,status:{type:'active',activeFlags:[]}}},owner);
 p.observeStatus({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:turn,tokenUsage:{}}},owner);
 p.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1790000000000,
  item:{id:'item-1',type:'dynamicToolCall',tool:'read',namespace:'repo',arguments:{path:'README.md'},status:'inProgress'}}},owner);
 p.observeItem({method:'item/completed',params:{threadId:thread,turnId:turn,completedAtMs:1790000000001,
  item:{id:'item-1',type:'dynamicToolCall',tool:'read',namespace:'repo',arguments:{path:'README.md'},status:'completed'}}},owner);
 p.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1790000000002,
  item:{id:'reason-1',type:'reasoning'}}},owner);
 for(const [method,extra] of [
  ['item/reasoning/summaryPartAdded',{summaryIndex:0}],
  ['item/reasoning/summaryTextDelta',{summaryIndex:0,delta:'brief'}],
  ['item/reasoning/textDelta',{contentIndex:0,delta:'brief'}]] as const)
  p.observeItem({method,params:{threadId:thread,turnId:turn,itemId:'reason-1',...extra}},owner);
 const bad=started();bad.acceptTurnStart(turnResult,owner);
 reject(()=>bad.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,
  startedAtMs:1,item:{id:'item-2',type:'dynamicToolCall',tool:'other',namespace:'repo',
   arguments:{path:'README.md'},status:'inProgress'}}},owner));
});

test('completed item can supply final finding when turn items are notLoaded; interrupted pending read is terminal',()=>{
 const p=started();p.acceptTurnStart(turnResult,owner);
 p.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1,
  item:{id:'final-1',type:'agentMessage',text:''}}},owner);
 p.observeItem({method:'item/completed',params:{threadId:thread,turnId:turn,completedAtMs:2,
  item:{id:'final-1',type:'agentMessage',phase:null,text:'{"finding":"ok"}'}}},owner);
 p.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'completed',itemsView:'notLoaded',items:[]}}},owner);
 assert.equal(p.summary().findingStatus,'valid');
 const pending=started();pending.acceptTurnStart(turnResult,owner);
 const call=pending.acceptToolCall({id:'srv',method:'item/tool/call',params:{threadId:thread,turnId:turn,
  callId:'call',namespace:'repo',tool:'read',arguments:{path:'README.md'}}},owner).call;
 pending.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'interrupted',items:[]}}},owner);
 reject(()=>pending.completeToolCall(call,{content:'late'}));
 const conflict=started();conflict.acceptTurnStart(turnResult,owner);
 conflict.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1,
  item:{id:'final-1',type:'agentMessage',text:''}}},owner);
 conflict.observeItem({method:'item/completed',params:{threadId:thread,turnId:turn,completedAtMs:2,
  item:{id:'final-1',type:'agentMessage',phase:null,text:'{"finding":"A"}'}}},owner);
 reject(()=>conflict.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'completed',items:[{id:'final-1',type:'agentMessage',phase:null,
   text:'{"finding":"B"}'}]}}},owner));
});

test('same thread status and usage are observational before reply and after terminal',()=>{
 const p=new FixedQualificationTurn(owner,cwd);p.threadStartRequest();
 p.observeLifecycle({method:'thread/started',params:{thread:{id:thread,cwd}}},owner);
 p.observeStatus({method:'thread/status/changed',params:{threadId:thread,status:{type:'active',activeFlags:[]}}},owner);
 p.acceptThreadStart(threadResult,owner);p.turnStartRequest();p.acceptTurnStart(turnResult,owner);
 p.acceptTurnCompleted({method:'turn/completed',params:{threadId:thread,
  turn:{id:turn,status:'completed',items:[]}}},owner);
 p.observeStatus({method:'thread/status/changed',params:{threadId:thread,status:{type:'idle'}}},owner);
 p.observeStatus({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:turn,tokenUsage:{}}},owner);
 assert.equal(p.summary().terminalStatus,'completed');
 const bad=new FixedQualificationTurn(owner,cwd);bad.threadStartRequest();
 bad.observeLifecycle({method:'thread/started',params:{thread:{id:thread,cwd}}},owner);
 reject(()=>bad.observeStatus({method:'thread/status/changed',params:{threadId:'foreign',
  status:{type:'idle'}}},owner));
});

test('only the fixed synthetic userMessage lifecycle is observational',()=>{
 const input={type:'text',text:SYNTHETIC_TURN_PROMPT,text_elements:[]};
 const p=started();p.acceptTurnStart(turnResult,owner);
 p.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1,
  item:{id:'user-1',type:'userMessage',content:[input]}}},owner);
 p.observeItem({method:'item/completed',params:{threadId:thread,turnId:turn,completedAtMs:2,
  item:{id:'user-1',type:'userMessage',content:[input]}}},owner);
 const bad=started();bad.acceptTurnStart(turnResult,owner);
 reject(()=>bad.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,
  startedAtMs:1,item:{id:'user-2',type:'userMessage',content:[{type:'text',text:'other'}]}}},owner));
});

test('schema string IDs remain opaque, including underscores; numeric RPC IDs must be safe',()=>{
 const p=started();p.acceptTurnStart(turnResult,owner);
 const accepted=p.acceptToolCall({id:'server_read_1',method:'item/tool/call',params:{
  threadId:thread,turnId:turn,callId:'call_read_1',namespace:'repo',tool:'read',
  arguments:{path:'README.md'}}},owner);
 assert.equal(accepted.queued,false);
 p.observeItem({method:'item/started',params:{threadId:thread,turnId:turn,startedAtMs:1,
  item:{id:'message_1',type:'agentMessage',text:''}}},owner);
 const bad=started();bad.acceptTurnStart(turnResult,owner);
 reject(()=>bad.acceptToolCall({id:Number.MAX_SAFE_INTEGER+1,method:'item/tool/call',params:{
  threadId:thread,turnId:turn,callId:'call_2',namespace:'repo',tool:'read',
  arguments:{path:'README.md'}}},owner));
});

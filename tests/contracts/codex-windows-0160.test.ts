import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';
import type { CodexProtocolTarget } from '../../src/adapters/codex/protocol/stdio.js';

const newTarget: CodexProtocolTarget = 'windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2';
// The cast lets the RED test reach runtime admission before this finite target is implemented.
const historical0163 = 'windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2' as CodexProtocolTarget;
const target0163 = 'windows-desktop-codex-0.163.0-alpha.11' as CodexProtocolTarget;
const lastHistoricalTarget: CodexProtocolTarget = 'windows-desktop-26.930.7945.0-codex-0.160.1';
const oldTarget: CodexProtocolTarget = 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1';
const cwd = 'D:\\repo\\source';
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const limits = { maxFrameBytes: 8192, maxTotalBytes: 65536, maxNotifications: 100, requestTimeoutMs: 500 };

test('thread response rejection identifies only the failed check, never returned values', async () => {
  for (const [response,code] of [
    [{cwd:'private-secret-path'},'CWD'],
    [{model:'private-secret-model'},'MODEL'],
    [{approvalPolicy:'always'},'POLICY'],
    [{runtimeWorkspaceRoots:[cwd]},'ROOTS'],
    [{modelProvider:''},'PROVIDER'],
    [{approvalsReviewer:'private-secret-reviewer'},'REVIEWER'],
    [{sandbox:{type:'workspaceWrite'}},'SANDBOX'],
    [{activePermissionProfile:{id:'private-secret-profile'}},'PROFILE'],
  ] as const) {
    const p=pair(newTarget);await p.initialize();
    const {pending}=await p.thread(response);
    await assert.rejects(pending,(error:Error)=>{
      assert.equal(error.message,`PROTOCOL_REJECTED_THREAD_${code}`);
      assert.equal(error.message.includes('private-secret'),false);return true;
    });
    assert.equal(p.terminated,1);p.transport.close();
  }
});

test('current Windows schema configWarning passes while malformed warning rejects before turn response', async () => {
  const allowed=pair(newTarget);
  await allowed.initialize();await (await allowed.thread()).pending;
  const turn=allowed.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
  const request=allowed.writes.at(-1)!;
  allowed.send({method:'configWarning',params:{summary:'private warning',details:null,path:null,range:null}});
  allowed.send({id:request.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});
  assert.equal(await turn,turnId);
  assert.equal(allowed.writes.filter(frame=>frame.method==='turn/start').length,1);
  allowed.transport.close();

  const rejected=pair(newTarget);
  await rejected.initialize();await (await rejected.thread()).pending;
  const pending=rejected.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
  rejected.send({method:'configWarning',params:{summary:'private warning',range:{start:{line:-1,column:0},end:{line:1,column:0}}}});
  await assert.rejects(pending,/^Error: PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID$/);
  assert.equal(rejected.writes.filter(frame=>frame.method==='turn/start').length,1);
  assert.equal(rejected.terminated,1);
});

test('current Windows bare warnings are bounded data, with distinct invalid and unknown rejection', async () => {
  for(const [method,params] of [
    ['deprecationNotice',{summary:'private summary',details:null}],
    ['warning',{message:'private warning',threadId:null}],
    ['guardianWarning',{message:'private guardian',threadId}],
  ] as const){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;
    const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
    const request=p.writes.at(-1)!;
    p.send({method,params});
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    p.send({id:request.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});
    assert.equal(await pending,turnId);
    p.transport.close();
  }
  for(const [method,params,code] of [
    ['configWarning',{summary:7},'PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID'],
    ['deprecationNotice',{summary:7},'PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID'],
    ['warning',{message:7},'PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID'],
    ['guardianWarning',{message:'private',threadId:null},'PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID'],
    ['unknownBare',{message:'private'},'PROTOCOL_REJECTED_INGEST_NOTIFICATION_UNKNOWN'],
  ] as const){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;
    const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
    p.send({method,params});
    await assert.rejects(pending,(error:Error)=>{assert.equal(error.message,code);return true;});
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(p.terminated,1);
  }
});

test('native bare error fails without payload disclosure or retry, including willRetry true', async () => {
  for(const willRetry of [false,true]){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;
    const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
    p.send({method:'error',params:{threadId,turnId,willRetry,error:{message:'private provider text'}}});
    await assert.rejects(pending,(error:Error)=>{
      assert.equal(error.message,'PROTOCOL_NATIVE_ERROR');
      assert.equal(error.message.includes('private provider text'),false);return true;
    });
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(p.terminated,1);
  }
});

test('native error maps only schema-known categories and bounded HTTP status classes', async () => {
  for(const [codexErrorInfo,code] of [
    ['unauthorized','PROTOCOL_NATIVE_UNAUTHORIZED'],
    ['badRequest','PROTOCOL_NATIVE_BAD_REQUEST'],
    ['rateLimitExceeded','PROTOCOL_NATIVE_RATE_LIMIT'],
    ['usageLimitExceeded','PROTOCOL_NATIVE_USAGE_LIMIT'],
    [{httpConnectionFailed:{httpStatusCode:null}},'PROTOCOL_NATIVE_CONNECTION'],
    [{responseStreamConnectionFailed:{httpStatusCode:null}},'PROTOCOL_NATIVE_STREAM_CONNECTION'],
    [{responseStreamDisconnected:{httpStatusCode:null}},'PROTOCOL_NATIVE_STREAM_DISCONNECTED'],
    [{httpConnectionFailed:{httpStatusCode:401}},'PROTOCOL_NATIVE_UNAUTHORIZED'],
    [{httpConnectionFailed:{httpStatusCode:403}},'PROTOCOL_NATIVE_FORBIDDEN'],
    [{responseStreamDisconnected:{httpStatusCode:429}},'PROTOCOL_NATIVE_RATE_LIMIT'],
    [{httpConnectionFailed:{httpStatusCode:503}},'PROTOCOL_NATIVE_SERVER'],
    [{httpConnectionFailed:{httpStatusCode:418}},'PROTOCOL_NATIVE_ERROR'],
    [{httpConnectionFailed:{httpStatusCode:'401'}},'PROTOCOL_NATIVE_ERROR'],
    [{httpConnectionFailed:{httpStatusCode:401},unknown:'private'},'PROTOCOL_NATIVE_ERROR'],
    ['private arbitrary provider text','PROTOCOL_NATIVE_ERROR'],
  ] as const){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;
    const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
    p.send({method:'error',params:{threadId,turnId,willRetry:true,
      error:{message:'private provider text',codexErrorInfo}}});
    await assert.rejects(pending,(error:Error)=>{
      assert.equal(error.message,code);
      assert.equal(error.message.includes('private'),false);return true;
    });
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(p.terminated,1);
  }
});

const retryError = () => ({method:'error',params:{threadId,turnId,willRetry:true,
  error:{message:'private provider text',additionalDetails:null,misalignment:null,
    codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}}});

test('current bound native stream recovery completes the same turn with one read and no new RPC', async () => {
  for(const codexErrorInfo of [
    {httpConnectionFailed:{httpStatusCode:null}},
    {responseStreamConnectionFailed:{httpStatusCode:null}},
    {responseStreamDisconnected:{httpStatusCode:null}},
    {responseStreamDisconnected:{httpStatusCode:503}},
  ]){
    const p=pair(newTarget,true);await p.initialize();await (await p.thread()).pending;await p.turn();
    const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
    // Attach before injecting the error so the old behavior is a normal failed regression.
    const outcome=assert.doesNotReject(pending);
    void outcome.catch(()=>undefined);
    const error=retryError();error.params.error.codexErrorInfo=codexErrorInfo as typeof error.params.error.codexErrorInfo;
    p.send(error);
    p.send({id:'srv-after-retry',method:'item/tool/call',params:{threadId,turnId,
      callId:'call-after-retry',namespace:'repo',tool:'read',arguments:{path:'src/a.ts'}}});
    await Promise.resolve();await Promise.resolve();
    assert.equal(p.reads,1);
    p.send({method:'item/completed',params:{threadId,turnId,completedAtMs:1,
      item:{type:'agentMessage',id:'final-after-retry',phase:'final_answer',text:'final JSON'}}});
    p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
    await outcome;
    assert.deepEqual((await pending).candidate,{itemId:'final-after-retry',text:'final JSON'});
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(p.writes.filter(frame=>frame.method==='turn/interrupt').length,0);
    assert.equal(p.terminated,0);p.transport.close();
  }
});

test('retry recovery rejects foreign, malformed, terminal and disallowed categories', async () => {
  for(const mutate of [
    (x:Record<string,unknown>)=>{x.threadId='foreign';},
    (x:Record<string,unknown>)=>{x.turnId='foreign';},
    (x:Record<string,unknown>)=>{x.extra='private';},
    (x:Record<string,unknown>)=>{x.willRetry=false;},
    (x:Record<string,unknown>)=>{x.willRetry='true';},
    (x:Record<string,unknown>)=>{delete x.willRetry;},
    (x:Record<string,unknown>)=>{(x.error as Record<string,unknown>).message=7;},
    (x:Record<string,unknown>)=>{(x.error as Record<string,unknown>).extra='private';},
    (x:Record<string,unknown>)=>{(x.error as Record<string,unknown>).additionalDetails=7;},
    (x:Record<string,unknown>)=>{(x.error as Record<string,unknown>).misalignment={message:'private'};},
    ...['unauthorized','badRequest','rateLimitExceeded','usageLimitExceeded','other',
      {responseTooManyFailedAttempts:{httpStatusCode:null}},
      {responseStreamDisconnected:{httpStatusCode:401}},
      {responseStreamDisconnected:{httpStatusCode:403}},
      {responseStreamDisconnected:{httpStatusCode:429}},
      {responseStreamDisconnected:{httpStatusCode:418}},
    ].map(info=>(x:Record<string,unknown>)=>{(x.error as Record<string,unknown>).codexErrorInfo=info;}),
  ]){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;await p.turn();
    const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
    const rejected=assert.rejects(pending,(error:Error)=>{
      assert.match(error.message,/^PROTOCOL_NATIVE_/);assert.equal(error.message.includes('private'),false);return true;
    });
    const frame=retryError();mutate(frame.params);p.send(frame);await rejected;
    assert.equal(p.writes.filter(x=>x.method==='turn/start').length,1);assert.equal(p.terminated,1);
  }
  for(const target of [lastHistoricalTarget,oldTarget] as const){
    const p=pair(target);await p.initialize();await (await p.thread()).pending;await p.turn();
    const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
    p.send(retryError());await assert.rejects(pending,/PROTOCOL_NATIVE_STREAM_DISCONNECTED/);
    assert.equal(p.terminated,1);
  }
});

test('retry notifications remain bounded and never clear tool duplicate identities', async () => {
  const p=pair(newTarget,false,{...limits,maxNotifications:1});
  await p.initialize();await (await p.thread()).pending;await p.turn();
  const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
  p.send(retryError());p.send(retryError());await assert.rejects(pending,/PROTOCOL_LIMIT_NOTIFICATIONS/);
  assert.equal(p.terminated,1);
  const q=pair(newTarget,true);await q.initialize();await (await q.thread()).pending;await q.turn();
  const wait=q.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
  const call={id:'srv-original',method:'item/tool/call',params:{threadId,turnId,
    callId:'call-original',namespace:'repo',tool:'read',arguments:{path:'src/a.ts'}}};
  q.send(call);await Promise.resolve();await Promise.resolve();q.send(retryError());
  q.send({...call,id:'srv-duplicate'});await assert.rejects(wait,/PROTOCOL_REJECTED/);
  assert.equal(q.reads,1);assert.equal(q.terminated,1);
});

test('retry does not defer wait deadline, suppress cancellation or override a terminal', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;await p.turn();
  const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:100});
  const expired=assert.rejects(pending,/PROTOCOL_TIMEOUT/);
  t.mock.timers.tick(70);p.send(retryError());t.mock.timers.tick(30);await expired;p.transport.close();
  const q=pair(newTarget);await q.initialize();await (await q.thread()).pending;await q.turn();
  const controller=new AbortController();
  const wait=q.transport.waitForBoundTurn({threadId,turnId,timeoutMs:100,signal:controller.signal});
  const aborted=assert.rejects(wait,/PROTOCOL_ABORTED/);
  q.send(retryError());controller.abort();await aborted;q.transport.close();
  const r=pair(newTarget);await r.initialize();await (await r.thread()).pending;await r.turn();
  const terminal=r.transport.waitForBoundTurn({threadId,turnId,timeoutMs:100});
  const rejected=assert.rejects(terminal,/PROTOCOL_NATIVE_STREAM_DISCONNECTED/);
  r.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
  r.send(retryError());await rejected;assert.equal(r.terminated,1);
});

test('bare warning notification count limit reports protocol limit', async () => {
  const p=pair(newTarget,false,{...limits,maxNotifications:1});
  await p.initialize();await (await p.thread()).pending;
  const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
  p.send({method:'warning',params:{message:'first'}});
  p.send({method:'deprecationNotice',params:{summary:'second'}});
  await assert.rejects(pending,/^Error: PROTOCOL_LIMIT_NOTIFICATIONS$/);
  assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
  assert.equal(p.terminated,1);
});

test('turn start rejects malformed structure and ID with fixed codes after one send', async () => {
  for(const [result,code] of [
    [{turn:null},'PROTOCOL_REJECTED_TURN_STRUCTURE'],
    [{turn:{id:'private invalid id',status:'inProgress',items:[]}},'PROTOCOL_REJECTED_TURN_ID'],
    [{turn:{id:turnId,status:'unknown',items:[]}},'PROTOCOL_REJECTED_TURN_STATUS'],
    [{turn:{id:turnId,status:'inProgress',items:null}},'PROTOCOL_REJECTED_TURN_ITEMS'],
  ] as const){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;
    const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
    p.send({id:p.writes.at(-1)!.id,result});
    await assert.rejects(pending,(error:Error)=>{assert.equal(error.message,code);return true;});
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(p.terminated,1);
  }
});

test('turn pending rejects malformed input frames with fixed redacted ingest codes', async () => {
  for(const [raw,code] of [
    ['{','PROTOCOL_REJECTED_INGEST_JSON'],
    [JSON.stringify({id:'private-id',result:{}}),'PROTOCOL_REJECTED_INGEST_ENVELOPE'],
    [JSON.stringify({method:'unknownWarning',params:{secret:'private'}}),'PROTOCOL_REJECTED_INGEST_NOTIFICATION_UNKNOWN'],
    [JSON.stringify({id:'private-id',method:'item/tool/call',params:{}}),'PROTOCOL_REJECTED_INGEST_SERVER_REQUEST'],
  ] as const){
    const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;
    const pending=p.transport.startRestrictedTurn({threadId,profileId:'investigator',text:'Inspect.'});
    p.output.write(`${raw}\n`);
    await assert.rejects(pending,(error:Error)=>{assert.equal(error.message,code);return true;});
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(p.terminated,1);
  }
});

function pair(target: CodexProtocolTarget, read = false, protocolLimits = limits) {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const writes: Array<Record<string, unknown>> = [];
  let terminated = 0, reads = 0;
  const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(),
    terminate() { terminated++; } }, protocolLimits, target);
  input.on('data', chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  if (read) transport.installRepoReadCapability({ async read(_call, emit) {
    reads++;
    emit({ success: true, contentItems: [{ type: 'inputText', text: 'bounded page' }] });
  } });
  const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  const initialize = async () => {
    const pending = transport.initialize();
    const frame = writes.at(-1)!;
    send({ id: frame.id, result: {} });
    await pending;
    return frame;
  };
  const thread = async (response: Record<string, unknown> = {}) => {
    const pending = transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' });
    const frame = writes.at(-1)!;
    send({ id: frame.id, result: { thread: { id: threadId, cwd }, cwd, model: 'gpt-6-sol',
      modelProvider: 'openai', approvalPolicy: 'never', approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: target===newTarget||target===target0163||target===historical0163?[]:[cwd],
      activePermissionProfile: { id: 'investigator' }, ...response } });
    return { frame, pending };
  };
  const turn = async () => {
    const pending = transport.startRestrictedTurn({ threadId, profileId: 'investigator', text: 'Inspect.' });
    const frame = writes.at(-1)!;
    send({ id: frame.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    await pending;
    return frame;
  };
  return { transport, writes, output, send, initialize, thread, turn,
    get terminated() { return terminated; }, get reads() { return reads; } };
}

test('0.163 preserves bounded requests and scoped reads, ignores partial answers until one final succeeds',async()=>{
  const p=pair(target0163,true);
  try{
    assert.deepEqual((await p.initialize()).params,{clientInfo:{name:'repo-conduit',version:'0.1.0'},
      capabilities:{experimentalApi:true,requestAttestation:false}});
    const {frame,pending}=await p.thread();assert.equal(await pending,threadId);
    const params=frame.params as Record<string,unknown>;
    assert.deepEqual(params.runtimeWorkspaceRoots,[]);assert.deepEqual(params.environments,[]);
    assert.equal(params.permissions,'investigator');assert.equal(params.approvalPolicy,'never');
    assert.equal(params.allowProviderModelFallback,false);assert.equal((params.dynamicTools as unknown[]).length,1);
    const turn=await p.turn();const turnParams=turn.params as Record<string,unknown>;
    assert.deepEqual(turnParams.runtimeWorkspaceRoots,[]);assert.deepEqual(turnParams.environments,[]);
    assert.deepEqual(turnParams.input,[{type:'text',text:'Inspect.',text_elements:[]}]);
    assert.equal(turnParams.permissions,'investigator');assert.equal(turnParams.approvalPolicy,'never');
    assert.ok(turnParams.outputSchema);
    const outcome=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
    p.send({method:'warning',params:{message:'synthetic',threadId}});
    p.send(retryError());
    p.send({id:'read-0163',method:'item/tool/call',params:{threadId,turnId,callId:'call-0163',
      namespace:'repo',tool:'read',arguments:{path:'src/a.ts'}}});
    await Promise.resolve();await Promise.resolve();assert.equal(p.reads,1);
    for(const [id,phase,text] of [['partial','partial_answer','not a result'],['final','final_answer','final JSON']])
      p.send({method:'item/completed',params:{threadId,turnId,completedAtMs:1,
        item:{type:'agentMessage',id,phase,text}}});
    p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',itemsView:'notLoaded',items:[]}}});
    assert.deepEqual((await outcome).candidate,{itemId:'final',text:'final JSON'});
    assert.equal(p.writes.filter(frame=>frame.method==='turn/start').length,1);assert.equal(p.terminated,0);
  }finally{p.transport.close();}
});

test('0.163 partial-only result is not a final; unknown phases and late final items still reject',async()=>{
  for(const phase of ['partial_answer','future_phase']){
    const p=pair(target0163);try{
      await p.initialize();await (await p.thread()).pending;await p.turn();
      const outcome=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
      const check=phase==='partial_answer'?outcome.then(value=>assert.equal(value.candidate,null)):
        assert.rejects(outcome,/PROTOCOL_REJECTED/);
      p.send({method:'item/completed',params:{threadId,turnId,completedAtMs:1,
        item:{type:'agentMessage',id:'partial',phase,text:'untrusted'}}});
      p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
      await check;
      if(phase==='partial_answer'){
        p.send({method:'item/completed',params:{threadId,turnId,completedAtMs:2,
          item:{type:'agentMessage',id:'late',phase:'final_answer',text:'late'}}});
        assert.equal(p.terminated,1);
      }
    }finally{p.transport.close();}
  }
});

test('prior 0.163 target retains the reviewed partial-answer parser for historical records',async()=>{
 const p=pair(historical0163);try{
  await p.initialize();await (await p.thread()).pending;await p.turn();
  const outcome=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
  p.send({method:'item/completed',params:{threadId,turnId,completedAtMs:1,
   item:{type:'agentMessage',id:'partial',phase:'partial_answer',text:'not final'}}});
  p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
  assert.equal((await outcome).candidate,null);
 }finally{p.transport.close();}
});

test('0.163 keeps root, profile and tool refusal despite accepting the newer notification schema',async()=>{
  for(const patch of [{runtimeWorkspaceRoots:[cwd]},{activePermissionProfile:{id:'other'}},
    {sandbox:{type:'workspaceWrite',networkAccess:false}}]){
    const p=pair(target0163);try{
      await p.initialize();await assert.rejects((await p.thread(patch)).pending,/PROTOCOL_REJECTED/);
    }finally{p.transport.close();}
  }
  const p=pair(target0163,true);try{
    await p.initialize();await (await p.thread()).pending;await p.turn();
    p.send({id:'wrong-0163',method:'item/tool/call',params:{threadId,turnId,callId:'wrong-call',
      namespace:'repo',tool:'execute',arguments:{path:'src/a.ts'}}});
    assert.equal(p.reads,0);assert.equal(p.terminated,1);
  }finally{p.transport.close();}
});

test('current native completed item supplies a final only after its exact successful turn', async () => {
 for(const itemsView of [undefined,'summary','notLoaded']){
  const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;await p.turn();
  const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
  let settled=false;void pending.then(()=>{settled=true;});
  const item={type:'agentMessage',id:'final-item',phase:'final_answer',text:'final JSON'};
  const completed={method:'item/completed',params:{threadId,turnId,completedAtMs:1,item}};
  p.send(completed);p.send(completed);
  await new Promise<void>(done=>setImmediate(done));assert.equal(settled,false);
  p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[],
    ...(itemsView?{itemsView}:{})}}});
  assert.deepEqual((await pending).candidate,{itemId:'final-item',text:'final JSON'});
  p.transport.close();
 }
});

test('completed items never substitute a foreign, asynchronous or failed result', async () => {
  for(const mode of ['foreign','async','commentary','failed','historical'] as const){
    const p=pair(mode==='historical'?lastHistoricalTarget:newTarget);
    await p.initialize();await (await p.thread()).pending;await p.turn();
    const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
    p.send({method:'item/completed',params:{threadId:mode==='foreign'?'foreign':threadId,
      turnId,completedAtMs:1,item:{type:'agentMessage',id:'final-item',
       phase:mode==='commentary'?'commentary':'final_answer',
       ...(mode==='async'?{delivery:'async'}:{}),text:'final JSON'}}});
    p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,
      status:mode==='failed'?'failed':'completed',items:[]}}});
    assert.equal((await pending).candidate,null);p.transport.close();
  }
});

test('conflicting native completed item identities reject before publication', async () => {
  const p=pair(newTarget);await p.initialize();await (await p.thread()).pending;await p.turn();
  const pending=p.transport.waitForBoundTurn({threadId,turnId,timeoutMs:500});
  for(const text of ['first','changed'])p.send({method:'item/completed',params:{threadId,turnId,
    completedAtMs:1,item:{type:'agentMessage',id:'final-item',phase:'final_answer',text}}});
  p.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
  await assert.rejects(pending,/PROTOCOL_REJECTED/);
});

test('selected 0.162 target sends the bounded 0.160 capabilities and text elements', async () => {
  for (const read of [false, true]) {
    const p = pair(newTarget, read);
    const init = await p.initialize();
    assert.deepEqual((init.params as Record<string, unknown>).capabilities,
      { experimentalApi: read, requestAttestation: false });
    const { frame, pending } = await p.thread();
    assert.equal(await pending, threadId);
    const params = frame.params as Record<string, unknown>;
    assert.equal(params.cwd, cwd);
    assert.equal(params.permissions, 'investigator');
    assert.equal(params.approvalPolicy, 'never');
    assert.deepEqual(params.runtimeWorkspaceRoots, []);
    assert.deepEqual(params.dynamicTools, read ? [{ type: 'namespace', name: 'repo',
      description: 'Read a bounded page of the authorized repository snapshot.',
      tools: [{ type: 'function', name: 'read',
        description: 'Read one bounded source page from the authorized snapshot.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 512 },
            maxBytes: { type: 'integer', minimum: 1, maximum: 8192 },
            maxLines: { type: 'integer', minimum: 1, maximum: 400 },
            cursor: { type: 'string', minLength: 1, maxLength: 2048 } } } }] }] : []);
    const turn = await p.turn();
    assert.deepEqual((turn.params as Record<string, unknown>).input,
      [{ type: 'text', text: 'Inspect.', text_elements: [] }]);
    assert.equal((turn.params as Record<string, unknown>).cwd, cwd);
    assert.deepEqual((turn.params as Record<string, unknown>).runtimeWorkspaceRoots, []);
    assert.ok((turn.params as Record<string, unknown>).outputSchema);
    p.transport.close();
  }
});

test('0.160.0 historical targets retain the bounded 0.160 protocol shape', async () => {
  for(const target of [
    'windows-desktop-26.930.3930.0-codex-0.160.0',
    'windows-desktop-26.930.4958.0-codex-0.160.0',
  ] as const){
    const p=pair(target);
    const initialized=await p.initialize();
    assert.deepEqual((initialized.params as Record<string,unknown>).capabilities,
      {experimentalApi:false,requestAttestation:false});
    await (await p.thread()).pending;
    const turn=await p.turn();
    assert.deepEqual((turn.params as Record<string,unknown>).input,
      [{type:'text',text:'Inspect.',text_elements:[]}]);
    p.transport.close();
  }
});

test('7945 historical target retains the bounded protocol shape for recovery', async () => {
  const p=pair(lastHistoricalTarget);
  const initialized=await p.initialize();
  assert.deepEqual((initialized.params as Record<string,unknown>).capabilities,
    {experimentalApi:false,requestAttestation:false});
  await (await p.thread()).pending;
  const turn=await p.turn();
  assert.deepEqual((turn.params as Record<string,unknown>).input,
    [{type:'text',text:'Inspect.',text_elements:[]}]);
  p.transport.close();
});

test('new target keeps dynamic repo.read scoped and rejects wrong tool', async () => {
  const p = pair(newTarget, true);
  await p.initialize(); await (await p.thread()).pending; await p.turn();
  const request = { id: 'srv-1', method: 'item/tool/call', params: { threadId, turnId,
    callId: 'call-1', namespace: 'repo', tool: 'read', arguments: { path: 'src/a.ts' } } };
  p.send(request);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(p.reads, 1);
  assert.deepEqual(p.writes.at(-1), { id: 'srv-1', result: { success: true,
    contentItems: [{ type: 'inputText', text: 'bounded page' }] } });
  p.send({ ...request, id: 'srv-2', params: { ...request.params, callId: 'call-2', tool: 'execute' } });
  assert.equal(p.terminated, 1);
  assert.equal(p.reads, 1);
});

test('new target rejects invalid profile, cwd and native sandbox without binding', async () => {
  const p = pair(newTarget);
  await p.initialize();
  await assert.rejects(p.transport.startRestrictedThread({ cwd: '../outside', profileId: 'investigator', model: 'gpt-6-sol' }), /INVALID_ARGUMENT/);
  await assert.rejects(p.transport.startRestrictedThread({ cwd, profileId: 'bad profile', model: 'gpt-6-sol' }), /INVALID_ARGUMENT/);
  const { pending } = await p.thread({ sandbox: { type: 'workspaceWrite', networkAccess: false } });
  await assert.rejects(pending, /PROTOCOL_REJECTED/);
  assert.equal(p.terminated, 1);
});

test('old targets preserve exact initialize and text payloads; unknown target fails', async () => {
  const p = pair(oldTarget);
  assert.deepEqual((await p.initialize().then(x => x.params) as Record<string, unknown>).capabilities,
    { experimentalApi: false });
  await (await p.thread()).pending;
  const oldTurn = await p.turn();
  assert.deepEqual((oldTurn.params as Record<string, unknown>).input, [{ type: 'text', text: 'Inspect.' }]);
  p.transport.close();
  const q = pair('wsl-codex-0.157.1');
  assert.deepEqual(((await q.initialize()).params as Record<string, unknown>).capabilities,
    { experimentalApi: false });
  q.transport.close();
  assert.throws(() => pair('windows-desktop-any' as CodexProtocolTarget), /INVALID_ARGUMENT/);
});

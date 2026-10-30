import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { ContextRevision } from '../../src/core/collaboration/context.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { DispatchService } from '../../src/application/dispatch.js';
import { normalizeCodexFailureCode, runCodexModelInvestigation } from '../../src/runtime/codex-model-investigation.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';

const at = new Date('2026-10-03T00:00:00.000Z');
const target = 'windows-desktop-codex-0.163.0-alpha.11' as const;
const cwd = 'C:\\investigator\\fixture';
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function fixture(question = 'Trace flow', maxWallSeconds = 60, syntheticLaunchQualification = false,
  maxToolCalls = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-codex-model-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'workspace', canonicalRoot: cwd, registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'investigate', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: cwd });
  base.insertGrant({ id: 'grant', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const snapshot = createSnapshotFromFiles('copy', 'abc', { 'src/main.ts': Buffer.from('export const answer = 42;\n') });
  const contextRevision: ContextRevision = { kind: 'revision', id: 'ctx', workspaceId: 'ws', collaborationId: 'col',
    parentRevisionId: null, snapshotId: snapshot.id, sourceProposalId: 'proposal', sourceRefs: ['source'],
    content: { goal: 'Trace the answer', constraints: [], acceptedDecisions: [], rejectedDecisions: [],
      currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] }, acceptedBy: 'p' };
  const store = new SqliteInvestigationStore(file, { verifyIsolation: e => e === 'isolated',
    verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
    verifyWindowsLaunch: () => syntheticLaunchQualification });
  const record: InvestigationRecord = { id: 'inv', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant', profileRef: 'readonly', budgetRef: 'budget',
    budget: { maxWallSeconds, maxTurns: 3, maxToolCalls }, contextRevisionId: 'ctx', snapshotRef: snapshot.id,
    question, scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] },
    requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued', cancelRequested: false,
    attempts: [], result: null, createdAt: at.toISOString() };
  store.enqueue(record, 'one', 'one');
  const claim = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'isolated',
    profileRevision: 'readonly', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const input = new PassThrough(); const output = new PassThrough(); const errors = new PassThrough();
  const exited = new EventEmitter();
  const writes: {id:number;method:string;params:Record<string,unknown>}[] = [];
  let terminated = 0;
  input.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) {
    const frame = JSON.parse(line) as {id?:number;method:string;params:Record<string,unknown>};
    if (frame.id) writes.push(frame as typeof writes[number]);
  } });
  const connection = { input, output, errors, exited, terminate() { terminated++; } };
  const run = (signal?: AbortSignal, effectiveStore = store,
    owned?:NonNullable<Parameters<typeof runCodexModelInvestigation>[0]['owned']>) => runCodexModelInvestigation({store:effectiveStore,
    claim, contextRevision, snapshot,
    connection, runtime: { protocolTarget: target, cwd, profileId: 'investigator', model: 'gpt-6-sol' },
    now: () => at, ...(signal ? {signal} : {}),...(owned?{owned}:{}) });
  const waitMethod = async (method: string) => { for (let i=0;i<20;i++) {
    if (writes.at(-1)?.method === method) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  } assert.equal(writes.at(-1)?.method,method); };
  const respond = (result: unknown) => output.write(`${JSON.stringify({id:writes.at(-1)!.id,result})}\n`);
  const notify = (status: string, items: unknown[]) => output.write(`${JSON.stringify({method:'turn/completed',
    params:{threadId,turn:{id:turnId,status,items}}})}\n`);
  return { dir, file, base, store, claim, snapshot, contextRevision, connection, writes,
    run, waitMethod, respond, notify, output, get terminated() {return terminated;}, close() { store.close(); base.close();
      rmSync(dir,{recursive:true,force:true}); } };
}

const threadResponse = { thread: {id:threadId,cwd}, cwd, model:'gpt-6-sol', modelProvider:'openai',
  approvalPolicy:'never', approvalsReviewer:'user', sandbox:{type:'readOnly'},
  runtimeWorkspaceRoots:[], activePermissionProfile:{id:'investigator'} };

test('native thread rejection records only a fixed stage and code', async () => {
  const f=fixture();
  try {
    const pending=f.run();
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    f.output.write(`${JSON.stringify({id:f.writes.at(-1)!.id,error:{code:-32000,message:'private provider text'}})}\n`);
    const result=await pending;
    assert.deepEqual(result.failure,{stage:'thread_start',code:'PROTOCOL_REMOTE_ERROR'});
    assert.equal(result.cleanupFailure,undefined);
    assert.equal(JSON.stringify(result).includes('private provider text'),false);
  } finally {f.close();}
});

test('turn response preemption records fixed ingress code without native replay', async () => {
  const f=fixture();
  try {
    const pending=f.run();
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');
    f.output.write(`${JSON.stringify({method:'unknownWarning',params:{message:'private provider text'}})}\n`);
    const result=await pending;
    assert.deepEqual(result.failure,{stage:'turn_start',code:'PROTOCOL_REJECTED_INGEST_NOTIFICATION_UNKNOWN'});
    assert.equal(result.threadId,threadId);
    assert.equal(result.turnId,null);
    assert.equal(f.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(JSON.stringify(result).includes('private provider text'),false);
  } finally {f.close();}
});

test('native categorized error after bound turn leaves candidate empty and does not replay', async () => {
  const f=fixture();
  try {
    const pending=f.run();
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    f.output.write(`${JSON.stringify({method:'error',params:{threadId,turnId,willRetry:true,
      error:{message:'private provider text',codexErrorInfo:'unauthorized'}}})}\n`);
    const result=await pending;
    assert.deepEqual(result.failure,{stage:'wait_turn',code:'PROTOCOL_NATIVE_UNAUTHORIZED'});
    assert.equal(result.candidate,null);
    assert.equal(f.writes.filter(frame=>frame.method==='turn/start').length,1);
    assert.equal(JSON.stringify(result).includes('private provider text'),false);
  } finally {f.close();}
});

test('unknown errors are redacted and cleanup failure cannot overwrite primary failure', async () => {
  const f=fixture();
  const secret='private model/provider path';
  const store=new Proxy(f.store,{get(target,key,receiver){
    if(key==='preflightSourceRead')return ()=>{throw new Error(secret);};
    const value=Reflect.get(target,key,receiver) as unknown;
    return typeof value==='function'?value.bind(target):value;
  }});
  try {
    const result=await runCodexModelInvestigation({store,claim:f.claim,
      contextRevision:f.contextRevision,snapshot:f.snapshot,connection:f.connection,
      runtime:{protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'},now:()=>at,
      owned:{send:line=>{f.connection.input.write(line);return true;},
        stopAndDrain:async()=>{throw new Error(`cleanup ${secret}`);}}});
    assert.deepEqual(result.failure,{stage:'prepare',code:'INTERNAL_ERROR'});
    assert.deepEqual(result.cleanupFailure,{stage:'cleanup',code:'INTERNAL_ERROR'});
    assert.equal(JSON.stringify(result).includes(secret),false);
  } finally {f.close();}
  assert.equal(normalizeCodexFailureCode(new Error(secret)),'INTERNAL_ERROR');
  assert.equal(normalizeCodexFailureCode(new Error('PROTOCOL_REJECTED')),'PROTOCOL_REJECTED');
  assert.equal(normalizeCodexFailureCode({message:'PROTOCOL_REJECTED'}),'INTERNAL_ERROR');
});

test('completed native turn with no complete final records a fixed failure without replay',async()=>{
  const f=fixture();
  try{
    const pending=f.run();await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    f.output.write(JSON.stringify({method:'turn/completed',params:{threadId,
      turn:{id:turnId,status:'completed',items:[],itemsView:'notLoaded'}}})+'\n');
    const result=await pending;
    assert.deepEqual(result.failure,{stage:'result_parse',code:'PROTOCOL_NO_FINAL_INCOMPLETE_VIEW'});
    assert.equal(result.candidate,null);
    assert.equal(f.writes.filter(frame=>frame.method==='turn/start').length,1);
  }finally{f.close();}
});

test('invalid model result records only a fixed parse failure', async () => {
  const f=fixture();
  try {
    const pending=f.run();
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    f.notify('completed',[{type:'agentMessage',id:'item-1',phase:'final_answer',text:'invalid result'}]);
    const result=await pending;
    assert.deepEqual(result.failure,{stage:'result_parse',code:'INVALID_INVESTIGATION_RESULT'});
    assert.equal(result.candidate,null);
  } finally {f.close();}
});

test('owned synchronous sender rechecks revoked source authority before native thread bytes',async()=>{
 const f=fixture();
 const guarded=new Proxy(f.store,{get(target,key,receiver){
  if(key==='beginNativeThreadIntent')return (...args:Parameters<typeof target.beginNativeThreadIntent>)=>{
   const result=target.beginNativeThreadIntent(...args);f.base.revokeGrant('read',at.toISOString());return result;
  };
  const value=Reflect.get(target,key,receiver) as unknown;
  return typeof value==='function'?value.bind(target):value;
 }});
 try{
  const pending=runCodexModelInvestigation({store:guarded,claim:f.claim,contextRevision:f.contextRevision,snapshot:f.snapshot,
   connection:f.connection,runtime:{protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'},now:()=>at,
   owned:{send:line=>{f.connection.input.write(line);return true;},stopAndDrain:async()=>{f.output.end();}}});
  await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
  const result=await pending;
  assert.equal(f.writes.some(frame=>frame.method==='thread/start'),false);
  assert.equal(result.candidate,null);assert.equal(f.store.listUnsettled().length,1);
 }finally{f.close();}
});

test('runtime mutation during source preflight refuses initialize before any native send', async () => {
  const f = fixture();
  try {
    const runtime = {protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'};
    let checked = false;
    const store = new Proxy(f.store, {get(object,key,receiver) {
      if (key === 'preflightSourceRead') return (...args:Parameters<typeof object.preflightSourceRead>) => {
        const result = object.preflightSourceRead(...args);
        if (!checked) { checked = true; runtime.profileId = 'other-profile'; }
        return result;
      };
      const value = Reflect.get(object,key,receiver) as unknown;
      return typeof value === 'function' ? value.bind(object) : value;
    }});
    const result = await runCodexModelInvestigation({store,claim:f.claim,
      contextRevision:f.contextRevision,snapshot:f.snapshot,connection:f.connection,runtime,now:()=>at});
    assert.equal(checked,true);
    assert.equal(result.candidate,null);
    assert.equal(f.writes.length,0);
    assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
  } finally {f.close();}
});

for(const mutationPoint of ['fourth-preflight','after-fourth-preflight-now'] as const){
  test(`runtime ${mutationPoint} refuses initialize before native send`,async()=>{
    const f=fixture('Trace flow',1);
    try{
      const runtime={protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'};
      let checks=0,mutated=false;
      const store=new Proxy(f.store,{get(object,key,receiver){
        if(key==='preflightSourceRead')return (...args:Parameters<typeof object.preflightSourceRead>)=>{
          checks++;
          const value=object.preflightSourceRead(...args);
          if(mutationPoint==='fourth-preflight'&&checks===4){
            runtime.profileId='changed';mutated=true;
          }
          return value;
        };
        const value=Reflect.get(object,key,receiver) as unknown;
        return typeof value==='function'?value.bind(object):value;
      }});
      const now=()=>{
        if(mutationPoint==='after-fourth-preflight-now'&&checks>=4&&!mutated){
          runtime.profileId='changed';mutated=true;
        }
        return at;
      };
      const result=await runCodexModelInvestigation({store,claim:f.claim,
        contextRevision:f.contextRevision,snapshot:f.snapshot,connection:f.connection,runtime,now});
      assert.equal(checks>=4,true);
      assert.equal(mutated,true);
      assert.equal(f.writes.length,0);
      assert.equal(result.candidate,null);
      assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
      assert.equal(f.store.get('inv')?.state,'recovery_required');
    }finally{f.close();}
  });
}

for (const state of ['intent', 'observed', 'recovery_required'] as const) {
  test(`supplied protocol connection cannot bypass ${state} Windows process launch journal`, async () => {
    const f = fixture('Trace flow', 60, true);
    try {
      const sourceDigest = 'a'.repeat(64);
      const privateRoot = 'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
      const reserved = f.store.reserveWindowsSourceView(f.claim, {
        attemptId: f.claim.attemptId, workspaceId: 'ws', workerEpoch: f.claim.workerEpoch, sourceDigest,
      }, privateRoot, ['src/main.ts'], at);
      const prepared = f.store.confirmWindowsSourcePrepared(reserved, {
        sourceDigest, viewPath: `${privateRoot}\\${f.claim.attemptId}.view`, isolationVerified: false,
      }, at);
      const launch = f.store.beginWindowsAppServerLaunch(prepared, {
        collaborationId: 'col', sourceDigest, profileRevision: 'readonly', permissionEpoch: 0,
        protocolTarget: target, recipe: 'windows_app_server_readonly_v1',
        hostScopeId: '33333333-3333-4333-8333-333333333333',
        executionInstanceId: '44444444-4444-4444-8444-444444444444',
        runtimeId: '55555555-5555-4555-8555-555555555555', configSha256: 'b'.repeat(64),
      }, at);
      if (state !== 'intent') f.store.recordWindowsLaunchObservation(launch, {
        pid: 42, creationFiletime: '134040960000000001',
        hostScopeId: launch.binding.hostScopeId, executionInstanceId: launch.binding.executionInstanceId,
      }, at);
      if (state === 'recovery_required') f.store.markWindowsLaunchRecoveryRequired(launch, at);
      const controller = new AbortController();
      f.connection.input.once('data', () => controller.abort());
      const result = await runCodexModelInvestigation({store: f.store, claim: prepared,
        contextRevision: f.contextRevision, snapshot: f.snapshot, connection: f.connection,
        runtime: {protocolTarget: target, cwd, profileId: 'investigator', model: 'gpt-6-sol'},
        signal: controller.signal, now: () => at});
      assert.equal(f.writes.length, 0);
      assert.equal(f.terminated, 0);
      assert.equal(result.threadId, null);
      assert.equal(result.candidate, null);
      assert.equal(f.store.getNativeJournal(prepared, 'col'), null);
      assert.equal(f.store.getWindowsLaunch(prepared)?.launchId, launch.launchId);
      assert.equal(f.store.getWindowsLaunch(prepared)?.state, 'recovery_required');
      assert.equal(f.store.get('inv')?.result, null);
      assert.equal(f.store.listUnsettled().length, 1);
      const peer = new SqliteInvestigationStore(f.file);
      let sourceCloseCalls = 0;
      try {
        const before = peer.listUnsettled();
        await runInvestigationCleanupTick(peer, 'cleanup', undefined, before, undefined, undefined, {
          close: async (descriptor, root) => {
            sourceCloseCalls++;
            return {kind: 'closed', descriptor, viewPath: `${root}\\${descriptor.attemptId}.view`,
              isolationVerified: false};
          },
        });
        assert.equal(sourceCloseCalls, 0);
        assert.deepEqual(peer.listUnsettled(), before);
        assert.equal(peer.getWindowsLaunch(before[0]!)?.launchId, launch.launchId);
      } finally { peer.close(); }
    } finally { f.close(); }
  });
}

test('journaled Windows single attempt returns syntax-only candidate and keeps occupied slot', async () => {
  const f = fixture();
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.thread.state,'intent');
    f.respond(threadResponse); await f.waitMethod('turn/start');
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.turns[0]?.state,'intent');
    f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    const raw = JSON.stringify({kind:'investigation_result_v1',requestId:'inv',attemptId:f.claim.attemptId,
      resultState:'completed',snapshotRef:f.snapshot.id,contextRevisionId:'ctx',findings:[],
      evidence:[{path:'src/main.ts',symbol:null,lineRange:[1,1],byteRange:[0,1],
        contentHash:'a'.repeat(64),excerpt:'e',toolReceipt:'fake-receipt'}],
      coverage:{searchedScope:['src/main.ts'],excludedCategories:[],truncated:true,missingDependencies:[]},
      openQuestions:[],limitsAndWarnings:[]});
    // A small valid streamed answer can have more than 256 token-level events.
    for(let i=0;i<512;i++)f.output.write(`${JSON.stringify({method:'item/agentMessage/delta',
      params:{threadId,turnId,itemId:'item-1',delta:'x'}})}\n`);
    f.notify('completed',[{type:'agentMessage',id:'item-1',phase:'final_answer',text:raw}]);
    const result = await pending;
    assert.equal(result.kind,'codex_investigation_protocol_observation');
    assert.equal(result.threadId,threadId); assert.equal(result.turnId,turnId);
    assert.equal(result.terminalStatus,'completed');
    assert.equal(result.candidate?.itemId,'item-1');
    assert.equal(result.candidate?.rawBytesSha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(f.store.get('inv')?.result,null);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.store.listUnsettled().length,1);
    assert.equal(f.terminated,0);
  } finally { f.close(); }
});

for (const sameReceipt of [true, false]) {
  test(`Codex result counts ${sameReceipt ? 'one reused' : 'two distinct'} read receipts under a one-call budget`, async () => {
    const f = fixture('Trace flow', 60, false, 1);
    try {
      const pending = f.run();
      await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
      await f.waitMethod('thread/start'); f.respond(threadResponse);
      await f.waitMethod('turn/start'); f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
      const evidence = [
        {path:'src/main.ts',symbol:null,lineRange:[1,1],byteRange:[0,1],
          contentHash:'a'.repeat(64),excerpt:'e',toolReceipt:'receipt-1'},
        {path:'src/main.ts',symbol:null,lineRange:[1,1],byteRange:[1,2],
          contentHash:'a'.repeat(64),excerpt:'x',toolReceipt:sameReceipt?'receipt-1':'receipt-2'},
      ];
      const raw = JSON.stringify({kind:'investigation_result_v1',requestId:'inv',attemptId:f.claim.attemptId,
        resultState:'completed',snapshotRef:f.snapshot.id,contextRevisionId:'ctx',findings:[],evidence,
        coverage:{searchedScope:['src/main.ts'],excludedCategories:[],truncated:true,missingDependencies:[]},
        openQuestions:[],limitsAndWarnings:[]});
      f.notify('completed',[{type:'agentMessage',id:'item-1',phase:'final_answer',text:raw}]);
      const result = await pending;
      assert.equal(result.candidate !== null,sameReceipt);
      assert.equal(result.candidate?.evidenceStatus,sameReceipt?'syntax_only':undefined);
      if (!sameReceipt) assert.deepEqual(result.failure,
        {stage:'result_parse',code:'INVALID_INVESTIGATION_RESULT'});
      assert.equal(f.store.get('inv')?.result,null);
      assert.equal(f.store.listUnsettled().length,1);
    } finally { f.close(); }
  });
}

test('oversize prompt refuses native start and keeps the claim for recovery', async () => {
  const f = fixture('x'.repeat(20_000));
  try {
    const result = await f.run();
    assert.equal(result.threadId,null);
    assert.equal(result.candidate,null);
    assert.equal(f.writes.length,0);
    assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('abort of exact bound turn records interrupt acknowledgment without terminal or slot release', async () => {
  const f = fixture(); const controller = new AbortController();
  try {
    const pending = f.run(controller.signal);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start'); f.respond(threadResponse);
    await f.waitMethod('turn/start'); f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    controller.abort();
    await f.waitMethod('turn/interrupt'); f.respond({});
    const result = await pending;
    assert.deepEqual(result.failure,{stage:'wait_turn',code:'PROTOCOL_ABORTED'});
    assert.equal(result.terminalStatus,null);
    assert.equal(result.candidate,null);
    assert.deepEqual(f.store.getNativeJournal(f.claim,'col')?.turns,
      [{intentId:f.store.getNativeJournal(f.claim,'col')!.turns[0]!.intentId,
        turnId,state:'observed',interruptAcknowledged:true}]);
    assert.equal(f.store.get('inv')?.result,null);
    assert.equal(f.store.listUnsettled().length,1);
    assert.equal(f.terminated,0);
  } finally {f.close();}
});

test('recovery takeover fences abort interrupt, transport termination and old-owner recovery write', async () => {
  const f = fixture(); const controller = new AbortController();
  let pending: ReturnType<typeof runCodexModelInvestigation> | undefined;
  try {
    const descriptor = {attemptId:f.claim.attemptId,workspaceId:'ws',
      workerEpoch:f.claim.workerEpoch,sourceDigest:'a'.repeat(64)};
    const reserved = f.store.reserveWindowsSourceView(f.claim,descriptor,
      'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator',['src/main.ts'],at);
    pending = f.run(controller.signal);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start'); f.respond(threadResponse);
    await f.waitMethod('turn/start'); f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const later = new Date(at.getTime()+30_001);
    assert.throws(() => f.store.acquireWindowsSourceCleanupLease(reserved,'cleanup',later), StoreConflict);
    const takeover = f.store.recoverAttempt(reserved,{workerId:'recovery',isolationEvidence:'isolated',
      profileRevision:'readonly',permissionEpoch:0,launchProtocol:'resource_reservation_v1',now:later});
    assert.ok(takeover); assert.notEqual(takeover.workerEpoch,f.claim.workerEpoch);
    controller.abort();
    const result = await pending;
    assert.equal(result.candidate,null);
    assert.equal(f.writes.filter(item=>item.method==='turn/interrupt').length,0);
    assert.equal(f.terminated,0);
    assert.equal(f.store.listUnsettled().length,1);
    assert.equal(f.store.getNativeJournal(takeover,'col')?.turns[0]?.interruptAcknowledged,false);
  } finally {controller.abort(); await pending?.catch(()=>undefined); f.close();}
});

test('lost native response preserves thread intent and occupied slot without replay', async () => {
  const f = fixture();
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    f.output.emit('error',new Error('connection failed'));
    const result = await pending;
    assert.equal(result.threadId,null);
    assert.equal(f.writes.filter(item=>item.method==='thread/start').length,1);
    assert.deepEqual(f.store.getNativeJournal(f.claim,'col')?.thread,{state:'intent',threadId:null});
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('short saved wall budget bounds unanswered initialize RPC without a native intent', async () => {
  const f = fixture('Trace flow',1);
  try {
    const started = performance.now();
    const pending = f.run();
    await f.waitMethod('initialize');
    const result = await pending;
    assert.ok(performance.now()-started < 3000);
    assert.equal(result.threadId,null);
    assert.equal(f.writes.filter(item=>item.method==='thread/start').length,0);
    assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.terminated,0);
  } finally {f.close();}
});

test('original owner elapsed prepare time reduces coordinator work and retained cleanup reserve', async () => {
  const f=fixture(),abort=new AbortController();let stopped=0;
  try {
    const owner={remainingWallMs:()=>10_400,send:(line:string)=>{f.connection.input.write(line);return true as const;},
      async stopAndDrain(){stopped++;f.output.end();f.connection.errors.end();}};
    const started=performance.now();
    const fallback=setTimeout(()=>abort.abort(),1500);
    const result=await f.run(abort.signal,f.store,owner);clearTimeout(fallback);
    assert.ok(performance.now()-started<1000);
    assert.equal(f.writes.filter(item=>item.method==='initialize').length,1);
    assert.equal(f.writes.filter(item=>item.method==='thread/start').length,0);
    assert.equal(stopped,1);assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  }finally{f.close();}
});

test('owner reserve exhaustion or invalid callback refuses every protocol send', async () => {
  for(const remainingWallMs of [()=>10_000,()=>Number.NaN,()=>{throw new Error('PRIVATE_OWNER_ERROR');},
    (()=>{let n=0;return ()=>++n===1?20_000:21_000;})()]){
    const f=fixture(),abort=new AbortController();let stopped=0;
    try {
      const owner={remainingWallMs,send:(line:string)=>{f.connection.input.write(line);return true as const;},
        async stopAndDrain(){stopped++;f.output.end();f.connection.errors.end();}};
      const fallback=setTimeout(()=>abort.abort(),100);
      const result=await f.run(abort.signal,f.store,owner);clearTimeout(fallback);
      assert.equal(f.writes.length,0);assert.equal(stopped,1);
      assert.equal(result.candidate,null);assert.equal(f.store.listUnsettled().length,1);
      assert.equal(JSON.stringify(result).includes('PRIVATE_OWNER_ERROR'),false);
    }finally{f.close();}
  }
});

test('owned read session persists the earlier work deadline after prepare time',async()=>{
  const f=fixture();let savedDeadline:Date|undefined,stopped=0;
  const readStore=new Proxy(f.store,{get(target,key,receiver){
    if(key==='prepareCodexReadSession')return (_claim:unknown,_binding:unknown,deadline:Date)=>{
      savedDeadline=deadline;throw new Error('STOP_AFTER_DEADLINE');};
    const value:unknown=Reflect.get(target,key,receiver);
    return typeof value==='function'?value.bind(target):value;
  }});
  const binding={collaborationId:'col',workingCopyId:'copy',snapshotId:f.snapshot.id,
    paths:['src/main.ts'],workerGrantId:'worker-read',workerAudience:'investigator',
    workerRecipient:'codex-local'};
  const owned={remainingWallMs:()=>15_000,send:(line:string)=>{f.connection.input.write(line);return true as const;},
    async stopAndDrain(){stopped++;f.output.end();f.connection.errors.end();}};
  try{
    const result=await runCodexModelInvestigation({store:readStore,claim:f.claim,
      contextRevision:f.contextRevision,snapshot:f.snapshot,connection:f.connection,
      runtime:{protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'},
      read:{binding,dispatcher:{dispatch:async()=>null} as unknown as Pick<DispatchService,'dispatch'>},
      owned,now:()=>at});
    assert.equal(savedDeadline?.getTime(),at.getTime()+5000);
    assert.equal(f.writes.length,0);assert.equal(stopped,1);
    assert.equal(result.candidate,null);assert.equal(f.store.listUnsettled().length,1);
  }finally{f.close();}
});

for(const ownerLeft of [11_000,5_000])
test(`owned abort with ${ownerLeft}ms left sequences interrupt then original stop when time permits`,async()=>{
  const f=fixture(),controller=new AbortController();let remainingOwner=60_000;
  const order:string[]=[];
  f.connection.input.on('data',(chunk:Buffer)=>{
    if(String(chunk).includes('turn/interrupt'))order.push('interrupt');
  });
  const owned={remainingWallMs:()=>remainingOwner,
    send:(line:string)=>{f.connection.input.write(line);return true as const;},
    async stopAndDrain(){order.push('stop');f.output.end();f.connection.errors.end();}};
  try{
    const pending=f.run(controller.signal,f.store,owned);
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    remainingOwner=ownerLeft;controller.abort();
    if(ownerLeft>10_000){await f.waitMethod('turn/interrupt');f.respond({});}
    const result=await pending;
    assert.deepEqual(order,ownerLeft>10_000?['interrupt','stop']:['stop']);
    assert.equal(result.candidate,null);assert.equal(f.store.listUnsettled().length,1);
  }finally{controller.abort();f.close();}
});

test('owned work timeout interrupts bound turn before original stop and leaves unknown slot',async()=>{
  const f=fixture(),abort=new AbortController();const order:string[]=[];let interruptSeen!:()=>void;
  const interrupted=new Promise<void>(resolve=>{interruptSeen=resolve;});
  f.connection.input.on('data',(chunk:Buffer)=>{
    if(String(chunk).includes('turn/interrupt')){order.push('interrupt');interruptSeen();}
  });
  const owned={remainingWallMs:()=>10_400,
    send:(line:string)=>{f.connection.input.write(line);return true as const;},
    async stopAndDrain(){order.push('stop');f.output.end();f.connection.errors.end();}};
  try{
    const fallback=setTimeout(()=>abort.abort(),1500);
    const pending=f.run(abort.signal,f.store,owned);
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await Promise.race([interrupted,pending.then(()=>{throw new Error('INTERRUPT_MISSING');})]);
    f.respond({});
    const result=await pending;clearTimeout(fallback);
    assert.deepEqual(order,['interrupt','stop']);
    assert.deepEqual(result.failure,{stage:'wait_turn',code:'PROTOCOL_TIMEOUT'});
    assert.equal(result.candidate,null);assert.equal(f.store.listUnsettled().length,1);
  }finally{abort.abort();f.close();}
});

test('synchronous interrupt send cannot spend the original stop reserve while no reply arrives',async()=>{
  const f=fixture(),abort=new AbortController();let ownerLeft=60_000,stopped=0;
  const owned={remainingWallMs:()=>ownerLeft,
    send:(line:string)=>{f.connection.input.write(line);
      if(line.includes('turn/interrupt'))ownerLeft=5_000;
      return true as const;},
    async stopAndDrain(){stopped++;f.output.end();f.connection.errors.end();}};
  try{
    const pending=f.run(abort.signal,f.store,owned);
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    ownerLeft=5_400;
    const started=performance.now();abort.abort();
    const result=await pending;
    assert.ok(performance.now()-started<300,'interrupt wait consumed the stop reserve');
    assert.equal(f.writes.filter(item=>item.method==='turn/interrupt').length,1);
    assert.equal(stopped,1);assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  }finally{abort.abort();f.close();}
});

test('cleanup binding check consuming owner reserve suppresses interrupt and keeps unknown turn',async()=>{
  const f=fixture(),abort=new AbortController();let ownerLeft=60_000,stopped=0;
  const checkedStore=new Proxy(f.store,{get(target,key,receiver){
    if(key==='assertNativeTurnBinding')return (...args:Parameters<typeof target.assertNativeTurnBinding>)=>{
      const result=target.assertNativeTurnBinding(...args);
      if(abort.signal.aborted)ownerLeft=5_000;
      return result;
    };
    const value:unknown=Reflect.get(target,key,receiver);
    return typeof value==='function'?value.bind(target):value;
  }});
  const owned={remainingWallMs:()=>ownerLeft,
    send:(line:string)=>{f.connection.input.write(line);return true as const;},
    async stopAndDrain(){stopped++;f.output.end();f.connection.errors.end();}};
  try{
    const pending=f.run(abort.signal,checkedStore,owned);
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    ownerLeft=5_400;abort.abort();
    const result=await pending;
    assert.equal(f.writes.filter(item=>item.method==='turn/interrupt').length,0);
    assert.equal(stopped,1);assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  }finally{abort.abort();f.close();}
});

test('short saved wall budget bounds unanswered thread start and preserves its intent', async () => {
  const f = fixture('Trace flow',1);
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    const result = await pending;
    assert.equal(result.threadId,null);
    assert.deepEqual(f.store.getNativeJournal(f.claim,'col')?.thread,{state:'intent',threadId:null});
    assert.equal(f.writes.filter(item=>item.method==='turn/start').length,0);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.terminated,0);
  } finally {f.close();}
});

test('abort during initialize returns promptly without starting thread or terminating process', async () => {
  const f = fixture(); const controller = new AbortController();
  try {
    const pending = f.run(controller.signal);
    await f.waitMethod('initialize'); controller.abort();
    const result = await pending;
    assert.equal(result.threadId,null);
    assert.equal(f.writes.filter(item=>item.method==='thread/start').length,0);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.terminated,0);
  } finally {f.close();}
});

test('synchronous abort on initialize write closes pending RPC without unhandled rejection', async () => {
  const f = fixture(); const controller = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection',onUnhandled);
  try {
    f.connection.input.on('data',(chunk:Buffer) => {
      if (String(chunk).includes('"method":"initialize"')) controller.abort();
    });
    const result = await f.run(controller.signal);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
    assert.equal(result.threadId,null);
    assert.equal(f.store.get('inv')?.state,'recovery_required');
    assert.equal(f.terminated,0);
  } finally {process.off('unhandledRejection',onUnhandled); f.close();}
});

test('abort during turn start leaves exact persisted intent and never guesses native turn ID', async () => {
  const f = fixture(); const controller = new AbortController();
  try {
    const pending = f.run(controller.signal);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start'); f.respond(threadResponse);
    await f.waitMethod('turn/start'); controller.abort();
    const result = await pending;
    assert.equal(result.threadId,threadId);
    assert.equal(result.turnId,null);
    assert.equal(f.writes.filter(item=>item.method==='turn/start').length,1);
    assert.equal(f.writes.filter(item=>item.method==='turn/interrupt').length,0);
    assert.deepEqual(f.store.getNativeJournal(f.claim,'col')?.turns.map(item=>[item.state,item.turnId]),
      [['intent',null]]);
    assert.equal(f.store.listUnsettled().length,1);
    assert.equal(f.terminated,0);
  } finally {f.close();}
});

test('native ID is durable before later permission response rejection', async () => {
  const f = fixture();
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    f.respond({...threadResponse,activePermissionProfile:{id:'wrong-profile'}});
    const result = await pending;
    assert.equal(result.candidate,null);
    assert.equal(result.threadId,threadId);
    assert.equal(result.failure?.stage,'thread_start');
    assert.ok(['PROTOCOL_REJECTED','PROTOCOL_REJECTED_THREAD_PROFILE'].includes(result.failure?.code ?? ''));
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.thread.threadId,threadId);
    assert.equal(f.writes.filter(item=>item.method==='turn/start').length,0);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('cancellation after thread intent prevents turn start and preserves observed native identity', async () => {
  const f = fixture();
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    f.store.requestCancel(f.store.get('inv')!,'cancel-after-thread','grant');
    f.respond(threadResponse);
    const result = await pending;
    assert.equal(result.turnId,null);
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.thread.threadId,threadId);
    assert.equal(f.writes.filter(item=>item.method==='turn/start').length,0);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('source read revocation after native thread start prevents any model turn', async () => {
  const f = fixture();
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');
    f.base.revokeGrant('read',at.toISOString());
    f.respond(threadResponse);
    const result = await pending;
    assert.equal(result.turnId,null);
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.thread.threadId,threadId);
    assert.equal(f.writes.filter(item=>item.method==='turn/start').length,0);
    assert.equal(f.store.get('inv')?.result,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('revocation on initialize response prevents initialized from reaching native input', async () => {
  const f = fixture();
  const sent: string[] = [];
  f.connection.input.on('data', chunk => sent.push(String(chunk)));
  f.output.on('data', chunk => {
    if (String(chunk).includes('"id":1')) f.base.revokeGrant('read',at.toISOString());
  });
  try {
    const pending = f.run();
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    const result = await pending;
    assert.equal(sent.some(line => line.includes('"method":"initialized"')),false);
    assert.equal(f.writes.some(item => item.method==='thread/start'),false);
    assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('revocation during durable thread intent prevents thread start native send', async () => {
  const f = fixture();
  const guarded = new Proxy(f.store,{get(target,key,receiver) {
    if (key === 'beginNativeThreadIntent') return (...args: Parameters<typeof target.beginNativeThreadIntent>) => {
      const result = target.beginNativeThreadIntent(...args);
      f.base.revokeGrant('read',at.toISOString());
      return result;
    };
    const value: unknown = Reflect.get(target,key,receiver);
    return typeof value==='function' ? value.bind(target) : value;
  }});
  try {
    const pending = f.run(undefined,guarded);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    const result = await pending;
    assert.equal(f.writes.some(item => item.method==='thread/start'),false);
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.thread.state,'intent');
    assert.equal(result.threadId,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('corked native input rejects initialized without retaining a frame for later uncork', async () => {
  const f=fixture();
  const sent:string[]=[];
  f.connection.input.on('data',chunk=>sent.push(String(chunk)));
  f.output.on('data',chunk=>{
    if(String(chunk).includes('"id":1')) f.connection.input.cork();
  });
  const guarded=new Proxy(f.store,{get(target,key,receiver){
    if(key==='beginNativeThreadIntent') return (...args:Parameters<typeof target.beginNativeThreadIntent>)=>{
      const result=target.beginNativeThreadIntent(...args);
      f.base.revokeGrant('read',at.toISOString());
      return result;
    };
    const value:unknown=Reflect.get(target,key,receiver);
    return typeof value==='function'?value.bind(target):value;
  }});
  try {
    const pending=f.run(undefined,guarded);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    const result=await pending;
    f.connection.input.uncork();
    assert.equal(sent.some(line=>line.includes('"method":"initialized"')),false);
    assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
    assert.equal(f.writes.some(item=>item.method==='thread/start'),false);
    assert.equal(result.threadId,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.connection.input.uncork(); f.close();}
});

test('original native input error is handled and produces no candidate or replay', async () => {
  const f=fixture();
  try {
    const pending=f.run();
    await f.waitMethod('initialize');
    assert.doesNotThrow(()=>f.connection.input.emit('error',new Error('synthetic EPIPE')));
    const result=await pending;
    assert.equal(result.candidate,null);
    assert.equal(f.writes.length,1);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('unfinished underlying write prevents any queued initialized or later replay',async()=>{
  const f=fixture();const sent:string[]=[];
  let release:(error?:Error|null)=>void=()=>assert.fail('expected held write');
  const original=f.connection.input._write.bind(f.connection.input);
  f.connection.input._write=(chunk,encoding,callback)=>original(chunk,encoding,()=>{release=callback;});
  f.connection.input.on('data',chunk=>sent.push(String(chunk)));
  try {
    const pending=f.run();
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    const result=await pending;
    f.base.revokeGrant('read',at.toISOString());release();
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(sent.length,1);
    assert.equal(result.candidate,null);
    assert.equal(f.store.getNativeJournal(f.claim,'col'),null);
  }finally{f.close();}
});

test('original input asynchronous callback error is handled without retry',async()=>{
  const f=fixture();
  const original=f.connection.input._write.bind(f.connection.input);
  f.connection.input._write=(chunk,encoding,callback)=>original(chunk,encoding,
    ()=>{setImmediate(()=>callback(new Error('synthetic callback EPIPE')));});
  try {
    const result=await f.run();
    assert.equal(result.candidate,null);
    assert.equal(f.writes.length,1);
    assert.equal(f.store.listUnsettled().length,1);
  }finally{f.close();}
});

test('revocation during durable turn intent prevents turn start native send', async () => {
  const f = fixture();
  const guarded = new Proxy(f.store,{get(target,key,receiver) {
    if (key === 'beginNativeTurnIntent') return (...args: Parameters<typeof target.beginNativeTurnIntent>) => {
      const result = target.beginNativeTurnIntent(...args);
      f.base.revokeGrant('read',at.toISOString());
      return result;
    };
    const value: unknown = Reflect.get(target,key,receiver);
    return typeof value==='function' ? value.bind(target) : value;
  }});
  try {
    const pending = f.run(undefined,guarded);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start'); f.respond(threadResponse);
    const result = await pending;
    assert.equal(f.writes.some(item => item.method==='turn/start'),false);
    assert.equal(f.store.getNativeJournal(f.claim,'col')?.turns[0]?.state,'intent');
    assert.equal(result.turnId,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('pre-aborted coordinator sends no native bytes', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const sent: string[]=[];
  f.connection.input.on('data',chunk=>sent.push(String(chunk)));
  try {
    const result=await f.run(controller.signal);
    assert.deepEqual(sent,[]);
    assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('source revocation during asynchronous read suppresses the automatic failure response', async () => {
  const f = fixture();
  const frames: Record<string,unknown>[]=[];
  f.connection.input.on('data',chunk=>{
    for(const line of String(chunk).trim().split('\n')) frames.push(JSON.parse(line) as Record<string,unknown>);
  });
  const readStore = new Proxy(f.store,{get(target,key,receiver) {
    if(key==='prepareCodexReadSession' || key==='assertCodexReadAuthority') return ()=>undefined;
    if(key==='getSucceededCodexReadReceipts') return ()=>[{id:'receipt',callId:'native-call',path:'src/main.ts'}];
    if(key==='discloseCodexRead') return ()=>{
      f.base.revokeGrant('read',at.toISOString());
      throw new Error('NOT_AVAILABLE');
    };
    const value:unknown=Reflect.get(target,key,receiver);
    return typeof value==='function'?value.bind(target):value;
  }});
  const dispatcher={async dispatch(){
    await new Promise<void>(resolve=>setImmediate(resolve));
    return {toolReceipt:'receipt',content:'sensitive-page'};
  }} as unknown as Pick<DispatchService,'dispatch'>;
  const binding={collaborationId:'col',workingCopyId:'copy',snapshotId:f.snapshot.id,
    paths:['src/main.ts'],workerGrantId:'worker-read',workerAudience:'investigator',
    workerRecipient:'codex-local'};
  try {
    const pending=runCodexModelInvestigation({store:readStore,claim:f.claim,
      contextRevision:f.contextRevision,snapshot:f.snapshot,connection:f.connection,
      runtime:{protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'},
      read:{binding,dispatcher},now:()=>at});
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start'); f.respond(threadResponse);
    await f.waitMethod('turn/start'); f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    f.output.write(JSON.stringify({id:'read-request',method:'item/tool/call',params:{threadId,turnId,
      callId:'native-call',namespace:'repo',tool:'read',arguments:{path:'src/main.ts'}}})+'\n');
    for(let i=0;i<100 && !f.base.grantsFor('p','external').find(g=>g.id==='read')?.revokedAt;i++)
      await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(frames.some(frame=>frame.id==='read-request'),false);
    f.output.emit('error',new Error('fixture complete'));
    const result=await pending;
    assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

test('owner work reserve exhausted during an in-flight read emits no successful repo response',async()=>{
  const f=fixture(),frames:Record<string,unknown>[]=[];let ownerLeft=60_000;
  let enterDispatch!:()=>void,resolveDispatch!:(value:unknown)=>void;
  const dispatched=new Promise<void>(resolve=>{enterDispatch=resolve;});
  const pendingRead=new Promise<unknown>(resolve=>{resolveDispatch=resolve;});
  f.connection.input.on('data',chunk=>{
    for(const line of String(chunk).trim().split('\n'))frames.push(JSON.parse(line) as Record<string,unknown>);
  });
  const readStore=new Proxy(f.store,{get(target,key,receiver){
    if(key==='prepareCodexReadSession'||key==='assertCodexReadAuthority')return ()=>undefined;
    if(key==='getSucceededCodexReadReceipts')return ()=>[{id:'receipt',callId:'native-call',path:'src/main.ts'}];
    if(key==='discloseCodexRead')return (_claim:unknown,_binding:unknown,_turn:unknown,_now:unknown,
      emit:()=>void)=>emit();
    const value:unknown=Reflect.get(target,key,receiver);
    return typeof value==='function'?value.bind(target):value;
  }});
  const owned={remainingWallMs:()=>ownerLeft,
    send:(line:string)=>{f.connection.input.write(line);return true as const;},
    async stopAndDrain(){f.output.end();f.connection.errors.end();}};
  const binding={collaborationId:'col',workingCopyId:'copy',snapshotId:f.snapshot.id,
    paths:['src/main.ts'],workerGrantId:'worker-read',workerAudience:'investigator',
    workerRecipient:'codex-local'};
  try{
    const pending=runCodexModelInvestigation({store:readStore,claim:f.claim,
      contextRevision:f.contextRevision,snapshot:f.snapshot,connection:f.connection,
      runtime:{protocolTarget:target,cwd,profileId:'investigator',model:'gpt-6-sol'},
      read:{binding,dispatcher:{dispatch:async()=>{enterDispatch();return pendingRead;}} as unknown as Pick<DispatchService,'dispatch'>},
      owned,now:()=>at});
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    f.output.write(JSON.stringify({id:'read-after-owner-expiry',method:'item/tool/call',params:{threadId,turnId,
      callId:'native-call',namespace:'repo',tool:'read',arguments:{path:'src/main.ts'}}})+'\n');
    await dispatched;ownerLeft=10_000;
    resolveDispatch({toolReceipt:'receipt',content:'SENSITIVE_PAGE'});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(frames.some(frame=>frame.id==='read-after-owner-expiry'&&
      (frame.result as {success?:boolean}|undefined)?.success===true),false);
    f.output.emit('error',new Error('fixture complete'));
    const result=await pending;
    assert.equal(result.candidate,null);assert.equal(f.store.listUnsettled().length,1);
  }finally{f.close();}
});

test('source revocation after bound turn suppresses cleanup interrupt', async () => {
  const f=fixture();const controller=new AbortController();
  try {
    const pending=f.run(controller.signal);
    await f.waitMethod('initialize');f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start');f.respond(threadResponse);
    await f.waitMethod('turn/start');f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    f.base.revokeGrant('read',at.toISOString());controller.abort();
    const result=await pending;
    assert.equal(f.writes.some(item=>item.method==='turn/interrupt'),false);
    assert.equal(result.candidate,null);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

for (const status of ['failed','interrupted'] as const) {
  test(`${status} native terminal is journaled without a candidate or release`,async()=>{
    const f = fixture();
    try {
      const pending = f.run();
      await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
      await f.waitMethod('thread/start'); f.respond(threadResponse);
      await f.waitMethod('turn/start');
      f.notify(status,[]); // May arrive before the turn/start response.
      f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
      const result = await pending;
      assert.equal(result.terminalStatus,status);
      assert.equal(result.candidate,null);
      assert.equal(f.store.getNativeJournal(f.claim,'col')?.turns[0]?.state,'terminal');
      assert.equal(f.store.get('inv')?.result,null);
      assert.equal(f.store.listUnsettled().length,1);
    } finally {f.close();}
  });
}

test('failed recovery write is explicit and does not claim successful completion', async () => {
  const f = fixture();
  try {
    const failing = new Proxy(f.store,{get(target,key,receiver) {
      if (key === 'markRecoveryRequired') return () => {throw new Error('RECOVERY_WRITE_FAILED');};
      const value: unknown = Reflect.get(target,key,receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const pending = f.run(undefined,failing);
    await f.waitMethod('initialize'); f.respond({userAgent:'Codex'});
    await f.waitMethod('thread/start'); f.respond(threadResponse);
    await f.waitMethod('turn/start'); f.respond({turn:{id:turnId,status:'inProgress',items:[]}});
    f.notify('failed',[]);
    await assert.rejects(pending,/RECOVERY_WRITE_FAILED/);
    assert.equal(f.store.listUnsettled().length,1);
  } finally {f.close();}
});

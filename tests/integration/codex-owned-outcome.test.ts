import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore,type CodexSessionClosure} from '../../src/adapters/storage/investigation-sqlite.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

function fixture(notStarted=false,multiFile=false,options:{relatedTests?:string[];begin?:boolean}={}) {
 const root=mkdtempSync(join(tmpdir(),'rcac-codex-owned-')),file=join(root,'state.sqlite'),now=new Date();
 const grants=new SqliteStore(file);
 grants.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:root,registeredBy:'owner'});
 grants.insertCollaboration({id:'col',workspaceId:'ws',openedBy:'owner',purpose:'read',hostThreadId:null,state:'open'});
 grants.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'user',workspaceId:'ws',
  collaborationId:'col',permissions:['investigation.request','investigation.cancel'],expiresAt:null,revokedAt:null});
 grants.insertGrant({id:'read',principal:'external',audience:'chatgpt',recipient:'user',workspaceId:'ws',
  collaborationId:'col',permissions:['data.read'],dataPaths:multiFile?
   ['state.ts','cancel.ts','publish.ts']:['a.ts'],expiresAt:null,revokedAt:null});
 const closure:CodexSessionClosure={sessionId:'original-session',requestId:'inv',attemptId:'',workerEpoch:1,
  ...(notStarted?{kind:'not_started' as const}:{})};
 const store=new SqliteInvestigationStore(file,{verifyIsolation:()=>true,verifyNativeReceipt:()=>false,
  verifyOutcomeReceipt:()=>false,verifyCodexSessionClosure:(_claim,fact)=>fact===closure});
 const record:InvestigationRecord={id:'inv',workspaceId:'ws',collaborationId:'col',workingCopyId:'wc',
  principal:'external',audience:'chatgpt',recipient:'user',grantId:'request',profileRef:'profile',budgetRef:'profile',
  budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2},contextRevisionId:'ctx',snapshotRef:'snapshot',
  question:'Trace',scope:{paths:multiFile?['state.ts','cancel.ts','publish.ts']:['a.ts'],
   symbols:[],relatedTests:options.relatedTests??[]},requestedOutputs:['evidence'],
  parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,createdAt:now.toISOString()};
 store.enqueue(record,'request','same');
 const claim=store.claimRequest('inv',{workerId:'worker',isolationEvidence:'local-native',profileRevision:'profile',
  permissionEpoch:0,now})!;
 closure.attemptId=claim.attemptId;closure.workerEpoch=claim.workerEpoch;
 if(options.begin!==false)store.beginCodexOwnedSession(claim,closure.sessionId,now);
 return {file,store,grants,claim,closure,now,close(){store.close();grants.close();rmSync(root,{recursive:true,force:true});}};
}

function ownedSessionCount(file:string,attemptId:string){
 const db=new DatabaseSync(file,{readOnly:true});
 try{return (db.prepare('SELECT count(*) AS n FROM investigation_codex_owned_sessions WHERE attempt_id=?')
  .get(attemptId) as {n:number}).n;}finally{db.close();}
}

function journalTurn(f:ReturnType<typeof fixture>, turnId='native-turn', now=f.now){
 f.store.beginNativeThreadIntent(f.claim,'col',now);
 f.store.observeNativeThread(f.claim,'col','native-thread');
 f.store.beginNativeTurnIntent(f.claim,'col','turn-intent','native-thread',now);
 f.store.observeNativeTurn(f.claim,'col','turn-intent',turnId,now);
}

test('first owned Codex turn projects running durably without inventing native start or releasing slot',()=>{
 const f=fixture();try{
  f.store.beginNativeThreadIntent(f.claim,'col',f.now);
  f.store.observeNativeThread(f.claim,'col','native-thread');
  f.store.beginNativeTurnIntent(f.claim,'col','turn-intent','native-thread',f.now);
  assert.equal(f.store.get('inv')?.state,'queued');
  f.store.observeNativeTurn(f.claim,'col','turn-intent','native-turn',f.now);
  const expected=f.store.get('inv')!;
  assert.equal(expected.state,'running');
  assert.deepEqual(expected.attempts[0],{id:f.claim.attemptId,state:'running',nativeRef:null,
   workerEpoch:f.claim.workerEpoch,startedAt:null,finishedAt:null,terminationConfirmed:false});
  assert.equal(f.store.listUnsettled().length,1);
  assert.equal(f.store.claimRequest('inv',{workerId:'other',isolationEvidence:'local-native',
   profileRevision:'profile',permissionEpoch:0,now:f.now}),null);
  const peer=new SqliteInvestigationStore(f.file);
  try{
   assert.deepEqual(peer.get('inv'),expected);
   assert.equal(peer.getNativeJournal(f.claim,'col')?.turns[0]?.turnId,'native-turn');
   peer.observeNativeTurn(f.claim,'col','turn-intent','native-turn',f.now);
   assert.deepEqual(peer.get('inv'),expected);
  }finally{peer.close();}
  assert.equal(f.store.listUnsettled().length,1);
 }finally{f.close();}
});

test('native journal without an owned session stays queued',()=>{
 const f=fixture(false,false,{begin:false});try{
  journalTurn(f);
  assert.equal(f.store.getNativeJournal(f.claim,'col')?.turns[0]?.turnId,'native-turn');
  assert.equal(f.store.get('inv')?.state,'queued');
  assert.equal(f.store.get('inv')?.attempts[0]?.state,'claimed');
 }finally{f.close();}
});

test('cancel before native turn preserves its ID but skips running; cancel after running does not reverse it',()=>{
 for(const order of ['before','after'] as const){
  const f=fixture();try{
   f.store.beginNativeThreadIntent(f.claim,'col',f.now);
   f.store.observeNativeThread(f.claim,'col','native-thread');
   f.store.beginNativeTurnIntent(f.claim,'col','turn-intent','native-thread',f.now);
   if(order==='before')f.store.requestCancel(f.store.get('inv')!,'cancel-before','request');
   f.store.observeNativeTurn(f.claim,'col','turn-intent','native-turn',f.now);
   if(order==='after')f.store.requestCancel(f.store.get('inv')!,'cancel-after','request');
   assert.equal(f.store.getNativeJournal(f.claim,'col')?.turns[0]?.turnId,'native-turn');
   assert.equal(f.store.get('inv')?.state,order==='before'?'queued':'running');
   assert.equal(f.store.get('inv')?.attempts[0]?.state,order==='before'?'claimed':'running');
   assert.equal(f.store.get('inv')?.cancelRequested,true);
   assert.equal(f.store.listUnsettled().length,1);
   const settled=f.store.settleCodexSession(f.claim,f.closure,null,f.now);
   assert.equal(settled.state,'cancelled');
   assert.equal(f.store.listUnsettled().length,0);
  }finally{f.close();}
 }
});

test('late owned native ID is retained without reviving recovery, expiry or revoked authority',()=>{
 for(const mode of ['recovery','expiry','revoked','malformed_grant'] as const){
  const f=fixture();try{
   f.store.beginNativeThreadIntent(f.claim,'col',f.now);
   f.store.observeNativeThread(f.claim,'col','native-thread');
   f.store.beginNativeTurnIntent(f.claim,'col','turn-intent','native-thread',f.now);
   if(mode==='recovery')f.store.recoverCodexOwnedSessions(new Date(f.now.getTime()+60_000));
   if(mode==='revoked')f.grants.revokeGrant('read',f.now.toISOString());
   if(mode==='malformed_grant'){
    const db=new DatabaseSync(f.file);
    try{db.prepare('UPDATE grants SET permissions_json=? WHERE id=?').run('{','request');}
    finally{db.close();}
   }
   f.store.observeNativeTurn(f.claim,'col','turn-intent','native-turn',
    mode==='expiry'?new Date(f.now.getTime()+60_000):f.now);
   assert.equal(f.store.getNativeJournal(f.claim,'col')?.turns[0]?.turnId,'native-turn');
   assert.equal(f.store.get('inv')?.state,mode==='recovery'?'recovery_required':'queued');
   assert.equal(f.store.get('inv')?.attempts[0]?.state,mode==='recovery'?'recovery_required':'claimed');
   assert.equal(f.store.listUnsettled().length,1);
   if(mode==='malformed_grant'){
    const peer=new SqliteInvestigationStore(f.file);
    try{
     assert.equal(peer.getNativeJournal(f.claim,'col')?.turns[0]?.turnId,'native-turn');
     assert.equal(peer.get('inv')?.state,'queued');
    }finally{peer.close();}
   }
  }finally{f.close();}
 }
});

test('conflicting, stale and closed native turn observations cannot revive settled records',()=>{
 const f=fixture();try{
  journalTurn(f);
  f.store.observeNativeTurnTerminal(f.claim,'col','turn-intent','native-turn');
  const running=f.store.get('inv')!;
  assert.throws(()=>f.store.observeNativeTurn(f.claim,'col','turn-intent','other-turn',f.now));
  assert.throws(()=>f.store.observeNativeTurn({...f.claim,workerEpoch:99},'col','turn-intent','native-turn',f.now));
  assert.deepEqual(f.store.get('inv'),running);
  const closed=f.store.settleCodexSession(f.claim,f.closure,null,f.now);
  assert.equal(closed.state,'failed');
  assert.throws(()=>f.store.observeNativeTurn(f.claim,'col','turn-intent','native-turn',f.now));
  assert.deepEqual(f.store.get('inv'),closed);
 }finally{f.close();}
});

test('owned session begins for authorized multi-file scope in submitted order',()=>{
 const f=fixture(false,true);try{
  assert.equal(f.store.listUnsettled().length,1);
  assert.deepEqual(f.store.get('inv')?.scope.paths,['state.ts','cancel.ts','publish.ts']);
  assert.equal(ownedSessionCount(f.file,f.claim.attemptId),1);
 }finally{f.close();}
});

test('owned session deduplicates overlapping related tests without changing submitted scope',()=>{
 const f=fixture(false,true,{relatedTests:['publish.ts','state.ts']});try{
  assert.deepEqual(f.store.get('inv')?.scope,{paths:['state.ts','cancel.ts','publish.ts'],
   symbols:[],relatedTests:['publish.ts','state.ts']});
  assert.equal(ownedSessionCount(f.file,f.claim.attemptId),1);
 }finally{f.close();}
});

test('revoked read grant before begin refuses and inserts no owned session',()=>{
 const f=fixture(false,true,{begin:false});try{
  f.grants.revokeGrant('read',f.now.toISOString());
  assert.throws(()=>f.store.beginCodexOwnedSession(f.claim,f.closure.sessionId,f.now));
  assert.equal(ownedSessionCount(f.file,f.claim.attemptId),0);
  assert.deepEqual(f.store.get('inv')?.scope.paths,['state.ts','cancel.ts','publish.ts']);
 }finally{f.close();}
});

test('unknown or foreign native closure cannot release the original slot',()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.settleCodexSession(f.claim,{...f.closure},null,f.now),/NOT_AVAILABLE/);
  assert.equal(f.store.get('inv')?.result,null);assert.equal(f.store.listUnsettled().length,1);
 }finally{f.close();}
});

test('confirmed original close settles cancellation with no result and no replay',()=>{
 const f=fixture();try{
  f.store.requestCancel(f.store.get('inv')!,'cancel','request');
  const record=f.store.settleCodexSession(f.claim,f.closure,null,f.now);
  assert.equal(record.state,'cancelled');assert.equal(record.result,null);
  assert.equal(record.attempts[0]?.terminationConfirmed,true);assert.equal(f.store.listUnsettled().length,0);
  assert.equal(f.store.claimRequest('inv',{workerId:'next',isolationEvidence:'local-native',profileRevision:'profile',
   permissionEpoch:0,now:f.now}),null);
 }finally{f.close();}
});

test('closed attempt with no trusted candidate fails and retains native journal history',()=>{
 const f=fixture();try{
  f.store.beginNativeThreadIntent(f.claim,'col',f.now);
  const record=f.store.settleCodexSession(f.claim,f.closure,null,f.now);
  assert.equal(record.state,'failed');assert.equal(record.result,null);
  assert.equal(f.store.listUnsettled().length,0);
 }finally{f.close();}
});

test('restart retains an orphaned owned intent as recovery_required and never admits another attempt',()=>{
 const f=fixture();try{
  const durable=()=>{
   const db=new DatabaseSync(f.file,{readOnly:true});
   try{return {owner:db.prepare('SELECT * FROM investigation_codex_owned_sessions WHERE attempt_id=?').get(f.claim.attemptId),
    outbox:db.prepare('SELECT * FROM investigation_outbox ORDER BY request_id').all()};}
   finally{db.close();}
  };
  const before=durable(),active=f.store.listUnsettled()[0]!;
  f.store.recoverStartupAttempts(new Date(f.now.getTime()+60_000));
  assert.equal(f.store.get('inv')?.state,'recovery_required');
  assert.equal(f.store.listUnsettled().length,1);
  assert.deepEqual(durable(),before);
  const retained=f.store.listUnsettled()[0]!;
  assert.equal(retained.attemptId,active.attemptId);assert.equal(retained.workerEpoch,active.workerEpoch);
  assert.equal(retained.nativeRef,active.nativeRef);
  assert.equal(f.store.settleExpiredUnreservedAttempt(f.claim,new Date(f.now.getTime()+60_000)),null);
  assert.equal(f.store.claimRequest('inv',{workerId:'next',isolationEvidence:'local-native',profileRevision:'profile',
   permissionEpoch:0,now:f.now}),null);
 }finally{f.close();}
});

test('a peer recovery pass leaves the active owned lease and phase intact',()=>{
 const f=fixture();try{
  const before=f.store.listUnsettled();
  const peer=new SqliteInvestigationStore(f.file);
  try{peer.recoverCodexOwnedSessions(f.now);}finally{peer.close();}
  assert.equal(f.store.get('inv')?.state,'queued');assert.deepEqual(f.store.listUnsettled(),before);
 }finally{f.close();}
});

test('original not-started proof fails without asserting process termination and releases only its slot',()=>{
 const f=fixture(true);try{
  const record=f.store.settleCodexSession(f.claim,f.closure,null,f.now);
  assert.equal(record.state,'failed');assert.equal(record.result,null);
  assert.equal(record.failureReason,'windows_launch_not_started');
  assert.equal(record.attempts[0]?.terminationConfirmed,false);
  assert.equal(f.store.listUnsettled().length,0);
  assert.equal(f.store.claimRequest('inv',{workerId:'next',isolationEvidence:'local-native',profileRevision:'profile',
   permissionEpoch:0,now:f.now}),null);
 }finally{f.close();}
});

test('original not-started proof records existing cancellation without claiming tree termination',()=>{
 const f=fixture(true);try{
  f.store.requestCancel(f.store.get('inv')!,'cancel-not-started','request');
  const record=f.store.settleCodexSession(f.claim,f.closure,null,f.now);
  assert.equal(record.state,'cancelled');assert.equal(record.attempts[0]?.terminationConfirmed,false);
  assert.equal(record.failureReason,'windows_launch_not_started');assert.equal(record.result,null);
 }finally{f.close();}
});

test('not-started closure refuses any native intent, supplied result, copied proof or expired epoch',()=>{
 for(const mode of ['journal','candidate','copy','expired'] as const){
  const f=fixture(true);try{
   if(mode==='journal')f.store.beginNativeThreadIntent(f.claim,'col',f.now);
   assert.throws(()=>f.store.settleCodexSession(f.claim,mode==='copy'?{...f.closure}:f.closure,
    mode==='candidate'?{} as NonNullable<Parameters<SqliteInvestigationStore['settleCodexSession']>[2]>:null,
    mode==='expired'?new Date(f.now.getTime()+60000):f.now));
   assert.equal(f.store.listUnsettled().length,1);assert.equal(f.store.get('inv')?.result,null);
  }finally{f.close();}
 }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ConversationApplication } from '../../src/application/conversation.js';
import { handoffState } from '../../src/core/collaboration/session-control.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import type { Permit, RequestContext } from '../../src/core/policy/authorize.js';

type Binding={id:string;workspaceId:string;collaborationId:string;providerId:string;accountId:string};
const bindings:[Binding,Binding,Binding,Binding,Binding,Binding]=[
  {id:'a',workspaceId:'ws-a',collaborationId:'col-a',providerId:'provider-a',accountId:'account-a'},
  {id:'b',workspaceId:'ws-b',collaborationId:'col-b',providerId:'provider-a',accountId:'account-a'},
  {id:'c',workspaceId:'ws-a',collaborationId:'col-c',providerId:'provider-a',accountId:'account-a'},
  {id:'d',workspaceId:'ws-a',collaborationId:'col-d',providerId:'provider-a',accountId:'account-b'},
  {id:'e',workspaceId:'ws-a',collaborationId:'col-e',providerId:'provider-b',accountId:'account-a'},
  {id:'f',workspaceId:'ws-b',collaborationId:'col-f',providerId:'provider-a',accountId:'account-a'},
];
const context:RequestContext={principal:'owner',audience:'host',recipient:'owner',
  surface:'local_host',now:new Date()};

const contenderProgram=`
import {SessionControlSqlite} from './src/adapters/storage/session-control-sqlite.ts';
const store=new SessionControlSqlite(process.env.RCAC_TEST_FILE);
process.stdout.write('READY\\n');
process.stdin.once('data',()=>{
  try {
    const id=process.env.RCAC_TEST_BINDING;
    const workspaceId=id==='b'?'ws-b':'ws-a';
    const collaborationId=id==='b'?'col-b':'col-c';
    const permit={grantId:'grant-'+id,operation:'conversation.send',effect:'external_send',
      scope:{workspaceId,collaborationId},principal:'owner',recipient:'owner'};
    store.markSending('send-'+id,permit,0,0);
    process.stdout.write(JSON.stringify({ok:true})+'\\n');
  } catch (error) { process.stdout.write(JSON.stringify({ok:false,
    error:error instanceof Error?error.message:String(error)})+'\\n'); }
  finally {store.close();process.stdin.destroy();}
});
`;

function contender(file:string,id:'b'|'c',executable=process.execPath) {
  const child=spawn(executable,['--import','tsx','--input-type=module','-e',contenderProgram],
    {cwd:process.cwd(),env:{...process.env,RCAC_TEST_FILE:file,RCAC_TEST_BINDING:id},
      stdio:['pipe','pipe','pipe']});
  let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
  let doneResolve!:(value:{ok:boolean;error?:string})=>void,doneReject!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const done=new Promise<{ok:boolean;error?:string}>((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
  // Both failures can happen before the caller awaits either promise.
  void ready.catch(()=>{});void done.catch(()=>{});
  type Terminal={code:number|null;signal:NodeJS.Signals|null;error?:Error};
  let terminalResolve!:(value:Terminal)=>void;
  const terminal=new Promise<Terminal>(resolve=>{terminalResolve=resolve;});
  let terminalSeen=false;
  const settleTerminal=(value:Terminal)=>{
    if (terminalSeen) return;
    terminalSeen=true;clearTimeout(timer);terminalResolve(value);
  };
  let output='',errorOutput='',readySeen=false,doneSeen=false;
  const timer=setTimeout(()=>{
    child.kill();
    const error=new Error('Contender timed out');readyReject(error);doneReject(error);
  },15_000);
  child.stdout.on('data',(chunk:Buffer)=>{
    output+=chunk.toString();
    for (;;) {
      const newline=output.indexOf('\n');
      if (newline<0) break;
      const line=output.slice(0,newline).trim();output=output.slice(newline+1);
      if (line==='READY') {readySeen=true;readyResolve();}
      else if (line) {
        try {doneSeen=true;doneResolve(JSON.parse(line) as {ok:boolean;error?:string});}
        catch {doneReject(new Error('Invalid contender response'));}
      }
    }
  });
  child.stderr.on('data',(chunk:Buffer)=>{errorOutput+=chunk.toString().slice(0,2000);});
  child.once('error',(error)=>{
    readyReject(error);doneReject(error);
    settleTerminal({code:null,signal:null,error});
  });
  child.once('close',(code,signal)=>{
    settleTerminal({code,signal});
    if (code!==0 || !readySeen || !doneSeen) {
    const error=new Error(`Contender exited ${code}: ${errorOutput.slice(0,2000)}`);
    readyReject(error);doneReject(error);
    }
  });
  return {ready,done,terminal,go(){child.stdin.end('GO\n');},
    async cleanup(){
      if (!terminalSeen) child.kill();
      let deadline:NodeJS.Timeout|undefined;
      await Promise.race([terminal,new Promise<void>(resolve=>{
        deadline=setTimeout(resolve,2_000);
      })]);
      if (deadline) clearTimeout(deadline);
      if (!terminalSeen) {
        child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();
      }
    }};
}

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'rcac-account-limit-'));
  const file=join(dir,'state.sqlite');
  const base=new SqliteStore(file);
  for (const workspaceId of ['ws-a','ws-b']) base.insertWorkspace({id:workspaceId,
    name:workspaceId,canonicalRoot:join(dir,workspaceId),registeredBy:'owner'});
  for (const binding of bindings) {
    base.insertCollaboration({id:binding.collaborationId,workspaceId:binding.workspaceId,
      openedBy:'owner',purpose:'account limit',hostThreadId:null,state:'open'});
    base.insertGrant({id:`grant-${binding.id}`,principal:'owner',audience:'host',recipient:'owner',
      workspaceId:binding.workspaceId,collaborationId:binding.collaborationId,
      permissions:['conversation.control'],expiresAt:null,revokedAt:null});
  }
  const first=new SessionControlSqlite(file);
  const second=new SessionControlSqlite(file);
  for (const binding of bindings) first.create({bindingId:binding.id,
    workspaceId:binding.workspaceId,collaborationId:binding.collaborationId,
    providerId:binding.providerId,accountId:binding.accountId,nativeSessionId:`chat-${binding.id}`,
    cursor:'turn-1',control:'host_controlled',epoch:0,revision:0});
  const permit=(binding:Binding,operation='conversation.send'):Permit=>({
    grantId:`grant-${binding.id}`,operation,
    effect:operation==='conversation.send'?'external_send':'state_write',
    scope:{workspaceId:binding.workspaceId,collaborationId:binding.collaborationId},
    principal:'owner',recipient:'owner'});
  const claim=(store:SessionControlSqlite,binding:Binding)=>store.claimCommand({
    commandId:`send-${binding.id}`,scope:{principal:'owner',audience:'host',workspaceId:binding.workspaceId,
      operation:'conversation.send',idempotencyKey:`send-key-${binding.id}`},
    payload:{text:`question-${binding.id}`},permit:permit(binding),bindingId:binding.id,
    expectedRevision:0,expectedEpoch:0});
  return {dir,file,base,first,second,permit,claim,
    close(){second.close();first.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('two SQLite connections reserve only two unresolved sends per provider account', async () => {
  const f=fixture();
  try {
    const [a,b,c,d,e,third]=bindings;
    for (const binding of [a,b,c,d,e,third])
      assert.equal(f.claim(f.first,binding).disposition,'claimed');
    assert.equal(f.first.markSending('send-a',f.permit(a),0,0).status,'sending');
    const contenders=await Promise.allSettled([
      Promise.resolve().then(()=>f.first.markSending('send-b',f.permit(b),0,0)),
      Promise.resolve().then(()=>f.second.markSending('send-c',f.permit(c),0,0)),
    ]);
    assert.equal(contenders.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(contenders.filter(result=>result.status==='rejected').length,1);
    const winner=contenders[0].status==='fulfilled'?b:c;
    const loser=winner===b?c:b;
    assert.equal(f.first.getCommand(`send-${loser.id}`)?.status,'prepared');
    assert.equal(f.second.get(loser.id)?.revision,0);
    assert.equal(f.second.markSending('send-d',f.permit(d),0,0).status,'sending');
    assert.equal(f.second.markSending('send-e',f.permit(e),0,0).status,'sending');
    let nativeSends=0;
    const app=new ConversationApplication(f.second,async ({operation,workspaceId,collaborationId})=>{
      const binding=bindings.find(item=>item.workspaceId===workspaceId &&
        item.collaborationId===collaborationId)!;
      return f.permit(binding,operation);
    },{syncDelta:async (state:SessionState)=>({providerId:state.providerId,accountId:state.accountId,
      nativeSessionId:state.nativeSessionId,fromCursor:state.cursor,nextCursor:state.cursor,
      complete:true,generating:false,historyChanged:false,messages:[]}),
    send:async()=>{nativeSends++;return {status:'submitted' as const};}});
    await assert.rejects(app.send({context,workspaceId:third.workspaceId,
      collaborationId:third.collaborationId,bindingId:third.id,expectedEpoch:0,
      idempotencyKey:'app-third',text:'question-third'}),/CONFLICT/);
    assert.equal(nativeSends,0);
    assert.equal(f.first.getCommand(`send-${third.id}`)?.status,'prepared');
    f.first.finishSend('send-a',1,0,'unknown');
    const reopened=new SessionControlSqlite(f.file);
    try {assert.throws(()=>reopened.markSending(`send-${loser.id}`,
      f.permit(loser),0,0),/CONFLICT/);} finally {reopened.close();}
    f.first.finishSend(`send-${winner.id}`,1,0,'rejected');
    assert.equal(f.second.markSending(`send-${loser.id}`,f.permit(loser),0,0).status,'sending');
  } finally {f.close();}
});

test('two independent processes contend for the final account slot', async () => {
  const f=fixture();
  const first=contender(f.file,'b'),second=contender(f.file,'c');
  try {
    const [a,b,c]=bindings;
    for (const binding of [a,b,c]) f.claim(f.first,binding);
    f.first.markSending('send-a',f.permit(a),0,0);
    await Promise.all([first.ready,second.ready]);
    first.go();second.go();
    const results=await Promise.all([first.done,second.done]);
    const terminals=await Promise.all([first.terminal,second.terminal]);
    assert.deepEqual(terminals.map(result=>({code:result.code,signal:result.signal})),
      [{code:0,signal:null},{code:0,signal:null}]);
    assert.equal(results.filter(result=>result.ok).length,1);
    assert.deepEqual(results.filter(result=>!result.ok).map(result=>result.error),['CONFLICT']);
    assert.deepEqual([b,c].map(binding=>f.first.getCommand(`send-${binding.id}`)?.status).sort(),
      ['prepared','sending']);
  } finally {
    await Promise.all([first.cleanup(),second.cleanup()]);
    f.close();
  }
});

test('contender spawn failure settles both observations and bounded cleanup', async () => {
  const missing=contender(join(tmpdir(),`rcac-missing-${process.pid}.sqlite`),'b',
    join(tmpdir(),`rcac-missing-executable-${process.pid}`));
  try {
    await assert.rejects(missing.ready,{code:'ENOENT'});
    await assert.rejects(missing.done,{code:'ENOENT'});
    const result=await missing.terminal;
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code,'ENOENT');
  } finally {await missing.cleanup();}
});

test('correlated native pair releases one account slot; unknown, handoff and revoke retain it', () => {
  const f=fixture();
  try {
    const [a,b,c]=bindings;
    for (const binding of [a,b,c]) f.claim(f.first,binding);
    f.first.markSending('send-a',f.permit(a),0,0);
    f.second.markSending('send-b',f.permit(b),0,0);
    f.first.finishSend('send-a',1,0,'submitted');
    assert.throws(()=>f.second.markSending('send-c',f.permit(c),0,0),/CONFLICT/);
    const pending=f.first.get(a.id)!;
    const {sendIntent,...withoutIntent}=pending;
    assert.ok(sendIntent);
    f.first.commitSync({commandId:'sync-a',scope:{principal:'owner',audience:'host',
      workspaceId:a.workspaceId,operation:'conversation.sync',idempotencyKey:'sync-a'},
    payload:{bindingId:a.id,expectedEpoch:0},permit:f.permit(a,'conversation.sync'),
    bindingId:a.id,expectedRevision:pending.revision,expectedEpoch:0,
    nextState:{...withoutIntent,revision:pending.revision+1,cursor:'turn-2'},
    messages:[{nativeMessageId:'user-a',version:'v1',text:'question-a'},
      {nativeMessageId:'reply-a',version:'v1',text:'answer'}],receipt:{complete:true},
    completesCommandId:'send-a',completedSend:{sendIntentId:'send-a',
      nativeUserMessageId:'user-a',nativeReplyMessageId:'reply-a'}});
    assert.equal(f.first.getCommand('send-a')?.status,'completed');
    assert.equal(f.second.markSending('send-c',f.permit(c),0,0).status,'sending');
  } finally {f.close();}

  const g=fixture();
  try {
    const [a,b,c]=bindings;
    for (const binding of [a,b,c]) g.claim(g.first,binding);
    g.first.markSending('send-a',g.permit(a),0,0);
    g.second.markSending('send-b',g.permit(b),0,0);
    g.first.finishSend('send-a',1,0,'unknown');
    const sending=g.second.get(b.id)!;
    assert.equal(g.second.compareAndSwap(1,handoffState(sending,0)),true);
    g.base.revokeGrant('grant-b',new Date().toISOString());
    const reopened=new SessionControlSqlite(g.file);
    try {
      assert.equal(reopened.getCommand('send-a')?.status,'reconcile_required');
      assert.equal(reopened.getCommand('send-b')?.status,'sending');
      assert.throws(()=>reopened.markSending('send-c',g.permit(c),0,0),/CONFLICT/);
      assert.equal(reopened.getCommand('send-c')?.status,'prepared');
    } finally {reopened.close();}
  } finally {g.close();}
});

test('historical over-capacity unresolved sends stay occupied until real reconciliation', () => {
  const f=fixture();
  try {
    const [a,b,c,,,fourth]=bindings;
    for (const binding of [a,b,c,fourth]) f.claim(f.first,binding);
    f.first.markSending('send-a',f.permit(a),0,0);
    f.second.markSending('send-b',f.permit(b),0,0);
    const prior=f.first.get(c.id)!;
    const historical={...prior,revision:1,control:'reconcile_required' as const,
      sendIntent:{id:'send-c',text:'question-c',status:'unknown' as const}};
    const raw=new DatabaseSync(f.file);
    try {
      raw.prepare(`UPDATE session_control SET revision=1,state_json=? WHERE binding_id=?`)
        .run(JSON.stringify(historical),c.id);
      raw.prepare(`UPDATE conversation_commands SET status='reconcile_required' WHERE command_id=?`)
        .run('send-c');
    } finally {raw.close();}
    assert.throws(()=>f.second.markSending('send-f',f.permit(fourth),0,0),/CONFLICT/);
    assert.equal(f.first.getCommand('send-f')?.status,'prepared');
  } finally {f.close();}
});

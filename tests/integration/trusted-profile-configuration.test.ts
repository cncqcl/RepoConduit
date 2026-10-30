import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { acceptContext, proposeContext } from '../../src/core/collaboration/context.js';
import type { RequestContext } from '../../src/core/policy/authorize.js';

const budget={maxWallSeconds:600,maxTurns:8,maxToolCalls:40};
const payload=(workspaceId:string)=>({workspaceId,expectedRevisionId:null,
  presetRef:'static_readonly_v1' as const,budget});

test('trusted local dispatcher stores a bounded profile revision', async () => {
  const dir=mkdtempSync(join(tmpdir(),'rcac-profile-dispatch-'));
  const store=new SqliteStore(join(dir,'state.sqlite'));
  try {
    store.insertWorkspace({id:'ws-profile',name:'profile',canonicalRoot:dir,registeredBy:'owner'});
    const context:RequestContext={principal:'owner',audience:'local-os',recipient:'owner',
      surface:'local_admin',now:new Date()};
    store.insertGrant({id:'profile-grant',principal:'owner',audience:'local-os',
      recipient:'owner',workspaceId:'management',permissions:['admin.profile'],
      expiresAt:null,revokedAt:null});
    const dispatcher=new DispatchService(store);
    const revision=await dispatcher.dispatch(context,{operation:'admin.configure_profile',
      scope:{workspaceId:'management'},idempotencyKey:'profile-key',payload:payload('ws-profile')}) as
      {id:string;workspaceId:string;runtimeAvailability:string;reason:string};
    assert.equal(revision.workspaceId,'ws-profile');
    assert.equal(revision.runtimeAvailability,'unavailable');
    assert.match(revision.reason,/runtime|isolation|unverified/i);
    const firstCommand={operation:'admin.configure_profile',scope:{workspaceId:'management'},
      idempotencyKey:'profile-key',payload:payload('ws-profile')};
    assert.deepEqual(await dispatcher.dispatch(context,firstCommand),revision);
    await assert.rejects(dispatcher.dispatch(context,{...firstCommand,payload:{...payload('ws-profile'),
      budget:{maxWallSeconds:60,maxTurns:1,maxToolCalls:2}}}),/Idempotency key/);
    await assert.rejects(dispatcher.dispatch(context,{...firstCommand,idempotencyKey:'stale-key'}),
      /Profile revision changed/);
    await assert.rejects(dispatcher.dispatch({...context,surface:'local_cli'},firstCommand));
    await assert.rejects(dispatcher.dispatch({...context,surface:'external_mcp'},firstCommand));
    await assert.rejects(dispatcher.dispatch(context,{...firstCommand,idempotencyKey:'missing-workspace',
      payload:payload('ws-other')}),/NOT_AVAILABLE/);
    const narrower={...payload('ws-profile'),expectedRevisionId:revision.id,
      budget:{maxWallSeconds:60,maxTurns:1,maxToolCalls:2}};
    const second=await dispatcher.dispatch(context,{...firstCommand,idempotencyKey:'second-key',
      payload:narrower}) as {id:string;previousRevisionId:string};
    assert.equal(second.previousRevisionId,revision.id);
    assert.equal(store.getCurrentProfileRevision('ws-profile')?.id,second.id);
    assert.equal(store.getProfileRevision('ws-profile',revision.id)?.id,revision.id);
    assert.deepEqual(await dispatcher.dispatch(context,firstCommand),revision);
    const staleGrant=store.grantsFor('owner','local-os').find(g=>g.id==='profile-grant')!;
    const callback=new DispatchService(store,()=>[staleGrant]);
    store.revokeGrant('profile-grant',new Date().toISOString());
    await assert.rejects(callback.dispatch(context,firstCommand));
    await assert.rejects(callback.dispatch(context,{...firstCommand,idempotencyKey:'third-key',
      payload:{...narrower,expectedRevisionId:second.id}}));
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('profile storage snapshots a changing budget and rejects async authorization preflight', () => {
  const dir=mkdtempSync(join(tmpdir(),'rcac-profile-storage-'));
  const store=new SqliteStore(join(dir,'state.sqlite'));
  try {
    store.insertWorkspace({id:'ws-profile',name:'profile',canonicalRoot:dir,registeredBy:'owner'});
    assert.throws(()=>store.insertProfileRevision({...payload('ws-profile'),
      budget:{...budget,maxToolCalls:41}},'owner',new Date()),/INVALID_ARGUMENT/);
    assert.equal(store.getCurrentProfileRevision('ws-profile'),null);
    let calls=0;
    const changingBudget={...budget};
    Object.defineProperty(changingBudget,'maxToolCalls',{enumerable:true,
      get:()=>++calls===1?1:41});
    const saved=store.insertProfileRevision({...payload('ws-profile'),
      budget:changingBudget},'owner',new Date());
    assert.equal(saved.budget.maxToolCalls,1);
    assert.equal(store.getCurrentProfileRevision('ws-profile')?.budget.maxToolCalls,1);
    assert.equal(calls,1);
    let mutated=false;
    const idem={principal:'owner',audience:'local-os',workspaceId:'management',
      operation:'admin.configure_profile',idempotencyKey:'async-preflight'};
    assert.throws(()=>store.runIdempotent(idem,{},()=>{mutated=true;return {ok:true};},
      async()=>{}),/synchronous/);
    assert.equal(mutated,false);
    assert.equal(store.lookupIdempotent(idem,{}),null);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('profile head failure leaves no orphaned immutable revision', () => {
  const dir=mkdtempSync(join(tmpdir(),'rcac-profile-atomic-'));
  const file=join(dir,'state.sqlite');
  const store=new SqliteStore(file);
  const probe=new DatabaseSync(file);
  try {
    store.insertWorkspace({id:'ws-profile',name:'profile',canonicalRoot:dir,registeredBy:'owner'});
    probe.exec(`CREATE TRIGGER fail_profile_head BEFORE INSERT ON profile_heads
      BEGIN SELECT RAISE(ABORT,'synthetic head fault'); END`);
    assert.throws(()=>store.insertProfileRevision(payload('ws-profile'),'owner',new Date()),
      /synthetic head fault/);
    assert.equal((probe.prepare('SELECT COUNT(*) AS count FROM profile_revisions').get() as
      {count:number}).count,0);
    assert.equal(store.getCurrentProfileRevision('ws-profile'),null);
  } finally {probe.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('management profile grant rejects revoked persisted administrator on first call and replay', async () => {
  const dir=mkdtempSync(join(tmpdir(),'rcac-profile-grant-'));
  const store=new SqliteStore(join(dir,'state.sqlite'));
  try {
    const administrator={id:'admin-grant',principal:'owner',audience:'local-os',
      recipient:'owner',workspaceId:'management',permissions:['admin.grant'],
      expiresAt:null,revokedAt:null};
    store.insertGrant(administrator);
    const stale=()=>[administrator];
    const dispatch=new DispatchService(store,stale);
    const context:RequestContext={principal:'owner',audience:'local-os',recipient:'owner',
      surface:'local_admin',now:new Date()};
    const grantCommand={operation:'admin.grant',scope:{workspaceId:'management'},
      idempotencyKey:'profile-grant',payload:{principal:'owner',audience:'local-os',
        workspaceId:'management',recipient:'owner',permissions:['admin.profile'],expiresAt:null}};
    const first=await dispatch.dispatch(context,grantCommand) as {id:string};
    assert.ok(first.id);
    store.revokeGrant('admin-grant',new Date().toISOString());
    await assert.rejects(dispatch.dispatch(context,grantCommand));
    await assert.rejects(dispatch.dispatch(context,{...grantCommand,idempotencyKey:'new-grant'}));
    let reads=0;
    const changingPayload={...grantCommand.payload};
    Object.defineProperty(changingPayload,'workspaceId',{enumerable:true,
      get:()=>++reads===1?'ordinary':'management'});
    await assert.rejects(dispatch.dispatch(context,{...grantCommand,
      idempotencyKey:'getter-bypass',payload:changingPayload}));
    assert.ok(reads>=1);
    assert.equal(store.grantsFor('owner','local-os').filter(g=>g.id!==first.id &&
      g.permissions.includes('admin.profile')).length,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('profile mutation rechecks persisted grant expiry before first write and replay', async () => {
  const dir=mkdtempSync(join(tmpdir(),'rcac-profile-expiry-'));
  const store=new SqliteStore(join(dir,'state.sqlite'));
  try {
    store.insertWorkspace({id:'ws-profile',name:'profile',canonicalRoot:dir,registeredBy:'owner'});
    const start=new Date('2026-01-01T00:00:00.000Z');
    let now=start;
    const persisted={id:'expiring-profile',principal:'owner',audience:'local-os',
      recipient:'owner',workspaceId:'management',permissions:['admin.profile'],
      expiresAt:new Date(start.getTime()+1000).toISOString(),revokedAt:null};
    store.insertGrant(persisted);
    const stale={...persisted,expiresAt:new Date(start.getTime()+60_000).toISOString()};
    const dispatch=new DispatchService(store,()=>[stale],()=>now);
    const context:RequestContext={principal:'owner',audience:'local-os',recipient:'owner',
      surface:'local_admin',now:start};
    const command={operation:'admin.configure_profile',scope:{workspaceId:'management'},
      idempotencyKey:'before-expiry',payload:payload('ws-profile')};
    const first=await dispatch.dispatch(context,command) as {id:string};
    assert.ok(first.id);
    now=new Date(start.getTime()+2000);
    await assert.rejects(dispatch.dispatch(context,command));
    await assert.rejects(dispatch.dispatch(context,{...command,idempotencyKey:'after-expiry',
      payload:{...payload('ws-profile'),expectedRevisionId:first.id}}));
    assert.equal(store.getCurrentProfileRevision('ws-profile')?.id,first.id);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('management grant exception rejects mixed permissions, data paths and foreign audience', async () => {
  const dir=mkdtempSync(join(tmpdir(),'rcac-profile-grant-shape-'));
  const store=new SqliteStore(join(dir,'state.sqlite'));
  try {
    store.insertGrant({id:'administrator',principal:'owner',audience:'local-os',recipient:'owner',
      workspaceId:'management',permissions:['admin.grant'],expiresAt:null,revokedAt:null});
    const context:RequestContext={principal:'owner',audience:'local-os',recipient:'owner',
      surface:'local_admin',now:new Date()};
    const dispatch=new DispatchService(store);
    const grant={principal:'owner',audience:'local-os',workspaceId:'management',
      recipient:'owner',permissions:['admin.profile'],expiresAt:null};
    const variants=[{...grant,permissions:['admin.profile','admin.grant']},
      {...grant,collaborationId:'col-other'}, {...grant,dataPaths:['src/']},
      {...grant,audience:'mcp'}, {...grant,recipient:'other'}];
    for (const [index,variant] of variants.entries()) {
      await assert.rejects(dispatch.dispatch(context,{operation:'admin.grant',
        scope:{workspaceId:'management'},idempotencyKey:`bad-management-${index}`,
        payload:variant}));
    }
    assert.equal(store.grantsFor('owner','local-os').filter(g=>g.permissions.includes('admin.profile')).length,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('source CLI init grants explicit profile management and reopens its revision', async () => {
  const base=process.platform==='win32'?homedir():tmpdir();
  const dir=mkdtempSync(join(base,'rcac-profile-cli-'));
  const data=join(dir,'data');
  const source=join(dir,'source');
  mkdirSync(source);
  const script=resolve('src/cli/main.ts');
  const run=(action:'init'|'request',input?:unknown)=>spawnSync(process.execPath,
    ['--import','tsx',script,'--data-dir',data,action],{input:input===undefined?undefined:JSON.stringify(input),
      encoding:'utf8',cwd:resolve('.'),timeout:60_000});
  try {
    const init=run('init');
    assert.equal(init.status,0,init.stderr);
    const register=run('request',{operation:'admin.register_workspace',scope:{workspaceId:'management'},
      idempotencyKey:'workspace-key',payload:{name:'profile',root:source}});
    assert.equal(register.status,0,register.stderr);
    const workspaceId=(JSON.parse(register.stdout) as {id:string}).id;
    const principal=(JSON.parse(init.stdout) as {principal:string}).principal;
    const collaborationId='col-profile',workingCopyId='copy-profile';
    const snapshot=createSnapshotFromFiles(workingCopyId,'fixture',
      {'src/a.ts':Buffer.from('export const a = 1;')}).toPersisted();
    const fixtureStore=new SqliteStore(join(data,'state.sqlite'));
    try {
      fixtureStore.insertWorkingCopy({id:workingCopyId,workspaceId,canonicalRoot:source});
      fixtureStore.insertCollaboration({id:collaborationId,workspaceId,openedBy:principal,
        purpose:'profile closed runtime',hostThreadId:null,state:'open'});
      await fixtureStore.saveSnapshot({workspaceId,collaborationId,workingCopyId,snapshot},
        {workspaceId,collaborationId,workingCopyId,commitRef:'fixture'},'capture',principal,'local-os');
      fixtureStore.insertGrant({id:'submit-grant',principal,audience:'local-os',recipient:principal,
        workspaceId,collaborationId,permissions:['investigation.request','data.read'],
        dataPaths:['src/'],expiresAt:null,revokedAt:null});
    } finally {fixtureStore.close();}
    const contextStore=new ContextDecisionSqlite(join(data,'state.sqlite'));
    try {
      const contextScope={workspaceId,collaborationId};
      const proposal=proposeContext({id:'profile-context-proposal',...contextScope,
        parentRevisionId:null,snapshotId:snapshot.id,proposedBy:principal,
        sourceRefs:['fixture'],content:{goal:'Inspect source',constraints:[],acceptedDecisions:[],
          rejectedDecisions:[],currentQuestions:[],evidenceRefs:[],expectedDeliverables:[],
          unknowns:[],recentChanges:[]}});
      const permit={grantId:'fixture-context',operation:'context.accept',effect:'state_write' as const,
        scope:contextScope,principal,recipient:principal};
      contextStore.insertProposal(proposal);
      contextStore.insertRevision(acceptContext(proposal,'profile-context',permit,'local_host'),
        permit,'local_host');
    } finally {contextStore.close();}
    const command={operation:'admin.configure_profile',scope:{workspaceId:'management'},
      idempotencyKey:'configure-key',payload:payload(workspaceId)};
    const first=run('request',command);
    assert.equal(first.status,0,first.stderr);
    const revision=JSON.parse(first.stdout) as {id:string;runtimeAvailability:string};
    assert.equal(revision.runtimeAvailability,'unavailable');
    const replay=run('request',command);
    assert.equal(replay.status,0,replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout),revision);
    const deniedSubmit=run('request',{operation:'investigate.submit',
      scope:{workspaceId,collaborationId},idempotencyKey:'still-closed',
      payload:{workingCopyId,input:{contextRevisionId:'profile-context',snapshotRef:snapshot.id,
        question:'Trace source behavior',scope:{paths:['src/a.ts'],symbols:[],relatedTests:[]},
        requestedOutputs:['flow'],parentInvestigationId:null}}});
    assert.equal(deniedSubmit.status,1);
    const reopened=new SqliteStore(join(data,'state.sqlite'));
    try {
      assert.deepEqual(reopened.getProfileRevision(workspaceId,revision.id),revision);
      const probe=new DatabaseSync(join(data,'state.sqlite'));
      try {
        for (const table of ['investigation_requests','investigation_outbox',
          'investigation_active_attempts']) {
          assert.equal((probe.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
            {count:number}).count,0);
        }
      } finally {probe.close();}
    }
    finally {reopened.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});

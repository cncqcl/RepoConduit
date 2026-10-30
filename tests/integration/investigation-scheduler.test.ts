import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { createInvestigationScheduler } from '../../src/runtime/investigation-scheduler.js';

const sourceDigest = 'b'.repeat(64);
const config = { recipe: 'claude_model_bootstrap_config_v3' as const,
  distro: 'Ubuntu', linuxUser: 'claude', relayRoot: '/home/claude/relay', paths: {
    installRoot: '/home/claude/install', nodeRoot: '/home/claude/node',
    srtSettingsFile: '/home/claude/srt.json', mcpConfigFile: '/home/claude/mcp.json',
    helperFile: '/home/claude/helper.py', privateAuthHome: '/home/claude/auth',
  }, profile: { allowedDomains: [] } };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-scheduler-'));
  const base = new SqliteStore(join(dir, 'state.sqlite'));
  const store = new SqliteInvestigationStore(join(dir, 'state.sqlite'), {
    verifyIsolation: (evidence, record, revision) =>
      evidence === `proof:${record.id}` && revision === record.profileRef,
    verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
  });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const seeded = new Set<number>();
  const workspace = (i: number) => `ws_${ids[i]!}`;
  const record = (i: number, suffix = ''): InvestigationRecord => {
    const ws = workspace(i); const col = `col-${i}`;
    if (!seeded.has(i)) {
      seeded.add(i);
      base.insertWorkspace({ id: ws, name: ws, canonicalRoot: join(dir,`workspace-${i}`), registeredBy: 'owner' });
      base.insertCollaboration({ id: col, workspaceId: ws, purpose: 'test', openedBy: 'owner', hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: `wc-${i}`, workspaceId: ws, canonicalRoot: join(dir,`workspace-${i}`) });
      base.insertGrant({ id: `request-${i}`, principal: 'external', audience: 'web', recipient: 'web-user',
        workspaceId: ws, collaborationId: col, permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
      base.insertGrant({ id: `read-${i}`, principal: 'external', audience: 'web', recipient: 'web-user',
        workspaceId: ws, collaborationId: col, permissions: ['data.read'], dataPaths: ['src/main.ts'], expiresAt: null, revokedAt: null });
    }
    return { id: `inv-${i}${suffix}`, workspaceId: ws, collaborationId: col, workingCopyId: `wc-${i}`,
      principal: 'external', audience: 'web', recipient: 'web-user', grantId: `request-${i}`,
      profileRef: 'profile-v1', budgetRef: 'budget-v1', budget: {maxWallSeconds:60,maxTurns:2,maxToolCalls:5},
      contextRevisionId: `ctx-${i}`, snapshotRef: `snapshot-${i}`, question: 'Trace code',
      scope: {paths:['src/main.ts'],symbols:[],relatedTests:[]}, requestedOutputs:['flow'],
      parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,
      createdAt:new Date().toISOString() };
  };
  const enqueue = (i: number, suffix = '') => {
    const saved = record(i, suffix); store.enqueue(saved, `key-${saved.id}`, `fingerprint-${saved.id}`); return saved;
  };
  const prepared = (saved: InvestigationRecord) => ({profileRevision:saved.profileRef,budgetRef:saved.budgetRef,
    permissionEpoch:base.permissionEpoch(saved.principal,saved.audience,saved.workspaceId),
    isolationEvidence:`proof:${saved.id}`,identity:{uid:1000,bootId:randomUUID()},runtime:config});
  const cleanup = () => {store.close();base.close();rmSync(dir,{recursive:true,force:true});};
  return {base,store,enqueue,prepared,cleanup};
}

test('default denied authority and stale proof never claim, grant or launch', async () => {
  const f=fixture(); const saved=f.enqueue(0); const launches: unknown[]=[];
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:()=>null},preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async input=>{launches.push(input);return null;}});
    await scheduler.tick();
    assert.equal(f.store.get(saved.id)?.attempts.length,0);
    assert.deepEqual(f.store.listUnsettled(),[]);
    assert.equal(f.base.grantsFor('worker','investigator').length,0);
    assert.equal(launches.length,0);
    const denied=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:()=>({...f.prepared(saved),isolationEvidence:'unverified'})},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async input=>{launches.push(input);return null;}});
    await denied.tick();
    assert.equal(f.store.get(saved.id)?.attempts.length,0);
    assert.deepEqual(f.store.listUnsettled(),[]);
    assert.equal(launches.length,0);
  } finally {f.cleanup();}
});

test('per-request authority and epoch are never borrowed from the next queued item', async () => {
  const f=fixture(); const bad=f.enqueue(0); const good=f.enqueue(1); const entered:string[]=[];
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:saved=>saved.id===bad.id ?
        {...f.prepared(saved),permissionEpoch:99} : f.prepared(saved)},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async input=>{entered.push(input.claim.requestId);return null;}});
    await scheduler.tick();
    assert.equal(f.store.get(bad.id)?.attempts.length,0);
    assert.deepEqual(entered,[good.id]);
    const claim=f.store.listUnsettled()[0]!;
    assert.equal(claim.requestId,good.id);
    assert.equal(claim.launchProtocol,'resource_reservation_v1');
    assert.equal(claim.wslResource?.gate?.payloadKind,'claude_model_v1');
    assert.equal(claim.wslResource?.gate?.launch?.action,'claude_model_v1');
    assert.match(claim.wslResource?.gate?.launch?.commandDigest??'',/^[0-9a-f]{64}$/);
    assert.equal(claim.wslResource?.gate?.launch?.sourceDigest,sourceDigest);
    const grant=f.base.grantsFor(claim.workerId,'investigator');
    assert.equal(grant.length,1);
    assert.deepEqual(grant[0]?.permissions,['data.read']);
    assert.deepEqual(grant[0]?.dataPaths,['src/main.ts']);
    assert.ok(grant[0]?.revokedAt);
  } finally {f.cleanup();}
});

test('prompt preflight and revocation before claim cause zero side effects', async () => {
  const f=fixture(); const oversized=f.enqueue(0); const revoked=f.enqueue(1);
  let promptChecks=0; let launches=0;
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:saved=>f.prepared(saved)},
      preflightPrompt:async id=>{promptChecks++;if(id===oversized.id)throw new Error('MODEL_PROMPT_LIMIT_EXCEEDED');
        f.base.revokeGrant(`request-1`,new Date().toISOString());return {actualBytes:42,maxBytes:16384};},
      runModelInvestigation:async()=>{launches++;return null;}});
    await scheduler.tick();
    assert.equal(promptChecks,2);
    assert.equal(launches,0);
    assert.deepEqual(f.store.listUnsettled(),[]);
    assert.equal(f.store.get(oversized.id)?.attempts.length,0);
    assert.equal(f.store.get(revoked.id)?.attempts.length,0);
  } finally {f.cleanup();}
});

test('post-claim failure occupies slot, and two workspaces fill only two global slots', async () => {
  const f=fixture(); const one=f.enqueue(0);const same=f.enqueue(0,'-second');
  const two=f.enqueue(1);const three=f.enqueue(2);const entered:string[]=[];
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:saved=>f.prepared(saved)},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async input=>{entered.push(input.claim.requestId);throw new Error('worker failed');}});
    await scheduler.tick();
    assert.deepEqual(entered,[one.id,two.id]);
    assert.equal(f.store.listUnsettled().length,2);
    assert.equal(f.store.get(same.id)?.attempts.length,0);
    assert.equal(f.store.get(three.id)?.attempts.length,0);
    for(const claim of f.store.listUnsettled()) {
      assert.equal(f.store.get(claim.requestId)?.state,'recovery_required');
      assert.ok(f.base.grantsFor(claim.workerId,'investigator')[0]?.revokedAt);
    }
  } finally {f.cleanup();}
});

test('close stops admission before abort and drains an in-flight run', async () => {
  const f=fixture();const one=f.enqueue(0);const second=f.enqueue(1);
  let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});
  let release!:()=>void;const running=new Promise<void>(resolve=>{release=resolve;});
  const order:string[]=[];
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:saved=>f.prepared(saved)},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async input=>{order.push('run');started();await running;
        assert.equal(input.signal?.aborted,true);return null;}});
    const tick=scheduler.tick();await entered;
    const closing=scheduler.close();order.push('close');
    await scheduler.tick();
    assert.equal(f.store.get(second.id)?.attempts.length,0);
    release();await Promise.all([tick,closing]);
    assert.deepEqual(order,['run','close']);
    assert.equal(f.store.get(one.id)?.state,'recovery_required');
  } finally {release?.();f.cleanup();}
});

test('two workspaces run concurrently while a third keeps its queued request', async () => {
  const f=fixture();const first=f.enqueue(0);const second=f.enqueue(1);const third=f.enqueue(2);
  let seen!:()=>void;const both=new Promise<void>(resolve=>{seen=resolve;});
  let release!:()=>void;const running=new Promise<void>(resolve=>{release=resolve;});
  const entered:string[]=[];
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:saved=>f.prepared(saved)},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async input=>{entered.push(input.claim.requestId);
        if(entered.length===2)seen();await running;return null;}});
    const tick=scheduler.tick();
    await both;
    assert.equal(await Promise.race([tick.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),75))]),true);
    assert.deepEqual(entered,[first.id,second.id]);
    assert.equal(f.store.listUnsettled().length,2);
    assert.equal(f.store.get(third.id)?.attempts.length,0);
    release();await scheduler.close();
  } finally {release?.();f.cleanup();}
});

test('worker grant revocation failure rejects shutdown and preserves occupied attempt', async () => {
  const f=fixture();const saved=f.enqueue(0);
  try {
    const scheduler=createInvestigationScheduler({store:f.store,
      grants:{insertGrant:grant=>f.base.insertGrant(grant),
        revokeGrant:()=>{throw new Error('grant-revoke-failed');}},getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:record=>f.prepared(record)},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async()=>null});
    await scheduler.tick();
    await assert.rejects(async()=>{await scheduler.close();},/shutdown unconfirmed/);
    assert.equal(f.store.get(saved.id)?.state,'recovery_required');
    assert.equal(f.store.listUnsettled().length,1);
    await assert.rejects(async()=>{await scheduler.close();},/shutdown unconfirmed/);
  } finally {f.cleanup();}
});

test('timed-out authority observation gets abort and cannot late-claim', async () => {
  const f=fixture();const saved=f.enqueue(0);
  let observationSignal: AbortSignal | undefined;
  let release!: (value: ReturnType<typeof f.prepared>)=>void;
  const pending = new Promise<ReturnType<typeof f.prepared>>(resolve=>{release=resolve;});
  try {
    const scheduler=createInvestigationScheduler({store:f.store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      observationTimeoutMs:30,
      authority:{prepareForRequest:(_record,signal)=>{observationSignal=signal;return pending;}},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async()=>{throw new Error('must not run');}});
    await scheduler.tick();
    assert.equal(observationSignal?.aborted,true);
    release(f.prepared(saved));
    await Promise.resolve();
    assert.equal(f.store.get(saved.id)?.attempts.length,0);
    assert.equal(scheduler.close(),undefined);
  } finally {release?.(f.prepared(saved));f.cleanup();}
});

test('synchronous queue read failure becomes a rejected tick and allows retry', async () => {
  const f=fixture();let reads=0;
  const store=new Proxy(f.store,{get(target,key){
    if(key==='listPending')return ()=>{if(++reads===1)throw new Error('sqlite-read-failed');return [];};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  try {
    const scheduler=createInvestigationScheduler({store,grants:f.base,getSourceDigest:async()=>sourceDigest,
      authority:{prepareForRequest:()=>null},
      preflightPrompt:async()=>({actualBytes:42,maxBytes:16384}),
      runModelInvestigation:async()=>null});
    let first!: Promise<void>;
    assert.doesNotThrow(()=>{first=scheduler.tick();});
    await assert.rejects(first,/sqlite-read-failed/);
    await scheduler.tick();
    assert.equal(reads,2);
    assert.equal(scheduler.close(),undefined);
  } finally {f.cleanup();}
});

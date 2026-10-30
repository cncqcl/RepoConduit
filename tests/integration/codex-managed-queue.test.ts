import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCodexInvestigationQueue} from '../../src/runtime/codex-investigation-queue.js';

const chosen={workspaceId:'ws',profileRevision:'profile'};
const queued=(id:string,overrides:Record<string,unknown>={})=>({
 id,workspaceId:'ws',collaborationId:'col',profileRef:'profile',budgetRef:'profile',state:'queued',
 cancelRequested:false,attempts:[],...overrides,
});

test('managed queue admits only first unattempted matching requests and coalesces ticks',async()=>{
 const records=[queued('valid'),queued('wrong-ws',{workspaceId:'other'}),
  queued('wrong-profile',{profileRef:'other'}),queued('wrong-budget',{budgetRef:'other'}),
  queued('cancelled',{cancelRequested:true}),queued('attempted',{attempts:[{id:'attempt'}]}),
  queued('unknown',{state:'recovery_required'}),queued('wrong-id',{id:'other-id'}),
  queued('wrong-col',{collaborationId:'other-col'})];
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const calls:string[]=[];
 const selection={...chosen};
 const queue=createCodexInvestigationQueue({selection,
  listPending:()=>records.map((record,index)=>({requestId:index===7?'wrong-id':record.id,
    workspaceId:record.workspaceId,collaborationId:'col'})),
  get:id=>(id==='wrong-id'?records[7]:records.find(record=>record.id===id)) as never,
  async run(id){calls.push(id);await gate;return records[0] as never;}});
 selection.workspaceId='mutated';selection.profileRevision='mutated';
 const one=queue.tick();assert.equal(queue.tick(),one);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['valid']);release();await one;
 await queue.close();assert.deepEqual(calls,['valid']);
});

test('managed queue closes admission before pending result and surfaces fatal errors',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 let calls=0;
 const queue=createCodexInvestigationQueue({selection:chosen,
  listPending:()=>[{requestId:'valid',workspaceId:'ws',collaborationId:'col'}],
  get:()=>queued('valid') as never,
  async run(){calls++;await gate;return queued('valid') as never;}});
 const pending=queue.tick();await new Promise<void>(resolve=>setImmediate(resolve));
 const closing=queue.close();assert.equal(queue.tick(),pending);
 release();await closing;assert.equal(calls,1);
 const broken=createCodexInvestigationQueue({selection:chosen,
  listPending:()=>{throw new Error('preclaim broken');},get:()=>null,run:async()=>null});
 await assert.rejects(broken.tick(),/preclaim broken/);
 await assert.rejects(broken.close(),/preclaim broken/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createExternalMcpServer } from '../../src/adapters/mcp/server.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { acceptContext, proposeContext } from '../../src/core/collaboration/context.js';
import { recordDecision } from '../../src/core/collaboration/decision.js';
import type { Grant, Permit, RequestContext } from '../../src/core/policy/authorize.js';

const scope={workspaceId:'ws-proposal',collaborationId:'col-proposal'};
const external:RequestContext={principal:'reviewer',audience:'mcp',recipient:'external',
  surface:'external_mcp',now:new Date()};
const local:RequestContext={principal:'owner',audience:'host',recipient:'local',
  surface:'local_host',now:new Date()};
const grant=(id:string,principal:string,audience:string,recipient:string,
  permissions:string[]):Grant=>({id,principal,audience,recipient,...scope,permissions,
  expiresAt:null,revokedAt:null});
const localPermit:Permit={grantId:'owner-context',operation:'context.accept',effect:'state_write',
  scope,principal:'owner',recipient:'local'};
const content={goal:'Review decision suggestion',constraints:[],acceptedDecisions:[],
  rejectedDecisions:[],currentQuestions:[],evidenceRefs:[],expectedDeliverables:[],
  unknowns:[],recentChanges:[]};

async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'rcac-decision-proposal-'));
  const file=join(dir,'state.sqlite');
  const base=new SqliteStore(file);
  base.insertWorkspace({id:scope.workspaceId,name:'proposal fixture',canonicalRoot:dir,registeredBy:'owner'});
  base.insertCollaboration({id:scope.collaborationId,workspaceId:scope.workspaceId,
    purpose:'review',openedBy:'owner',hostThreadId:null,state:'open'});
  base.insertWorkingCopy({id:'copy-proposal',workspaceId:scope.workspaceId,canonicalRoot:dir});
  const snapshot=createSnapshotFromFiles('copy-proposal','fixture',
    {'src/a.ts':Buffer.from('export const a = 1;')}).toPersisted();
  await base.saveSnapshot({...scope,workingCopyId:'copy-proposal',snapshot},
    {...scope,workingCopyId:'copy-proposal',commitRef:'fixture'},'capture','owner','host');
  let store=new ContextDecisionSqlite(file);
  const contextProposal=proposeContext({id:'ctx-proposal',...scope,parentRevisionId:null,
    snapshotId:snapshot.id,proposedBy:'reviewer',sourceRefs:['message-1'],content});
  store.insertProposal(contextProposal);
  store.insertRevision(acceptContext(contextProposal,'ctx-1',localPermit,'local_host'),
    localPermit,'local_host');
  const bundle={bundleId:'bundle-1',...scope,contextRevision:'ctx-1',snapshotRefs:[snapshot.id]};
  base.saveBundle({input:bundle});
  base.publishBundle({...bundle,files:[],semanticStatus:'not_reviewed',
    expectedSetBasis:'receiver_observed'});
  const bundleManifestHash=store.getPublishedBundleHash(scope.workspaceId,scope.collaborationId,'bundle-1');
  const externalGrant=grant('external-propose','reviewer','mcp','external',['decision.propose']);
  const localGrant=grant('local-read','owner','host','local',['context.read','decision.record']);
  base.insertGrant(externalGrant);base.insertGrant(localGrant);
  let callbackGrants:Grant[]=[externalGrant,localGrant];
  const signer={sign:(body:string)=>base.signBundleCursor(`decision.list\n${body}`),
    verify:(body:string,signature:string)=>base.verifyBundleCursor(`decision.list\n${body}`,signature)};
  const app=()=>new ContextDecisionApplication(store,()=>callbackGrants,()=>new Date(),signer);
  return {dir,file,base,get store(){return store;},snapshotId:snapshot.id,bundleManifestHash,
    app, setCallbackGrants(value:Grant[]){callbackGrants=value;},
    reopen(){store.close();store=new ContextDecisionSqlite(file);},
    close(){store.close();base.close();rmSync(dir,{recursive:true,force:true});}};
}

test('real MCP proposal is scoped, immutable, non-authorizing and survives SQLite reopen', async () => {
  const f=await fixture();
  const app=f.app();
  const server=createExternalMcpServer({dispatcher:new DispatchService(f.base,undefined,undefined,
    {contextDecision:app}),context:external,visibleOperations:['decision.propose'],
  allowedWorkspaceId:scope.workspaceId,allowedCollaborationId:scope.collaborationId});
  const client=new Client({name:'proposal-e2e',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);await client.connect(clientTransport);
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.map(tool=>tool.name),['decision.propose']);
    const payload={proposalId:'suggestion-1',contextRevisionId:'ctx-1',snapshotId:f.snapshotId,
      recommendation:'modify',reason:'Check the evidence first'};
    const args={scope,payload,idempotencyKey:'suggestion-key'};
    const first=await client.callTool({name:'decision.propose',arguments:args});
    assert.equal(first.isError,undefined);
    const proposed=JSON.parse((first.content[0] as {text:string}).text);
    assert.deepEqual(proposed,{kind:'decision_proposal',id:'suggestion-1',...scope,
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,recommendation:'modify',
      reason:'Check the evidence first',proposedBy:'reviewer',implementationAuthorized:false});
    assert.deepEqual(await client.callTool({name:'decision.propose',arguments:args}),first);
    assert.equal(f.store.getDecision(scope.workspaceId,scope.collaborationId,'suggestion-1'),null);
    assert.equal(f.store.getCurrentRevision(scope.workspaceId,scope.collaborationId)?.id,'ctx-1');
    assert.equal(app.readDecisionProposal({context:local,...scope,proposalId:'suggestion-1'})?.id,'suggestion-1');
    assert.equal(app.listDecisions({context:local,...scope}).decisions.length,0);
    const forged=await client.callTool({name:'decision.propose',arguments:{...args,
      idempotencyKey:'forged',payload:{...payload,implementationAuthorized:true}}});
    assert.equal(forged.isError,true);
    const wrongScope=await client.callTool({name:'decision.propose',arguments:{...args,
      scope:{...scope,collaborationId:'col-other'},idempotencyKey:'other'}});
    assert.equal(wrongScope.isError,true);
    f.base.revokeGrant('external-propose',new Date().toISOString());
    const revoked=await client.callTool({name:'decision.propose',arguments:args});
    assert.equal(revoked.isError,true);
    assert.throws(()=>app.proposeDecision({context:external,...scope,
      proposalId:'revoked-direct',contextRevisionId:'ctx-1',snapshotId:f.snapshotId,
      recommendation:'modify',reason:'Denied',idempotencyKey:'revoked-key'}));
    assert.equal(f.store.getDecisionProposal(scope.workspaceId,scope.collaborationId,'revoked-direct'),null);
    await client.close();await server.close();
    f.reopen();
    assert.deepEqual(f.store.getDecisionProposal(scope.workspaceId,scope.collaborationId,
      'suggestion-1'),proposed);
  } finally {await client.close();await server.close();f.close();}
});

test('proposal validates historical revision, optional published bundle, replay and signed kind cursor', async () => {
  const f=await fixture();
  try {
    const app=f.app();
    const input={context:external,...scope,proposalId:'p-1',contextRevisionId:'ctx-1',
      snapshotId:f.snapshotId,recommendation:'accept' as const,reason:'Evidence checked',
      idempotencyKey:'key-1'};
    const first=app.proposeDecision(input);
    assert.deepEqual(app.proposeDecision(input),first);
    assert.throws(()=>app.proposeDecision({...input,reason:'Changed'}),/CONFLICT/);
    assert.throws(()=>app.proposeDecision({...input,idempotencyKey:'different-key',
      reason:'Changed'}),/CONFLICT/);
    assert.throws(()=>app.proposeDecision({...input,proposalId:'p-2',idempotencyKey:'key-2',
      snapshotId:'wrong'}),/NOT_AVAILABLE/);
    assert.throws(()=>app.proposeDecision({...input,proposalId:'p-3',idempotencyKey:'key-3',
      bundleId:'bundle-1'}),/NOT_AVAILABLE/);
    assert.throws(()=>app.proposeDecision({...input,proposalId:'p-4',idempotencyKey:'key-4',
      bundleId:'bundle-1',bundleManifestHash:'0'.repeat(64)}),/NOT_AVAILABLE/);
    const bundled=app.proposeDecision({...input,proposalId:'p-2',idempotencyKey:'key-bundle',
      bundleId:'bundle-1',bundleManifestHash:f.bundleManifestHash});
    assert.equal(bundled.bundleManifestHash,f.bundleManifestHash);
    const third=app.proposeDecision({...input,proposalId:'p-3',idempotencyKey:'key-3'});
    assert.equal(third.implementationAuthorized,false);
    const contextProposal=proposeContext({id:'ctx-proposal-2',...scope,
      parentRevisionId:'ctx-1',snapshotId:f.snapshotId,proposedBy:'reviewer',
      sourceRefs:['message-2'],content});
    f.store.insertProposal(contextProposal);
    f.store.insertRevision(acceptContext(contextProposal,'ctx-2',localPermit,'local_host'),
      localPermit,'local_host');
    assert.equal(f.store.getCurrentRevision(scope.workspaceId,scope.collaborationId)?.id,'ctx-2');
    assert.equal(app.proposeDecision({...input,proposalId:'historical-after-head',
      idempotencyKey:'historical-key'}).contextRevisionId,'ctx-1');
    const firstPage=app.listDecisions({context:local,...scope,kind:'proposal',limit:1});
    assert.deepEqual(firstPage.proposals.map(p=>p.proposalId),['p-1']);
    assert.ok(firstPage.nextCursor);
    assert.throws(()=>app.listDecisions({context:local,...scope,limit:1,
      cursor:firstPage.nextCursor!}),/INVALID_ARGUMENT/);
    assert.throws(()=>app.listDecisions({context:local,...scope,
      kind:'unknown' as never}),/INVALID_ARGUMENT/);
    const secondPage=app.listDecisions({context:local,...scope,kind:'proposal',limit:1,
      cursor:firstPage.nextCursor!});
    assert.deepEqual(secondPage.proposals.map(p=>p.proposalId),['p-2']);
    const recordPermit:Permit={...localPermit,operation:'decision.record'};
    for (const id of ['decision-1','decision-2']) {
      const record=recordDecision({id,...scope,bundleId:'bundle-1',
        bundleManifestHash:f.bundleManifestHash,snapshotId:f.snapshotId,
        contextRevisionId:'ctx-1',outcome:'reject',reason:'Not adopted',decidedBy:'owner'},
      recordPermit,'local_host');
      f.store.insertDecision(record,recordPermit,'local_host');
    }
    const records=app.listDecisions({context:local,...scope,limit:1});
    assert.deepEqual(records.decisions.map(d=>d.decisionId),['decision-1']);
    assert.ok(records.nextCursor);
    assert.throws(()=>app.listDecisions({context:local,...scope,kind:'proposal',limit:1,
      cursor:records.nextCursor!}),/INVALID_ARGUMENT/);
    const dispatcher=new DispatchService(f.base,undefined,undefined,{contextDecision:app});
    await assert.rejects(dispatcher.dispatch(local,{operation:'decision.get',scope,
      payload:{decisionId:'decision-1',proposalId:'p-1'}}));
    await assert.rejects(dispatcher.dispatch(local,{operation:'decision.get',scope,payload:{}}));
    await assert.rejects(dispatcher.dispatch(local,{operation:'decision.get',scope,
      payload:{proposalId:'p-1',implementationAuthorized:true}}));
    assert.equal(app.readDecisionProposal({context:local,...scope,proposalId:'p-3'})?.id,'p-3');
    assert.equal(app.readDecisionProposal({context:local,...scope,proposalId:'missing'}),null);
    assert.throws(()=>app.readDecisionProposal({context:external,...scope,proposalId:'p-1'}),/NOT_AVAILABLE/);
    assert.throws(()=>app.listDecisions({context:external,...scope,kind:'proposal'}),/NOT_AVAILABLE/);
    for (const [index,extra] of [{proposedBy:'owner'},
      {implementationAuthorized:true},{execute:true}].entries()) {
      const proposalId=`unknown-${index}`;
      const idempotencyKey=`unknown-key-${index}`;
      assert.throws(()=>app.proposeDecision({...input,proposalId,idempotencyKey,
        ...extra} as never),/INVALID_ARGUMENT/);
      assert.equal(f.store.getDecisionProposal(scope.workspaceId,scope.collaborationId,proposalId),null);
      assert.equal(app.proposeDecision({...input,proposalId,idempotencyKey}).id,proposalId);
    }
    f.setCallbackGrants([]);
    assert.throws(()=>app.proposeDecision({...input,proposalId:'p-4',idempotencyKey:'key-4'}));
    assert.equal(f.store.getDecisionProposal(scope.workspaceId,scope.collaborationId,'p-4'),null);
  } finally {f.close();}
});

test('transaction failure leaves no decision proposal or idempotency residue', async () => {
  const f=await fixture();
  try {
    const app=f.app();
    const request={context:external,...scope,proposalId:'fault-proposal',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,
      recommendation:'reject' as const,reason:'Requires more evidence',idempotencyKey:'fault-key'};
    const original=f.store.insertDecisionProposal.bind(f.store);
    f.store.insertDecisionProposal=(...args)=>{
      original(...args);throw new Error('synthetic fault after insert');
    };
    assert.throws(()=>app.proposeDecision(request),/synthetic fault/);
    assert.equal(f.store.getDecisionProposal(scope.workspaceId,scope.collaborationId,'fault-proposal'),null);
    f.store.insertDecisionProposal=original;
    assert.equal(app.proposeDecision(request).id,'fault-proposal');
  } finally {f.close();}
});

test('local review records a formal decision about an immutable proposal across reopen', async () => {
  const f=await fixture();
  try {
    const app=f.app();
    const proposal=app.proposeDecision({context:external,...scope,proposalId:'formal-source',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,recommendation:'reject',
      reason:'External view',idempotencyKey:'formal-source-key'});
    const review=app.reviewBaseline({context:local,...scope,reviewId:'formal-review',
      proposalId:proposal.id,snapshotId:f.snapshotId,contextRevisionId:'ctx-1',
      idempotencyKey:'formal-review-key'} as never);
    assert.equal(review.proposalId,proposal.id);
    const decision=app.decide({context:local,...scope,decisionId:'formal-decision',
      proposalId:proposal.id,snapshotId:f.snapshotId,contextRevisionId:'ctx-1',
      reviewId:review.id,outcome:'accept',reason:'Owner independently accepts',
      items:[{id:'item-1',sourceRef:'proposal:formal-source',outcome:'accept',reason:'Reviewed'}],
      idempotencyKey:'formal-decision-key'} as never);
    assert.equal(decision.proposalId,proposal.id);
    assert.equal(decision.implementationAuthorized,false);
    assert.equal('bundleId' in decision,false);
    assert.equal(f.store.getDecision(scope.workspaceId,scope.collaborationId,'formal-decision')?.id,
      decision.id);
    const listed=app.listDecisions({context:local,...scope}).decisions[0];
    assert.equal(listed?.proposalId,proposal.id);
    assert.equal('bundleId' in listed!,false);
    f.reopen();
    assert.deepEqual(f.store.getDecision(scope.workspaceId,scope.collaborationId,'formal-decision'),
      decision);
  } finally {f.close();}
});

test('direct local review and decision reject forged authority fields without idempotency residue', async () => {
  const f=await fixture();
  try {
    const app=f.app();
    app.proposeDecision({context:external,...scope,proposalId:'strict-source',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,recommendation:'reject',
      reason:'External view',idempotencyKey:'strict-source-key'});
    const reviewRequest={context:local,...scope,reviewId:'strict-review',
      proposalId:'strict-source',snapshotId:f.snapshotId,contextRevisionId:'ctx-1',
      idempotencyKey:'strict-review-key'};
    const reviewPermit:Permit={...localPermit,operation:'decision.review'};
    assert.throws(()=>f.store.insertBaselineReview({id:'strict-review',...scope,
      proposalId:'strict-source',snapshotId:f.snapshotId,contextRevisionId:'ctx-1',
      reviewedBy:'owner',implementationAuthorized:true} as never,reviewPermit,'local_host'),
      /NOT_AVAILABLE/);
    assert.throws(()=>app.reviewBaseline({...reviewRequest,decidedBy:'forged'} as never),/INVALID_ARGUMENT/);
    const review=app.reviewBaseline(reviewRequest);
    assert.equal(review.id,'strict-review');
    const decisionRequest={context:local,...scope,decisionId:'strict-decision',
      proposalId:'strict-source',snapshotId:f.snapshotId,contextRevisionId:'ctx-1',
      reviewId:review.id,outcome:'reject' as const,reason:'Local rejection',
      idempotencyKey:'strict-decision-key'};
    assert.throws(()=>app.decide({...decisionRequest,implementationAuthorized:true} as never),
      /INVALID_ARGUMENT/);
    assert.equal(f.store.getDecision(scope.workspaceId,scope.collaborationId,'strict-decision'),null);
    assert.equal(app.decide(decisionRequest).id,'strict-decision');
  } finally {f.close();}
});

test('formal proposal target stays scoped and an outdated baseline cannot authorize adoption', async () => {
  const f=await fixture();
  try {
    const app=f.app();
    const source={context:external,...scope,contextRevisionId:'ctx-1',snapshotId:f.snapshotId,
      recommendation:'accept' as const,reason:'Suggested adoption'};
    app.proposeDecision({...source,proposalId:'source-a',idempotencyKey:'source-a-key'});
    app.proposeDecision({...source,proposalId:'source-b',idempotencyKey:'source-b-key',
      bundleId:'bundle-1',bundleManifestHash:f.bundleManifestHash});
    const reviewRequest={context:local,...scope,reviewId:'review-a',proposalId:'source-a',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,idempotencyKey:'review-a-key'};
    assert.throws(()=>app.reviewBaseline({...reviewRequest,bundleId:'bundle-1',
      bundleManifestHash:f.bundleManifestHash} as never),/INVALID_ARGUMENT/);
    assert.throws(()=>app.reviewBaseline({...reviewRequest,proposalId:'missing'}),/NOT_AVAILABLE/);
    assert.throws(()=>app.reviewBaseline({...reviewRequest,contextRevisionId:'wrong'}),/NOT_AVAILABLE/);
    assert.throws(()=>f.store.insertBaselineReview({id:'foreign-review',workspaceId:scope.workspaceId,
      collaborationId:'col-other',proposalId:'source-a',snapshotId:f.snapshotId,
      contextRevisionId:'ctx-1',reviewedBy:'owner'},
      {grantId:'other-local',operation:'decision.review',effect:'state_write',
        scope:{workspaceId:scope.workspaceId,collaborationId:'col-other'},principal:'owner',
        recipient:'local'},'local_host'),/NOT_AVAILABLE/);
    assert.equal(app.reviewBaseline(reviewRequest).proposalId,'source-a');
    const record={context:local,...scope,decisionId:'decision-a',proposalId:'source-a',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,reviewId:'review-a',
      outcome:'accept' as const,reason:'Local adoption',idempotencyKey:'decision-a-key'};
    assert.throws(()=>app.decide({...record,proposalId:'source-b'}),/NOT_AVAILABLE/);
    assert.throws(()=>app.decide({...record,items:[{id:'item-a',sourceRef:'bundle:bundle-1',
      outcome:'accept',reason:'Wrong target'}]}),/NOT_AVAILABLE/);
    assert.throws(()=>app.decide({...record,bundleId:'bundle-1',
      bundleManifestHash:f.bundleManifestHash} as never),/INVALID_ARGUMENT/);
    assert.throws(()=>app.decide({...record,context:external,idempotencyKey:'external-record'}),
      /Resource or operation is not available/);
    const dispatcher=new DispatchService(f.base,undefined,undefined,{contextDecision:app});
    await assert.rejects(dispatcher.dispatch(local,{operation:'decision.record',scope,
      idempotencyKey:'mixed-dispatch',payload:{decisionId:'mixed-dispatch',proposalId:'source-a',
        bundleId:'bundle-1',bundleManifestHash:f.bundleManifestHash,
        snapshotId:f.snapshotId,contextRevisionId:'ctx-1',outcome:'reject',reason:'Mixed'}}),
      /Choose one decision target/);
    const decision=app.decide({...record,items:[{id:'item-a',sourceRef:'proposal:source-a',
      outcome:'accept',reason:'Reviewed'}]});
    assert.equal(decision.currentContextRevisionId,'ctx-1');
    const staleReview=app.reviewBaseline({...reviewRequest,reviewId:'review-b',proposalId:'source-b',
      idempotencyKey:'review-b-key'});
    assert.equal(staleReview.proposalId,'source-b');
    const contextProposal=proposeContext({id:'ctx-proposal-later',...scope,
      parentRevisionId:'ctx-1',snapshotId:f.snapshotId,proposedBy:'reviewer',
      sourceRefs:['message-later'],content});
    f.store.insertProposal(contextProposal);
    f.store.insertRevision(acceptContext(contextProposal,'ctx-later',localPermit,'local_host'),
      localPermit,'local_host');
    assert.deepEqual(app.decide({...record,items:[{id:'item-a',sourceRef:'proposal:source-a',
      outcome:'accept',reason:'Reviewed'}]}),decision);
    assert.throws(()=>app.decide({...record,decisionId:'decision-b',proposalId:'source-b',
      reviewId:staleReview.id,idempotencyKey:'decision-b-key'}),/BASELINE_MISMATCH/);
    assert.equal(f.store.getDecision(scope.workspaceId,scope.collaborationId,'decision-b'),null);
    const freshReview=app.reviewBaseline({...reviewRequest,reviewId:'review-b-current',
      proposalId:'source-b',idempotencyKey:'review-b-current-key'});
    assert.equal(freshReview.currentContextRevisionId,'ctx-later');
    const modified=app.decide({...record,decisionId:'decision-b',proposalId:'source-b',
      reviewId:freshReview.id,outcome:'modify',reason:'Owner changes the suggestion',
      idempotencyKey:'decision-b-key',items:[{id:'item-b',sourceRef:'proposal:source-b',
        outcome:'modify',reason:'Scope correction'}]});
    assert.equal(modified.outcome,'modify');
    assert.equal(modified.currentContextRevisionId,'ctx-later');
    assert.equal(app.decide({context:local,...scope,decisionId:'direct-reject',proposalId:'source-b',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,outcome:'reject',reason:'Local rejection',
      idempotencyKey:'direct-reject-key'}).outcome,'reject');
    f.base.revokeGrant('local-read',new Date().toISOString());
    assert.throws(()=>app.decide({...record,items:[{id:'item-a',sourceRef:'proposal:source-a',
      outcome:'accept',reason:'Reviewed'}]}),/Resource or operation is not available/);
  } finally {f.close();}
});

test('formal decision transaction fault rolls back record and idempotency key', async () => {
  const f=await fixture();
  try {
    const app=f.app();
    app.proposeDecision({context:external,...scope,proposalId:'fault-source',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,recommendation:'modify',
      reason:'Consider changes',idempotencyKey:'fault-source-key'});
    const request={context:local,...scope,decisionId:'fault-decision',proposalId:'fault-source',
      contextRevisionId:'ctx-1',snapshotId:f.snapshotId,outcome:'reject' as const,
      reason:'Owner declines',idempotencyKey:'fault-decision-key'};
    const original=f.store.insertDecision.bind(f.store);
    f.store.insertDecision=(...args)=>{original(...args);throw new Error('synthetic decision fault');};
    assert.throws(()=>app.decide(request),/synthetic decision fault/);
    assert.equal(f.store.getDecision(scope.workspaceId,scope.collaborationId,'fault-decision'),null);
    f.store.insertDecision=original;
    assert.equal(app.decide(request).id,'fault-decision');
  } finally {f.close();}
});

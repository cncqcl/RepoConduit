import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {RepositoryApplication} from '../../src/application/repository.js';
import {DispatchService} from '../../src/application/dispatch.js';
import {authorize} from '../../src/core/policy/authorize.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';
import type {ContextRevision} from '../../src/core/collaboration/context.js';
import {createPersonalClaudeInvestigator,type PersonalClaudeOwner} from '../../src/runtime/claude-personal-investigation.js';
import {runInvestigationCleanupTick} from '../../src/runtime/investigation-recovery.js';

// Real SQLite, grants, HTTP MCP and exact-byte result validation; only the native/model process is simulated.
for(const mode of ['success','success-dot','success-stream','success-fenced','fenced-extra','fenced-duplicate',
 'fenced-receipt','fenced-hash','forged','cancel','unknown-close','revoked','output-write-failure','timeout-reserve'] as const){
 test(`Windows Claude composition ${mode} preserves actual read and close semantics`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rcac-claude-personal-'));
  const base=new SqliteStore(join(dir,'state.sqlite'));
  const snapshot=createSnapshotFromFiles('wc','synthetic',{'entry.ts':Buffer.from('export const answer = 42;\n'),
   'hidden.ts':Buffer.from('DO_NOT_DISCLOSE')});
  base.insertWorkspace({id:'ws',name:'Synthetic',canonicalRoot:dir,registeredBy:'owner'});
  base.insertCollaboration({id:'col',workspaceId:'ws',openedBy:'owner',purpose:'read',hostThreadId:null,state:'open'});
  base.insertWorkingCopy({id:'wc',workspaceId:'ws',canonicalRoot:dir});
  await base.saveSnapshot({workspaceId:'ws',collaborationId:'col',workingCopyId:'wc',snapshot:snapshot.toPersisted()},
   {workspaceId:'ws',collaborationId:'col',workingCopyId:'wc',commitRef:'synthetic'},'capture','owner','local_cli');
  base.insertGrant({id:'request',principal:'external',audience:'chatgpt',recipient:'web',workspaceId:'ws',
   collaborationId:'col',permissions:['investigation.request','investigation.cancel'],expiresAt:null,revokedAt:null});
  base.insertGrant({id:'read',principal:'external',audience:'chatgpt',recipient:'web',workspaceId:'ws',
   collaborationId:'col',permissions:['data.read'],dataPaths:['entry.ts'],expiresAt:null,revokedAt:null});
  const record:InvestigationRecord={id:'inv-fixture',workspaceId:'ws',collaborationId:'col',workingCopyId:'wc',
   principal:'external',audience:'chatgpt',recipient:'web',grantId:'request',profileRef:'profile',budgetRef:'profile',
   budget:{maxWallSeconds:15,maxTurns:2,maxToolCalls:2},contextRevisionId:'ctx',snapshotRef:snapshot.id,
   question:'Read entry',scope:{paths:['entry.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],
   parentInvestigationId:null,state:'queued',cancelRequested:false,attempts:[],result:null,createdAt:new Date().toISOString()};
  const context:ContextRevision={kind:'revision',id:'ctx',sourceProposalId:'p',acceptedBy:'owner',workspaceId:'ws',
   collaborationId:'col',parentRevisionId:null,snapshotId:snapshot.id,sourceRefs:['synthetic'],content:{goal:'read',
    constraints:[],acceptedDecisions:[],rejectedDecisions:[],currentQuestions:[],evidenceRefs:[],
    expectedDeliverables:[],unknowns:[],recentChanges:[]}};
  let stops=0,sends=0,workerId='';
  const nativeTool=mode==='success-dot'?'mcp__repo-conduit__repo.read':'mcp__repo-conduit__repo_read';
  const runtime=createPersonalClaudeInvestigator(dir,{workspaceId:'ws',profileRevision:'profile'},undefined,{
   assertAvailable(){},
   async open(options){
    if(mode==='output-write-failure')mkdirSync(join(options.runtimeRoot,'native.jsonl'));
    const output=new PassThrough(),errors=new PassThrough();
    let work:Promise<void>|undefined;
    workerId=store.listUnsettled()[0]!.workerId;
    let nativeRoot:{pid:number;creationFiletime:string}|null=null;
    const owner:PersonalClaudeOwner={output,errors,get root(){return nativeRoot;},
     remainingWallMs(){return mode==='timeout-reserve'?6_000:options.maxWallSeconds*1000;},
     async start(){nativeRoot={pid:123,creationFiletime:'1234'};return nativeRoot;},
     send(frame){
      sends++;
      if(mode==='timeout-reserve')return true;
      work=(async()=>{
       const message=JSON.parse(frame) as {message:{content:string}};
       const config=JSON.parse(readFileSync(join(options.runtimeRoot,'mcp.json'),'utf8')) as {
        mcpServers:Record<string,{url:string;headers:Record<string,string>}>};
       const mcp=config.mcpServers['repo-conduit']!;
       const client=new Client({name:'synthetic-Claude',version:'1'});
       try{
        await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url),{requestInit:{headers:mcp.headers}}));
        const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['repo.read']);
        const args={scope:{workspaceId:'ws',collaborationId:'col'},payload:{workingCopyId:'wc',snapshotId:snapshot.id,path:'hidden.ts'}};
        const denied=await client.callTool({name:'repo.read',arguments:args});
        assert.equal(denied.isError,true);assert.doesNotMatch(JSON.stringify(denied),/DO_NOT_DISCLOSE/);
        if(mode==='revoked')base.revokeGrant('read',new Date().toISOString());
        const read=await client.callTool({name:'repo.read',arguments:{...args,payload:{...args.payload,path:'entry.ts'}}});
        if(mode==='revoked'){assert.equal(read.isError,true);output.end();return;}
        const page=JSON.parse((read.content as {text:string}[])[0]!.text) as Record<string,unknown>;
        const current=store.get(record.id)!;
        const result={kind:'investigation_result_v1',requestId:record.id,attemptId:current.attempts[0]!.id,
         resultState:'completed',snapshotRef:snapshot.id,contextRevisionId:'ctx',
         findings:[{statement:'answer is 42',classification:'source_confirmed',evidenceRefs:[page.toolReceipt]}],
         evidence:[{path:'entry.ts',symbol:null,lineRange:[1,1],byteRange:[0,26],contentHash:page.contentHash,
          excerpt:mode==='forged'?'fabricated':'export const answer = 42;\n',toolReceipt:page.toolReceipt}],
         coverage:{searchedScope:['entry.ts'],excludedCategories:[],truncated:false,missingDependencies:[]},
         openQuestions:[],limitsAndWarnings:[]};
        if(mode==='fenced-receipt'){
         result.evidence[0]!.toolReceipt='not-a-durable-read';
         result.findings[0]!.evidenceRefs=['not-a-durable-read'];
        }
        if(mode==='fenced-hash')result.evidence[0]!.contentHash='0'.repeat(64);
        let resultJson=JSON.stringify(mode==='fenced-extra'?{...result,extra:true}:result);
        if(mode==='fenced-duplicate')resultJson=resultJson.replace('"kind":',
         '"kind":"investigation_result_v1","kind":');
        if(mode==='success-fenced'||mode.startsWith('fenced-'))resultJson=`\`\`\`json\n${resultJson}\n\`\`\``;
        assert.match(message.message.content,/inv-fixture/);
        if(mode==='cancel')store.requestCancel(store.get(record.id)!,'cancel','request');
        const streamEvents:unknown[]=[];
        if(mode==='success-stream')streamEvents.push({type:'system',subtype:'ui_invalidate',
         event:'ui.render',uuid:'22b03344-5566-4788-99aa-bbccddeeff00',session_id:'session-fixture'});
        streamEvents.push({type:'system',subtype:'init',session_id:'session-fixture',tools:[nativeTool]});
        if(mode==='success-stream')streamEvents.push(
         {type:'system',subtype:'thinking_tokens',estimated_tokens:19,
          estimated_tokens_delta:4,session_id:'session-fixture',
          uuid:'22b03344-5566-4788-99aa-bbccddeeff00'},
         {type:'assistant',message:{content:[{type:'thinking',
          thinking:'Synthetic internal text only.',signature:'synthetic-signature'}]}});
        streamEvents.push({type:'assistant',message:{content:[{type:'tool_use',name:nativeTool,id:'read-1'}]}});
        if(mode==='success-stream')streamEvents.push({type:'system',subtype:'thinking_tokens',
         estimated_tokens:25,estimated_tokens_delta:6,session_id:'session-fixture',
         uuid:'22b03344-5566-4788-99aa-bbccddeeff00'});
        streamEvents.push({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1'}]}});
        streamEvents.push({type:'result',subtype:'success',is_error:false,
         session_id:'session-fixture',num_turns:1,result:resultJson});
        output.end(streamEvents.map(item=>JSON.stringify(item)).join('\n')+'\n');
       }finally{await client.close();}
      })().catch(error=>{output.destroy(error as Error);});
      return true;
     },
     async stop(){stops++;await work;errors.end();
      if(mode==='unknown-close')throw new Error('UNKNOWN');
      return {kind:'job_closed'};},
    };
    return owner;
   },
  });
  const store=new SqliteInvestigationStore(join(dir,'state.sqlite'),{verifyIsolation:runtime.verifyIsolation,
   verifyNativeReceipt:runtime.verifyNativeReceipt,verifyOutcomeReceipt:runtime.verifyOutcomeReceipt});
  const repository=new RepositoryApplication({authorize:async request=>{
   await request.context.assertFreshAuthority?.();return authorize({...request.context,now:new Date()},request.operation,
    {workspaceId:request.workspaceId,collaborationId:request.collaborationId},base.grantsFor(request.context.principal,request.context.audience));},
   getWorkingCopy:(ws,wc)=>base.getWorkingCopy(ws,wc),collaborationBelongsToWorkspace:(ws,col)=>base.collaborationBelongsToWorkspace(ws,col),
   lookupCapture:(...a)=>base.lookupCapture(...a),saveSnapshot:(...a)=>base.saveSnapshot(...a),getSnapshot:(...a)=>base.getSnapshot(...a)});
  const dispatcher=new DispatchService(base,undefined,undefined,{repository});
  try{
   store.enqueue(record,'new','fingerprint');
   const started=performance.now();
   const work=runtime.run({store,grants:base,dispatcher,record,contextRevision:context,snapshot,signal:new AbortController().signal});
   let observed:InvestigationRecord|null;
   if(mode==='output-write-failure'){
    await assert.rejects(work,/CLAUDE_INVESTIGATION_CLEANUP_UNCONFIRMED/);
    observed=store.get(record.id);
   }else observed=await work;
   assert.equal(sends,1);assert.equal(stops,1);
   const attempt=observed!.attempts[0]!;
   const persisted=JSON.parse(readFileSync(join(dir,'claude-runs',attempt.id,'native-diagnostic.json'),'utf8')) as
    {requestId:string;outputBytes:number;stderrBytes:number;httpClose:string;jobClosed:boolean;cleanupFailures:string[]};
   assert.equal(persisted.requestId,record.id);
   if(mode==='revoked'||mode==='timeout-reserve')assert.equal(persisted.outputBytes,0);
   else assert.ok(persisted.outputBytes>0);
   assert.equal(persisted.stderrBytes,0);
   assert.equal(persisted.httpClose,'closed');assert.equal(persisted.jobClosed,mode!=='unknown-close');
   assert.deepEqual(JSON.parse(readFileSync(join(dir,'claude-runs',attempt.id,'mcp.json'),'utf8')),{mcpServers:{}});
   assert.deepEqual(persisted.cleanupFailures,mode==='output-write-failure'?['native_output_write']:[]);
   if(mode==='timeout-reserve')assert.ok(performance.now()-started<3_000,
    'model stop must reserve original owner closure time instead of waiting for its hard deadline');
   const completed=mode.startsWith('success')||mode==='output-write-failure';
   assert.equal(observed?.state,completed?'completed':mode==='cancel'?'cancelled':mode==='unknown-close'?'recovery_required':'failed');
   if(completed){
    assert.equal(observed?.result?.resultState,'completed');
    assert.equal(Object.hasOwn(observed!.result!.evidence[0]!,'byteRange'),false);
   }
   else assert.notEqual(observed?.result?.resultState,'completed');
   // Failed/unknown is never silently replayed and no live worker grant survives completion.
   assert.ok(workerId);assert.equal(base.grantsFor(workerId,'claude-investigator').filter(g=>g.revokedAt===null).length,0);
   if(mode==='unknown-close'){
    // Simulate loss between native start and the owner's catch/finally, then a new host startup.
    const db=new DatabaseSync(join(dir,'state.sqlite'));
    const running={...observed!,state:'running',attempts:observed!.attempts.map(a=>({...a,state:'running'}))};
    db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify(running),record.id);
    db.prepare("UPDATE investigation_active_attempts SET lease_until=?,phase='started' WHERE request_id=?")
     .run(new Date(Date.now()-1000).toISOString(),record.id);db.close();
    await runInvestigationCleanupTick(store,'restart-fixture',{
     async removeContainer(){throw new Error('must not call Docker');},async removeScratch(){throw new Error('must not remove unknown files');}});
    assert.equal(store.get(record.id)?.state,'recovery_required');
    assert.equal(store.listUnsettled().length,1);
    assert.deepEqual(await runtime.run({store,grants:base,dispatcher,record:store.get(record.id)!,
     contextRevision:context,snapshot,signal:new AbortController().signal}),store.get(record.id));
    assert.equal(sends,1);
   }
  }finally{store.close();base.close();rmSync(dir,{recursive:true,force:true});}
 });
}

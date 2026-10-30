import type {DispatchService} from '../application/dispatch.js';
import type {RequestContext} from '../core/policy/authorize.js';
import type {InvestigationClaim,RunningReadBinding,SqliteInvestigationStore,CodexNativeReadTurn} from
  '../adapters/storage/investigation-sqlite.js';
import {parseCodexRepoReadArguments,type CodexRepoReadCall,type CodexRepoReadCapability} from
  '../adapters/codex/protocol/repo-read-tool.js';

export type CodexInvestigatorReadStore=Pick<SqliteInvestigationStore,
 'get'|'getNativeJournal'|'assertCodexReadAuthority'|'reserveCodexRead'|
 'discloseCodexRead'|'getSucceededCodexReadReceipts'>;

/** Internal capability only; model arguments cannot select identity, grant, operation or snapshot. */
export function createCodexInvestigatorReadCapability(input:{
 store:CodexInvestigatorReadStore;claim:InvestigationClaim;binding:RunningReadBinding;
 dispatcher:Pick<DispatchService,'dispatch'>;signal?:AbortSignal;now?:()=>Date;
 assertWorkFresh?:()=>void;
}):CodexRepoReadCapability {
 const claim=structuredClone(input.claim),binding=structuredClone(input.binding);
 const now=input.now??(()=>new Date());
 const record=input.store.get(claim.requestId);
 if(!record || record.workspaceId!==claim.workspaceId || record.collaborationId!==binding.collaborationId ||
  record.workingCopyId!==binding.workingCopyId || record.snapshotRef!==binding.snapshotId ||
  JSON.stringify([...new Set([...record.scope.paths,...record.scope.relatedTests])].sort())!==
  JSON.stringify([...binding.paths].sort())) throw new Error('NOT_AVAILABLE');
 const resolveTurn=(call:CodexRepoReadCall):CodexNativeReadTurn=>{
  if(input.signal?.aborted) throw new Error('NOT_AVAILABLE');
  const journal=input.store.getNativeJournal(claim,binding.collaborationId);
  const turn=journal?.turns.find(item=>item.turnId===call.turnId && item.state==='observed');
  if(!journal || journal.thread.threadId!==call.threadId || journal.workerEpoch!==claim.workerEpoch ||
   !turn) throw new Error('NOT_AVAILABLE');
  return {intentId:turn.intentId,threadId:call.threadId,turnId:call.turnId};
 };
 return {async read(call,emit){
  const args=parseCodexRepoReadArguments(call.arguments);
  if(!binding.paths.includes(args.path)) throw new Error('NOT_AVAILABLE');
  const turn=resolveTurn(call);
  const fresh=()=>{
   input.assertWorkFresh?.();
   if(input.signal?.aborted) throw new Error('NOT_AVAILABLE');
   input.store.assertCodexReadAuthority(claim,binding,turn,now());
  };
  fresh();
  const context:RequestContext={principal:claim.workerId,audience:binding.workerAudience,
   recipient:binding.workerRecipient,surface:'external_mcp',now:now(),delegatedPermissions:['data.read'],
   assertFreshAuthority:async()=>fresh(),
   reserveRepositoryRead:read=>{fresh();return input.store.reserveCodexRead(claim,binding,turn,call.callId,read,now());}};
  const result=await input.dispatcher.dispatch(context,{operation:'repo.read',
   scope:{workspaceId:claim.workspaceId,collaborationId:binding.collaborationId},
   payload:{workingCopyId:binding.workingCopyId,snapshotId:binding.snapshotId,
    path:args.path,maxBytes:args.maxBytes??4096,maxLines:args.maxLines??200,
    ...(args.cursor===undefined?{}:{cursor:args.cursor})}});
  fresh();
  if(!result || typeof result!=='object' || Array.isArray(result) ||
   typeof (result as Record<string,unknown>).toolReceipt!=='string') throw new Error('NOT_AVAILABLE');
  const receiptId=(result as Record<string,unknown>).toolReceipt;
  const receipts=input.store.getSucceededCodexReadReceipts(claim,turn);
  if(!receipts.some(item=>item.id===receiptId && item.callId===call.callId && item.path===args.path))
   throw new Error('NOT_AVAILABLE');
  const text=JSON.stringify(result);
  if(Buffer.byteLength(text,'utf8')>32*1024) throw new Error('NOT_AVAILABLE');
  if(input.signal?.aborted) throw new Error('NOT_AVAILABLE');
  // This synchronous enqueue is ordered with persistent revocation by the store's short transaction.
  input.store.discloseCodexRead(claim,binding,turn,now(),()=>{
   input.assertWorkFresh?.();
   if(input.signal?.aborted) throw new Error('NOT_AVAILABLE');
   emit({success:true,contentItems:[{type:'inputText',text}]});
  });
 }};
}

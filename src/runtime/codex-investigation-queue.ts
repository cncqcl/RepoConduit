import type {InvestigationRecord} from '../core/investigation/request.js';

type Selection={workspaceId:string;profileRevision:string};
type Pending={requestId:string;workspaceId:string;collaborationId:string};

/** Admission coordinator only. The existing SQLite claim decides slots and authority. */
export function createCodexInvestigationQueue(deps:{selection?:Selection;
 /** Trusted composition only; evaluated afresh for each queued request. */
 matches?:(record:InvestigationRecord)=>boolean;
 listPending():Pending[];get(requestId:string):InvestigationRecord|null;
 run(requestId:string):Promise<InvestigationRecord|null>}){
 if((deps.selection===undefined)===(deps.matches===undefined))throw new Error('NOT_AVAILABLE');
 const selected=deps.selection?Object.freeze({...deps.selection}):undefined;
 let accepting=true;
 let ticking:Promise<void>|undefined;
 let failure:unknown;
 let failed=false;
 const stopAdmission=()=>{accepting=false;};
 const tick=():Promise<void>=>{
  if(ticking)return ticking;
  if(!accepting)return failed?Promise.reject(failure):Promise.resolve();
  const work=(async()=>{
   for(const pending of deps.listPending()){
    if(!accepting)return;
    if(selected&&pending.workspaceId!==selected.workspaceId)continue;
    const record=deps.get(pending.requestId);
    if(!record||record.id!==pending.requestId||record.workspaceId!==pending.workspaceId||
       record.collaborationId!==pending.collaborationId||
       (selected&&(record.profileRef!==selected.profileRevision||
       record.budgetRef!==selected.profileRevision))||record.state!=='queued'||
       record.cancelRequested||record.attempts.length!==0)continue;
    if(deps.matches&&!deps.matches(structuredClone(record)))continue;
    await deps.run(record.id);
   }
  })();
  ticking=work;
  void work.then(()=>{if(ticking===work)ticking=undefined;},error=>{
   accepting=false;failed=true;failure=error;
   if(ticking===work)ticking=undefined;
  });
  return work;
 };
 const close=async()=>{stopAdmission();if(ticking)await ticking;if(failed)throw failure;};
 return {tick,stopAdmission,close,get failed(){return failed;}};
}

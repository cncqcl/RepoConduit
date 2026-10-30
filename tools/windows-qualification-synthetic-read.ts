/** Only synthetic README bytes may enter the application read handler in this source-only trial. */
import {join} from 'node:path';
import {SqliteStore} from '../src/adapters/storage/sqlite.js';
import {createSnapshotFromFiles} from '../src/adapters/repository/snapshots.js';
import {RepositoryApplication} from '../src/application/repository.js';
import {DispatchService} from '../src/application/dispatch.js';
import {authorize,type RequestContext} from '../src/core/policy/authorize.js';
import {parseCodexRepoReadArguments} from '../src/adapters/codex/protocol/repo-read-tool.js';

const denied=()=>new Error('QUALIFICATION_READ_DENIED');
const source=Buffer.from('# RepoConduit synthetic qualification source\nNo repository data.\n');

export async function createSyntheticQualificationRead(fixtureRoot:string){
 const base=new SqliteStore(join(fixtureRoot,'qualification-read.sqlite'));
 let closed=false,count=0,dispatches=0;
 try{
  const now=new Date();
  base.insertWorkspace({id:'qualification-ws',name:'Synthetic',canonicalRoot:fixtureRoot,registeredBy:'local-owner'});
  base.insertCollaboration({id:'qualification-col',workspaceId:'qualification-ws',openedBy:'local-owner',
   purpose:'synthetic-only',hostThreadId:null,state:'open'});
  base.insertWorkingCopy({id:'qualification-copy',workspaceId:'qualification-ws',canonicalRoot:fixtureRoot});
  const snapshot=createSnapshotFromFiles('qualification-copy','synthetic',{
   'README.md':source,'private.txt':Buffer.from('FIXED SYNTHETIC CANARY: out of scope.\n')});
  await base.saveSnapshot({workspaceId:'qualification-ws',collaborationId:'qualification-col',
   workingCopyId:'qualification-copy',snapshot:snapshot.toPersisted()},
  {workspaceId:'qualification-ws',collaborationId:'qualification-col',workingCopyId:'qualification-copy',
   commitRef:'synthetic'},'capture','local-owner','local_cli');
  base.insertGrant({id:'qualification-read',principal:'qualification-agent',audience:'investigator',
   recipient:'codex-local',permissions:['data.read'],dataPaths:['README.md'],
   workspaceId:'qualification-ws',collaborationId:'qualification-col',revokedAt:null,
   expiresAt:new Date(now.getTime()+600_000).toISOString()});
  const repository=new RepositoryApplication({
   authorize:async({context,operation,workspaceId,collaborationId})=>{
    if(closed)throw denied();await context.assertFreshAuthority?.();
    return authorize({...context,now:new Date()},operation,{workspaceId,collaborationId},
     base.grantsFor(context.principal,context.audience));
   },
   getWorkingCopy:(ws,copy)=>base.getWorkingCopy(ws,copy),
   collaborationBelongsToWorkspace:(ws,col)=>base.collaborationBelongsToWorkspace(ws,col),
   lookupCapture:(input,key,p,a)=>base.lookupCapture(input,key,p,a),
   saveSnapshot:(value,input,key,p,a)=>base.saveSnapshot(value,input,key,p,a),
   getSnapshot:(id,ws,col)=>base.getSnapshot(id,ws,col),
  });
  const dispatcher=new DispatchService(base,undefined,undefined,{repository});
  return Object.freeze({
   async read(untrusted:unknown):Promise<unknown>{
    if(closed||count>=3)throw denied();
    let args:ReturnType<typeof parseCodexRepoReadArguments>;
    try{args=parseCodexRepoReadArguments(untrusted);}catch{throw denied();}
    count++;
    const context:RequestContext={principal:'qualification-agent',audience:'investigator',
     recipient:'codex-local',surface:'external_mcp',now:new Date(),delegatedPermissions:['data.read'],
     assertFreshAuthority:async()=>{if(closed)throw denied();}};
    try{dispatches++;return await dispatcher.dispatch(context,{operation:'repo.read',
     scope:{workspaceId:'qualification-ws',collaborationId:'qualification-col'},
     payload:{workingCopyId:'qualification-copy',snapshotId:snapshot.id,path:args.path,
      maxBytes:args.maxBytes,maxLines:args.maxLines,...(args.cursor===undefined?{}:{cursor:args.cursor})}});}
    catch{throw denied();}
   },
   calls:()=>count,
   dispatches:()=>dispatches,
   close(){if(closed)return;closed=true;base.close();},
  });
 }catch{base.close();throw denied();}
}

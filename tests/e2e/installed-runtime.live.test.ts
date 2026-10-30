/** One installed Claude runtime smoke. A missing case is an explicit skip, never live evidence. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {closeSync,existsSync,lstatSync,openSync,readFileSync,realpathSync,writeSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

interface Case {
 kind:string;root:string;cli:string;cliSha256:string;workspaceId:string;collaborationId:string;
 workingCopyId:string;contextRevisionId:string;snapshotId:string;profileRevision:string;
 requestId:string;sourcePath:string;sourceSha256:string;
}
interface Result {
 requestId:string;state:string;hasResult:boolean;
 diagnostic?:{requestId:string;stage:string;code:string;jobClosed?:boolean;
  nativeSessionId?:string;outputSha256?:string};
}
interface StoredRecord {
 id:string;workspaceId:string;collaborationId:string;workingCopyId:string;
 contextRevisionId:string;snapshotRef:string;profileRef:string;budgetRef:string;
 state:string;attempts:Array<{id:string;nativeRef:string|null;terminationConfirmed:boolean}>;
 result:null|{resultState:string;evidence:Array<{path:string;contentHash:string;
  toolReceipt:string|null}>};
}
const parent=process.env.RCAC_LIVE_FIXTURE_PARENT ?? join(homedir(),'repo-conduit-live-fixtures');
function assertIdentity(record:StoredRecord,value:Case){
 assert.equal(record.id,value.requestId);
 assert.equal(record.workspaceId,value.workspaceId);
 assert.equal(record.collaborationId,value.collaborationId);
 assert.equal(record.workingCopyId,value.workingCopyId);
 assert.equal(record.contextRevisionId,value.contextRevisionId);
 assert.equal(record.snapshotRef,value.snapshotId);
 assert.equal(record.profileRef,value.profileRevision);
 assert.equal(record.budgetRef,value.profileRevision);
}

function loadCase(root:string):Case{
 assert.ok(isAbsolute(root)&&resolve(root)===root);
 assert.ok(root.startsWith(parent+sep)&&basename(root).startsWith('neutral01-live-'));
 for(const path of [parent,root]){
  const stat=lstatSync(path);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  assert.equal(realpathSync.native(path).toLowerCase(),resolve(path).toLowerCase());
 }
 const path=join(root,'neutral01-case.json');
 assert.ok(lstatSync(path).isFile());
 const bytes=readFileSync(path);assert.ok(bytes.length<8192);
 const value=JSON.parse(bytes.toString('utf8')) as Case;
 assert.equal(value.kind,'neutral01_installed_claude_v1');
 assert.equal(value.root,root);assert.equal(value.sourcePath,'src/provenance.ts');
 assert.match(value.requestId,/^inv_[0-9a-f-]{36}$/);
 assert.match(value.sourceSha256,/^[0-9a-f]{64}$/);
 assert.ok(isAbsolute(value.cli)&&existsSync(value.cli)&&lstatSync(value.cli).isFile());
 assert.ok(value.cli.replaceAll('\\','/').endsWith('/dist/src/cli/main.js'));
 assert.equal(realpathSync.native(value.cli).toLowerCase(),resolve(value.cli).toLowerCase());
 assert.match(value.cliSha256,/^[0-9a-f]{64}$/);
 assert.equal(createHash('sha256').update(readFileSync(value.cli)).digest('hex'),value.cliSha256);
 const hash=createHash('sha256').update(readFileSync(join(root,value.sourcePath))).digest('hex');
 assert.equal(hash,value.sourceSha256);
 return value;
}

async function runOnce(value:Case):Promise<{exitCode:number|null;timedOut:boolean;
 outputLimitExceeded:boolean;closedAt:string;stdout:string;stderr:string}>{
 const stdoutFile=join(value.root,'neutral01-cli.stdout');
 const stderrFile=join(value.root,'neutral01-cli.stderr');
 const out=openSync(stdoutFile,'wx',0o600),err=openSync(stderrFile,'wx',0o600);
 const child=spawn(process.execPath,[value.cli,'--data-dir',value.root,'run-claude-investigation'],
  {cwd:value.root,stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='',timedOut=false,outputLimitExceeded=false;
 const cap=1024*1024;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},210_000);
 const hardTimer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},215_000);
 try{
  child.stdout.on('data',(part:Buffer)=>{
   const remaining=Math.max(0,cap-Buffer.byteLength(stdout));
   if(part.length>remaining){outputLimitExceeded=true;child.kill('SIGTERM');}
   const bounded=part.subarray(0,remaining);writeSync(out,bounded);stdout+=bounded.toString('utf8');
  });
  child.stderr.on('data',(part:Buffer)=>{
   const remaining=Math.max(0,cap-Buffer.byteLength(stderr));
   if(part.length>remaining){outputLimitExceeded=true;child.kill('SIGTERM');}
   const bounded=part.subarray(0,remaining);writeSync(err,bounded);stderr+=bounded.toString('utf8');
  });
  child.stdin.end(JSON.stringify({workspaceId:value.workspaceId,
   profileRevision:value.profileRevision,requestId:value.requestId}));
  const exitCode=await new Promise<number|null>((resolve,reject)=>{
   child.once('error',reject);child.once('close',resolve);
  });
  return {exitCode,timedOut,outputLimitExceeded,closedAt:new Date().toISOString(),stdout,stderr};
 }finally{clearTimeout(timer);clearTimeout(hardTimer);closeSync(out);closeSync(err);}
}

const selected=process.env.RCAC_NEUTRAL_CASE;
test('NEUTRAL01 installed Claude read, result and native close',
 {skip:!selected&&'RCAC_NEUTRAL_CASE absent: no installed live run was executed',timeout:220_000},
 async()=>{
  const value=loadCase(selected!);
  const file=join(value.root,'state.sqlite');
  const before=new DatabaseSync(file,{readOnly:true});
  try{
   const row=before.prepare('SELECT record_json FROM investigation_requests WHERE id=?')
    .get(value.requestId) as {record_json:string}|undefined;
   assert.ok(row);
   const record=JSON.parse(row.record_json) as StoredRecord;
   assertIdentity(record,value);
   assert.equal(record.state,'queued');assert.equal(record.attempts.length,0);
  }finally{before.close();}
  // Creation with wx is the one-shot guard. An interrupted or failed call is evidence, not replayable.
  const marker=openSync(join(value.root,'neutral01-run-started.json'),'wx',0o600);
  try{writeSync(marker,JSON.stringify({requestId:value.requestId,at:new Date().toISOString()})+'\n');}
  finally{closeSync(marker);}
  let run:Awaited<ReturnType<typeof runOnce>>|undefined,runError:string|null=null;
  try{run=await runOnce(value);}catch(error){runError=error instanceof Error?error.message:String(error);}
  const db=new DatabaseSync(file,{readOnly:true});
  const {record,reads,active,outbox,workerGrants}=(()=>{try{
   const row=db.prepare('SELECT record_json FROM investigation_requests WHERE id=?')
    .get(value.requestId) as {record_json:string}|undefined;
   const record=row?JSON.parse(row.record_json) as StoredRecord:null;
   const reads=db.prepare('SELECT * FROM investigation_read_receipts WHERE request_id=? ORDER BY observed_at,id')
    .all(value.requestId) as Record<string,unknown>[];
   const active=(db.prepare('SELECT COUNT(*) AS n FROM investigation_active_attempts WHERE request_id=?')
    .get(value.requestId) as {n:number}).n;
   const outbox=(db.prepare('SELECT COUNT(*) AS n FROM investigation_outbox WHERE request_id=?')
    .get(value.requestId) as {n:number}).n;
   const workerGrants=(db.prepare("SELECT COUNT(*) AS n FROM grants WHERE id LIKE 'claude-read-%' AND revoked_at IS NULL")
    .get() as {n:number}).n;
   return {record,reads,active,outbox,workerGrants};
  }finally{db.close();}})();
  let response:Result|null=null;
  try{response=run?.stdout?JSON.parse(run.stdout) as Result:null;}catch{/* Raw stdout remains authoritative. */}
  const nativePath=record?.attempts[0]?.id?
   join(value.root,'claude-runs',record.attempts[0].id,'native.jsonl'):null;
  const nativeOutputSha256=nativePath&&existsSync(nativePath)?
   createHash('sha256').update(readFileSync(nativePath)).digest('hex'):null;
  const sourceSha256After=createHash('sha256').update(readFileSync(join(value.root,value.sourcePath)))
   .digest('hex');
  // Once the installed handler reports its original Job closed, withdraw only this case's grants.
  let revokeError:string|null=null;
  if(response?.diagnostic?.jobClosed===true&&active===0&&outbox===0){
   try{
    const packageRoot=resolve(dirname(value.cli),'../../..');
    const storageFile=join(packageRoot,'dist/src/adapters/storage/sqlite.js');
    const storage=await import(pathToFileURL(storageFile).href) as
     typeof import('../../src/adapters/storage/sqlite.js');
    const store=new storage.SqliteStore(file);
    try{for(const id of ['neutral-admin','neutral-request','neutral-read'])
     store.revokeGrant(id,new Date().toISOString());}
    finally{store.close();}
   }catch(error){revokeError=error instanceof Error?error.message:String(error);}
  }
  const evidence={kind:'neutral01_installed_claude_observation_v1',at:new Date().toISOString(),
   requestId:value.requestId,exitCode:run?.exitCode??null,timedOut:run?.timedOut??false,
   outputLimitExceeded:run?.outputLimitExceeded??false,closedAt:run?.closedAt??null,
   runError,revokeError,response,record,reads,active,outbox,workerGrants,
   nativeOutputSha256,sourceSha256After,
   stdoutFile:'neutral01-cli.stdout',stderrFile:'neutral01-cli.stderr'};
  const evidenceFile=join(value.root,'neutral01-observation.json');
  const evidenceFd=openSync(evidenceFile,'wx',0o600);
  try{writeSync(evidenceFd,JSON.stringify(evidence,null,2)+'\n');}finally{closeSync(evidenceFd);}
  assert.equal(runError,null);
  assert.equal(run?.timedOut,false);
  assert.equal(run?.outputLimitExceeded,false);
  assert.equal(run?.exitCode,0,run?.stderr.slice(0,4096));
  assert.equal(response?.requestId,value.requestId);
  assert.equal(response?.state,'completed');assert.equal(response?.hasResult,true);
  assert.equal(response?.diagnostic?.requestId,value.requestId);
  assert.equal(response?.diagnostic?.jobClosed,true);
  assert.equal(nativeOutputSha256,response?.diagnostic?.outputSha256);
  assert.equal(revokeError,null);
  assert.equal(sourceSha256After,value.sourceSha256);
  assert.ok(record);assertIdentity(record,value);
  assert.equal(record?.state,'completed');
  assert.equal(record?.attempts.length,1);
  assert.ok(record?.attempts[0]?.nativeRef?.startsWith('claude-windows:'));
  // The generic legacy field remains false for a normal Claude completion;
  // the original Windows Job closure is established by the owner diagnostic above.
  assert.equal(record?.attempts[0]?.terminationConfirmed,false);
  assert.equal(record?.result?.resultState,'completed');
  assert.ok(reads.some(read=>read.status==='succeeded'&&read.path===value.sourcePath&&
   read.full_content_hash===value.sourceSha256&&
   record?.result?.evidence.some(item=>item.path===value.sourcePath&&
    item.contentHash===value.sourceSha256&&item.toolReceipt===read.id)));
  assert.equal(active,0);assert.equal(outbox,0);assert.equal(workerGrants,0);
 });

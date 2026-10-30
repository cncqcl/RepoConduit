import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {parseWindowsConfigInitialize,parseWindowsConfigRead,runWindowsConfigProtocol} from
 '../../src/adapters/codex/protocol/windows-config-check.js';
import {diagnoseOwnedConfigChannel} from
 '../../src/adapters/codex/investigator/windows-job-stdio.js';

const codexHome='C:\\private\\home\\.codex';
const configPath=`${codexHome}\\config.toml`;
const origin={name:{type:'user',file:configPath},version:'1'};
const expected={codexHome,configPath,modelRef:'gpt-6-sol'};

test('schema shaped initialize and config/read prove selected values and user origins only',()=>{
 assert.equal(parseWindowsConfigInitialize({userAgent:'Codex',codexHome,
  platformFamily:'windows',platformOs:'windows'},codexHome),true);
 assert.equal(parseWindowsConfigRead({config:{model:'gpt-6-sol',approval_policy:'never',
  web_search:'disabled'},origins:{model:origin,approval_policy:origin,web_search:origin},
  layers:null},expected),true);
});

test('unknown origins, other models, platform, or layers never verify strict config',()=>{
 assert.equal(parseWindowsConfigInitialize({userAgent:'Codex',codexHome,
  platformFamily:'unix',platformOs:'windows'},codexHome),false);
 for(const bad of [
  {config:{model:'other',approval_policy:'never',web_search:'disabled'},
   origins:{model:origin,approval_policy:origin,web_search:origin},layers:null},
  {config:{model:'gpt-6-sol',approval_policy:'never',web_search:'disabled'},
   origins:{model:{name:{type:'project',dotCodexFolder:'C:\\repo\\.codex'},version:'1'},
    approval_policy:origin,web_search:origin},layers:null},
  {config:{model:'gpt-6-sol',approval_policy:'never',web_search:'disabled'},
   origins:{model:origin,approval_policy:origin,web_search:origin},layers:[{name:{type:'project'},version:'1',config:{}}]},
 ]) assert.equal(parseWindowsConfigRead(bad,expected),false);
});

test('fixed protocol sends initialized then config/read and projects no raw config',async()=>{
 const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough(),exited=new EventEmitter();
 const sent:string[]=[];
 input.on('data',chunk=>{
  const frame=JSON.parse(String(chunk)) as {method:string};sent.push(frame.method);
  if(frame.method==='initialize') output.write(JSON.stringify({id:1,result:{userAgent:'Codex',
   codexHome,platformFamily:'windows',platformOs:'windows'}})+'\n');
  if(frame.method==='config/read') output.write(JSON.stringify({id:2,result:{
   config:{model:'gpt-6-sol',approval_policy:'never',web_search:'disabled'},
   origins:{model:origin,approval_policy:origin,web_search:origin},layers:null}})+'\n');
 });
 const result=await runWindowsConfigProtocol({input,output,errors,exited,
  terminate(){exited.emit('close',0);}}, {...expected,checkCwd:'C:\\private\\check'});
 assert.equal(result,true);
 assert.deepEqual(sent,['initialize','initialized','config/read']);
});

const binding={recipe:'desktop_config_check_v1' as const,
 hostScopeId:'11111111-1111-4111-8111-111111111111',
 executionInstanceId:'22222222-2222-4222-8222-222222222222'};
const root={pid:10,creationFiletime:'133900000000000001'};
const started={kind:'started',root,createdSuspended:true,jobMemberBeforeResume:true};
const closure={kind:'job_closed',root,rootExited:true,
 members:{complete:true,assigned:0,listed:0,pids:[]}};

function strictChannel(options:{revokeAt?:'initialize'|'initialized';reply?:'wrong_order'|'duplicate'|'utf8'|'extra';
 missing?:'stdout_eof'|'job_closed';code?:number;corkInitialized?:boolean}={}){
 let allowed=true,sequence=1;
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),
  stderr:new PassThrough(),kill(){queueMicrotask(()=>child.emit('close',null));return true;}});
 const writes:string[]=[];
 const emit=(event:object)=>child.stdout.write(JSON.stringify({protocol:'windows_job_stdio_v1',
  helperVersion:'3',...binding,sequence:sequence++,...event})+'\n');
 const body=(bytes:Buffer)=>emit({kind:'stdout',dataBase64:bytes.toString('base64')});
 const goodInit=JSON.stringify({id:1,result:{userAgent:'Codex',codexHome,
  platformFamily:'windows',platformOs:'windows'}})+'\n';
 const goodRead=JSON.stringify({id:2,result:{config:{model:'gpt-6-sol',approval_policy:'never',
  web_search:'disabled'},origins:{model:origin,approval_policy:origin,web_search:origin},layers:null}})+'\n';
 child.stdin.on('data',(chunk:Buffer)=>{
  const command=String(chunk);writes.push(command);
  queueMicrotask(()=>{
   if(command==='config-initialize\n'){
    if(options.revokeAt==='initialize')allowed=false;
    if(options.corkInitialized){
     child.stdin.cork();
     setImmediate(()=>{allowed=false;child.stdin.uncork();});
    }
    body(Buffer.from(options.reply==='wrong_order'?goodRead:goodInit));
   }else if(command==='config-initialized\n'){
    if(options.revokeAt==='initialized')allowed=false;
   }else if(command==='config-read\n'){
    body(options.reply==='utf8'?Buffer.from([0xff,10]):Buffer.from(goodRead));
    if(options.reply==='duplicate'||options.reply==='extra')body(Buffer.from(goodRead));
   }else if(command==='stop\n'){
    if(options.missing!=='stdout_eof')emit({kind:'stdout_eof'});
    emit({kind:'stderr_eof'});emit({kind:'root_exit'});
    if(options.missing!=='job_closed')emit(closure);
    child.emit('close',options.code??0);
   }
  });
 });
 const opening=diagnoseOwnedConfigChannel(child,binding,{...expected,checkCwd:'C:\\private\\check'},
  {assertDiagnosticAuthority:()=>allowed});
 emit(started);
 return {opening,writes};
}

test('strict recipe sends exactly three ordered controls and requires owned closure',async()=>{
 const c=strictChannel();
 const result=await c.opening;
 assert.equal(result.strictConfigVerified,true);
 assert.equal(result.closure.kind,'job_closed');
 assert.deepEqual(c.writes,['config-initialize\n','config-initialized\n','config-read\n','stop\n']);
});

test('strict recipe revocation and invalid native responses never verify',async()=>{
 for(const option of [{revokeAt:'initialize'},{revokeAt:'initialized'},
  {reply:'wrong_order'},{reply:'duplicate'},{reply:'utf8'},{reply:'extra'},
  {missing:'stdout_eof'},{missing:'job_closed'},{code:1}] as const){
  const c=strictChannel(option);
  await assert.rejects(c.opening,/WINDOWS_OWNED_STDIO_UNKNOWN/);
  if(option.revokeAt==='initialize')assert.equal(c.writes.includes('config-initialized\n'),false);
  if(option.revokeAt==='initialized')assert.equal(c.writes.includes('config-read\n'),false);
 }
});

test('corked initialized callback cannot prequeue config/read across revocation',async()=>{
 const c=strictChannel({corkInitialized:true});
 await assert.rejects(c.opening,/WINDOWS_OWNED_STDIO_UNKNOWN/);
 assert.equal(c.writes.includes('config-read\n'),false);
 assert.equal(c.writes.includes('stop\n'),true);
});

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {
  ManagedChatgptLoginProtocol,parseEffectiveEphemeralConfig,
  managedLoginStartRequest,
} from '../../tools/windows-qualification-login-protocol.ts';
import {acceptManagedLoginStartWhenRunning,managedLoginClosureComplete,ownedNativeClosureObserved} from '../../tools/windows-qualification-preflight.ts';

const path='C:\\Private\\runtime\\home\\.codex\\config.toml';
const owner=Object.freeze({hostScopeId:'scope-one',executionInstanceId:'instance-one',
  helperPid:411,helperCreationFiletime:'133000000000000000'});
const another={...owner,helperPid:412};
const origin={name:{type:'user',file:path},version:'v1'};
const effective={config:{cli_auth_credentials_store:'ephemeral'},
  origins:{cli_auth_credentials_store:origin},layers:null};
const url='https://chatgpt.com/anything?state=private';
const response={id:4,result:{type:'chatgpt',loginId:'login-one',authUrl:url}};
const completed={method:'account/login/completed',
  params:{loginId:'login-one',success:true,error:null}};
const failure=(fn:()=>unknown)=>assert.throws(fn,/QUALIFICATION_LOGIN_PROTOCOL/);

test('effective ephemeral requires actual value and exact private user-file origin',()=>{
 assert.equal(parseEffectiveEphemeralConfig(effective,path),true);
 for(const altered of [
  {config:{},origins:effective.origins},
  {config:{cli_auth_credentials_store:'file'},origins:effective.origins},
  {config:effective.config,origins:{}},
  {config:effective.config,origins:{cli_auth_credentials_store:{...origin,
    name:{type:'system',file:path}}}},
  {config:effective.config,origins:{cli_auth_credentials_store:{...origin,
    name:{type:'user',file:'C:\\Other\\config.toml'}}}},
  {requirements:{cliAuthCredentialsStore:'ephemeral'}},
 ])assert.equal(parseEffectiveEphemeralConfig(altered,path),false);
});

test('login request is the sole fixed managed ChatGPT variant with no tokens or model call',()=>{
 assert.deepEqual(managedLoginStartRequest(),
  {id:4,method:'account/login/start',params:{type:'chatgpt'}});
 assert.doesNotMatch(JSON.stringify(managedLoginStartRequest()),/apiKey|chatgptAuthTokens|turn\/start/);
});

test('owned start and matching completion disclose URL only through private handoff',()=>{
 failure(()=>new ManagedChatgptLoginProtocol(owner).acceptStart(response,owner,()=>{}));
 const flow=new ManagedChatgptLoginProtocol(owner);
 let handed='';
 flow.confirmEphemeral(effective,path);
 assert.deepEqual(flow.startRequest(),managedLoginStartRequest());
 flow.acceptStart(response,owner,value=>{handed=value;});
 assert.equal(handed,url);
 assert.equal(flow.summary().authUrlSha256,createHash('sha256').update(url).digest('hex'));
 assert.equal(flow.summary().authUrlBytes,Buffer.byteLength(url));
 assert.equal(JSON.stringify(flow.summary()).includes(url),false);
 flow.acceptCompletion(completed,owner);
 assert.equal(flow.summary().status,'success');
 assert.equal(JSON.stringify(flow.summary()).includes('login-one'),false);
});

test('wrong owner, wrong ID, completion before start, and duplicate or malformed frames fail closed',()=>{
 const fresh=()=>{const flow=new ManagedChatgptLoginProtocol(owner);flow.confirmEphemeral(effective,path);
  flow.startRequest();return flow;};
 failure(()=>fresh().acceptCompletion(completed,owner));
 failure(()=>fresh().acceptStart(response,another,()=>{}));
 for(const bad of [
  {id:4,result:{type:'apiKey'}},
  {id:4,result:{...response.result,loginId:''}},
  {id:4,result:{...response.result,unexpected:true}},
  {id:5,result:response.result},
 ])failure(()=>fresh().acceptStart(bad,owner,()=>{}));
 const flow=fresh();flow.acceptStart(response,owner,()=>{});
 failure(()=>flow.acceptStart(response,owner,()=>{}));
 for(const [message,actualOwner] of [
  [{...completed,params:{...completed.params,loginId:'other'}},owner],
  [completed,another],
 ] as const){const candidate=fresh();candidate.acceptStart(response,owner,()=>{});
  failure(()=>candidate.acceptCompletion(message,actualOwner));
  failure(()=>candidate.acceptCompletion(completed,owner));}
 const successful=fresh();successful.acceptStart(response,owner,()=>{});
 successful.acceptCompletion(completed,owner);
 failure(()=>successful.acceptCompletion(completed,owner));
});

test('caller mutation cannot rebind the original owned helper',()=>{
 const mutable:{hostScopeId:string;executionInstanceId:string;helperPid:number;helperCreationFiletime:string}={...owner};
 const flow=new ManagedChatgptLoginProtocol(mutable);
 mutable.helperPid=412;
 flow.confirmEphemeral(effective,path);flow.startRequest();
 failure(()=>flow.acceptStart(response,mutable,()=>{}));
 const pendingOwner:{hostScopeId:string;executionInstanceId:string;helperPid:number;helperCreationFiletime:string}={...owner};
 const pending=new ManagedChatgptLoginProtocol(pendingOwner);
 pending.confirmEphemeral(effective,path);pending.startRequest();
 pending.acceptStart(response,owner,()=>{});
 pendingOwner.executionInstanceId='changed';
 failure(()=>pending.acceptCompletion(completed,pendingOwner));
 failure(()=>pending.acceptCompletion(completed,owner));
 assert.equal(pending.summary().status,'failed');
});

test('only documented exact HTTPS OpenAI origins reach a human, without path assumptions',()=>{
 for(const good of ['https://chatgpt.com/something?a=1',
  'https://auth.openai.com/another/path?opaque=1']){
  const flow=new ManagedChatgptLoginProtocol(owner);flow.confirmEphemeral(effective,path);
  flow.startRequest();let seen='';flow.acceptStart({...response,result:{...response.result,authUrl:good}},
   owner,value=>{seen=value;});assert.equal(seen,good);
 }
 for(const bad of ['http://chatgpt.com/auth','https://evil.example/auth',
  'https://chatgpt.com.evil.example/auth','https://user:pass@chatgpt.com/auth',
  'https://chatgpt.com:444/auth','https://auth.openai.com.evil.example/auth']){
  const flow=new ManagedChatgptLoginProtocol(owner);flow.confirmEphemeral(effective,path);
  flow.startRequest();failure(()=>flow.acceptStart({...response,result:{...response.result,authUrl:bad}},
   owner,()=>{throw new Error('handoff must not run');}));
 }
});

test('cancel sends only the original login ID; racing success or inconsistent cancel fails closed',()=>{
 const flow=new ManagedChatgptLoginProtocol(owner);flow.confirmEphemeral(effective,path);
 flow.startRequest();flow.acceptStart(response,owner,()=>{});
 assert.deepEqual(flow.cancelRequest(),{id:5,method:'account/login/cancel',params:{loginId:'login-one'}});
 failure(()=>flow.acceptCompletion(completed,owner));
 assert.equal(flow.summary().status,'failed');
 failure(()=>flow.acceptCancel({id:5,result:{status:'canceled'}},owner));
 const canceled=new ManagedChatgptLoginProtocol(owner);canceled.confirmEphemeral(effective,path);
 canceled.startRequest();canceled.acceptStart(response,owner,()=>{});canceled.cancelRequest();
 canceled.acceptCancel({id:5,result:{status:'canceled'}},owner);
 canceled.acceptCompletion({...completed,params:{...completed.params,success:false,error:'private error'}},owner);
 assert.equal(canceled.summary().status,'canceled');
 assert.equal(JSON.stringify(canceled.summary()).includes('private error'),false);
 failure(()=>canceled.cancelRequest());
 const wrong=new ManagedChatgptLoginProtocol(owner);wrong.confirmEphemeral(effective,path);
 wrong.startRequest();wrong.acceptStart(response,owner,()=>{});wrong.cancelRequest();
 failure(()=>wrong.acceptCancel({id:5,result:{status:'notFound'}},owner));
});

test('login success, cancel ACK and deadline each require actual owned closure',()=>{
 const complete={firstFailure:null,exitCode:0,stdoutEnded:true,stderrEnded:true,
  helperStderr:'',partialBytes:0,rpcPartialBytes:0,startWriteSucceeded:true,
  stopWriteSucceeded:true,stopSent:true,phase:4,readiness:'updateRequired',
  root:{pid:99},terminal:{kind:'job_closed',root:{pid:99}},
  kinds:['prepared','started','stdout_eof','stderr_eof','root_exit','job_closed'],
  loginStatus:'success',ephemeralConfigVerified:true,authJsonAbsent:true};
 assert.equal(managedLoginClosureComplete(complete),true);
 assert.equal(managedLoginClosureComplete({...complete,loginStatus:'cancel_ack'}),false);
 assert.equal(managedLoginClosureComplete({...complete,exitCode:null}),false);
 assert.equal(managedLoginClosureComplete({...complete,authJsonAbsent:false}),false);
 assert.equal(managedLoginClosureComplete({...complete,stopWriteSucceeded:false}),false);
 assert.equal(managedLoginClosureComplete({...complete,kinds:complete.kinds.slice(0,-1)}),false);
 assert.equal(ownedNativeClosureObserved({...complete,firstFailure:'login_not_success',phase:2}),true);
 assert.equal(ownedNativeClosureObserved({...complete,exitCode:null}),false);
});

test('late login start reply after interruption cannot trigger browser handoff or success',()=>{
 for(const gate of [{stopSent:true,firstFailure:null,interrupted:false},
  {stopSent:false,firstFailure:'login_interrupted',interrupted:false},
  {stopSent:false,firstFailure:null,interrupted:true}]){
  const flow=new ManagedChatgptLoginProtocol(owner);
  flow.confirmEphemeral(effective,path);flow.startRequest();
  let handoffs=0;
  assert.throws(()=>acceptManagedLoginStartWhenRunning(flow,response,owner,()=>{handoffs++;},gate),
   /QUALIFICATION_LOGIN_STOPPED/);
  assert.equal(handoffs,0);
  assert.notEqual(flow.summary().status,'success');
 }
});

test('bounded first violation distinguishes reported failure from malformed completion and failed handoff',()=>{
 const pending=()=>{const flow=new ManagedChatgptLoginProtocol(owner);
  flow.confirmEphemeral(effective,path);flow.startRequest();flow.acceptStart(response,owner,()=>{});
  return flow;};
 const reported=pending();reported.acceptCompletion({...completed,
  params:{...completed.params,success:false,error:'private-error-token'}},owner);
 assert.deepEqual(reported.summary().violation,null);
 assert.equal(reported.summary().completionOutcome,'reported_failure');
 for(const [params,reason] of [[{success:true,error:null},'login_id_missing'],
  [{...completed.params,loginId:null},'login_id_null'],
  [{...completed.params,loginId:55},'login_id_type'],
  [{...completed.params,loginId:'another-private-id'},'login_id_mismatch']] as const){
  const flow=pending();failure(()=>flow.acceptCompletion({...completed,
   params},owner));
  assert.deepEqual(flow.summary().violation,{stage:'completion',stateBefore:'pending',reason});
  assert.equal(flow.summary().completionOutcome,'not_seen');
 }
 const wrongError=pending();failure(()=>wrongError.acceptCompletion({...completed,
  params:{...completed.params,error:'private-error-token'}},owner));
 assert.deepEqual(wrongError.summary().violation,{stage:'completion',stateBefore:'pending',reason:'error_on_success'});
 const handoff=new ManagedChatgptLoginProtocol(owner);handoff.confirmEphemeral(effective,path);handoff.startRequest();
 failure(()=>handoff.acceptStart(response,owner,()=>{throw new Error('private-url-token');}));
 assert.equal(handoff.summary().handoffStatus,'failed');
 assert.deepEqual(handoff.summary().violation,{stage:'handoff',stateBefore:'pending',reason:'handoff_failed'});
 for(const flow of [reported,wrongError,handoff]){
  const json=JSON.stringify(flow.summary());
  assert.doesNotMatch(json,/private-error-token|private-url-token|another-private-id|login-one|chatgpt\.com/);
 }
});

test('completion accepts only schema optional safe integer emittedAtMs without weakening identity',()=>{
 const pending=()=>{const flow=new ManagedChatgptLoginProtocol(owner);
  flow.confirmEphemeral(effective,path);flow.startRequest();flow.acceptStart(response,owner,()=>{});
  return flow;};
 for(const message of [completed,...[1790000000000,-1,0,Number.MAX_SAFE_INTEGER].map(
  emittedAtMs=>({...completed,emittedAtMs}))]){
  const flow=pending();flow.acceptCompletion(message,owner);
  assert.equal(flow.summary().status,'success');
 }
 for(const emittedAtMs of [null,undefined,'1790000000000',1.5,Number.MAX_SAFE_INTEGER+1,
  -Number.MAX_SAFE_INTEGER-1,Infinity,NaN]){
  const flow=pending();failure(()=>flow.acceptCompletion({...completed,emittedAtMs},owner));
  assert.deepEqual(flow.summary().violation,{stage:'completion',stateBefore:'pending',reason:'envelope'});
  assert.equal(flow.summary().completionShape?.emittedAtMsValid,false);
 }
 for(const bad of [{...completed,unknown:'secret-value'},
  {...completed,id:55},{...completed,jsonrpc:'2.0'},
  {...completed,emittedAtMs:1790000000000,unknown:'secret-value'}]){
  const flow=pending();failure(()=>flow.acceptCompletion(bad,owner));
  assert.equal(flow.summary().status,'failed');
  assert.equal(flow.summary().completionShape?.unexpectedKeyCount,1);
  assert.doesNotMatch(JSON.stringify(flow.summary()),/unknown|secret-value|jsonrpc|1790000000000/);
 }
 const wrongOwner=pending();failure(()=>wrongOwner.acceptCompletion({...completed,emittedAtMs:1790000000000},another));
 const wrongId=pending();failure(()=>wrongId.acceptCompletion({...completed,emittedAtMs:1790000000000,
  params:{...completed.params,loginId:'wrong'}},owner));
 const duplicate=pending();duplicate.acceptCompletion({...completed,emittedAtMs:1790000000000},owner);
 failure(()=>duplicate.acceptCompletion({...completed,emittedAtMs:1790000000000},owner));
 const shape=pending();shape.acceptCompletion({...completed,emittedAtMs:1790000000000},owner);
 assert.deepEqual(shape.summary().completionShape,{hasEmittedAtMs:true,emittedAtMsValid:true,
  unexpectedKeyCount:0,paramsIsObject:true,hasId:false});
 const start=new ManagedChatgptLoginProtocol(owner);start.confirmEphemeral(effective,path);
 start.startRequest();failure(()=>start.acceptStart({...response,emittedAtMs:1},owner,()=>{}));
 const cancel=pending();cancel.cancelRequest();
 failure(()=>cancel.acceptCancel({id:5,result:{status:'canceled'},emittedAtMs:1},owner));
});

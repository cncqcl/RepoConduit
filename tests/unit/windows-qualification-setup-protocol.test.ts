import assert from 'node:assert/strict';
import test from 'node:test';
import {FixedSandboxSetup} from '../../tools/windows-qualification-setup-protocol.ts';

const owner={hostScopeId:'scope',executionInstanceId:'execution',helperPid:123,helperCreationFiletime:'134357560846343794'};
const cwd='C:\\synthetic\\runtime\\check';
const ack={id:4,result:{started:true}};
const completed=(success=true,error:string|null=null)=>({method:'windowsSandbox/setupCompleted',params:{mode:'elevated',success,error}});
test('setup emits exactly one fixed elevated request and excludes account/model work',()=>{
 const setup=new FixedSandboxSetup(owner,cwd);
 assert.deepEqual(setup.startRequest(),{id:4,method:'windowsSandbox/setupStart',params:{mode:'elevated',cwd}});
 assert.throws(()=>setup.startRequest());
 assert.equal(setup.summary().status,'invalid');
});
test('completion may precede ACK, but both are required before one readiness request',()=>{
 for(const early of [true,false]){
  const setup=new FixedSandboxSetup(owner,cwd);setup.startRequest();
  if(early)setup.acceptCompletion({...completed(),emittedAtMs:123},owner);else setup.acceptStart(ack,owner);
  assert.equal(setup.canReadiness(),false);
  if(early)setup.acceptStart(ack,owner);else setup.acceptCompletion(completed(),owner);
  assert.equal(setup.canReadiness(),true);
  assert.deepEqual(setup.readinessRequest(),{id:5,method:'windowsSandbox/readiness',params:null});
  setup.acceptReadiness({id:5,result:{status:'ready'}},owner);
  assert.equal(setup.summary().status,'ready');
  assert.throws(()=>setup.readinessRequest());
 }
});
test('wrong owner, mode, duplicate completion and unsafe envelope fail closed',()=>{
 for(const mutate of [
  ()=>({notification:completed(),source:{...owner,helperPid:124}}),
  ()=>({notification:{...completed(),params:{mode:'unelevated',success:true}},source:owner}),
  ()=>({notification:{...completed(),emittedAtMs:0.5},source:owner}),
  ()=>({notification:{...completed(),id:4},source:owner}),
 ]){
  const setup=new FixedSandboxSetup(owner,cwd);setup.startRequest();const {notification,source}=mutate();
  assert.throws(()=>setup.acceptCompletion(notification,source));assert.equal(setup.summary().status,'invalid');
 }
 const setup=new FixedSandboxSetup(owner,cwd);setup.startRequest();setup.acceptCompletion(completed(),owner);
 assert.throws(()=>setup.acceptCompletion(completed(),owner));
 const unopened=new FixedSandboxSetup(owner,cwd);assert.throws(()=>unopened.acceptCompletion(completed(),owner));
});
test('refused start and reported failure cannot become ready; raw error is not projected',()=>{
 const declined=new FixedSandboxSetup(owner,cwd);declined.startRequest();declined.acceptStart({id:4,result:{started:false}},owner);
 assert.equal(declined.summary().status,'not_started');assert.equal(declined.canReadiness(),false);
 const failed=new FixedSandboxSetup(owner,cwd);failed.startRequest();failed.acceptStart(ack,owner);
 failed.acceptCompletion(completed(false,'private secret diagnostic'),owner);
 assert.equal(failed.summary().status,'reported_failure');assert.equal(failed.canReadiness(),false);
 assert.equal(JSON.stringify(failed.summary()).includes('private secret'),false);
 assert.equal(failed.summary().error?.bytes,25);
});
test('ready result alone and malformed ACK do not prove setup completion',()=>{
 const setup=new FixedSandboxSetup(owner,cwd);setup.startRequest();setup.acceptStart(ack,owner);
 assert.throws(()=>setup.acceptReadiness({id:5,result:{status:'ready'}},owner));
 for(const bad of [{id:4,result:{started:true,extra:true}},{id:4,error:{message:'private'}},{id:4,result:{started:1}}]){
  const item=new FixedSandboxSetup(owner,cwd);item.startRequest();assert.throws(()=>item.acceptStart(bad,owner));
 }
 const stale=new FixedSandboxSetup(owner,cwd);stale.startRequest();stale.acceptStart(ack,owner);stale.acceptCompletion(completed(),owner);
 stale.readinessRequest();stale.acceptReadiness({id:5,result:{status:'updateRequired'}},owner);
 assert.equal(stale.summary().status,'readiness_pending');
});
test('failed completion returns bounded raw error only for dedicated private capture; summary stays sanitized',()=>{
 const setup=new FixedSandboxSetup(owner,cwd);setup.startRequest();
 const raw='private setup error';
 assert.equal(setup.acceptCompletion(completed(false,raw),owner),raw);
 assert.equal(JSON.stringify(setup.summary()).includes(raw),false);
 assert.throws(()=>setup.acceptCompletion(completed(false,raw),owner));
 const huge=new FixedSandboxSetup(owner,cwd);huge.startRequest();
 assert.throws(()=>huge.acceptCompletion(completed(false,'é'.repeat(2049)),owner));
 assert.equal(huge.summary().status,'invalid');
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FixedQualificationTurn,FixedQualificationThreadStartOnly} from '../../tools/windows-qualification-turn-protocol.ts';

const owner={hostScopeId:'scope',executionInstanceId:'instance',helperPid:41,
 helperCreationFiletime:'133000000000000000'};
const cwd='D:\\synthetic\\check';
const response={id:6,result:{thread:{id:'thread_1',cwd},cwd,model:'gpt-6-sol',
 modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',
 sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:[],
 activePermissionProfile:{id:'rcac_static'}}};

test('fixed thread request retains its cwd root while empty response roots bind the turn',()=>{
 const trial=new FixedQualificationTurn(owner,cwd);
 const request=trial.threadStartRequest();
 assert.deepEqual(request.params.environments,[]);
 assert.deepEqual(request.params.runtimeWorkspaceRoots,[cwd]);
 trial.acceptThreadStart(response,owner);
 const turn=trial.turnStartRequest();
 assert.equal(turn.method,'turn/start');
 assert.deepEqual(turn.params.environments,[]);
 assert.deepEqual(turn.params.runtimeWorkspaceRoots,[cwd]);
 const threadOnly=new FixedQualificationThreadStartOnly(owner,cwd);
 assert.deepEqual(threadOnly.start().params.runtimeWorkspaceRoots,[cwd]);
 assert.equal(threadOnly.accept(response,owner),'accepted');
});

test('missing, null, nonarray and nonempty response roots refuse before any turn',()=>{
 const withoutRoots={...response.result};
 assert.equal(Reflect.deleteProperty(withoutRoots,'runtimeWorkspaceRoots'),true);
 for(const result of [withoutRoots,{...response.result,runtimeWorkspaceRoots:null},
  {...response.result,runtimeWorkspaceRoots:'[]'},
  {...response.result,runtimeWorkspaceRoots:[cwd]},
  {...response.result,runtimeWorkspaceRoots:['D:\\other']}]){
  const trial=new FixedQualificationTurn(owner,cwd);
  trial.threadStartRequest();
  assert.throws(()=>trial.acceptThreadStart({id:6,result},owner),/QUALIFICATION_TURN_PROTOCOL/);
  assert.equal(trial.summary().status,'failed');
  assert.throws(()=>trial.turnStartRequest(),/QUALIFICATION_TURN_PROTOCOL/);
  const threadOnly=new FixedQualificationThreadStartOnly(owner,cwd);
  threadOnly.start();
  assert.throws(()=>threadOnly.accept({id:6,result},owner),/QUALIFICATION_THREAD_START_PROTOCOL/);
  assert.equal(threadOnly.summary().failureReason,'result_projection');
 }
});

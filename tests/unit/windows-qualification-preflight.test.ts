import assert from 'node:assert/strict';
import test from 'node:test';
import {parseQualificationReply,qualificationRequests,waitQualificationHelperClose,qualificationClosureComplete,qualificationMarkerMatches,qualificationTrialPreviouslyUsed} from '../../tools/windows-qualification-preflight.ts';
import {WINDOWS_APP_SERVER_PROTOCOL_TARGET} from '../../src/adapters/codex/investigator/windows-launch-record.js';
import type {PreparedWindowsEvent} from '../../src/adapters/codex/investigator/windows-prepared-session.js';

const expected={home:'D:\\synthetic\\runtime\\home\\.codex',configPath:'D:\\synthetic\\runtime\\home\\.codex\\config.toml',modelRef:'gpt-6-sol',checkCwd:'D:\\synthetic\\runtime\\check'};
test('another managed trial mode cannot reuse the same candidate',()=>{
 assert.equal(qualificationTrialPreviouslyUsed(new Set()),false);
 for(const name of ['managed-login-attempt.json','managed-model-attempt.json',
  'managed-login.json','managed-model.json','sandbox-setup-attempt.json','sandbox-setup.json'])
  assert.equal(qualificationTrialPreviouslyUsed(new Set([name])),true);
});
test('preflight refuses historical candidate metadata before opening the new fixed helper',()=>{
 const marker={kind:'windows_qualification_candidate_v1',modelRef:'gpt-6-sol',protocolTarget:WINDOWS_APP_SERVER_PROTOCOL_TARGET};
 assert.equal(qualificationMarkerMatches(marker),true);
 assert.equal(qualificationMarkerMatches({...marker,protocolTarget:'windows-desktop-26.930.7945.0-codex-0.160.1'}),false);
 assert.equal(qualificationMarkerMatches({...marker,protocolTarget:'windows-desktop-26.930.3930.0-codex-0.160.0'}),false);
 assert.equal(qualificationMarkerMatches({...marker,modelRef:'other'}),false);
 assert.equal(qualificationMarkerMatches(null),false);
});
test('qualification preflight has only zero-model fixed requests',()=>{
 const requests=qualificationRequests(expected);
 assert.deepEqual(requests.map(r=>r.method),['initialize','initialized','config/read','windowsSandbox/readiness']);
 assert.equal(JSON.stringify(requests).includes('account/login'),false);
 assert.equal(JSON.stringify(requests).includes('turn/start'),false);
 assert.equal(JSON.stringify(requests).includes('windowsSandbox/setup'),false);
});
test('qualification preflight rejects another HOME and wrong native platform',()=>{
 const valid={userAgent:'Codex',codexHome:expected.home,platformFamily:'windows',platformOs:'windows'};
 assert.equal(parseQualificationReply(1,valid,expected),true);
 assert.equal(parseQualificationReply(1,{...valid,codexHome:'D:\\another'},expected),false);
 assert.equal(parseQualificationReply(1,{...valid,platformOs:'linux'},expected),false);
});
test('readiness is observation only and unknown statuses are refused',()=>{
 for(const status of ['ready','notConfigured','updateRequired'])assert.equal(parseQualificationReply(3,{status},expected),status);
 assert.equal(parseQualificationReply(3,{status:'qualified'},expected),false);
 assert.equal(parseQualificationReply(3,{status:'ready',isolationVerified:true},expected),false);
 assert.equal(parseQualificationReply(4,{status:'ready'},expected),false);
});
test('three-field config projection requires exact candidate origin but is not effective boundary proof',()=>{
 const config={model:expected.modelRef,approval_policy:'never',web_search:'disabled'};
 const origin={name:{type:'user',file:expected.configPath},version:'v1'};
 const value={config,origins:{model:origin,approval_policy:origin,web_search:origin},layers:null};
 assert.equal(parseQualificationReply(2,value,expected),true);
 assert.equal(parseQualificationReply(2,{...value,config:{...config,approval_policy:'on-request'}},expected),false);
 assert.equal(parseQualificationReply(2,{...value,origins:{...value.origins,model:{...origin,name:{type:'system'}}}},expected),false);
});
test('nonclosing helper reaches bounded unknown rather than hanging or claiming closure',async()=>{
 let detached=false;
 assert.equal(await waitQualificationHelperClose(new Promise(()=>{}),()=>{detached=true;},10),null);
 assert.equal(detached,true);
 let detachAfterClose=false;
 assert.equal(await waitQualificationHelperClose(Promise.resolve(0),()=>{detachAfterClose=true;},10),0);
 assert.equal(detachAfterClose,false);
 assert.throws(()=>waitQualificationHelperClose(Promise.resolve(0),()=>{},28_001));
});
test('Job closure without complete exchange and successful start/stop writes stays unknown',()=>{
 const root={pid:101,creationFiletime:'123'};
 const terminal={kind:'job_closed',root} as PreparedWindowsEvent;
 const s={firstFailure:null,exitCode:0,stdoutEnded:true,stderrEnded:true,helperStderr:'',partialBytes:0,rpcPartialBytes:0,
  startWriteSucceeded:true,stopWriteSucceeded:true,stopSent:true,phase:3,readiness:'ready',root,terminal,
  kinds:['prepared','started','stdout_eof','stderr_eof','root_exit','job_closed']};
 assert.equal(qualificationClosureComplete(s),true);
 for(const field of ['startWriteSucceeded','stopWriteSucceeded','stopSent','stdoutEnded','stderrEnded'])
  assert.equal(qualificationClosureComplete({...s,[field]:false}),false,field);
 assert.equal(qualificationClosureComplete({...s,readiness:null}),false);
 assert.equal(qualificationClosureComplete({...s,phase:2}),false);
 assert.equal(qualificationClosureComplete({...s,firstFailure:'stop_write'}),false);
 assert.equal(qualificationClosureComplete({...s,root:{...root,pid:102}}),false);
 assert.equal(qualificationClosureComplete({...s,kinds:[...s.kinds,'stdout_eof']}),false);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePreparedWindowsEvent, openPreparedWindowsFixture} from
 '../../src/adapters/codex/investigator/windows-prepared-session.js';

const binding={recipe:'prepared_owned_fixture_v1' as const,
 hostScopeId:'11111111-1111-4111-8111-111111111111',
 executionInstanceId:'22222222-2222-4222-8222-222222222222'};
const writer={helperPid:123,helperCreationFiletime:'133900000000000002',
 pipeName:`\\\\.\\pipe\\RepoConduit-prepared-${binding.hostScopeId}-${binding.executionInstanceId}`,
 handle:'42',deadlineUtcTicks:'638000000000000000',deadlineUptimeMs:'100000'};
const frame=(event:object,sequence=1)=>JSON.stringify({protocol:'windows_job_stdio_v1',
 helperVersion:'3',...binding,sequence,...event});

test('prepared event has no child identity and cannot substitute the writer origin',()=>{
 const prepared={kind:'prepared',childPresent:false,writer};
 const parsed=parsePreparedWindowsEvent(frame(prepared),binding,1);
 assert.ok(parsed?.kind==='prepared');
 assert.equal(Object.isFrozen(parsed.writer),true);
 for(const bad of [{...prepared,root:{pid:1,creationFiletime:'1'}},
  {...prepared,childPresent:true}, {...prepared,writer:{...writer,handle:'0'}},
  {...prepared,writer:{...writer,helperCreationFiletime:'18446744073709551616'}},
  {...prepared,writer:{...writer,pipeName:'\\\\.\\pipe\\other'}},
  {...prepared,writer:{...writer,deadlineUptimeMs:'01'}},
  {...prepared,sequence:2}, {...prepared,recipe:'desktop_readiness_v1'}])
  assert.equal(parsePreparedWindowsEvent(frame(bad),binding,1),null);
});

test('prepared closure and process closure remain distinct strict observations',()=>{
 const members={complete:true,assigned:0,listed:0,pids:[]};
 assert.ok(parsePreparedWindowsEvent(frame({kind:'prepared_closed',childPresent:false,members},2),binding,2));
 assert.equal(parsePreparedWindowsEvent(frame({kind:'prepared_closed',childPresent:false,members,
  root:null},2),binding,2),null);
 const root={pid:1,creationFiletime:'133900000000000002'};
 assert.ok(parsePreparedWindowsEvent(frame({kind:'job_closed',root,rootExited:true,members},6),binding,6));
 assert.equal(parsePreparedWindowsEvent(frame({kind:'job_closed',root,rootExited:false,members},6),binding,6),null);
 assert.equal(parsePreparedWindowsEvent(frame({kind:'stdout',dataBase64:'YQ'},3),binding,3),null);
 assert.equal(parsePreparedWindowsEvent(frame({kind:'stdout',dataBase64:Buffer.alloc(4097).toString('base64')},3),binding,3),null);
});

test('fixture owner refuses executable, channel, authority and production recipe injection before spawning',async()=>{
 for(const extra of [{executable:'cmd.exe'},{channel:{}},{assertAuthority:()=>true},
  {recipe:'windows_app_server_readonly_v1'},{maxWallSeconds:601},{maxWallSeconds:0},{signal:{}}])
  await assert.rejects(openPreparedWindowsFixture({maxWallSeconds:5,...extra} as
   Parameters<typeof openPreparedWindowsFixture>[0]),/WINDOWS_PREPARED_UNKNOWN/);
 const signal=AbortSignal.abort();
 await assert.rejects(openPreparedWindowsFixture({maxWallSeconds:5,signal}),/WINDOWS_PREPARED_UNKNOWN/);
});

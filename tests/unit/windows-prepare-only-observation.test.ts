import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observeWindowsPrepareOnly,parseWindowsPrepareOnlyTranscript} from
 '../../src/adapters/codex/investigator/windows-prepare-only-observation.js';

const binding={recipe:'windows_app_server_readonly_v1' as const,
 hostScopeId:'11111111-1111-4111-8111-111111111111',
 executionInstanceId:'22222222-2222-4222-8222-222222222222'};
const writer={helperPid:123,helperCreationFiletime:'133900000000000002',
 pipeName:`\\\\.\\pipe\\RepoConduit-prepared-${binding.hostScopeId}-${binding.executionInstanceId}`,
 handle:'42',deadlineUtcTicks:'638000000000000000',deadlineUptimeMs:'100000'};
const frame=(kind:string,sequence:number,extra:object)=>JSON.stringify({protocol:'windows_job_stdio_v1',
 helperVersion:'3',...binding,kind,sequence,...extra});
const lines=[frame('prepared',1,{childPresent:false,writer}),
 frame('prepared_closed',2,{childPresent:false,members:{complete:true,assigned:0,listed:0,pids:[]}})];
const terminal={stopWriteSucceeded:true,stdoutEnded:true,stderrEnded:true,stderrEmpty:true,exitCode:0};

test('prepare-only transcript preserves full helper identity, excludes writer and never grants launch authority',()=>{
 const value=parseWindowsPrepareOnlyTranscript(lines,binding,123,terminal);
 assert.ok(value);
 assert.deepEqual(value.helper,{pid:123,creationFiletime:'133900000000000002'});
 assert.equal(value.prepared.sequence,1);assert.equal(value.preparedClosed.sequence,2);
 for(const name of ['launchId','start','send','writer','verified','root']) assert.equal(name in value,false);
 assert.ok(Object.isFrozen(value));assert.ok(Object.isFrozen(value.helper));
});

test('prepare-only transcript rejects wrong scopes, actual PID, full FILETIME and any child event',()=>{
 for(const first of [lines[0]!.replace(binding.hostScopeId,binding.executionInstanceId),
  lines[0]!.replace('133900000000000002','18446744073709551616'),
  lines[0]!.replace('windows_app_server_readonly_v1','prepared_owned_fixture_v1'),
  frame('started',1,{root:{pid:2,creationFiletime:'1'},createdSuspended:true,jobMemberBeforeResume:true})])
  assert.equal(parseWindowsPrepareOnlyTranscript([first,lines[1]!],binding,123,terminal),null);
 assert.equal(parseWindowsPrepareOnlyTranscript(lines,binding,124,terminal),null);
});

test('prepare-only transcript refuses duplicates, partial/extra frames and incomplete Job membership',()=>{
 for(const changed of [[],[lines[0]!],[...lines,lines[1]!],[lines[0]!,lines[0]!],
  [lines[0]!,lines[1]!.slice(0,-1)],
  [lines[0]!,lines[1]!.replace('"assigned":0','"assigned":1')]])
  assert.equal(parseWindowsPrepareOnlyTranscript(changed,binding,123,terminal),null);
});

test('write failure, missing helper EOF, stderr and unknown/nonzero exit are not observations',()=>{
 for(const changed of [{...terminal,stopWriteSucceeded:false},{...terminal,stdoutEnded:false},
  {...terminal,stderrEnded:false},{...terminal,stderrEmpty:false},{...terminal,exitCode:1},
  {...terminal,exitCode:null}])
  assert.equal(parseWindowsPrepareOnlyTranscript(lines,binding,123,changed),null);
});

test('prepare-only observer refuses executable/channel/recipe injection and pre-abort before spawning',async()=>{
 for(const extra of [{executable:'cmd.exe'},{desktopTarget:'cmd.exe'},{channel:{}},{recipe:'prepared_owned_fixture_v1'},
  {maxWallSeconds:601},{signal:{}},{launchId:'fake'},{verified:true}])
  await assert.rejects(observeWindowsPrepareOnly({fixtureRoot:'missing',maxWallSeconds:5,...extra} as
   Parameters<typeof observeWindowsPrepareOnly>[0]),/WINDOWS_PREPARE_ONLY_UNKNOWN/);
 await assert.rejects(observeWindowsPrepareOnly({fixtureRoot:'missing',maxWallSeconds:5,
  signal:AbortSignal.abort()}),/WINDOWS_PREPARE_ONLY_UNKNOWN/);
});

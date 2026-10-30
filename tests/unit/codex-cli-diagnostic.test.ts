import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {createCliCodexDiagnosticSink} from '../../src/cli/codex-diagnostic.js';

test('CLI Codex diagnostic emits one bounded local fact without provider text or unknown fields',
 {timeout: 5_000}, () => {
 const lines:string[]=[];
 const sink=createCliCodexDiagnosticSink(line=>{lines.push(line);});
 const requestId='inv_ea2a5361-13a8-428d-8049-06cc057a80df';
 sink({requestId,failure:{stage:'native_open',code:'INTERNAL_ERROR',privateText:'PRIVATE_PROVIDER_TEXT'},
  cleanupFailure:{stage:'native_stop',code:'PROTOCOL_TIMEOUT'},
  preparedFailure:{helperStage:'CONFIG_HASH',helperCloseObserved:true,exitCode:1,signal:null,
   forcedKill:false,startWriteAttempted:false,protocolFault:false,spawnError:null,
   privatePath:'C:/PRIVATE_PATH'},privateToken:'PRIVATE_TOKEN'} as never);
 assert.equal(lines.length,1);
 const fact=JSON.parse(lines[0]!) as Record<string,unknown>;
 assert.deepEqual(fact,{kind:'codex_managed_diagnostic',requestId,
  failure:{stage:'native_open',code:'INTERNAL_ERROR'},
  cleanupFailure:{stage:'native_stop',code:'PROTOCOL_TIMEOUT'},
  preparedFailure:{helperStage:'CONFIG_HASH',helperCloseObserved:true,exitCode:1,signal:null,
   forcedKill:false,startWriteAttempted:false,protocolFault:false,spawnError:null}});
 assert.doesNotMatch(lines[0]!,/PRIVATE_PROVIDER_TEXT|PRIVATE_PATH|PRIVATE_TOKEN/);
});

test('CLI Codex diagnostic normalizes unexpected values and ignores a failing local writer',
 {timeout: 5_000}, () => {
 const lines:string[]=[];
 const sink=createCliCodexDiagnosticSink(line=>{lines.push(line);throw new Error('writer failed');});
 assert.doesNotThrow(()=>sink({requestId:'managed_queue',failure:{stage:'PRIVATE_STAGE',code:'PRIVATE_CODE'},
  preparedFailure:{helperStage:'PRIVATE_STAGE',helperCloseObserved:true,exitCode:99999999999,
   signal:'PRIVATE_SIGNAL',forcedKill:false,startWriteAttempted:false,protocolFault:false,
   spawnError:'PRIVATE_SPAWN'}} as never));
 assert.equal(lines.length,1);
 assert.deepEqual(JSON.parse(lines[0]!),{kind:'codex_managed_diagnostic',requestId:'managed_queue',
  failure:{stage:'unknown',code:'INTERNAL_ERROR'},
  preparedFailure:{helperStage:'unknown',helperCloseObserved:true,exitCode:null,signal:null,
   forcedKill:false,startWriteAttempted:false,protocolFault:false,spawnError:null}});
 assert.doesNotThrow(()=>sink({requestId:'PRIVATE_REQUEST',failure:{stage:'native_open',code:'INTERNAL_ERROR'}}));
 assert.equal(lines.length,1);
});

test('CLI Codex diagnostic ignores an asynchronously rejected writer', {timeout: 10_000}, () => {
 const source=`const {createCliCodexDiagnosticSink}=await import('./src/cli/codex-diagnostic.ts');\n`+
  `createCliCodexDiagnosticSink(()=>Promise.reject(new Error('PRIVATE_WRITER_ERROR')))`+
  `({requestId:'inv_ea2a5361-13a8-428d-8049-06cc057a80df',`+
  `failure:{stage:'native_open',code:'INTERNAL_ERROR'}});\n`+
  `await new Promise(resolve=>setTimeout(resolve,20));\n`+
  `process.stdout.write('ASYNC_WRITER_SETTLED\\n');\n`;
 const result=spawnSync(process.execPath,['--unhandled-rejections=strict','--import','tsx',
  '--input-type=module','--eval',source],{cwd:process.cwd(),encoding:'utf8',timeout:5_000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/ASYNC_WRITER_SETTLED/);
 assert.doesNotMatch(result.stderr,/PRIVATE_WRITER_ERROR/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOwnedWindowsReadiness } from '../../src/adapters/codex/investigator/windows-job-stdio.js';

test('actual owned native fixture is routed through readiness protocol and full Job closure',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const result = await runOwnedWindowsReadiness('stdio_fixture_v1', { assertDiagnosticAuthority: () => true });
    assert.equal(result.readiness, 'notConfigured');
    assert.equal(result.isolationVerified, false);
    assert.equal(result.modelTurn, 'not_run');
    assert.equal(result.closure.rootExited, true);
    assert.deepEqual(result.closure.root, result.root);
    assert.deepEqual(result.closure.members, { complete: true, assigned: 0, listed: 0, pids: [] });
  });

test('private owned pipe fixture sends fixed frames through synchronous native writer',
  {skip:process.platform!=='win32',timeout:20_000},async()=>{
    const result=await runOwnedWindowsReadiness('owned_pipe_fixture_v1',
      {assertDiagnosticAuthority:()=>true});
    assert.equal(result.recipe,'owned_pipe_fixture_v1');
    assert.equal(result.readiness,'notConfigured');
    assert.equal(result.isolationVerified,false);
    assert.equal(result.modelTurn,'not_run');
    assert.equal(result.closure.rootExited,true);
    assert.deepEqual(result.closure.root,result.root);
    assert.deepEqual(result.closure.members,{complete:true,assigned:0,listed:0,pids:[]});
  });

test('fixed native entry refuses missing authority and already aborted requests before launch', async () => {
  await assert.rejects(runOwnedWindowsReadiness('stdio_fixture_v1', { assertDiagnosticAuthority: () => false }),
    /WINDOWS_OWNED_STDIO_UNKNOWN/);
  await assert.rejects(runOwnedWindowsReadiness('unknown' as 'stdio_fixture_v1', { assertDiagnosticAuthority: () => true }),
    /WINDOWS_OWNED_STDIO_UNKNOWN/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runOwnedWindowsReadiness('stdio_fixture_v1',
    { signal: controller.signal, assertDiagnosticAuthority: () => true }), /WINDOWS_OWNED_STDIO_UNKNOWN/);
});

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import { EventEmitter } from 'node:events';
import {resolve} from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { diagnoseOwnedReadinessChannel, parseOwnedStdioEvent } from '../../src/adapters/codex/investigator/windows-job-stdio.js';

const binding = { recipe: 'stdio_fixture_v1' as const,
  hostScopeId: '11111111-1111-4111-8111-111111111111',
  executionInstanceId: '22222222-2222-4222-8222-222222222222' };
const root = { pid: 10, creationFiletime: '133900000000000001' };
const started = { kind: 'started', root, createdSuspended: true, jobMemberBeforeResume: true };
const closure = { kind: 'job_closed', root, rootExited: true,
  members: { complete: true, assigned: 0, listed: 0, pids: [] } };
const frame = (v: object, sequence = 1) => ({ protocol: 'windows_job_stdio_v1', helperVersion: '3', ...binding, sequence, ...v });
const parse = (v: object, sequence = 1) => parseOwnedStdioEvent(JSON.stringify(frame(v, sequence)), binding, sequence);

test('owned stdio envelope rejects substituted bindings, noncanonical bytes and false closure', () => {
  assert.ok(parse(started));
  const parsed = parse(started);
  assert.ok(parsed?.kind === 'started');
  assert.equal(Object.isFrozen(parsed.root), true);
  for (const v of [
    { ...started, root: { ...root, creationFiletime: '01' } },
    { ...started, root: { ...root, creationFiletime: '18446744073709551616' } },
    { ...started, hostScopeId: binding.executionInstanceId }, { ...started, sequence: 2 },
    { ...started, createdSuspended: false }, { ...started, executable: 'cmd.exe' },
    { kind: 'stdout', dataBase64: 'YQ' }, { kind: 'stdout', dataBase64: '' },
    { kind: 'stdout', dataBase64: Buffer.alloc(4097).toString('base64') },
    { ...closure, members: { ...closure.members, listed: 1, pids: [10] } },
    { ...closure, rootExited: false }, { kind: 'stdout_eof', dataBase64: '' },
  ]) assert.equal(parse(v), null);
  assert.equal(parseOwnedStdioEvent('{', binding, 1), null);
  assert.equal(parseOwnedStdioEvent(JSON.stringify(frame(started)), { ...binding, recipe: 'unknown' } as unknown as typeof binding, 1), null);
});

test('owned pipe origin is strict and a supplied helper channel cannot mint writer authority', async()=>{
  const ownedBinding={...binding,recipe:'owned_pipe_fixture_v1' as const};
  const writer={helperPid:123,helperCreationFiletime:'133900000000000002',
    pipeName:`\\\\.\\pipe\\RepoConduit-owned-${binding.hostScopeId}-${binding.executionInstanceId}`,
    handle:'42',deadlineUtcTicks:'638000000000000000',deadlineUptimeMs:'100000'};
  const ownedFrame=(origin:object)=>JSON.stringify({...frame(started),recipe:ownedBinding.recipe,
    writer:origin});
  const parsed=parseOwnedStdioEvent(ownedFrame(writer),ownedBinding,1);
  assert.equal(parsed?.kind,'started');
  for(const bad of [{...writer,handle:'0'},{...writer,pipeName:'\\\\.\\pipe\\other'},
    {...writer,helperCreationFiletime:'01'},{...writer,deadlineUptimeMs:'0'}])
    assert.equal(parseOwnedStdioEvent(ownedFrame(bad),ownedBinding,1),null);
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),
    stderr:new PassThrough(),kill(){return true;}});
  await assert.rejects(diagnoseOwnedReadinessChannel(child,ownedBinding,
    {assertDiagnosticAuthority:()=>true}),/WINDOWS_OWNED_STDIO_UNKNOWN/);
});

function channel(options: { revoke?: 'initialize' | 'query'; tail?: boolean; missingClosed?: boolean;
  code?: number; extra?: object; split?: boolean } = {}) {
  let allowed = true;
  let sequence = 1;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill() { queueMicrotask(() => child.emit('close', null)); return true; } });
  const writes: string[] = [];
  const emit = (v: object) => child.stdout.write(JSON.stringify(frame(v, sequence++)) + '\n');
  const output = (text: string) => {
    const bytes = Buffer.from(text);
    if (options.split) {
      for (const b of bytes) emit({ kind: 'stdout', dataBase64: Buffer.from([b]).toString('base64') });
    } else emit({ kind: 'stdout', dataBase64: bytes.toString('base64') });
  };
  child.stdin.on('data', (bytes: Buffer) => {
    const command = bytes.toString(); writes.push(command);
    queueMicrotask(() => {
      if (command === 'readiness-initialize\n') {
        if (options.revoke === 'query') allowed = false;
        output('{"id":1,"result":{"fixture":"日"}}\n');
      } else if (command === 'readiness-query\n') output('{"id":2,"result":{"status":"notConfigured"}}\n');
      else if (command === 'stop\n') {
        if (options.tail) output('truncated');
        emit({ kind: 'stdout_eof' }); emit({ kind: 'stderr_eof' }); emit({ kind: 'root_exit' });
        if (!options.missingClosed) emit(closure);
        child.emit('close', options.code ?? 0);
      }
    });
  });
  const opening = diagnoseOwnedReadinessChannel(child, binding, { assertDiagnosticAuthority: () => allowed });
  if (options.revoke === 'initialize') allowed = false;
  emit(started);
  if (options.extra) emit(options.extra);
  return { opening, writes, emit, child };
}

test('readiness returns only after both pipe EOFs, original root exit, empty Job and helper close', async () => {
  const c = channel({ split: true });
  const result = await c.opening;
  assert.equal(result.readiness, 'notConfigured');
  assert.equal(result.isolationVerified, false);
  assert.equal(result.modelTurn, 'not_run');
  assert.deepEqual(result.root, root);
  assert.equal(result.closure.kind, 'job_closed');
  assert.deepEqual(c.writes, ['readiness-initialize\n', 'readiness-initialized\n', 'readiness-query\n', 'stop\n']);
});

test('candidate never upgrades missing closure, failure exit or trailing bytes', async () => {
  for (const options of [{ tail: true }, { missingClosed: true }, { code: 1 }]) {
    const c = channel(options);
    await assert.rejects(c.opening, /WINDOWS_OWNED_STDIO_UNKNOWN/);
  }
});

test('authority loss blocks new native writes and still closes owned Job', async () => {
  for (const revoke of ['initialize', 'query'] as const) {
    const c = channel({ revoke });
    await assert.rejects(c.opening, /WINDOWS_OWNED_STDIO_UNKNOWN/);
    assert.equal(c.writes.includes('readiness-query\n'), false);
    assert.equal(c.writes.includes('stop\n'), true);
    if (revoke === 'initialize') assert.equal(c.writes.includes('readiness-initialize\n'), false);
  }
});

test('unsolicited, duplicate EOF, malformed and scope changed frames fail closed', async () => {
  for (const extra of [closure, { kind: 'stderr_eof' },
    { kind: 'stdout', dataBase64: '??' }, { ...started, executionInstanceId: binding.hostScopeId }]) {
    const c = channel({ extra });
    await assert.rejects(c.opening, /WINDOWS_OWNED_STDIO_UNKNOWN/);
  }
});

test('late started after readiness timeout never flushes queued initialize during cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill() { return true; } });
  const writes: string[] = [];
  child.stdin.on('data', (data: Buffer) => writes.push(data.toString()));
  const opening = diagnoseOwnedReadinessChannel(child, binding, { assertDiagnosticAuthority: () => true });
  const rejected = assert.rejects(opening, /WINDOWS_OWNED_STDIO_UNKNOWN/);
  t.mock.timers.tick(10001);
  child.stdout.write(JSON.stringify(frame(started)) + '\n');
  assert.deepEqual(writes, ['stop\n']);
  for (const [i, value] of [{ kind: 'stdout_eof' }, { kind: 'stderr_eof' }, { kind: 'root_exit' }, closure].entries())
    child.stdout.write(JSON.stringify(frame(value, i + 2)) + '\n');
  child.emit('close', 0);
  await rejected;
});

test('missing owned helper PID handles its asynchronous spawn error without crashing host',
  {skip:process.platform!=='win32'},()=>{
    const script=`
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {EventEmitter} from 'node:events';
      import {pathToFileURL} from 'node:url';
      import {resolve} from 'node:path';
      let spawned=0;
      childProcess.spawn=()=>{
        spawned++;
        const child=new EventEmitter();
        queueMicrotask(()=>child.emit('error',new Error('SYNTHETIC_SPAWN_FAILURE')));
        return child;
      };
      syncBuiltinESMExports();
      const module=await import(pathToFileURL(resolve('src/adapters/codex/investigator/windows-job-stdio.ts')).href);
      let rejected=false;
      try{await module.runOwnedWindowsReadiness('owned_pipe_fixture_v1',
        {assertDiagnosticAuthority:()=>true});}
      catch(error){rejected=error?.message==='WINDOWS_OWNED_STDIO_UNKNOWN';}
      await new Promise(resolveValue=>setImmediate(resolveValue));
      process.stdout.write(JSON.stringify({spawned,rejected}));
    `;
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{
      cwd:resolve('.'),encoding:'utf8',timeout:5000,maxBuffer:8192,windowsHide:true});
    assert.equal(child.status,0,child.stderr);
    assert.deepEqual(JSON.parse(child.stdout),{spawned:1,rejected:true});
  });

test('authority callback aborting synchronously prevents native spawn for both fixed recipes',
  {skip:process.platform!=='win32'},()=>{
    const script=`
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {pathToFileURL} from 'node:url';
      import {resolve} from 'node:path';
      let spawned=0;
      childProcess.spawn=()=>{spawned++;throw new Error('SYNTHETIC_SPAWN');};
      syncBuiltinESMExports();
      const module=await import(pathToFileURL(resolve('src/adapters/codex/investigator/windows-job-stdio.ts')).href);
      const results=[];
      for(const recipe of ['owned_pipe_fixture_v1','stdio_fixture_v1']){
        const controller=new AbortController();
        let errorCode='none';
        try{await module.runOwnedWindowsReadiness(recipe,{signal:controller.signal,
          assertDiagnosticAuthority:()=>{controller.abort();return true;}});}
        catch(error){errorCode=error?.message;}
        results.push(errorCode);
      }
      process.stdout.write(JSON.stringify({spawned,results}));
    `;
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{
      cwd:resolve('.'),encoding:'utf8',timeout:5000,maxBuffer:8192,windowsHide:true});
    assert.equal(child.status,0,child.stderr);
    assert.deepEqual(JSON.parse(child.stdout),{spawned:0,
      results:['WINDOWS_OWNED_STDIO_UNKNOWN','WINDOWS_OWNED_STDIO_UNKNOWN']});
  });

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const source = resolve('native/windows/WindowsJobHost.cs');
type Frame = Record<string, unknown>;
type Writer = {helperPid:number;helperCreationFiletime:string;pipeName:string;handle:string;
  deadlineUtcTicks:string;deadlineUptimeMs:string};

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-prepared-native-'));
  const exe = join(dir, 'WindowsJobHost.exe');
  const result = spawnSync(compiler, ['/nologo','/target:exe','/platform:x64',`/out:${exe}`,source],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
  return { exe, dir, close: () => {
    const parent = realpathSync.native(tmpdir()), actual = realpathSync.native(dir);
    if (!actual.startsWith(parent + sep) || !basename(actual).startsWith('rcac-prepared-native-') ||
        !lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
      throw new Error('FIXTURE_CLEANUP_SCOPE');
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } };
}

function run(exe: string, recipe = 'prepared_owned_fixture_v1') {
  const host = randomUUID(), execution = randomUUID();
  const child = spawn(exe, recipe === 'prepared_owned_fixture_v1' ?
    [recipe,host,execution,'30'] : [recipe,host,execution], {
    stdio: ['pipe','pipe','pipe'], windowsHide: true,
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' },
  });
  const events: Frame[] = [];
  let partial = '', stderr = '', closed = false, exitCode: number | null = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    partial += chunk;
    for (let end; (end = partial.indexOf('\n')) >= 0;) {
      events.push(JSON.parse(partial.slice(0, end)) as Frame);
      partial = partial.slice(end + 1);
    }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>(resolveExit => child.once('close', code => {
    closed = true; exitCode = code; resolveExit(code);
  }));
  async function until(kind: string): Promise<Frame> {
    for (let i = 0; i < 240; i++) {
      const event = events.find(value => value.kind === kind);
      if (event) return event;
      if (closed) throw new Error(`HELPER_EXIT_${exitCode} ${stderr}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    throw new Error(`EVENT_TIMEOUT_${kind} ${stderr}`);
  }
  async function finish() {
    if (!closed && child.stdin.writable) child.stdin.write('stop\n');
    const boundedClose = async (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([exited, new Promise<null>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(null), ms);
      })]); } finally { if (timer) clearTimeout(timer); }
    };
    await boundedClose(6000);
    if (!closed) {
      child.kill();
      await boundedClose(1000);
    }
    return exitCode;
  }
  function assertCompleteClosure(root?: {pid:number;creationFiletime:string}) {
    assert.equal(closed, true);
    assert.equal(exitCode, 0);
    assert.equal(partial, '');
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    for (const event of events) {
      assert.equal(event.protocol, 'windows_job_stdio_v1');
      assert.equal(event.helperVersion, '3');
      assert.equal(event.recipe, recipe);
      assert.equal(event.hostScopeId, host);
      assert.equal(event.executionInstanceId, execution);
    }
    const last = events.at(-1);
    assert.deepEqual(last?.members, {complete:true,assigned:0,listed:0,pids:[]});
    if (root) {
      assert.equal(last?.kind, 'job_closed');
      assert.deepEqual(last.root, root);
      for (const kind of ['stdout_eof','stderr_eof','root_exit'])
        assert.equal(events.filter(event => event.kind === kind).length, 1);
    } else {
      assert.equal(last?.kind, 'prepared_closed');
      assert.equal(last.childPresent, false);
      assert.equal(Object.hasOwn(last, 'root'), false);
      assert.equal(events.some(event => event.kind === 'started'), false);
    }
  }
  return {host,execution,child,events,until,finish,assertCompleteClosure,get stderr(){return stderr;}};
}

test('prepared helper owns no child until one start; native writer accepts one full UTF8 JSONL frame',
  { skip: process.platform !== 'win32', timeout: 25_000 }, async () => {
    const built = build();
    let verifiedClosure = false;
    try {
      const runState = run(built.exe);
      try {
        const prepared = await runState.until('prepared');
        assert.equal(prepared.protocol, 'windows_job_stdio_v1');
        assert.equal(prepared.helperVersion, '3');
        assert.equal(prepared.recipe, 'prepared_owned_fixture_v1');
        assert.equal(prepared.childPresent, false);
        assert.equal(Object.hasOwn(prepared, 'root'), false);
        const writer = prepared.writer as Writer;
        assert.match(writer.handle, /^[1-9][0-9]*$/);
        assert.equal(runState.events.filter(event => event.kind === 'started').length, 0);
        runState.child.stdin.write('start\n');
        const started = await runState.until('started');
        assert.equal(started.createdSuspended, true);
        assert.equal(started.jobMemberBeforeResume, true);
        assert.equal(Object.hasOwn(started, 'writer'), false);
        const root = started.root as {pid:number;creationFiletime:string};
        assert.ok(root.pid > 0);
        assert.match(root.creationFiletime, /^[1-9][0-9]{0,19}$/);
        const args = ['__write_owned_frame',runState.host,runState.execution,
          String(writer.helperPid),writer.helperCreationFiletime,writer.pipeName,writer.handle,
          writer.deadlineUtcTicks,writer.deadlineUptimeMs];
        const wrongRecipeWriter = spawnSync(built.exe, ['__write_owned_pipe',...args.slice(1)],
          {input:'owned-initialize\n',encoding:'utf8',timeout:3000,windowsHide:true});
        assert.notEqual(wrongRecipeWriter.status, 0);
        assert.equal(wrongRecipeWriter.stdout, '');
        const frame = `${JSON.stringify({id:1,method:'fixture/echo',params:{text:'π'+'x'.repeat(65000)}})}\n`;
        assert.ok(Buffer.byteLength(frame, 'utf8') <= 65536);
        const send = spawnSync(built.exe, args, {input:frame,encoding:'utf8',timeout:3000,windowsHide:true});
        assert.equal(send.status, 0, `${send.stdout} ${send.stderr}`);
        assert.deepEqual(JSON.parse(send.stdout), {accepted:true});
        const digest = createHash('sha256').update(frame).digest('hex');
        let receipt = '';
        for (let i = 0; i < 240 && !receipt.includes(digest); i++) {
          receipt = runState.events.filter(event => event.kind === 'stdout')
            .map(event => Buffer.from(String(event.dataBase64), 'base64').toString('utf8')).join('');
          if (!receipt.includes(digest)) await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
        }
        assert.match(receipt, new RegExp(digest));
        for (const invalid of [frame+'{}\n', '{"id":,}\n',
          '{"__type":"System.IO.FileInfo"}\n',
          `{"x":${'['.repeat(70)}0${']'.repeat(70)}}\n`,
          `${JSON.stringify({x:'x'.repeat(65536)})}\n`]) {
          const denied = spawnSync(built.exe, args, {input:invalid,encoding:'utf8',timeout:3000,windowsHide:true});
          assert.notEqual(denied.status, 0);
          assert.equal(denied.stdout, '');
        }
        const invalidUtf8 = spawnSync(built.exe, args,
          {input:Buffer.from([123,34,120,34,58,34,0xff,34,125,10]),
            encoding:'utf8',timeout:3000,windowsHide:true});
        assert.notEqual(invalidUtf8.status, 0);
        assert.equal(invalidUtf8.stdout, '');
        assert.equal(await runState.finish(), 0, runState.stderr);
        const closed = runState.events.at(-1);
        assert.equal(closed?.kind, 'job_closed');
        assert.deepEqual(closed?.root, root);
        assert.deepEqual(closed?.members, {complete:true,assigned:0,listed:0,pids:[]});
        runState.assertCompleteClosure(root);
        verifiedClosure = true;
      } finally { await runState.finish(); }
    } finally { if (verifiedClosure) built.close(); }
  });

test('new arbitrary-frame writer rejects unmodified diagnostic origin metadata',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
    const built = build(); let verifiedClosure = false;
    const runState = run(built.exe, 'owned_pipe_fixture_v1');
    try {
      const started = await runState.until('started');
      const writer = started.writer as Writer;
      const args = ['__write_owned_frame',runState.host,runState.execution,
        String(writer.helperPid),writer.helperCreationFiletime,writer.pipeName,writer.handle,
        writer.deadlineUtcTicks,writer.deadlineUptimeMs];
      const denied = spawnSync(built.exe,args,{input:'{"id":1}\n',encoding:'utf8',timeout:3000,windowsHide:true});
      assert.notEqual(denied.status, 0);
      assert.equal(denied.stdout, '');
      assert.equal(await runState.finish(), 0, runState.stderr);
      runState.assertCompleteClosure(started.root as {pid:number;creationFiletime:string});
      verifiedClosure = true;
    } finally {
      if (!verifiedClosure) await runState.finish();
      if (verifiedClosure) built.close();
    }
  });

test('stop before start produces only a complete prepared closure',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
    const built = build();
    let verifiedClosure = false;
    const runState = run(built.exe);
    try {
      await runState.until('prepared');
      assert.equal(await runState.finish(), 0, runState.stderr);
      assert.equal(runState.events.some(event => event.kind === 'started'), false);
      const closed = runState.events.at(-1);
      assert.equal(closed?.kind, 'prepared_closed');
      assert.equal(closed?.childPresent, false);
      assert.equal(Object.hasOwn(closed ?? {}, 'root'), false);
      assert.deepEqual(closed?.members, {complete:true,assigned:0,listed:0,pids:[]});
      runState.assertCompleteClosure();
      verifiedClosure = true;
    } finally {
      if (!verifiedClosure) await runState.finish();
      if (verifiedClosure) built.close();
    }
  });

test('prepared pipe NOWAIT saturation rejects a later frame without retry or child creation',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
    const built = build(); let verifiedClosure = false;
    const runState = run(built.exe);
    try {
      const prepared = await runState.until('prepared');
      const writer = prepared.writer as Writer;
      const args = ['__write_owned_frame',runState.host,runState.execution,
        String(writer.helperPid),writer.helperCreationFiletime,writer.pipeName,writer.handle,
        writer.deadlineUtcTicks,writer.deadlineUptimeMs];
      let accepted = 0, rejected = 0;
      let failureStage = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const frame = `${JSON.stringify({id:attempt+1,payload:'x'.repeat(65000)})}\n`;
        const result = spawnSync(built.exe,args,{input:frame,encoding:'utf8',timeout:3000,windowsHide:true});
        if (result.status === 0) {
          assert.deepEqual(JSON.parse(result.stdout),{accepted:true}); accepted++;
        } else { assert.equal(result.stdout,''); rejected++; failureStage=result.stderr.trim(); break; }
      }
      t.diagnostic(JSON.stringify({accepted,rejected,failureStage}));
      assert.ok(accepted >= 1);
      assert.ok(rejected >= 1, 'bounded NOWAIT buffer must eventually refuse a full message');
      assert.equal(runState.events.some(event => event.kind === 'started'), false);
      assert.equal(await runState.finish(), 0, runState.stderr);
      runState.assertCompleteClosure();
      verifiedClosure = true;
    } finally {
      if (!verifiedClosure) await runState.finish();
      if (verifiedClosure) built.close();
    }
  });

test('a second start is rejected and cannot publish a normal job closure',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
    const built = build();
    const runState = run(built.exe);
    try {
      await runState.until('prepared');
      runState.child.stdin.write('start\nstart\n');
      await runState.until('started');
      assert.equal(await runState.finish(), 1);
      assert.equal(runState.events.some(event => event.kind === 'job_closed'), false);
      assert.match(runState.stderr, /CONTROL_ORDER/);
    } finally { await runState.finish(); /* Unknown closure preserves the fixture directory. */ }
  });

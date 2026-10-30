import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Writable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { observeBeforeInitialize, readContainedHelper, finishContainedStdin, waitContainedOriginalExit,
  containedCloseIsExpected } from '../../tools/wsl-qualification-preflight.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';
import { buildWslIsolationCandidate, checkContainedPayload, sealSource } from '../../tools/wsl-isolation-candidate.js';
import { createInitializeOnlyDiagnosticWriter } from '../../src/adapters/codex/investigator/wsl-app-server-diagnostic.js';
import type { WslDiagnosticObservation } from '../../src/adapters/codex/investigator/wsl-app-server-diagnostic.js';

const id = '148d2ffc-55cb-47be-9d99-23f103de2ab5';
const facts = { processTreeMatched: true, namespacesMatched: true, mountsMatched: true,
  environmentMatched: true, privilegesMatched: true, stdioMatched: true, fdScopeMatched: true };

test('contained initialize recipe keeps the same fixed boundary and records only owned launch pipes', () => {
  const spec = buildWslIsolationCandidate(id);
  assert.deepEqual(spec.appServerInitialize.slice(-6),
    ['/usr/bin/python3.10', '-I', '-S', '-c', sealSource, '__PIPE_RECORD__']);
  assert.deepEqual(spec.appServerInitialize.slice(0, spec.unit.length + spec.sandbox.length),
    [...spec.unit, ...spec.sandbox]);
  assert.ok(spec.initializeLaunch.at(-1)!.includes("argv[-1]=json.dumps(metadata"));
  assert.equal(Object.isFrozen(spec.initializeLaunch), true);
  assert.ok(spec.initializeLaunch.at(-1)!.includes(`/home/fixture/.local/repoconduit-private-homes/${id}/launch-pipes.json`));
  assert.ok(!spec.helpLaunch.at(-1)!.includes('launch-pipes.json'));
  assert.ok(!spec.initializeLaunch.at(-1)!.includes('OBSERVE_COMPLETE'));
});

test('unknown or incomplete contained payload facts refuse before any handshake write', () => {
  let writes = 0;
  for (const invalid of [null, {}, { facts: [] }, { facts: { ...facts, extra: true } },
    ...Object.keys(facts).map(key => ({ facts: { ...facts, [key]: false } })),
    ...Object.keys(facts).map(key => ({ facts: Object.fromEntries(Object.entries(facts).filter(([k]) => k !== key)) }))]) {
    assert.throws(() => {
      checkContainedPayload(invalid);
      writes++;
    }, /CONTAINED_PAYLOAD_UNVERIFIED/);
  }
  assert.equal(writes, 0);
  checkContainedPayload({ facts, processes: [] }); // The fixed observer owns metadata verification.
});

test('verified contained diagnostics still accept only two exact frames and explicit gateway OAuth', () => {
  checkContainedPayload({ facts });
  const sent: string[] = [];
  const input = new Writable({ write(data, _encoding, done) { sent.push(data.toString()); done(); } });
  const intents: string[] = [];
  const writer = createInitializeOnlyDiagnosticWriter(input, line => intents.push(line));
  const params = { clientInfo: { name: 'repo-conduit', version: '0.1.0' }, capabilities: { experimentalApi: false } };
  writer(JSON.stringify({ id: 1, method: 'initialize', params }) + '\n', { kind: 'rpc', method: 'initialize', params });
  assert.equal(JSON.parse(sent[0]!).params.capabilities.explicitGatewayOauth, true);
  writer('{"method":"initialized"}\n', { kind: 'initialized' });
  assert.throws(() => writer('{"method":"initialized"}\n', { kind: 'initialized' }), /DIAGNOSTIC_CONTROL_REJECTED/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent, intents);
  input.end();
});

test('ambient FD close failures other than EBADF prevent bootstrap execution', () => {
  const source = buildWslIsolationCandidate(id).initializeLaunch.at(-1)!;
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? 'python.exe', ['-I', '-S', '-c', String.raw`
import ast,errno,sys
tree=ast.parse(sys.stdin.read())
parts=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='close_ambient_fds']
assert len(parts)==1
class OS:
 def listdir(self,path): return ['0','1','2','3','4']
 def close(self,fd):
  if fd==3: raise OSError(errno.EBADF,'already closed')
  if fd==4: raise OSError(errno.EIO,'real close failure')
scope={'os':OS(),'errno':errno}
exec(compile(ast.Module(body=parts,type_ignores=[]),'close-only','exec'),scope)
try: scope['close_ambient_fds']()
except OSError as e: assert e.errno==errno.EIO
else: raise AssertionError('close failure ignored')
scope['os'].close=lambda fd:None
scope['close_ambient_fds']()
print('CLOSE_ONLY')`], { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'CLOSE_ONLY');
});

test('contained initialize source has no old uncontained setup/schema/native command entry', () => {
  const source = readFileSync('tools/wsl-qualification-preflight.ts', 'utf8');
  for (const old of ['privateLoginSpec', 'prepare-wsl-private-home.sh', 'diagnosticPrivateEnvironmentCheck',
    "stage('generate_schema')", "privateCommand(['--version'])", 'diagnosticAppServerUnitSpec'])
    assert.equal(source.includes(old), false, old);
  assert.ok(source.includes('spec.initializeLaunch'));
  assert.ok(source.indexOf('checkContainedPayload(payload)') < source.indexOf('transport.initialize()'));
  assert.equal(source.includes('spawnSync'), false);
});

test('delayed observation cannot enable protocol writes after malformed data, limits, error or close', async () => {
  for (const kind of ['malformed', 'overflow', 'error', 'close']) {
    const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
    const exited = new EventEmitter(); const bytes: string[] = [];
    input.on('data', part => bytes.push(part.toString()));
    let failed = false, verified = false;
    const writer = createInitializeOnlyDiagnosticWriter(input, () => {});
    const refuse = () => { if (failed) throw new Error('BRIDGE_FAILURE_BEFORE_WRITE'); };
    const transport = new CodexJsonlTransport({ input, output, errors, exited,
      terminate: () => { failed = true; } },
    { maxFrameBytes: 256, maxTotalBytes: 512, maxNotifications: 8, requestTimeoutMs: 1000 },
    'wsl-codex-0.157.1', undefined, (line, control) => {
      refuse(); assert.equal(verified, true); return writer(line, control);
    });
    let finishObservation!: (value: unknown) => void;
    const initialization = observeBeforeInitialize(transport,
      () => new Promise(resolve => { finishObservation = resolve; }), refuse, () => { verified = true; });
    const rejected = assert.rejects(initialization, /BRIDGE_FAILURE|PROTOCOL_/);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (kind === 'malformed') output.write('bad json\n');
    if (kind === 'overflow') output.write(Buffer.alloc(513, 65));
    if (kind === 'error') exited.emit('error', new Error('synthetic bridge error'));
    if (kind === 'close') exited.emit('close', 0);
    finishObservation({ facts });
    await rejected;
    assert.deepEqual(bytes, [], kind);
    assert.equal(verified, false, kind);
    transport.close({ terminate: false }); input.destroy(); output.destroy(); errors.destroy();
  }
});

test('asynchronous verified observation precedes the actual two-frame handshake', async () => {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const bytes: string[] = [];
  input.on('data', part => {
    const line = part.toString(); bytes.push(line);
    if (JSON.parse(line).method === 'initialize') setImmediate(() =>
      output.write(JSON.stringify({ id: JSON.parse(line).id, result: {} }) + '\n'));
  });
  const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(), terminate: () => {} },
    { maxFrameBytes: 1024, maxTotalBytes: 4096, maxNotifications: 8, requestTimeoutMs: 1000 },
    'wsl-codex-0.157.1', undefined, createInitializeOnlyDiagnosticWriter(input, () => {}));
  await observeBeforeInitialize(transport, async () => {
    await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(bytes, []); return { facts };
  }, () => {}, () => {});
  assert.equal(bytes.length, 2);
  assert.equal(JSON.parse(bytes[0]!).params.capabilities.explicitGatewayOauth, true);
  transport.close({ terminate: false }); input.destroy(); output.destroy(); errors.destroy();
});

test('helper without close or with a failed kill returns bounded unconfirmed evidence and zero writes', async () => {
  for (const killFails of [false, true]) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), kill() { if (killFails) throw new Error('synthetic kill failure'); return false; },
      unref() {} });
    const started = Date.now();
    const pending = readContainedHelper(child as unknown as ChildProcessWithoutNullStreams, 'synthetic', 10);
    child.stdout.write('retained-prefix'); child.stderr.write('retained-error');
    const result = await pending;
    assert.equal(result.status, null); assert.equal(result.unconfirmed, true);
    assert.equal(result.errorCode, 'HELPER_TIMEOUT');
    assert.equal(result.stdout.toString(), 'retained-prefix');
    assert.equal(result.stderr.toString(), 'retained-error');
    assert.ok(Date.now() - started < 1500);
    const input = new PassThrough(); const bytes: string[] = [];
    input.on('data', part => bytes.push(part.toString()));
    const transport = new CodexJsonlTransport({ input, output: new PassThrough(), errors: new PassThrough(),
      exited: new EventEmitter(), terminate() {} },
      { maxFrameBytes: 1024, maxTotalBytes: 4096, maxNotifications: 8, requestTimeoutMs: 1000 });
    await assert.rejects(observeBeforeInitialize(transport, async () => {
      if (result.unconfirmed) throw new Error('HELPER_UNCONFIRMED'); return { facts };
    }, () => {}, () => {}), /HELPER_UNCONFIRMED/);
    assert.deepEqual(bytes, []); transport.close({ terminate: false }); input.destroy();
  }
});

test('contained stdin EOF records finish rather than equating end request with delivery', async () => {
  let finishWrite!: () => void;
  const input = new Writable({ write(_data, _encoding, done) { finishWrite = done; } });
  input.write('fixed frame\n');
  let finished = false;
  const pending = finishContainedStdin(input, 500).then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(input.writableEnded, true);
  assert.equal(finished, false);
  finishWrite(); await pending;
  assert.equal(input.writableFinished, true);
});

test('unconfirmed, failed or prematurely closed stdin never supplies a finish observation', async () => {
  for (const cause of ['timeout', 'error', 'close'] as const) {
    const input = new Writable({ write() {} }); input.write('fixed frame\n');
    const pending = finishContainedStdin(input, 20);
    if (cause === 'error') input.emit('error', new Error('synthetic failure'));
    if (cause === 'close') input.emit('close');
    await assert.rejects(pending, /STDIN_FINISH_UNCONFIRMED/);
    // Consume any error in this deliberately uncompleted synthetic stream during disposal.
    input.on('error', () => {}); input.destroy();
  }
});

const original: WslDiagnosticObservation = {
  bootId: '87c64855-966c-4a85-ac83-3ff2ef015c75', uid: 1000,
  unitName: 'rcac-investigator-074a4d47-f171-40be-8d2a-3f1afc3e2167.service',
  invocationId: 'b99a0f25b593458f8f4353aa64f134b4',
  controlGroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/rcac-investigator-074a4d47-f171-40be-8d2a-3f1afc3e2167.service',
  mainPid: 450, loadState: 'loaded', activeState: 'active', subState: 'running', cgroupState: 'populated',
};

test('contained EOF observation permits delayed natural exit beyond the former four polls', async () => {
  let calls = 0;
  await waitContainedOriginalExit(original, Date.now() + 1000, async remaining => {
    assert.ok(remaining > 0 && remaining <= 1000);
    return ++calls <= 4 ? original : { ...original, mainPid: 0, subState: 'exited', cgroupState: 'empty' };
  });
  assert.equal(calls, 5);
});

test('contained EOF observation rejects drift, failed runtime termination and exhausted window', async () => {
  for (const current of [{ ...original, invocationId: 'f'.repeat(32) },
    { ...original, mainPid: 0, activeState: 'failed', subState: 'failed', cgroupState: 'empty' },
    { ...original, mainPid: 0, subState: 'exited', cgroupState: 'populated' }]) {
    await assert.rejects(waitContainedOriginalExit(original, Date.now() + 1000, async () => current),
      /ORIGINAL_EXIT_UNCONFIRMED/);
  }
  let called = false;
  await assert.rejects(waitContainedOriginalExit(original, Date.now() - 1, async () => { called = true; return original; }),
    /ORIGINAL_EXIT_UNCONFIRMED/);
  assert.equal(called, false);
  await assert.rejects(waitContainedOriginalExit(original, Date.now() + 20, async () => original),
    /ORIGINAL_EXIT_UNCONFIRMED/);
});

test('only confirmed clean bridge close after requested EOF suppresses termination failure', () => {
  assert.equal(containedCloseIsExpected(true, 0, null, true, true, false), true);
  for (const args of [[false, 0, null, true, true, false], [true, null, null, true, true, false],
    [true, 1, null, true, true, false], [true, 0, 'SIGTERM', true, true, false],
    [true, 0, null, false, true, false], [true, 0, null, true, false, false],
    [true, 0, null, true, true, true]] as const)
    assert.equal(containedCloseIsExpected(args[0], args[1], args[2], args[3], args[4], args[5]), false);
});

test('contained clean close continues parsing until EOF and rejects truncated or late invalid tail', async () => {
  for (const tail of ['', '{"method":"partial', '{"method":"badBare","params":{}}\n']) {
    const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough(), exited = new EventEmitter();
    let stdoutEnded = false, stderrEnded = false, expected = false, failure = false;
    output.once('end', () => { stdoutEnded = true; }); errors.once('end', () => { stderrEnded = true; });
    errors.resume();
    // Register actual close classification before transport's close listener, as in the runner.
    exited.once('close', (code: number, signal: string | null) => {
      expected = containedCloseIsExpected(true, code, signal, stdoutEnded, stderrEnded, failure);
    });
    const transport = new CodexJsonlTransport({ input, output, errors, exited,
      terminate() { if (!expected) failure = true; } },
    { maxFrameBytes: 1024, maxTotalBytes: 4096, maxNotifications: 8, requestTimeoutMs: 500 },
    'wsl-codex-0.157.1', undefined, createInitializeOnlyDiagnosticWriter(input, () => {}));
    try {
      const pending = transport.initialize(); output.write('{"id":1,"result":{}}\n'); await pending;
      // These bytes arrive after unit terminal, before stream EOF and bridge close.
      output.end(tail); errors.end();
      await new Promise<void>(resolve => setImmediate(resolve));
      exited.emit('close', 0, null);
      assert.equal(failure, tail !== '');
      assert.equal(expected, tail === '');
    } finally { transport.close({ terminate: false }); input.destroy(); output.destroy(); errors.destroy(); }
  }
  const runner = readFileSync('tools/wsl-qualification-preflight.ts', 'utf8');
  assert.ok(runner.indexOf('transport?.close({ terminate: false })') > runner.indexOf('record.bridge = await Promise.race'));
});

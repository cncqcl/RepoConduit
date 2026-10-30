import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { observeWslTerminal } from '../../src/adapters/codex/investigator/terminal-observer.js';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';
import type { CodexControlSend } from '../../src/adapters/codex/protocol/stdio.js';
import { bindDiagnosticRunning, diagnosticAppServerExited, diagnosticAppServerUnitSpec,
  diagnosticSameUnit, createInitializeOnlyDiagnosticGuard, createInitializeOnlyDiagnosticWriter,
  checkDiagnosticInitializeSchema, checkDiagnosticPrivateBinding, diagnosticPrivateEnvironmentCheck,
  type WslDiagnosticObservation } from '../../src/adapters/codex/investigator/wsl-app-server-diagnostic.js';

const input = {
  distro: 'Ubuntu-22.04', loginId: 'c033e1ac-1796-4a23-b807-1da8b9c949b1',
  linuxHome: '/home/fixture', linuxNode: '/home/fixture/.hermes/node/bin/node',
  codexEntry: '/home/fixture/.local/repoconduit-codex-0.157.1/package/bin/codex.js',
  unitName: 'rcac-investigator-11111111-1111-4111-8111-111111111111.service', maxWallSeconds: 60,
};
const bootId = '22222222-2222-4222-8222-222222222222';
const uid = 1000;
const controlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${input.unitName}`;
const running: WslDiagnosticObservation = { bootId, uid, unitName: input.unitName,
  invocationId: 'a'.repeat(32), controlGroup, loadState: 'loaded', activeState: 'active',
  subState: 'running', mainPid: 1234, cgroupState: 'populated' };

test('private binding requires a complete true-only environment observation without secret fields', () => {
  const binding = { homeMatched: true, codexHomeMatched: true, cwdMatched: true,
    commandMatched: true, authFileAbsent: true, environmentMatched: true };
  checkDiagnosticPrivateBinding(binding);
  for (const key of Object.keys(binding)) {
    const missing = { ...binding } as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => checkDiagnosticPrivateBinding(missing), /PRIVATE_BINDING_UNVERIFIED/);
    for (const value of [false, 'true', 1, null])
      assert.throws(() => checkDiagnosticPrivateBinding({ ...binding, [key]: value }), /PRIVATE_BINDING_UNVERIFIED/);
  }
  for (const value of [null, [], { ...binding, apiKey: 'synthetic-canary-not-a-key' },
    { ...binding, environment: { OPENAI_API_KEY: 'synthetic-canary-not-a-key' } }]) {
    assert.throws(() => checkDiagnosticPrivateBinding(value), error =>
      error instanceof Error && error.message === 'PRIVATE_BINDING_UNVERIFIED');
  }
});

test('synthetic legacy subset binding cannot satisfy the new full environment check', () => {
  const observed = JSON.parse(readFileSync(new URL('../fixtures/legacy-runtime/subset-binding.json', import.meta.url), 'utf8'));
  assert.equal(observed.closureObserved, true);
  assert.throws(() => checkDiagnosticPrivateBinding(observed.privateBinding), /PRIVATE_BINDING_UNVERIFIED/);
});

test('the exact Linux audit predicate rejects secret, duplicate, malformed and wrong environment entries', () => {
  const expected = ['HOME=/private/home', 'CODEX_HOME=/private/home/.codex', 'PATH=/fixed/bin:/usr/bin:/bin'];
  const encode = (entries: string[]) => entries.join('\0') + '\0';
  const cases = [encode(expected), encode([...expected].reverse()), encode(expected.slice(0, 2)),
    encode([...expected, 'OPENAI_API_KEY=synthetic-canary-not-a-key']),
    encode([...expected, expected[0]!]),
    encode([expected[0]!, expected[0]!, expected[2]!]),
    encode([expected[0]!, expected[1]!, 'OPENAI_API_KEY=synthetic-canary-not-a-key']),
    encode([expected[0]!, expected[1]!, 'PATH=/other/bin']),
    encode([expected[0]!, expected[1]!, 'BROKEN']),
    expected.join('\0'), '', encode([...expected, ''])];
  // Executes only this portable pure predicate with synthetic bytes, never WSL/Codex or /proc.
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'),
    ['-I', '-S', '-c', diagnosticPrivateEnvironmentCheck + `
import json, sys
cases=json.load(sys.stdin)
print(json.dumps([matches_private_environment(x.encode(), '/private/home', '/private/home/.codex', '/fixed/bin:/usr/bin:/bin') for x in cases]))
`], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [true, true, false, false, false, false, false, false, false, false, false, false]);
  assert.equal(result.stdout.includes('synthetic-canary'), false);
});

test('diagnostic launch is the production spec with a bounded retained unit', () => {
  const spec = diagnosticAppServerUnitSpec(input);
  assert.deepEqual(spec.args.filter(arg => arg === '--remain-after-exit'), ['--remain-after-exit']);
  assert.equal(spec.args[spec.args.indexOf('--pipe') - 1], '--remain-after-exit');
  assert.equal(spec.args.at(-1), '--stdio');
  for (const maxWallSeconds of [0, 61, 600, NaN])
    assert.throws(() => diagnosticAppServerUnitSpec({ ...input, maxWallSeconds }), /INVALID_ARGUMENT/);
  assert.throws(() => diagnosticAppServerUnitSpec({ ...input, linuxHome: '/tmp' }), /INVALID_ARGUMENT/);
});

test('binding requires exact input, running state and immutable native identity', () => {
  const source = { ...running };
  const bound = bindDiagnosticRunning(input, source);
  assert.deepEqual(bound, { bootId, uid, unitName: input.unitName, invocationId: running.invocationId,
    controlGroup, mainPid: 1234 });
  assert.equal(Object.isFrozen(bound), true);
  source.invocationId = 'b'.repeat(32);
  source.mainPid = 99;
  assert.equal(bound.invocationId, 'a'.repeat(32));
  assert.equal(bound.mainPid, 1234);
  for (const change of [
    { bootId: 'bad' }, { uid: 0 }, { uid: 1.5 }, { unitName: 'other.service' },
    { invocationId: 'A'.repeat(32) }, { controlGroup: `${controlGroup}/child` },
    { controlGroup: `/user.slice/user-999.slice/user@999.service/app.slice/${input.unitName}` },
    { loadState: 'not-found' }, { activeState: 'inactive' }, { subState: 'exited' },
    { mainPid: 0 }, { mainPid: 1.5 }, { cgroupState: 'empty' },
  ]) assert.throws(() => bindDiagnosticRunning(input, { ...running, ...change }), /INVALID_DIAGNOSTIC_RUNNING/);
  assert.throws(() => bindDiagnosticRunning({ ...input, maxWallSeconds: 61 }, running), /INVALID_DIAGNOSTIC_RUNNING/);
  assert.throws(() => bindDiagnosticRunning({ ...input, unitName: 'other.service' }, running), /INVALID_DIAGNOSTIC_RUNNING/);
});

test('exit proof and cleanup identity require the bound unit and invocation', () => {
  const bound = bindDiagnosticRunning(input, running);
  const exited = { ...running, activeState: 'active', subState: 'exited', mainPid: 0,
    cgroupState: 'empty' };
  assert.equal(diagnosticAppServerExited(bound, exited), true);
  assert.equal(diagnosticAppServerExited(bound, { ...exited, controlGroup: '', cgroupState: 'absent' }), true);
  assert.equal(diagnosticSameUnit(bound, running), true);
  assert.equal(diagnosticSameUnit(bound, exited), true);
  for (const change of [
    { bootId: '33333333-3333-4333-8333-333333333333' }, { uid: 1001 },
    { unitName: 'other.service' }, { invocationId: 'b'.repeat(32) },
    { loadState: 'not-found' }, { controlGroup: `${controlGroup}/child` },
  ]) {
    assert.equal(diagnosticAppServerExited(bound, { ...exited, ...change }), false);
    assert.equal(diagnosticSameUnit(bound, { ...exited, ...change }), false);
  }
  for (const change of [
    { activeState: 'inactive' }, { subState: 'dead' }, { mainPid: 12 },
    { cgroupState: 'populated' },
  ]) assert.equal(diagnosticAppServerExited(bound, { ...exited, ...change }), false);
  assert.equal(diagnosticSameUnit(bound, { ...running, mainPid: 2222 }), false);
});

test('diagnostic exited state is not a production unit_terminal observation', async () => {
  const resource = { distro: input.distro, bootId, uid, unitName: input.unitName,
    invocationId: running.invocationId, controlGroup };
  const exited = { ...running, subState: 'exited', mainPid: 0, cgroupState: 'empty' };
  const result = await observeWslTerminal(resource, 'fixture', async () =>
    ({ exitCode: 0, stderr: '', stdout: JSON.stringify(exited) }));
  assert.deepEqual(result, { kind: 'unconfirmed', reason: 'not_terminal' });
});

test('diagnostic control permits only ordered initialize and initialized once', () => {
  const initialize: CodexControlSend = { kind: 'rpc', method: 'initialize', params: {} };
  const initialized: CodexControlSend = { kind: 'initialized' };
  const reject = (guard: (frame: CodexControlSend) => void, frame: CodexControlSend) =>
    assert.throws(() => guard(frame), /DIAGNOSTIC_CONTROL_REJECTED/);
  const guard = createInitializeOnlyDiagnosticGuard();
  reject(guard, initialized);
  guard(initialize);
  reject(guard, initialize);
  guard(initialized);
  reject(guard, initialized);
  for (const frame of [
    { kind: 'rpc', method: 'thread/start', params: {} },
    { kind: 'rpc', method: 'turn/start', params: {} },
    { kind: 'rpc', method: 'repo/read', params: {} },
    { kind: 'repo-read-failure', threadId: 't', turnId: 'u' },
  ] as CodexControlSend[]) {
    reject(createInitializeOnlyDiagnosticGuard(), frame);
    reject(guard, frame);
  }
});

test('diagnostic writer confines actual transport to two persisted handshake frames', async () => {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const intents: string[] = [], bytes: string[] = [];
  input.on('data', chunk => bytes.push(chunk.toString()));
  const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(),
    terminate: () => {} },
  { maxFrameBytes: 8192, maxTotalBytes: 1024 * 1024, maxNotifications: 100, requestTimeoutMs: 1000 },
  'wsl-codex-0.157.1', undefined, createInitializeOnlyDiagnosticWriter(input, line => intents.push(line)));
  const initialization = transport.initialize();
  assert.equal(intents.length, 1);
  assert.deepEqual(bytes, intents);
  output.write(`${JSON.stringify({ id: JSON.parse(bytes[0]!).id, result: {} })}\n`);
  await initialization;
  assert.equal(intents.length, 2);
  assert.deepEqual(bytes, intents);
  assert.equal(JSON.parse(bytes[0]!).method, 'initialize');
  assert.deepEqual(JSON.parse(bytes[0]!).params, { clientInfo: { name: 'repo-conduit', version: '0.1.0' },
    capabilities: { experimentalApi: false, explicitGatewayOauth: true } });
  assert.equal(JSON.parse(bytes[1]!).method, 'initialized');
  await assert.rejects(transport.startRestrictedThread({ cwd: '/home/fixture/workspace',
    profileId: 'investigator', model: 'gpt-6-sol' }), /PROTOCOL_CLOSED/);
  assert.equal(intents.length, 2);
  assert.deepEqual(bytes, intents);
  transport.close();
});

test('diagnostic writer persists before writing and rejects missing control or unusable input', () => {
  const input = new PassThrough();
  const bytes: string[] = [];
  input.on('data', chunk => bytes.push(chunk.toString()));
  const writer = createInitializeOnlyDiagnosticWriter(input, () => { throw new Error('persist failed'); });
  assert.throws(() => writer(initializeLine(), initializeControl()), /persist failed/);
  assert.deepEqual(bytes, []);
  assert.throws(() => writer('{"id":1,"method":"initialize","params":{}}\n'),
    /DIAGNOSTIC_CONTROL_REJECTED/);
  const ended = new PassThrough();
  ended.end();
  assert.throws(() => createInitializeOnlyDiagnosticWriter(ended, () => {})('x\n',
    { kind: 'rpc', method: 'initialize', params: {} }), /DIAGNOSTIC_CONTROL_REJECTED/);
});

const initializeParams = () => ({ clientInfo: { name: 'repo-conduit', version: '0.1.0' },
  capabilities: { experimentalApi: false } });
const initializeControl = (): CodexControlSend => ({ kind: 'rpc', method: 'initialize', params: initializeParams() });
const initializeLine = (params: unknown = initializeParams()) =>
  `${JSON.stringify({ id: 37, method: 'initialize', params })}\n`;

test('actual retained schema must support explicit boolean gateway OAuth before launch', () => {
  const schema = JSON.parse(readFileSync(new URL('../fixtures/legacy-runtime/InitializeParams.json', import.meta.url), 'utf8'));
  checkDiagnosticInitializeSchema(schema);
  for (const change of [undefined, { type: 'string' }, { type: ['boolean', 'null'] }]) {
    const changed = structuredClone(schema);
    changed.definitions.InitializeCapabilities.properties.explicitGatewayOauth = change;
    assert.throws(() => checkDiagnosticInitializeSchema(changed), /INITIALIZE_SCHEMA_UNVERIFIED/);
  }
  assert.throws(() => checkDiagnosticInitializeSchema(null), /INITIALIZE_SCHEMA_UNVERIFIED/);
  const cyclic = structuredClone(schema);
  cyclic.definitions.InitializeCapabilities = { $ref: '#/definitions/InitializeCapabilities' };
  assert.throws(() => checkDiagnosticInitializeSchema(cyclic), /INITIALIZE_SCHEMA_UNVERIFIED/);
});

test('diagnostic writer rejects mismatched or additional frames before intent or bytes', () => {
  const rejected = (line: string, control: CodexControlSend = initializeControl()) => {
    const input = new PassThrough(), intents: string[] = [], bytes: string[] = [];
    input.on('data', chunk => bytes.push(chunk.toString()));
    const writer = createInitializeOnlyDiagnosticWriter(input, line => intents.push(line));
    assert.throws(() => writer(line, control), /DIAGNOSTIC_CONTROL_REJECTED/);
    assert.deepEqual(intents, []); assert.deepEqual(bytes, []);
  };
  for (const params of [{}, { ...initializeParams(), extra: true },
    { ...initializeParams(), clientInfo: { name: 'other', version: '0.1.0' } },
    { ...initializeParams(), capabilities: { experimentalApi: true } },
    { ...initializeParams(), capabilities: { experimentalApi: false, explicitGatewayOauth: false } }])
    rejected(initializeLine(params));
  rejected(initializeLine(), { kind: 'rpc', method: 'initialize', params: {} });
  rejected(`${JSON.stringify({ id: 37, method: 'turn/start', params: initializeParams() })}\n`);
  rejected(initializeLine() + '{"method":"turn/start"}\n');
  rejected(initializeLine().trimEnd());
  rejected(`${JSON.stringify({ id: -1, method: 'initialize', params: initializeParams() })}\n`);
  rejected(`${JSON.stringify({ id: 37, method: 'initialize', params: initializeParams(), extra: true })}\n`);
  rejected(' '.repeat(16384) + initializeLine());
  rejected('{"method":"initialized","params":{}}\n', { kind: 'initialized' });
});

test('diagnostic writer preserves request ID and never retries after persistence failure', () => {
  const input = new PassThrough(), intents: string[] = [], bytes: string[] = [];
  input.on('data', chunk => bytes.push(chunk.toString()));
  const writer = createInitializeOnlyDiagnosticWriter(input, line => {
    intents.push(line); throw new Error('persist failed');
  });
  assert.throws(() => writer(initializeLine(), initializeControl()), /persist failed/);
  assert.equal(JSON.parse(intents[0]!).id, 37);
  assert.equal(JSON.parse(intents[0]!).params.capabilities.explicitGatewayOauth, true);
  assert.throws(() => writer(initializeLine(), initializeControl()), /DIAGNOSTIC_CONTROL_REJECTED/);
  assert.equal(intents.length, 1); assert.deepEqual(bytes, []);
});

test('malformed initialized and third frame cannot emit extra bytes', () => {
  const input = new PassThrough(), intents: string[] = [], bytes: string[] = [];
  input.on('data', chunk => bytes.push(chunk.toString()));
  const writer = createInitializeOnlyDiagnosticWriter(input, line => intents.push(line));
  assert.equal(writer(initializeLine(), initializeControl()), true);
  assert.throws(() => writer('{"method":"initialized","params":{}}\n', { kind: 'initialized' }),
    /DIAGNOSTIC_CONTROL_REJECTED/);
  assert.equal(intents.length, 1); assert.deepEqual(bytes, intents);
  assert.equal(writer('{"method":"initialized"}\n', { kind: 'initialized' }), true);
  assert.throws(() => writer('{"method":"initialized"}\n', { kind: 'initialized' }),
    /DIAGNOSTIC_CONTROL_REJECTED/);
  assert.equal(intents.length, 2); assert.deepEqual(bytes, intents);
});

test('diagnostic OAuth rewriting does not alter the production transport handshake', async () => {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const bytes: string[] = [];
  input.on('data', chunk => bytes.push(chunk.toString()));
  const transport = new CodexJsonlTransport({ input, output, errors, exited: new EventEmitter(), terminate: () => {} },
    { maxFrameBytes: 8192, maxTotalBytes: 1024 * 1024, maxNotifications: 100, requestTimeoutMs: 1000 },
    'wsl-codex-0.157.1');
  const initialized = transport.initialize();
  assert.deepEqual(JSON.parse(bytes[0]!).params.capabilities, { experimentalApi: false });
  output.write(`${JSON.stringify({ id: JSON.parse(bytes[0]!).id, result: {} })}\n`);
  await initialized;
  transport.close();
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runWindowsReadinessProtocol } from '../../src/adapters/codex/protocol/windows-readiness.js';
import { confirmWindowsChildClose, desktopVersionMatches, preflightWindowsDesktop, windowsDesktopLaunchSpec } from '../../src/adapters/codex/investigator/windows-preflight.js';

function pair(autoClose = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const exited = new EventEmitter();
  let terminated = false;
  const run = runWindowsReadinessProtocol({ input, output, errors, exited,
    terminate() { terminated = true; if (autoClose) queueMicrotask(() => exited.emit('close', 0)); } }, 200);
  return { input, output, errors, exited, run, get terminated() { return terminated; } };
}

const initialized = '{"id":1,"result":{"userAgent":"codex-cli","codexHome":"C:\\\\Users\\\\test\\\\.codex","platformFamily":"windows","platformOs":"windows"}}\n';

test('Windows readiness sends only initialize and null-parameter readiness RPC', async () => {
  const p = pair();
  assert.deepEqual(JSON.parse(p.input.read().toString()), { id: 1, method: 'initialize', params: {
    clientInfo: { name: 'repo-conduit-readiness', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  } });
  p.output.write(initialized);
  assert.deepEqual(p.input.read().toString().trim().split('\n').map((line: string) => JSON.parse(line)), [
    { method: 'initialized' }, { id: 2, method: 'windowsSandbox/readiness', params: null },
  ]);
  p.output.write('{"method":"remoteControl/status/changed","params":{"installationId":"opaque","serverName":"Codex","status":"disabled"}}\n');
  p.output.write('{"id":2,"result":{"status":"updateRequired"}}\n');
  assert.deepEqual(await p.run, { readiness: 'updateRequired', isolationVerified: false, modelTurn: 'not_run' });
  assert.equal(p.terminated, true);
  assert.equal(p.input.read(), null);
});

test('Windows readiness rejects unknown status, extra RPC, notifications and secret-bearing errors', async () => {
  for (const line of [
    '{"id":2,"result":{"status":"futureReady"}}',
    '{"id":2,"result":{"status":"ready","unexpected":true}}',
    '{"id":3,"result":{"status":"ready"}}',
    '{"method":"thread/started","params":{"secret":"TOKEN"}}',
    '{"id":2,"error":{"message":"TOKEN C:\\\\private"}}',
  ]) {
    const p = pair();
    p.output.write(initialized);
    p.output.write(`${line}\n`);
    await assert.rejects(p.run, error => error instanceof Error && error.message === 'WINDOWS_READINESS_FAILED');
    assert.equal(p.terminated, true);
  }
});

test('Windows readiness accepts exactly the three schema-defined states without asserting isolation', async () => {
  for (const readiness of ['ready', 'notConfigured', 'updateRequired'] as const) {
    const p = pair();
    p.output.write(initialized);
    p.output.write(`${JSON.stringify({ id: 2, result: { status: readiness } })}\n`);
    assert.deepEqual(await p.run, { readiness, isolationVerified: false, modelTurn: 'not_run' });
    assert.equal(p.terminated, true);
  }
});

test('Windows readiness rejects an unsolicited message delivered after result in a later stdout chunk', async () => {
  const p = pair(false);
  p.output.write(initialized);
  p.output.write('{"id":2,"result":{"status":"ready"}}\n');
  p.output.write('{"method":"thread/started","params":{}}\n');
  p.exited.emit('close', 0);
  await assert.rejects(p.run, /WINDOWS_READINESS_FAILED/);
  assert.equal(p.terminated, true);
});

test('Windows readiness fails if process does not close after the candidate response', async () => {
  const p = pair(false);
  p.output.write(initialized);
  p.output.write('{"id":2,"result":{"status":"ready"}}\n');
  await assert.rejects(p.run, /WINDOWS_READINESS_FAILED/);
  assert.equal(p.terminated, true);
});

test('Windows child cleanup is bounded when kill returns false or throws and no close arrives', async () => {
  for (const behavior of ['false', 'throw'] as const) {
    let kills = 0;
    const child = Object.assign(new EventEmitter(), { kill() {
      kills += 1;
      if (behavior === 'throw') throw new Error('synthetic kill failure');
      return false;
    } });
    const started = Date.now();
    assert.equal(await confirmWindowsChildClose(child, 20), false);
    assert.equal(kills, 2);
    assert.ok(Date.now() - started < 500);
  }
});

test('Windows wrapper releases owned streams and event-loop ref after unconfirmed termination', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let kills = 0;
  let opens = 0;
  let unrefed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr,
    kill() { kills += 1; return false; },
    unref() { unrefed = true; },
  });
  stdin.on('data', chunk => {
    const frame = JSON.parse(chunk.toString().trim().split('\n')[0]) as { id?: number };
    if (frame.id === 1) stdout.write(initialized);
    if (chunk.toString().includes('windowsSandbox/readiness')) {
      stdout.write('{"id":2,"result":{"status":"ready"}}\n');
    }
  });
  await assert.rejects(preflightWindowsDesktop({
    version: () => ({ status: 0, stdout: 'codex-cli 0.165.0-alpha.1.2\n' }),
    open: () => { opens += 1; return child; },
    protocolTimeoutMs: 100,
    closeTimeoutMs: 20,
  }), /WINDOWS_READINESS_FAILED/);
  assert.equal(opens, 1);
  assert.ok(kills >= 2);
  assert.equal(stdin.destroyed, true);
  assert.equal(stdout.destroyed, true);
  assert.equal(stderr.destroyed, true);
  assert.equal(unrefed, true);
});

test('Windows readiness rejects excess stderr and process exit before native readiness response', async () => {
  const noisy = pair();
  noisy.errors.write(Buffer.alloc(8193));
  await assert.rejects(noisy.run, /WINDOWS_READINESS_FAILED/);
  assert.equal(noisy.terminated, true);
  const exited = pair();
  exited.output.write(initialized);
  exited.exited.emit('close', 0);
  await assert.rejects(exited.run, /WINDOWS_READINESS_FAILED/);
  assert.equal(exited.terminated, true);
});

test('Windows readiness bounds output and timeout and rejects non-result initialization', async () => {
  for (const line of ['{"id":1,"error":{"message":"TOKEN"}}\n', 'x'.repeat(5000)]) {
    const p = pair();
    p.output.write(line);
    await assert.rejects(p.run, /WINDOWS_READINESS_FAILED/);
  }
  const p = pair();
  await assert.rejects(p.run, /WINDOWS_READINESS_FAILED/);
  assert.equal(p.terminated, true);
});

test('Windows desktop diagnostic fixes executable, version, arguments and launch environment', () => {
  const spec = windowsDesktopLaunchSpec('stdio','C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe');
  assert.equal(spec.executable, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe');
  assert.deepEqual(spec.args, ['app-server', '--stdio']);
  assert.equal(spec.env.PATH, 'C:\\Windows\\System32;C:\\Windows');
  assert.equal(desktopVersionMatches('codex-cli 0.165.0-alpha.1.2\n'), true);
  assert.equal(desktopVersionMatches('codex-cli 0.164.0-alpha.11.1\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.163.0-alpha.11.1\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.163.0-alpha.11\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.163.0-alpha.10.2\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.162.0-alpha.17.2\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.162.0-alpha.2\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.160.1\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.159.2\n'), false);
  assert.equal(desktopVersionMatches('codex-cli 0.158.0-alpha.2.1\n'), false);
});

test('Windows desktop rejects old and mismatched versions before opening App Server', async () => {
  for (const stdout of ['codex-cli 0.164.0-alpha.11.1\n', 'codex-cli 0.163.0-alpha.11.1\n', 'codex-cli 0.159.0-alpha.12.1\n', 'codex-cli 0.158.0-alpha.2.1\n', 'codex-cli 0.159.1\n', 'codex-cli 0.159.2\n']) {
    let opens = 0;
    await assert.rejects(preflightWindowsDesktop({
      version: () => ({ status: 0, stdout }),
      open: () => { opens += 1; throw new Error('APP_SERVER_OPENED'); },
    }), /WINDOWS_READINESS_FAILED/);
    assert.equal(opens, 0);
  }
});

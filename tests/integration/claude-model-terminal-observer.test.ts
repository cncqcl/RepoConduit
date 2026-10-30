import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import { claudeModelCommandDigest, claudeModelSupervisorSpec,
  parseClaudeModelSupervisorOutput, type ClaudeModelSupervisorDescriptor,
  type ClaudeModelSupervisorState } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import type { ClaudeModelRunningObservation } from
  '../../src/adapters/secondary-investigator/claude-model-running-observer.js';
import { observeClaudeModelTerminal } from
  '../../src/adapters/secondary-investigator/claude-model-terminal-observer.js';
const profile = { allowedDomains: [] };

const attemptId = `attempt_${randomUUID()}`;
const workspaceId = `ws_${randomUUID()}`;
const unitName = `rcac-investigator-${randomUUID()}.service`;
const bootId = randomUUID();
const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`;
const descriptor: ClaudeModelSupervisorDescriptor = { attemptId, workspaceId, unitName, bootId,
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000, launchWorkerEpoch: 1,
  sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), commandDigest: 'c'.repeat(64) };
const resource: WslResource = { unitName, bootId, distro: descriptor.distro, uid: 1000,
  invocationId: 'f'.repeat(32), controlGroup: group,
  gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture', root: '/home/fixture/model-gate',
    payloadKind: 'claude_model_v1', launch: { action: 'claude_model_v1', workerEpoch: 1,
      sourceDigest: descriptor.sourceDigest, profileDigest: descriptor.profileDigest,
      commandDigest: descriptor.commandDigest } } };
const journal: ClaudeModelSupervisorState = { protocol: 'claude_model_v1', action: 'claude_model_v1',
  phase: 'entered', closed: true, attemptId, workspaceId, unitName, bootId, uid: 1000,
  launchWorkerEpoch: 1, sourceDigest: descriptor.sourceDigest,
  profileDigest: descriptor.profileDigest, commandDigest: descriptor.commandDigest,
  invocationId: resource.invocationId!, controlGroup: group, enterPid: 123, enterStartTicks: 456 };
const loaded = { bootId, uid: 1000, unitName, invocationId: resource.invocationId!, controlGroup: '',
  loadState: 'loaded', activeState: 'failed', subState: 'failed', mainPid: 0,
  originalPid: 123, originalStartTicks: 456, processState: 'absent', cgroupState: 'empty' };
const unloaded = { ...loaded, invocationId: '', loadState: 'not-found',
  activeState: 'inactive', subState: 'dead', cgroupState: 'absent' };
const response = (native: object) => ({ exitCode: 0, stdout: JSON.stringify(native) + '\n', stderr: '' });
const runningFact: ClaudeModelRunningObservation = { kind: 'claude_model_running', resource,
  journal: { ...journal, phase: 'entered', closed: false }, native: {
    bootId, uid: 1000, unitName, invocationId: resource.invocationId!, controlGroup: group,
    loadState: 'loaded', activeState: 'active', subState: 'running',
    mainPid: 123, startTicks: 456, procControlGroup: group } };

test('model terminal accepts only closed exact unit and bounded native terminal state', async () => {
  for (const native of [loaded, unloaded]) {
    const observed = await observeClaudeModelTerminal(resource, journal, descriptor,
      null, async () => response(native));
    assert.equal(observed.kind, 'model_unit_terminal');
    if (observed.kind === 'model_unit_terminal') assert.deepEqual(observed.native, native);
  }
  let calls = 0;
  const runner = async () => { calls++; return response(loaded); };
  for (const changed of [
    { ...journal, closed: false }, { ...journal, phase: 'prepared' as const },
    { ...journal, sourceDigest: 'd'.repeat(64) }, { ...journal, commandDigest: 'd'.repeat(64) },
  ]) assert.deepEqual(await observeClaudeModelTerminal(resource, changed, descriptor, null, runner),
    { kind: 'unconfirmed' });
  assert.equal(calls, 0);
});

test('consumed model terminal requires exact historical entered running fact', async () => {
  const consumed = { ...journal, phase: 'consumed' as const };
  assert.deepEqual(await observeClaudeModelTerminal(resource, consumed, descriptor,
    null, async () => response(unloaded)), { kind: 'unconfirmed' });
  assert.deepEqual(await observeClaudeModelTerminal(resource, consumed, descriptor,
    { ...runningFact, native: { ...runningFact.native!, startTicks: 457 } } as ClaudeModelRunningObservation,
    async () => response(unloaded)), { kind: 'unconfirmed' });
  assert.equal((await observeClaudeModelTerminal(resource, consumed, descriptor,
    runningFact, async () => response(unloaded))).kind, 'model_unit_terminal');
  assert.deepEqual(await observeClaudeModelTerminal(resource, journal, descriptor,
    { ...runningFact, native: { ...runningFact.native!, startTicks: 457 } } as ClaudeModelRunningObservation,
    async () => response(loaded)), { kind: 'unconfirmed' });
});

test('model terminal rejects changed boot, invocation, PID reuse and populated group doubles', async () => {
  for (const changed of [
    { ...loaded, bootId: randomUUID() }, { ...loaded, invocationId: 'e'.repeat(32) },
    { ...loaded, originalPid: 124 }, { ...loaded, originalStartTicks: 457 },
    { ...loaded, processState: 'reused' }, { ...loaded, cgroupState: 'populated' },
    { ...unloaded, invocationId: resource.invocationId },
  ]) assert.deepEqual(await observeClaudeModelTerminal(resource, journal, descriptor,
    null, async () => response(changed)), { kind: 'unconfirmed' });
  assert.deepEqual(await observeClaudeModelTerminal(resource, journal, descriptor,
    null, async () => ({ ...response(loaded), exitCode: 1 })), { kind: 'unconfirmed' });
});

test('real WSL closed waiting model unit is observed terminal without release or prompt',
  { timeout: 25000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: readonly string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    const id = `attempt_${randomUUID()}`;
    const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
      srtSettingsFile: '/home/fixture/settings/srt.json', mcpConfigFile: '/home/fixture/settings/mcp.json',
      helperFile: '/home/fixture/settings/mcp-fifo.py',
      privateFifoDirectory: `/home/fixture/private/${id}-1.mcp`, privateAuthHome: '/home/fixture/auth' };
    const live: ClaudeModelSupervisorDescriptor = { ...descriptor, attemptId: id,
      workspaceId: `ws_${randomUUID()}`, unitName: `rcac-investigator-${randomUUID()}.service`,
      uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
      commandDigest: claudeModelCommandDigest(paths, profile, 3) };
    const root = `/home/fixture/model-terminal-${id}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const call = (op: 'prepare' | 'status' | 'close') => {
      const spec = claudeModelSupervisorSpec(op, live, root);
      return spawnSync(spec.executable, [...spec.args],
        { env: spec.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    };
    let child: ReturnType<typeof spawn> | undefined; let bridgeClosed = false; let safeCleanup = false;
    try {
      assert.equal(call('prepare').status, 0);
      const spec = claudeModelSupervisorSpec('enter_wait_exec', live, root, paths,
        undefined, { maxWallSeconds: 12, maxTurns: 3 }, profile);
      child = spawn(spec.executable, [...spec.args], { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin!.write(spec.startupInput);
      const exit = new Promise<void>(resolve => child!.once('close', () => { bridgeClosed = true; resolve(); }));
      let entered: ClaudeModelSupervisorState | null = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = call('status');
        entered = status.status === 0 ? parseClaudeModelSupervisorOutput(status.stdout, live) : null;
        if (entered?.phase === 'entered') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(entered?.phase, 'entered');
      assert.equal(call('close').status, 0);
      await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(
        new Error('unit bridge close timeout')), 4000))]);
      assert.equal(run(['/usr/bin/systemctl', '--user', 'stop', live.unitName]).status, 0);
      const closed = parseClaudeModelSupervisorOutput(call('status').stdout, live);
      assert.equal(closed?.closed, true);
      const liveResource: WslResource = { unitName: live.unitName, distro: live.distro,
        uid: live.uid, bootId: live.bootId, invocationId: entered.invocationId!,
        controlGroup: entered.controlGroup!, gate: { protocol: 'attempt_gate_v1',
          linuxUser: live.linuxUser, root, payloadKind: 'claude_model_v1',
          launch: { workerEpoch: 1, sourceDigest: live.sourceDigest,
            profileDigest: live.profileDigest, commandDigest: live.commandDigest,
            action: 'claude_model_v1' } } };
      const observed = await observeClaudeModelTerminal(liveResource, closed!, live);
      assert.equal(observed.kind, 'model_unit_terminal');
      safeCleanup = true;
    } finally {
      if (child && !bridgeClosed) {
        child.kill();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1500);
          child!.once('close', () => { bridgeClosed = true; clearTimeout(timer); resolve(); });
        });
      }
      if (safeCleanup) {
        assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.json`]).status, 0);
        assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.lock`]).status, 0);
        assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
      }
    }
  });

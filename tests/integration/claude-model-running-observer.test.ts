import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import { claudeModelCommandDigest, claudeModelSupervisorSpec,
  parseClaudeModelSupervisorOutput, type ClaudeModelSupervisorDescriptor,
  type ClaudeModelSupervisorState } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { claudeModelRunningSpec, observeClaudeModelRunning } from
  '../../src/adapters/secondary-investigator/claude-model-running-observer.js';
const profile = { allowedDomains: [] };

const attemptId = `attempt_${randomUUID()}`;
const workspaceId = `ws_${randomUUID()}`;
const unitName = `rcac-investigator-${randomUUID()}.service`;
const bootId = randomUUID();
const invocationId = 'f'.repeat(32);
const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`;
const descriptor: ClaudeModelSupervisorDescriptor = { attemptId, workspaceId,
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000, bootId, unitName,
  launchWorkerEpoch: 1, sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
  commandDigest: 'c'.repeat(64) };
const journal: ClaudeModelSupervisorState = { protocol: 'claude_model_v1', action: 'claude_model_v1',
  phase: 'entered', closed: false, attemptId, workspaceId, bootId, uid: 1000, unitName,
  launchWorkerEpoch: 1, sourceDigest: descriptor.sourceDigest,
  profileDigest: descriptor.profileDigest, commandDigest: descriptor.commandDigest,
  invocationId, controlGroup, enterPid: 123, enterStartTicks: 456 };
const resource: WslResource = { unitName, distro: descriptor.distro, uid: 1000, bootId,
  invocationId, controlGroup, gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture',
    root: '/home/fixture/model-gate', payloadKind: 'claude_model_v1',
    launch: { workerEpoch: 1, sourceDigest: descriptor.sourceDigest,
      profileDigest: descriptor.profileDigest, commandDigest: descriptor.commandDigest,
      action: 'claude_model_v1' } } };
const native = { bootId, uid: 1000, unitName, invocationId, controlGroup,
  loadState: 'loaded', activeState: 'active', subState: 'running',
  mainPid: 123, startTicks: 456, procControlGroup: controlGroup };
const output = (value: object) => ({ exitCode: 0, stdout: JSON.stringify(value) + '\n', stderr: '' });

test('fixed model running probe requires exact model binding before native I/O', async () => {
  const spec = claudeModelRunningSpec(resource, journal, descriptor);
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.match(spec.args[11]!, /systemctl/);
  assert.match(spec.args[11]!, /\/proc\//);
  assert.equal(spec.args.includes('/bin/sh'), false);
  let calls = 0;
  const runner = async () => { calls++; return output(native); };
  for (const changed of [
    { ...journal, phase: 'released' as const }, { ...journal, closed: true },
    { ...journal, commandDigest: 'd'.repeat(64) },
    { ...journal, launchWorkerEpoch: 2 }, { ...journal, sourceDigest: 'd'.repeat(64) },
    { ...journal, invocationId: 'e'.repeat(32) },
  ]) assert.deepEqual(await observeClaudeModelRunning(resource, changed, descriptor, runner),
    { kind: 'unconfirmed' });
  for (const changed of [
    { ...resource, gate: { ...resource.gate!, payloadKind: 'native_supervisor_v2' as const } },
    { ...resource, gate: { ...resource.gate!, launch: { ...resource.gate!.launch!,
      action: 'fixed_zero_model_v1' as const } } },
    { ...resource, gate: { ...resource.gate!, launch: { ...resource.gate!.launch!,
      commandDigest: 'd'.repeat(64) } } },
    { ...resource, gate: { ...resource.gate!, extra: true } as never },
  ]) assert.deepEqual(await observeClaudeModelRunning(changed, journal, descriptor, runner),
    { kind: 'unconfirmed' });
  assert.equal(calls, 0);
  assert.deepEqual(await observeClaudeModelRunning(resource, journal, descriptor, runner),
    { kind: 'claude_model_running', resource, journal, native });
  assert.equal(calls, 1);
});

test('model observer rejects widened, stale and mismatched native facts', async () => {
  for (const changed of [
    { ...native, extra: true }, { ...native, bootId: randomUUID() },
    { ...native, uid: 2000 }, { ...native, invocationId: 'e'.repeat(32) },
    { ...native, controlGroup: '/other' }, { ...native, mainPid: 124 },
    { ...native, startTicks: 457 }, { ...native, procControlGroup: '/other' },
    { ...native, subState: 'exited' },
  ]) assert.deepEqual(await observeClaudeModelRunning(resource, journal, descriptor,
    async () => output(changed)), { kind: 'unconfirmed' });
  assert.deepEqual(await observeClaudeModelRunning(resource, journal, descriptor,
    async () => ({ ...output(native), exitCode: 1 })), { kind: 'unconfirmed' });
});

test('pending native probe cannot attach a mutated launch or journal to its earlier result', async () => {
  const mutableResource = structuredClone(resource);
  const mutableJournal = structuredClone(journal);
  const mutableDescriptor = structuredClone(descriptor);
  let release!: (value: ReturnType<typeof output>) => void;
  const pending = observeClaudeModelRunning(mutableResource, mutableJournal, mutableDescriptor,
    async () => new Promise(resolve => { release = resolve; }));
  mutableResource.gate!.launch!.commandDigest = 'd'.repeat(64);
  mutableJournal.commandDigest = 'd'.repeat(64);
  mutableDescriptor.commandDigest = 'd'.repeat(64);
  release(output(native));
  const observed = await pending;
  assert.equal(observed.kind, 'claude_model_running');
  if (observed.kind === 'claude_model_running') {
    assert.equal(observed.resource.gate!.launch!.commandDigest, descriptor.commandDigest);
    assert.equal(observed.journal.commandDigest, descriptor.commandDigest);
  }
});

test('returned model fact has an isolated gate and validates descriptor syntax', async () => {
  let calls = 0;
  const runner = async () => { calls++; return output(native); };
  assert.deepEqual(await observeClaudeModelRunning(resource, journal,
    { ...descriptor, sourceDigest: 'bad' }, runner), { kind: 'unconfirmed' });
  assert.deepEqual(await observeClaudeModelRunning(resource, journal,
    { ...descriptor, extra: true } as never, runner), { kind: 'unconfirmed' });
  assert.equal(calls, 0);
  const mutableResource = structuredClone(resource);
  const observed = await observeClaudeModelRunning(mutableResource, journal, descriptor, runner);
  assert.equal(observed.kind, 'claude_model_running');
  mutableResource.gate!.launch!.commandDigest = 'e'.repeat(64);
  if (observed.kind === 'claude_model_running')
    assert.equal(observed.resource.gate!.launch!.commandDigest, descriptor.commandDigest);
});

test('real WSL waiting model unit yields exact running fact without release or prompt',
  { timeout: 25000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: readonly string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    const liveAttempt = `attempt_${randomUUID()}`;
    const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
      srtSettingsFile: '/home/fixture/settings/srt.json', mcpConfigFile: '/home/fixture/settings/mcp.json',
      helperFile: '/home/fixture/settings/mcp-fifo.py',
      privateFifoDirectory: `/home/fixture/private/${liveAttempt}-1.mcp`, privateAuthHome: '/home/fixture/auth' };
    const live: ClaudeModelSupervisorDescriptor = { ...descriptor,
      attemptId: liveAttempt, workspaceId: `ws_${randomUUID()}`,
      unitName: `rcac-investigator-${randomUUID()}.service`,
      uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
      commandDigest: claudeModelCommandDigest(paths, profile, 3) };
    const root = `/home/fixture/model-observe-${liveAttempt}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const call = (op: 'prepare' | 'status' | 'close') => {
      const spec = claudeModelSupervisorSpec(op, live, root);
      return spawnSync(spec.executable, [...spec.args],
        { env: spec.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    };
    let child: ReturnType<typeof spawn> | undefined;
    let bridgeClosed = false; let safeCleanup = false;
    try {
      assert.equal(call('prepare').status, 0);
      const spec = claudeModelSupervisorSpec('enter_wait_exec', live, root, paths,
        undefined, { maxWallSeconds: 12, maxTurns: 3 }, profile);
      child = spawn(spec.executable, [...spec.args],
        { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin!.write(spec.startupInput);
      const exit = new Promise<number | null>(resolve => child!.once('close', code => {
        bridgeClosed = true; resolve(code);
      }));
      let entered: ClaudeModelSupervisorState | null = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = call('status');
        entered = status.status === 0 ? parseClaudeModelSupervisorOutput(status.stdout, live) : null;
        if (entered?.phase === 'entered') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(entered?.phase, 'entered');
      const liveResource: WslResource = { unitName: live.unitName, distro: live.distro,
        uid: live.uid, bootId: live.bootId, invocationId: entered.invocationId!,
        controlGroup: entered.controlGroup!, gate: { protocol: 'attempt_gate_v1',
          linuxUser: live.linuxUser, root, payloadKind: 'claude_model_v1',
          launch: { workerEpoch: 1, sourceDigest: live.sourceDigest,
            profileDigest: live.profileDigest, commandDigest: live.commandDigest,
            action: 'claude_model_v1' } } };
      const observed = await observeClaudeModelRunning(liveResource, entered, live);
      assert.equal(observed.kind, 'claude_model_running');
      if (observed.kind === 'claude_model_running') {
        assert.equal(observed.native.mainPid, entered.enterPid);
        assert.equal(observed.native.startTicks, entered.enterStartTicks);
      }
      assert.equal(call('close').status, 0);
      await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(
        new Error('unit bridge close timeout')), 4000))]);
      assert.equal(bridgeClosed, true);
      assert.equal(run(['/usr/bin/systemctl', '--user', 'stop', live.unitName]).status, 0);
      const terminal = run(['/usr/bin/python3', '-I', '-S', '-c',
        'import os,sys; pid=int(sys.argv[1]); group=sys.argv[2]; assert not os.path.exists("/proc/%d"%pid); path="/sys/fs/cgroup"+group; assert not os.path.exists(path) or open(path+"/cgroup.events").read().split("populated ")[1][0]=="0"',
        String(entered.enterPid), entered.controlGroup!]);
      assert.equal(terminal.status, 0, terminal.stderr);
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

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { nativeSupervisorGateSpec, parseNativeSupervisorGateOutput,
  type NativeSupervisorGateDescriptor, type NativeSupervisorGateOperation,
  type NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';

const descriptor: NativeSupervisorGateDescriptor = {
  attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000,
  bootId: '33333333-3333-4333-8333-333333333333',
  unitName: 'rcac-investigator-44444444-4444-4444-8444-444444444444.service',
  launchWorkerEpoch: 2, sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
};

test('v2 spec fixes Python command and requires exact binding and release observation', () => {
  const spec = nativeSupervisorGateSpec('prepare', descriptor, '/home/fixture/gates');
  assert.equal(spec.executable.toLowerCase().endsWith('wsl.exe'), true);
  assert.deepEqual(spec.args.slice(0, 11), ['-d', descriptor.distro, '--user', descriptor.linuxUser,
    '--cd', '/', '--exec', '/usr/bin/python3', '-I', '-S', '-c']);
  assert.equal(spec.args.includes('/bin/sh'), false);
  assert.equal(spec.args.includes('claude'), false);
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
  assert.throws(() => nativeSupervisorGateSpec('release', descriptor, '/home/fixture/gates'));
  assert.throws(() => nativeSupervisorGateSpec('prepare', { ...descriptor, launchWorkerEpoch: -1 }, '/home/fixture/gates'));
  assert.throws(() => nativeSupervisorGateSpec('prepare', { ...descriptor, sourceDigest: 'wrong' }, '/home/fixture/gates'));
  assert.throws(() => nativeSupervisorGateSpec('prepare', descriptor, '/mnt/c/gates'));
  assert.throws(() => nativeSupervisorGateSpec('prepare', descriptor, '/home/fixture/../gates'));
  assert.throws(() => nativeSupervisorGateSpec('launch' as never, descriptor, '/home/fixture/gates'));
});

test('v2 parser rejects widened, cross-attempt, epoch and incomplete phase states', () => {
  const base = { protocol: 'native_supervisor_v2', phase: 'prepared', closed: false,
    attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
    bootId: descriptor.bootId, uid: descriptor.uid, unitName: descriptor.unitName,
    launchWorkerEpoch: descriptor.launchWorkerEpoch,
    sourceDigest: descriptor.sourceDigest, profileDigest: descriptor.profileDigest };
  assert.deepEqual(parseNativeSupervisorGateOutput(JSON.stringify(base) + '\n', descriptor), base);
  for (const changed of [{ ...base, extra: true }, { ...base, attemptId: `attempt_${randomUUID()}` },
    { ...base, launchWorkerEpoch: 3 }, { ...base, profileDigest: 'c'.repeat(64) },
    { ...base, phase: 'entered' }, { ...base, phase: 'released' }])
    assert.equal(parseNativeSupervisorGateOutput(JSON.stringify(changed) + '\n', descriptor), null);
});

const liveEnabled = process.env.RCAC_NATIVE_SUPERVISOR_GATE_LIVE === '1';
function fixture() {
  const prefix = ['-d', descriptor.distro, '--user', descriptor.linuxUser, '--cd', '/', '--exec'];
  const run = (args: string[]) => spawnSync('wsl.exe', [...prefix, ...args],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 });
  const uidRun = run(['/usr/bin/id', '-u']);
  const bootRun = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
  assert.equal(uidRun.status, 0, uidRun.stderr);
  assert.equal(bootRun.status, 0, bootRun.stderr);
  const live = { ...descriptor, uid: Number(uidRun.stdout.trim()), bootId: bootRun.stdout.trim(),
    attemptId: `attempt_${randomUUID()}`, unitName: `rcac-investigator-${randomUUID()}.service` };
  const root = `/home/${live.linuxUser}/.local/state/rcac/supervisor-${live.attemptId}`;
  assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
  const call = (op: NativeSupervisorGateOperation,
    observed?: { invocationId: string; controlGroup: string },
    binding: NativeSupervisorGateDescriptor = live) => {
    const spec = nativeSupervisorGateSpec(op, binding, root, observed);
    return spawnSync(spec.executable, spec.args,
      { env: spec.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 });
  };
  const status = () => parseNativeSupervisorGateOutput(call('status').stdout, live);
  const statusV2 = (): NativeSupervisorGateState => {
    const state = status();
    assert.equal(state?.protocol, 'native_supervisor_v2');
    return state as NativeSupervisorGateState;
  };
  const cleanup = () => {
    for (const suffix of ['.supervisor.canary', '.supervisor.json', '.supervisor.lock'])
      run(['/usr/bin/unlink', `${root}/${live.attemptId}${suffix}`]);
    run(['/usr/bin/rmdir', root]);
  };
  return { prefix, run, live, root, call, status, statusV2, cleanup };
}

async function awaitPhase(status: () => ReturnType<typeof parseNativeSupervisorGateOutput>,
  phase: string, deadlineMs = 4000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = status();
    if (state?.protocol === 'native_supervisor_v2' && state.phase === phase) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`phase ${phase} not observed`);
}

function startUnit(f: ReturnType<typeof fixture>) {
  const enter = nativeSupervisorGateSpec('enter', f.live, f.root);
  const child = spawn('wsl.exe', [...f.prefix, '/usr/bin/systemd-run', '--user', '--wait', '--collect',
    '--unit', f.live.unitName, '--property=RuntimeMaxSec=12s', '--',
    '/usr/bin/python3', ...enter.args.slice(8)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', part => { stderr += String(part); });
  const exited = new Promise<{ code: number | null; stderr: string }>(resolve =>
    child.on('close', code => resolve({ code, stderr })));
  return { child, exited };
}

test('real WSL unit enters, host releases exact identity, and original enter consumes once',
  { skip: !liveEnabled }, async () => {
    const f = fixture();
    let unit: ReturnType<typeof startUnit> | undefined;
    try {
      assert.equal(f.call('prepare').status, 0);
      unit = startUnit(f);
      const entered = await awaitPhase(f.status, 'entered');
      assert.equal(entered.closed, false);
      const observed = { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! };
      assert.notEqual(f.call('release', observed, { ...f.live, launchWorkerEpoch: 3 }).status, 0);
      assert.notEqual(f.call('release', observed, { ...f.live, sourceDigest: 'c'.repeat(64) }).status, 0);
      assert.notEqual(f.call('release', { ...observed, invocationId: 'f'.repeat(32) }).status, 0);
      assert.equal(f.statusV2().phase, 'entered');
      assert.equal(f.call('release', observed).status, 0);
      const replay = f.call('release', observed);
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(parseNativeSupervisorGateOutput(replay.stdout, f.live)?.protocol, 'native_supervisor_v2');
      const ended = await unit.exited;
      assert.equal(ended.code, 0, ended.stderr);
      assert.equal(f.statusV2().phase, 'consumed');
      assert.equal(f.run(['/usr/bin/test', '-f', `${f.root}/${f.live.attemptId}.supervisor.canary`]).status, 0);
      assert.equal(f.call('close').status, 0);
      assert.equal(f.statusV2().closed, true);
      assert.notEqual(f.call('release', observed).status, 0);
    } finally { unit?.child.kill(); f.cleanup(); }
  });

test('real WSL close before release wins and leaves no fixed action',
  { skip: !liveEnabled }, async () => {
    const f = fixture();
    let unit: ReturnType<typeof startUnit> | undefined;
    try {
      assert.equal(f.call('prepare').status, 0);
      unit = startUnit(f);
      const entered = await awaitPhase(f.status, 'entered');
      const observed = { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! };
      assert.equal(f.call('close').status, 0);
      assert.notEqual(f.call('release', observed).status, 0);
      assert.notEqual((await unit.exited).code, 0);
      assert.equal(f.statusV2().closed, true);
      assert.equal(f.run(['/usr/bin/test', '-e', `${f.root}/${f.live.attemptId}.supervisor.canary`]).status, 1);
    } finally { unit?.child.kill(); f.cleanup(); }
  });

test('real WSL close after host release but before original consume wins',
  { skip: !liveEnabled }, async () => {
    const f = fixture();
    let unit: ReturnType<typeof startUnit> | undefined;
    let pausedPid: number | undefined;
    try {
      assert.equal(f.call('prepare').status, 0);
      unit = startUnit(f);
      const entered = await awaitPhase(f.status, 'entered');
      pausedPid = entered.enterPid;
      assert.equal(f.run(['/usr/bin/kill', '-STOP', String(pausedPid)]).status, 0);
      const observed = { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! };
      assert.equal(f.call('release', observed).status, 0);
      assert.equal(f.statusV2().phase, 'released');
      assert.equal(f.call('close').status, 0);
      assert.equal(f.run(['/usr/bin/kill', '-CONT', String(pausedPid)]).status, 0);
      pausedPid = undefined;
      assert.notEqual((await unit.exited).code, 0);
      assert.equal(f.statusV2().closed, true);
      assert.equal(f.statusV2().phase, 'released');
      assert.equal(f.run(['/usr/bin/test', '-e', `${f.root}/${f.live.attemptId}.supervisor.canary`]).status, 1);
    } finally {
      if (pausedPid) f.run(['/usr/bin/kill', '-CONT', String(pausedPid)]);
      unit?.child.kill(); f.cleanup();
    }
  });

test('real WSL paused original cannot consume release after its monotonic deadline',
  { skip: !liveEnabled }, async () => {
    const f = fixture();
    let unit: ReturnType<typeof startUnit> | undefined;
    let pausedPid: number | undefined;
    try {
      assert.equal(f.call('prepare').status, 0);
      unit = startUnit(f);
      const entered = await awaitPhase(f.status, 'entered');
      pausedPid = entered.enterPid;
      assert.equal(f.run(['/usr/bin/kill', '-STOP', String(pausedPid)]).status, 0);
      await new Promise(resolve => setTimeout(resolve, 6500));
      const observed = { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! };
      assert.equal(f.call('release', observed).status, 0);
      assert.equal(f.run(['/usr/bin/kill', '-CONT', String(pausedPid)]).status, 0);
      pausedPid = undefined;
      assert.notEqual((await unit.exited).code, 0);
      assert.equal(f.statusV2().closed, true);
      assert.equal(f.run(['/usr/bin/test', '-e', `${f.root}/${f.live.attemptId}.supervisor.canary`]).status, 1);
    } finally {
      if (pausedPid) f.run(['/usr/bin/kill', '-CONT', String(pausedPid)]);
      unit?.child.kill(); f.cleanup();
    }
  });

test('real WSL enter timeout closes journal and never permits late release',
  { skip: !liveEnabled }, async () => {
    const f = fixture();
    let unit: ReturnType<typeof startUnit> | undefined;
    try {
      assert.equal(f.call('prepare').status, 0);
      unit = startUnit(f);
      const entered = await awaitPhase(f.status, 'entered');
      const observed = { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! };
      assert.notEqual((await unit.exited).code, 0);
      assert.equal(f.statusV2().closed, true);
      assert.notEqual(f.call('release', observed).status, 0);
      assert.equal(f.run(['/usr/bin/test', '-e', `${f.root}/${f.live.attemptId}.supervisor.canary`]).status, 1);
    } finally { unit?.child.kill(); f.cleanup(); }
  });

test('real WSL stopped original unit cannot receive a late host release',
  { skip: !liveEnabled }, async () => {
    const f = fixture();
    let unit: ReturnType<typeof startUnit> | undefined;
    try {
      assert.equal(f.call('prepare').status, 0);
      unit = startUnit(f);
      const entered = await awaitPhase(f.status, 'entered');
      const observed = { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! };
      assert.equal(f.run(['/usr/bin/systemctl', '--user', 'stop', f.live.unitName]).status, 0);
      await unit.exited;
      assert.notEqual(f.call('release', observed).status, 0);
      assert.equal(f.statusV2().phase, 'entered');
      assert.equal(f.call('close').status, 0);
      assert.equal(f.statusV2().closed, true);
      assert.equal(f.run(['/usr/bin/test', '-e', `${f.root}/${f.live.attemptId}.supervisor.canary`]).status, 1);
    } finally { unit?.child.kill(); f.cleanup(); }
  });

test('real WSL journal refuses symlink root and group-readable gate root',
  { skip: !liveEnabled }, () => {
    const f = fixture();
    const link = `${f.root}-link`;
    try {
      assert.equal(f.run(['/usr/bin/ln', '-s', f.root, link]).status, 0);
      const linked = nativeSupervisorGateSpec('prepare', f.live, link);
      assert.notEqual(spawnSync(linked.executable, linked.args,
        { env: linked.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 }).status, 0);
      assert.equal(f.run(['/usr/bin/unlink', link]).status, 0);
      assert.equal(f.run(['/usr/bin/chmod', '750', f.root]).status, 0);
      assert.notEqual(f.call('prepare').status, 0);
      assert.equal(f.run(['/usr/bin/chmod', '700', f.root]).status, 0);
      assert.equal(f.call('close').status, 0);
      assert.equal(f.statusV2().closed, true);
    } finally {
      f.run(['/usr/bin/unlink', link]);
      f.run(['/usr/bin/chmod', '700', f.root]);
      f.cleanup();
    }
  });

test('real WSL legacy v1 record is readable and close-only',
  { skip: !liveEnabled }, () => {
    const f = fixture();
    try {
      const legacy = { protocol: 'native_supervisor_v1', kind: 'open',
        attemptId: f.live.attemptId, workspaceId: f.live.workspaceId, bootId: f.live.bootId,
        uid: f.live.uid, unitName: f.live.unitName };
      assert.equal(f.run(['/usr/bin/python3', '-c',
        'import os,sys; a=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(a,sys.argv[3].encode()); os.fsync(a); os.close(a); b=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.fsync(b); os.close(b)',
        `${f.root}/${f.live.attemptId}.supervisor.json`,
        `${f.root}/${f.live.attemptId}.supervisor.lock`, JSON.stringify(legacy) + '\n']).status, 0);
      assert.equal(f.status()?.protocol, 'native_supervisor_v1');
      assert.notEqual(f.call('prepare').status, 0);
      assert.notEqual(f.call('enter').status, 0);
      assert.equal(f.call('close').status, 0);
      assert.equal(f.status()?.protocol, 'native_supervisor_v1');
      assert.notEqual(f.call('release', { invocationId: 'a'.repeat(32),
        controlGroup: `/user.slice/user-${f.live.uid}.slice/user@${f.live.uid}.service/app.slice/${f.live.unitName}` }).status, 0);
    } finally { f.cleanup(); }
  });

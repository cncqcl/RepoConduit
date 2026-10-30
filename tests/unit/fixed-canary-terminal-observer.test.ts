import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { observeFixedCanaryTerminal } from '../../src/adapters/codex/investigator/fixed-canary-terminal-observer.js';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';

const unitName = 'rcac-investigator-11111111-1111-4111-8111-111111111111.service';
const resource: WslResource = {
  distro: 'Ubuntu-22.04', uid: 1000, bootId: '489e4ff0-c995-44d1-829f-2f23c3c2daa8',
  unitName, invocationId: 'f3f4939908f042f9bfbd804103a376f6',
  controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`,
  gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture', root: '/home/fixture/.local/state/rcac/gate',
    payloadKind: 'canary_v1' },
};
const native = { bootId: resource.bootId, uid: resource.uid, unitName,
  invocationId: resource.invocationId, controlGroup: '', loadState: 'loaded',
  activeState: 'active', subState: 'exited', mainPid: 0, cgroupState: 'absent' };
const respond = (value: unknown) => async () => ({ exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });

test('fixed canary terminal accepts retained successful identity with empty saved cgroup', async () => {
  const result = await observeFixedCanaryTerminal(resource, respond(native));
  assert.equal(result.kind, 'fixed_canary_terminal');
  if (result.kind === 'fixed_canary_terminal') assert.deepEqual(result.resource, resource);
  assert.equal((await observeFixedCanaryTerminal(resource, respond({ ...native,
    activeState: 'failed', subState: 'failed', cgroupState: 'empty' }))).kind,
  'fixed_canary_terminal');
});

test('fixed canary terminal rejects changed identity, live process and ambiguous unit', async () => {
  const changes = [
    { bootId: '00000000-0000-4000-8000-000000000000' }, { uid: 1001 },
    { unitName: 'other.service' }, { invocationId: 'a'.repeat(32) },
    { activeState: 'active', subState: 'running' }, { mainPid: 12 },
    { cgroupState: 'populated' }, { cgroupState: ['empty'] }, { loadState: 'not-found' },
    { activeState: 'inactive', subState: 'dead', invocationId: '' },
  ];
  for (const change of changes) {
    const result = await observeFixedCanaryTerminal(resource, respond({ ...native, ...change }));
    assert.equal(result.kind, 'unconfirmed', JSON.stringify(change));
  }
});

test('fixed canary terminal refuses non-canary resource and native probe failure', async () => {
  const notCanary: WslResource = { distro: resource.distro, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    invocationId: resource.invocationId, controlGroup: resource.controlGroup };
  assert.equal((await observeFixedCanaryTerminal(notCanary, async () => {
    throw new Error('runner must not be reached');
  })).kind, 'unconfirmed');
  assert.equal((await observeFixedCanaryTerminal(resource,
    async () => ({ exitCode: 1, stdout: `${JSON.stringify(native)}\n`, stderr: '' }))).kind,
  'unconfirmed');
});

test('real retained fixed unit exposes matching terminal identity',
  { skip: process.env.RCAC_WSL_FIXED_CANARY_TERMINAL_LIVE !== '1' }, async () => {
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe', [...prefix, ...args],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 });
    const nonce = randomUUID();
    const name = `rcac-investigator-${nonce}.service`;
    const description = `rcac-fixed-canary-${nonce}`;
    const show = () => run(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
      '--property=Id,LoadState,ActiveState,InvocationID,Description', name]);
    assert.match(show().stdout, /LoadState=not-found/);
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    assert.equal(uid.status, 0);
    assert.equal(boot.status, 0);
    let ownedInvocation = '';
    try {
      const started = run(['/usr/bin/systemd-run', '--user', '--remain-after-exit',
        '--unit', name, '--description', description,
        '--property=RuntimeMaxSec=10s', '--', '/usr/bin/true']);
      assert.equal(started.status, 0, started.stderr);
      const state = show();
      assert.equal(state.status, 0);
      assert.match(state.stdout, new RegExp(`^Description=${description}$`, 'm'));
      ownedInvocation = state.stdout.match(/^InvocationID=([0-9a-f]{32})$/m)?.[1] ?? '';
      assert.match(ownedInvocation, /^[0-9a-f]{32}$/);
      const live: WslResource = { ...resource, distro: 'Ubuntu-22.04', uid: Number(uid.stdout.trim()),
        bootId: boot.stdout.trim(), unitName: name, invocationId: ownedInvocation,
        controlGroup: `/user.slice/user-${uid.stdout.trim()}.slice/user@${uid.stdout.trim()}.service/app.slice/${name}` };
      const deadline = Date.now() + 5000;
      let observed: Awaited<ReturnType<typeof observeFixedCanaryTerminal>> | undefined;
      do {
        const current = show();
        assert.match(current.stdout, new RegExp(`^InvocationID=${ownedInvocation}$`, 'm'));
        observed = await observeFixedCanaryTerminal(live);
        if (observed.kind === 'fixed_canary_terminal') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.equal(observed?.kind, 'fixed_canary_terminal');
    } finally {
      const current = show();
      if (current.stdout.includes('LoadState=loaded')) {
        assert.match(current.stdout, new RegExp(`^Id=${name.replace('.', '\\.')}$`, 'm'));
        assert.match(current.stdout, new RegExp(`^Description=${description}$`, 'm'));
        if (ownedInvocation)
          assert.match(current.stdout, new RegExp(`^InvocationID=${ownedInvocation}$`, 'm'));
        assert.equal(run(['/usr/bin/systemctl', '--user', 'stop', name]).status, 0);
      }
      assert.match(show().stdout, /LoadState=not-found/);
    }
  });

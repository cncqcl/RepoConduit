import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  parseWslLaunchGateOutput, wslLaunchGateSpec,
  type WslLaunchGateDescriptor,
} from '../../src/adapters/codex/investigator/launch-gate.js';

const descriptor: WslLaunchGateDescriptor = {
  attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  distro: 'Ubuntu', linuxUser: 'rcac_test', uid: 1001,
  bootId: '33333333-3333-4333-8333-333333333333',
  unitName: 'rcac-investigator-44444444-4444-4444-8444-444444444444.service',
};

test('launch gate spec fixes executable and rejects untrusted descriptors', () => {
  const spec = wslLaunchGateSpec('prepare', descriptor, '/home/rcac_test/.local/state/rcac/gates');
  assert.equal(spec.executable.toLowerCase().endsWith('wsl.exe'), true);
  assert.deepEqual(spec.args.slice(0, 8), ['-d', 'Ubuntu', '--user', 'rcac_test', '--cd', '/', '--exec', '/usr/bin/python3']);
  assert.equal(spec.args.includes('/bin/sh'), false);
  assert.throws(() => wslLaunchGateSpec('enter', { ...descriptor, unitName: 'other.service' }, '/home/rcac_test/gates'));
  assert.throws(() => wslLaunchGateSpec('enter', { ...descriptor, attemptId: 'wrong' }, '/home/rcac_test/gates'));
  assert.throws(() => wslLaunchGateSpec('prepare', descriptor, '/mnt/c/gates'));
  assert.throws(() => wslLaunchGateSpec('prepare', descriptor, '/home/../tmp/gates'));
  assert.equal(wslLaunchGateSpec('status', descriptor, '/home/rcac_test/gates').args.includes('status'), true);
});

test('launch gate output accepts only exact identity and bounded closed or consumed states', () => {
  const state = { kind: 'closed_unconsumed', attemptId: descriptor.attemptId,
    workspaceId: descriptor.workspaceId, bootId: descriptor.bootId, uid: descriptor.uid,
    unitName: descriptor.unitName };
  assert.deepEqual(parseWslLaunchGateOutput(JSON.stringify(state) + '\n', descriptor), state);
  assert.equal(parseWslLaunchGateOutput(JSON.stringify({ ...state, uid: 0 }) + '\n', descriptor), null);
  assert.equal(parseWslLaunchGateOutput(JSON.stringify({ ...state, extra: 1 }) + '\n', descriptor), null);
  assert.equal(parseWslLaunchGateOutput('x'.repeat(4097), descriptor), null);
  assert.equal(parseWslLaunchGateOutput('{', descriptor), null);
});

test('real WSL gate keeps close-before-prepare tombstone across processes',
  { skip: process.env.RCAC_WSL_GATE_LIVE !== '1' }, () => {
    const distro = 'Ubuntu-22.04';
    const linuxUser = 'fixture';
    const prefix = ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec'];
    const run = (args: string[]) => spawnSync('wsl.exe', [...prefix, ...args],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uidRun = run(['/usr/bin/id', '-u']);
    const bootRun = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    assert.equal(uidRun.status, 0);
    assert.equal(bootRun.status, 0);
    const attemptId = `attempt_${randomUUID()}`;
    const live: WslLaunchGateDescriptor = { ...descriptor, distro, linuxUser,
      uid: Number(uidRun.stdout.trim()), bootId: bootRun.stdout.trim(), attemptId,
      unitName: `rcac-investigator-${randomUUID()}.service` };
    const root = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const execute = (op: 'prepare' | 'enter' | 'close' | 'status') => {
      const spec = wslLaunchGateSpec(op, live, root);
      return spawnSync(spec.executable, spec.args, { env: spec.env, encoding: 'utf8',
        timeout: 8000, maxBuffer: 8192 });
    };
    const closed = execute('close');
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(parseWslLaunchGateOutput(closed.stdout, live)?.kind, 'closed_unconsumed');
    const latePrepare = execute('prepare');
    assert.equal(latePrepare.error, undefined);
    assert.equal(latePrepare.signal, null);
    assert.equal(latePrepare.status, 1);
    assert.match(latePrepare.stderr, /ValueError: gate closed or consumed/);
    const lateEnter = execute('enter');
    assert.equal(lateEnter.error, undefined);
    assert.equal(lateEnter.signal, null);
    assert.equal(lateEnter.status, 1);
    assert.match(lateEnter.stderr, /ValueError: gate not open/);
    assert.equal(run(['/usr/bin/test', '-e', `${root}/${attemptId}.canary`]).status, 1);
    assert.equal(parseWslLaunchGateOutput(execute('close').stdout, live)?.kind, 'closed_unconsumed');
    // Remove only the exact files created by this test, then the empty fixture.
    assert.equal(run(['/usr/bin/unlink', `${root}/${attemptId}.json`]).status, 0);
    assert.equal(run(['/usr/bin/unlink', `${root}/${attemptId}.lock`]).status, 0);
    assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
  });

test('real systemd unit consumes gate once before fixed canary',
  { skip: process.env.RCAC_WSL_GATE_LIVE !== '1' }, () => {
    const distro = 'Ubuntu-22.04';
    const linuxUser = 'fixture';
    const prefix = ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec'];
    const run = (args: string[]) => spawnSync('wsl.exe', [...prefix, ...args],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
    const uid = Number(run(['/usr/bin/id', '-u']).stdout.trim());
    const bootId = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']).stdout.trim();
    const attemptId = `attempt_${randomUUID()}`;
    const live: WslLaunchGateDescriptor = { ...descriptor, distro, linuxUser, uid, bootId, attemptId,
      unitName: `rcac-investigator-${randomUUID()}.service` };
    const root = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const call = (op: 'prepare' | 'close') => {
      const spec = wslLaunchGateSpec(op, live, root);
      return spawnSync(spec.executable, spec.args, { env: spec.env, encoding: 'utf8',
        timeout: 10000, maxBuffer: 8192 });
    };
    assert.equal(call('prepare').status, 0);
    const enter = wslLaunchGateSpec('enter', live, root);
    const native = run(['/usr/bin/systemd-run', '--user', '--wait', '--collect', '--unit', live.unitName,
      '--property=RuntimeMaxSec=10s', '--', '/usr/bin/python3', ...enter.args.slice(8)]);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(run(['/usr/bin/test', '-f', `${root}/${attemptId}.canary`]).status, 0);
    const closed = call('close');
    assert.equal(closed.status, 0, closed.stderr);
    const state = parseWslLaunchGateOutput(closed.stdout, live);
    assert.equal(state?.kind, 'closed_consumed');
    assert.match(state?.invocationId ?? '', /^[0-9a-f]{32}$/);
    const repeated = call('prepare');
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /ValueError: gate closed or consumed/);
    for (const suffix of ['.canary', '.json', '.lock'])
      assert.equal(run(['/usr/bin/unlink', `${root}/${attemptId}${suffix}`]).status, 0);
    assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
  });

test('two native enter processes in one tracked unit cannot both consume',
  { skip: process.env.RCAC_WSL_GATE_LIVE !== '1' }, () => {
    const distro = 'Ubuntu-22.04';
    const linuxUser = 'fixture';
    const prefix = ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec'];
    const run = (args: string[]) => spawnSync('wsl.exe', [...prefix, ...args],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
    const uid = Number(run(['/usr/bin/id', '-u']).stdout.trim());
    const bootId = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']).stdout.trim();
    const attemptId = `attempt_${randomUUID()}`;
    const live: WslLaunchGateDescriptor = { ...descriptor, distro, linuxUser, uid, bootId, attemptId,
      unitName: `rcac-investigator-${randomUUID()}.service` };
    const root = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const call = (op: 'prepare' | 'close') => {
      const spec = wslLaunchGateSpec(op, live, root);
      return spawnSync(spec.executable, spec.args, { env: spec.env, encoding: 'utf8',
        timeout: 10000, maxBuffer: 8192 });
    };
    assert.equal(call('prepare').status, 0);
    const enter = wslLaunchGateSpec('enter', live, root);
    const race = String.raw`import json,subprocess,sys
args=['/usr/bin/python3']+sys.argv[1:]
a=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
b=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def observe(p):
    out,err=p.communicate(timeout=4)
    return p.returncode,out,err
results=[observe(p) for p in (a,b)]
success=[(out,err) for code,out,err in results if code==0]
denied=[(out,err) for code,out,err in results if code==1]
valid=len(success)==1 and len(denied)==1 and not success[0][1] and json.loads(success[0][0])['kind']=='consumed' and b'ValueError: gate not open' in denied[0][1] and not denied[0][0]
sys.exit(0 if valid else 31)
`;
    const native = run(['/usr/bin/systemd-run', '--user', '--wait', '--collect', '--unit', live.unitName,
      '--property=RuntimeMaxSec=10s', '--', '/usr/bin/python3', '-I', '-S', '-c', race,
      ...enter.args.slice(8)]);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(run(['/usr/bin/test', '-f', `${root}/${attemptId}.canary`]).status, 0);
    const state = parseWslLaunchGateOutput(call('close').stdout, live);
    assert.equal(state?.kind, 'closed_consumed');
    for (const suffix of ['.canary', '.json', '.lock'])
      assert.equal(run(['/usr/bin/unlink', `${root}/${attemptId}${suffix}`]).status, 0);
    assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
  });

test('native canary failure after durable consume cannot reopen or follow a link',
  { skip: process.env.RCAC_WSL_GATE_LIVE !== '1' }, () => {
    const distro = 'Ubuntu-22.04';
    const linuxUser = 'fixture';
    const prefix = ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec'];
    const run = (args: string[]) => spawnSync('wsl.exe', [...prefix, ...args],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
    const uid = Number(run(['/usr/bin/id', '-u']).stdout.trim());
    const bootId = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']).stdout.trim();
    const attemptId = `attempt_${randomUUID()}`;
    const live: WslLaunchGateDescriptor = { ...descriptor, distro, linuxUser, uid, bootId, attemptId,
      unitName: `rcac-investigator-${randomUUID()}.service` };
    const root = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
    const target = `/home/${linuxUser}/.local/state/rcac/target-${attemptId}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    assert.equal(run(['/usr/bin/ln', '-s', target, `${root}/${attemptId}.canary`]).status, 0);
    const call = (op: 'prepare' | 'close') => {
      const spec = wslLaunchGateSpec(op, live, root);
      return spawnSync(spec.executable, spec.args, { env: spec.env, encoding: 'utf8',
        timeout: 10000, maxBuffer: 8192 });
    };
    assert.equal(call('prepare').status, 0);
    const enter = wslLaunchGateSpec('enter', live, root);
    const native = run(['/usr/bin/systemd-run', '--user', '--wait', '--collect', '--unit', live.unitName,
      '--property=RuntimeMaxSec=10s', '--', '/usr/bin/python3', ...enter.args.slice(8)]);
    assert.notEqual(native.status, 0);
    assert.equal(run(['/usr/bin/test', '-e', target]).status, 1);
    const closed = call('close');
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(parseWslLaunchGateOutput(closed.stdout, live)?.kind, 'closed_consumed');
    const denied = call('prepare');
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /ValueError: gate closed or consumed/);
    for (const suffix of ['.canary', '.json', '.lock'])
      assert.equal(run(['/usr/bin/unlink', `${root}/${attemptId}${suffix}`]).status, 0);
    assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
  });

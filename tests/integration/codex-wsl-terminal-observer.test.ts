import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { observeWslTerminal, readWslTerminalProbeChild, wslTerminalObservationSpec } from '../../src/adapters/codex/investigator/terminal-observer.js';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';

const resource = {
  distro: 'Ubuntu-22.04', uid: 1000,
  bootId: '489e4ff0-c995-44d1-829f-2f23c3c2daa8',
  unitName: 'rcac-investigator-11111111-1111-4111-8111-111111111111.service',
  invocationId: 'f3f4939908f042f9bfbd804103a376f6',
  controlGroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/rcac-investigator-11111111-1111-4111-8111-111111111111.service',
};

const native = {
  bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
  invocationId: resource.invocationId, controlGroup: resource.controlGroup,
  loadState: 'loaded', activeState: 'inactive', subState: 'dead', mainPid: 0,
  cgroupState: 'absent',
};

type CleanupCommandResult = { status: number | null; stdout: string; stderr: string };

function cleanupSyntheticUnits(run: (args: string[]) => CleanupCommandResult,
  tracked: string, sibling: string): string[] {
  const errors: string[] = [];
  const call = (label: string, args: string[]): CleanupCommandResult | undefined => {
    try { return run(args); }
    catch { errors.push(`${label}: command failed`); return undefined; }
  };
  const stop = call('stop sibling', ['/usr/bin/systemctl', '--user', 'stop', sibling]);
  const resetSibling = call('reset sibling', ['/usr/bin/systemctl', '--user', 'reset-failed', sibling]);
  const resetTracked = call('reset tracked', ['/usr/bin/systemctl', '--user', 'reset-failed', tracked]);
  const read = (unit: string) => call(`show ${unit}`, ['/usr/bin/systemctl', '--user', 'show', '--no-pager',
    '--property=Id,LoadState,ActiveState,MainPID', unit]);
  const siblingShow = read(sibling);
  const trackedShow = read(tracked);
  const state = (label: string, unit: string, result: CleanupCommandResult | undefined) => {
    if (!result || result.status !== 0) { errors.push(`${label}: state unavailable`); return undefined; }
    const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=', 2)));
    if (fields.Id !== unit || !['loaded', 'not-found'].includes(fields.LoadState ?? '') ||
      !['active', 'inactive', 'failed'].includes(fields.ActiveState ?? '') ||
      !/^\d+$/.test(fields.MainPID ?? '')) { errors.push(`${label}: invalid state`); return undefined; }
    if (fields.ActiveState === 'active' || fields.MainPID !== '0') errors.push(`${label}: still active`);
    return fields;
  };
  const siblingState = state('sibling', sibling, siblingShow);
  const trackedState = state('tracked', tracked, trackedShow);
  if (stop && stop.status !== 0 && siblingState?.LoadState !== 'not-found') errors.push('stop sibling: failed');
  if (resetSibling && resetSibling.status !== 0 && siblingState?.LoadState !== 'not-found')
    errors.push('reset sibling: failed');
  if (resetTracked && resetTracked.status !== 0 && trackedState?.LoadState !== 'not-found')
    errors.push('reset tracked: failed');
  return errors;
}

test('terminal observer pins WSL and a fixed Linux program with data-only arguments', () => {
  const spec = wslTerminalObservationSpec(resource, 'fixture');
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(spec.args.slice(0, 9), ['-d', resource.distro, '--user', 'fixture', '--cd', '/',
    '--exec', '/usr/bin/python3', '-I']);
  assert.equal(spec.args[9], '-S');
  assert.equal(spec.args[10], '-c');
  assert.equal(spec.args.at(-2), resource.unitName);
  assert.equal(spec.args.at(-1), resource.controlGroup);
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
  assert.ok(!spec.args.includes('/bin/sh'));
  assert.match(spec.args[11]!, /cgroup\.controllers/);
  assert.match(spec.args[11]!, /mountinfo/);
});

test('explicit trusted Linux user is required and not inferred from WSL default', async () => {
  for (const user of ['', 'root;id', '../other', '0', 'a'.repeat(65)]) {
    assert.throws(() => wslTerminalObservationSpec(resource, user), /INVALID_ARGUMENT/);
    assert.equal((await observeWslTerminal(resource, user)).kind, 'unconfirmed');
  }
  assert.deepEqual(await observeWslTerminal(resource, ['fixture'] as unknown as string, async () => {
    throw new Error('malformed user reached runner');
  }), { kind: 'unconfirmed', reason: 'invalid_resource' });
  assert.deepEqual(wslTerminalObservationSpec({ ...resource, distro: 'a'.repeat(128), uid: 70000,
    controlGroup: `/user.slice/user-70000.slice/user@70000.service/app.slice/${resource.unitName}` }, 'fixture').args.slice(0, 4),
    ['-d', 'a'.repeat(128), '--user', 'fixture']);
});

test('observer reports only tracked unit terminal identity with absent or empty saved cgroup', async () => {
  for (const cgroupState of ['absent', 'empty'] as const) {
    const result = await observeWslTerminal(resource, 'fixture', async () => ({ exitCode: 0,
      stdout: `${JSON.stringify({ ...native, cgroupState })}\n`, stderr: '' }));
    assert.equal(result.kind, 'unit_terminal');
    if (result.kind === 'unit_terminal') {
      assert.deepEqual(result.resource, resource);
      assert.equal(result.native.cgroupState, cgroupState);
    }
  }
});

test('bounded WSL launcher warning cannot supply identity and does not erase exact stdout', async () => {
  const warning = 'w\0s\0l\0: NAT warning';
  assert.equal((await observeWslTerminal(resource, 'fixture', async () => ({ exitCode: 0,
    stdout: `${JSON.stringify(native)}\n`, stderr: warning }))).kind, 'unit_terminal');
  assert.equal((await observeWslTerminal(resource, 'fixture', async () => ({ exitCode: 0,
    stdout: '{}\n', stderr: warning }))).kind, 'unconfirmed');
});

test('terminal observer refuses identity, unit state and cgroup ambiguity', async () => {
  const mutations = [
    { bootId: '00000000-0000-4000-8000-000000000000' }, { uid: 1001 },
    { unitName: 'other.service' }, { invocationId: 'a'.repeat(32) },
    { controlGroup: '/other.slice/unit.service' }, { loadState: 'not-found' },
    { activeState: 'active', subState: 'running' }, { activeState: 'failed', subState: 'dead' },
    { mainPid: 12 }, { cgroupState: 'populated' }, { cgroupState: 'unknown' },
  ];
  for (const mutation of mutations) {
    const result = await observeWslTerminal(resource, 'fixture', async () => ({ exitCode: 0,
      stdout: `${JSON.stringify({ ...native, ...mutation })}\n`, stderr: '' }));
    assert.equal(result.kind, 'unconfirmed', JSON.stringify(mutation));
  }
  assert.equal((await observeWslTerminal(resource, 'fixture', async () => ({ exitCode: 0,
    stdout: `${JSON.stringify({ ...native, loadState: 'not-found', invocationId: '', controlGroup: '' })}\n`,
    stderr: 'w\0s\0l\0: NAT warning' }))).kind, 'unconfirmed');
});

test('terminal observer refuses malformed input and untrusted process output', async () => {
  for (const mutation of [
    { distro: 'Ubuntu; echo bad' }, { uid: -1 }, { bootId: 'bad' },
    { unitName: '../other.service' }, { invocationId: null },
    { controlGroup: '/user.slice/../other' },
    { distro: ['Ubuntu-22.04'] }, { unitName: [resource.unitName] },
    { bootId: [resource.bootId] }, { controlGroup: [resource.controlGroup] },
  ]) {
    const result = await observeWslTerminal({ ...resource, ...mutation } as unknown as WslResource, 'fixture', async () => {
      throw new Error('malformed input reached runner');
    });
    assert.deepEqual(result, { kind: 'unconfirmed', reason: 'invalid_resource' });
  }

  for (const output of [
    { exitCode: 1, stdout: `${JSON.stringify(native)}\n`, stderr: '' },
    { exitCode: 0, stdout: `${JSON.stringify(native)}\n`, stderr: 'x'.repeat(5000) },
    { exitCode: 0, stdout: '{}\n', stderr: '' },
    { exitCode: 0, stdout: `${JSON.stringify(native)}\n${JSON.stringify(native)}\n`, stderr: '' },
    { exitCode: 0, stdout: 'x'.repeat(5000), stderr: '' },
  ]) {
    const result = await observeWslTerminal(resource, 'fixture', async () => output);
    assert.equal(result.kind, 'unconfirmed');
  }
});

test('bounded native probe refuses stream overflow and timeout after child process closes', async () => {
  const overflowChild = spawn(process.execPath,
    ['-e', 'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const overflow = await readWslTerminalProbeChild(overflowChild, 1000);
  assert.equal(overflow.exitCode, null);
  const timeoutChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const timeout = await readWslTerminalProbeChild(timeoutChild, 100);
  assert.equal(timeout.exitCode, null);
});

test('synthetic unit cleanup attempts both unique units after every command failure', () => {
  const tracked = `rcac-investigator-${randomUUID()}.service`;
  const sibling = `rcac-observer-sibling-${randomUUID()}.service`;
  const attempted: string[] = [];
  const errors = cleanupSyntheticUnits(args => {
    attempted.push(args.join(' '));
    return { status: 1, stdout: '', stderr: 'failed' };
  }, tracked, sibling);
  assert.equal(attempted.length, 5);
  assert.ok(attempted.some(command => command.endsWith(`stop ${sibling}`)));
  assert.ok(attempted.some(command => command.endsWith(`reset-failed ${sibling}`)));
  assert.ok(attempted.some(command => command.endsWith(`reset-failed ${tracked}`)));
  assert.ok(errors.length >= 2);
});

test('actual fixed Linux helper rejects synthetic non-cgroup root before absent claim',
  { skip: process.env.RCAC_WSL_TERMINAL_CANARY !== '1' }, () => {
    const spec = wslTerminalObservationSpec(resource, 'fixture');
    const normal = spawnSync(spec.executable, spec.args, { env: spec.env,
      timeout: 7000, maxBuffer: 4096, encoding: 'utf8' });
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).loadState, 'not-found');

    const modified = [...spec.args];
    modified[11] = modified[11]!.replace("os.open('/sys/fs/cgroup'", "os.open('/tmp'");
    assert.notEqual(modified[11], spec.args[11]);
    const negative = spawnSync(spec.executable, modified, { env: spec.env,
      timeout: 7000, maxBuffer: 4096, encoding: 'utf8' });
    assert.notEqual(negative.status, 0);
    assert.equal(negative.stdout, '');
  });

test('real failed transient unit with cleared ControlGroup remains unconfirmed',
  { skip: process.env.RCAC_WSL_TERMINAL_CANARY !== '1' }, async () => {
    const unitName = `rcac-investigator-${randomUUID()}.service`;
    const spec = wslTerminalObservationSpec(resource, 'fixture');
    const wsl = (args: string[]) => spawnSync(spec.executable,
      ['-d', resource.distro, '--user', 'fixture', '--cd', '/', '--exec', ...args],
      { env: spec.env, timeout: 7000, maxBuffer: 4096, encoding: 'utf8' });
    try {
      const launch = wsl(['/usr/bin/systemd-run', '--user', '--quiet', '--wait',
        `--unit=${unitName}`, '--property=Restart=no', '--property=KillMode=control-group',
        '--property=SendSIGKILL=yes', '/usr/bin/false']);
      assert.equal(launch.error, undefined);
      const shown = wsl(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unitName]);
      assert.equal(shown.status, 0);
      const fields = Object.fromEntries(shown.stdout.trim().split('\n').map(line => line.split('=', 2)));
      assert.equal(fields.Id, unitName);
      assert.equal(fields.ActiveState, 'failed');
      assert.equal(fields.SubState, 'failed');
      assert.equal(fields.ControlGroup, '');
      const boot = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      const uid = wsl(['/usr/bin/id', '-u']);
      assert.equal(boot.status, 0);
      assert.equal(uid.status, 0);
      const observed = await observeWslTerminal({
        distro: resource.distro, uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
        unitName, invocationId: fields.InvocationID!,
        controlGroup: `/user.slice/user-${uid.stdout.trim()}.slice/user@${uid.stdout.trim()}.service/app.slice/${unitName}`,
      }, 'fixture');
      assert.equal(observed.kind, 'unconfirmed');
      assert.equal(observed.reason, 'identity_mismatch');
    } finally {
      // Reset only the unique synthetic failed unit. This fixture never stops a live service.
      const reset = wsl(['/usr/bin/systemctl', '--user', 'reset-failed', unitName]);
      assert.equal(reset.status, 0);
    }
  });

test('WSL tracked unit can end while its bus-created sibling service remains alive',
  { skip: process.env.RCAC_WSL_TERMINAL_CANARY !== '1' }, async () => {
    const tracked = `rcac-investigator-${randomUUID()}.service`;
    const sibling = `rcac-observer-sibling-${randomUUID()}.service`;
    const spec = wslTerminalObservationSpec(resource, 'fixture');
    const wsl = (args: string[]) => spawnSync(spec.executable,
      ['-d', resource.distro, '--user', 'fixture', '--cd', '/', '--exec', ...args],
      { env: spec.env, timeout: 7000, maxBuffer: 4096, encoding: 'utf8' });
    const show = (unit: string) => {
      const result = wsl(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unit]);
      assert.equal(result.status, 0);
      return Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=', 2)));
    };
    const launchSibling = String.raw`import subprocess,sys
p=subprocess.run(['/usr/bin/systemd-run','--user','--quiet',
    '--unit='+sys.argv[1],'--property=Restart=no','--property=RuntimeMaxSec=90s',
    '/usr/bin/sleep','90'],capture_output=True,timeout=4)
if p.returncode: sys.stderr.buffer.write(p.stderr[:512])
sys.exit(1 if p.returncode == 0 else 2)`;
    let primaryError: unknown;
    let hadPrimaryError = false;
    let cleanupErrors: string[];
    try {
      const launch = wsl(['/usr/bin/systemd-run', '--user', '--quiet', '--pipe', '--wait',
        `--unit=${tracked}`, '--property=Restart=no', '--property=KillMode=control-group',
        '--property=SendSIGKILL=yes', '/usr/bin/python3', '-I', '-S', '-c', launchSibling, sibling]);
      assert.equal(launch.error, undefined);
      const original = show(tracked);
      const escaped = show(sibling);
      assert.equal(original.ActiveState, 'failed');
      assert.equal(original.SubState, 'failed');
      assert.equal(original.MainPID, '0');
      assert.equal(original.ControlGroup, '');
      assert.equal(escaped.ActiveState, 'active', JSON.stringify({ original, escaped, launchStatus: launch.status,
        launchStdout: launch.stdout, launchStderr: launch.stderr }));
      assert.equal(escaped.SubState, 'running');
      assert.match(escaped.MainPID!, /^[1-9]\d*$/);

      const boot = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      const uid = wsl(['/usr/bin/id', '-u']);
      assert.equal(boot.status, 0);
      assert.equal(uid.status, 0);
      const saved = {
        distro: resource.distro, uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
        unitName: tracked, invocationId: original.InvocationID!,
        controlGroup: `/user.slice/user-${uid.stdout.trim()}.slice/user@${uid.stdout.trim()}.service/app.slice/${tracked}`,
      };
      const actual = await observeWslTerminal(saved, 'fixture');
      assert.equal(actual.kind, 'unconfirmed'); // Real helper remains unconfirmed: ControlGroup was cleared.
      // Even with an exact synthetic unit observation, the type states only the
      // tracked unit's status; the real sibling above remains active.
      const unitOnly = await observeWslTerminal(saved, 'fixture', async () => ({ exitCode: 0,
        stdout: `${JSON.stringify({ bootId: saved.bootId, uid: saved.uid,
          unitName: tracked, invocationId: saved.invocationId, controlGroup: saved.controlGroup,
          loadState: 'loaded', activeState: 'failed', subState: 'failed', mainPid: 0,
          cgroupState: 'absent' })}\n`, stderr: '' }));
      assert.equal(unitOnly.kind, 'unit_terminal');
      const stillAlive = show(sibling);
      assert.equal(stillAlive.ActiveState, 'active');
      assert.match(stillAlive.MainPID!, /^[1-9]\d*$/);
    } catch (error) {
      primaryError = error;
      hadPrimaryError = true;
    } finally {
      // All commands target only the two unique fixture units. Attempt every
      // cleanup operation even when launch, observation or an earlier cleanup fails.
      cleanupErrors = cleanupSyntheticUnits(wsl, tracked, sibling);
    }
    if (hadPrimaryError && cleanupErrors.length > 0)
      throw new AggregateError([primaryError, ...cleanupErrors.map(message => new Error(message))],
        'fixture assertion and cleanup failed');
    if (hadPrimaryError) throw primaryError;
    assert.deepEqual(cleanupErrors, []);
  });

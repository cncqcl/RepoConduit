import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { WslResource } from '../../storage/investigation-sqlite.js';
import { WSL_EXECUTABLE } from './preflight.js';

export interface WslTerminalNativeState {
  bootId: string;
  uid: number;
  unitName: string;
  invocationId: string;
  controlGroup: string;
  loadState: 'loaded';
  activeState: 'inactive' | 'failed';
  subState: 'dead' | 'failed';
  mainPid: 0;
  cgroupState: 'absent' | 'empty';
}

export type WslTerminalObservation =
  // A process with access to the same user systemd bus can start a sibling unit
  // before this tracked unit ends. This proves only the saved unit/cgroup state.
  // It MUST NOT authorize investigation slot release or claim all descendants ended.
  | { kind: 'unit_terminal'; resource: WslResource; native: WslTerminalNativeState }
  | { kind: 'unconfirmed'; reason: 'invalid_resource' | 'probe_failed' | 'identity_mismatch' | 'not_terminal' | 'invalid_output' };

export interface WslTerminalLaunchSpec { executable: string; args: string[]; env: NodeJS.ProcessEnv }
export interface WslTerminalProbeOutput { exitCode: number | null; stdout: string; stderr: string }
export type WslTerminalRunner = (spec: WslTerminalLaunchSpec) => Promise<WslTerminalProbeOutput>;

// This program is fixed in the product binary. Resource values are separate argv data.
// The second show catches ordinary state changes during cgroup observation; it is not an atomic lock.
const LINUX_OBSERVER = String.raw`
import json, os, stat, subprocess, sys
unit, saved_group = sys.argv[1:3]
def show():
    p = subprocess.run(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unit],
        capture_output=True, timeout=2, check=True)
    if p.stderr or len(p.stdout) > 2048: raise ValueError('show output')
    fields = {}
    for line in p.stdout.decode('ascii').splitlines():
        k, sep, v = line.partition('=')
        if not sep or k in fields: raise ValueError('show field')
        fields[k] = v
    expected = {'Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'ControlGroup'}
    if fields.keys() != expected: raise ValueError('show fields')
    return fields
def verified_cgroup_root():
    fd = os.open('/sys/fs/cgroup', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        device = os.fstat(fd).st_dev
        with open('/proc/self/mountinfo', encoding='ascii') as source:
            rows = [line.strip().split(' - ', 1) for line in source]
        matches = []
        for row in rows:
            if len(row) != 2: raise ValueError('mountinfo format')
            left, right = row
            fields, fs = left.split(), right.split()
            if len(fields) < 5 or len(fs) < 1: raise ValueError('mountinfo fields')
            if fields[4] == '/sys/fs/cgroup': matches.append((fields, fs))
        if len(matches) != 1: raise ValueError('cgroup mount count')
        fields, fs = matches[0]
        if fields[3] != '/' or fs[0] != 'cgroup2' or fields[2] != '%s:%s' % (os.major(device), os.minor(device)):
            raise ValueError('not cgroup v2 root')
        controllers = os.open('cgroup.controllers', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            if not stat.S_ISREG(os.fstat(controllers).st_mode): raise ValueError('controllers type')
            if len(os.read(controllers, 1024)) >= 1024: raise ValueError('controllers size')
        finally: os.close(controllers)
        return fd
    except:
        os.close(fd)
        raise
def group_state():
    fd = verified_cgroup_root()
    try:
        for component in saved_group.split('/')[1:]:
            try:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except FileNotFoundError:
                return 'absent'
            os.close(fd)
            fd = next_fd
        def read(name):
            leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try: return os.read(leaf, 1024)
            finally: os.close(leaf)
        events = read('cgroup.events').decode('ascii').splitlines()
        values = dict(line.split(' ', 1) for line in events)
        if values.get('populated') not in ('0', '1'): raise ValueError('cgroup events')
        procs = read('cgroup.procs')
        if len(procs) >= 1024: raise ValueError('cgroup procs')
        return 'empty' if values['populated'] == '0' and not procs.strip() else 'populated'
    finally:
        os.close(fd)
boot = open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip()
uid = os.getuid()
first = show()
group = group_state()
second = show()
if first != second: raise ValueError('unit changed')
if boot != open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() or uid != os.getuid():
    raise ValueError('host changed')
sys.stdout.write(json.dumps({'bootId': boot, 'uid': uid, 'unitName': second['Id'],
    'invocationId': second['InvocationID'], 'controlGroup': second['ControlGroup'],
    'loadState': second['LoadState'], 'activeState': second['ActiveState'],
    'subState': second['SubState'], 'mainPid': int(second['MainPID']), 'cgroupState': group}) + '\n')
`;

function validResource(resource: WslResource): boolean {
  return resource !== null && typeof resource === 'object' &&
    typeof resource.distro === 'string' && typeof resource.bootId === 'string' &&
    typeof resource.unitName === 'string' && typeof resource.controlGroup === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resource.distro) &&
    Number.isSafeInteger(resource.uid) && resource.uid > 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resource.bootId) &&
    /^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(resource.unitName) &&
    typeof resource.invocationId === 'string' && /^[0-9a-f]{32}$/.test(resource.invocationId) &&
    resource.controlGroup === `/user.slice/user-${resource.uid}.slice/user@${resource.uid}.service/app.slice/${resource.unitName}`;
}

function validLinuxUser(linuxUser: string): boolean {
  return typeof linuxUser === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(linuxUser);
}

export function wslTerminalObservationSpec(resource: WslResource, linuxUser: string): WslTerminalLaunchSpec {
  if (!validResource(resource) || !validLinuxUser(linuxUser)) throw new Error('INVALID_ARGUMENT');
  return {
    executable: WSL_EXECUTABLE,
    args: ['-d', resource.distro, '--user', linuxUser, '--cd', '/',
      '--exec', '/usr/bin/python3', '-I', '-S', '-c', LINUX_OBSERVER,
      resource.unitName, resource.controlGroup!],
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' },
  };
}

type BoundedProbeChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean };

/** Reads an already launched child; it cannot choose or launch an executable. */
export async function readWslTerminalProbeChild(child: BoundedProbeChild,
  timeoutMs = 7000): Promise<WslTerminalProbeOutput> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7000) throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let finished = false;
    let failed = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ exitCode: failed ? null : exitCode, stdout, stderr });
    };
    const fail = () => {
      if (failed || finished) return;
      failed = true;
      child.kill();
      // Wait for the Windows bridge to close. If it refuses, still return an
      // unconfirmed result after a bounded grace; this never proves Linux cleanup.
      grace = setTimeout(() => finish(null), 1000);
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4096) { fail(); return; }
      stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4096) { fail(); return; }
      stderr += part.toString('utf8');
    });
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', code => finish(code));
  });
}

export function runWslTerminalProbe(spec: WslTerminalLaunchSpec): Promise<WslTerminalProbeOutput> {
  const child = spawn(spec.executable, spec.args, { env: spec.env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  return readWslTerminalProbeChild(child);
}

export async function observeWslTerminal(resource: WslResource, linuxUser: string,
  runner: WslTerminalRunner = runWslTerminalProbe): Promise<WslTerminalObservation> {
  if (!validResource(resource) || !validLinuxUser(linuxUser)) return { kind: 'unconfirmed', reason: 'invalid_resource' };
  let output: WslTerminalProbeOutput;
  try { output = await runner(wslTerminalObservationSpec(resource, linuxUser)); }
  catch { return { kind: 'unconfirmed', reason: 'probe_failed' }; }
  if (!output || typeof output.stdout !== 'string' || typeof output.stderr !== 'string')
    return { kind: 'unconfirmed', reason: 'invalid_output' };
  // WSL can print a host NAT warning on stderr even when the fixed Linux helper
  // succeeded. The helper rejects systemctl stderr itself; only its structured
  // stdout supplies identity. Both streams remain bounded independently.
  if (output.exitCode !== 0 || Buffer.byteLength(output.stderr, 'utf8') > 4096 ||
    Buffer.byteLength(output.stdout, 'utf8') > 4096) return { kind: 'unconfirmed', reason: 'probe_failed' };
  let state: unknown;
  try { state = JSON.parse(output.stdout); }
  catch { return { kind: 'unconfirmed', reason: 'invalid_output' }; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { kind: 'unconfirmed', reason: 'invalid_output' };
  const value = state as Record<string, unknown>;
  const keys = ['bootId', 'uid', 'unitName', 'invocationId', 'controlGroup', 'loadState',
    'activeState', 'subState', 'mainPid', 'cgroupState'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value)))
    return { kind: 'unconfirmed', reason: 'invalid_output' };
  if (value.bootId !== resource.bootId || value.uid !== resource.uid ||
    value.unitName !== resource.unitName || value.invocationId !== resource.invocationId ||
    value.controlGroup !== resource.controlGroup) return { kind: 'unconfirmed', reason: 'identity_mismatch' };
  if (value.loadState !== 'loaded' ||
    !((value.activeState === 'inactive' && value.subState === 'dead') ||
      (value.activeState === 'failed' && value.subState === 'failed')) ||
    value.mainPid !== 0 || (value.cgroupState !== 'absent' && value.cgroupState !== 'empty'))
    return { kind: 'unconfirmed', reason: 'not_terminal' };
  return { kind: 'unit_terminal', resource: { ...resource }, native: value as unknown as WslTerminalNativeState };
}

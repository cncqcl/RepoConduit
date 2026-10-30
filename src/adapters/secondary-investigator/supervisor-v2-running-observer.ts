import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { WslResource } from '../storage/investigation-sqlite.js';
import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import { parseNativeSupervisorGateOutput, type NativeSupervisorGateDescriptor,
  type NativeSupervisorGateState } from './claude-native-supervisor.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from './fixed-zero-model-profile.js';

export interface SupervisorV2RunningNativeState {
  bootId: string;
  uid: number;
  unitName: string;
  invocationId: string;
  controlGroup: string;
  loadState: 'loaded';
  activeState: 'active';
  subState: 'running';
  mainPid: number;
  startTicks: number;
  procControlGroup: string;
}
export type SupervisorV2RunningObservation =
  | { kind: 'original_unit_running'; resource: WslResource;
    journal: NativeSupervisorGateState; native: SupervisorV2RunningNativeState }
  | { kind: 'unconfirmed' };
export interface SupervisorV2RunningSpec {
  executable: typeof WSL_EXECUTABLE;
  args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
}
export interface SupervisorV2RunningOutput { exitCode: number | null; stdout: string; stderr: string }
export type SupervisorV2RunningRunner =
  (spec: SupervisorV2RunningSpec) => Promise<SupervisorV2RunningOutput>;

// Fixed code; the unit and expected process identity are separate argv data.
// Two systemctl reads bracket /proc checks. This narrows ordinary races but is
// an observation, not an atomic authority decision.
const LINUX_RUNNING_OBSERVER = String.raw`
import json, os, subprocess, sys
unit, expected_group, expected_inv, expected_pid, expected_ticks = sys.argv[1:6]
expected_pid, expected_ticks = int(expected_pid), int(expected_ticks)
def show():
    p = subprocess.run(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unit],
        capture_output=True, timeout=2, check=True)
    if p.stderr or len(p.stdout) > 2048: raise ValueError('show output')
    fields = {}
    for line in p.stdout.decode('ascii').splitlines():
        key, sep, value = line.partition('=')
        if not sep or key in fields: raise ValueError('show field')
        fields[key] = value
    if fields.keys() != {'Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'ControlGroup'}:
        raise ValueError('show fields')
    if fields['Id'] != unit or fields['LoadState'] != 'loaded' or fields['ActiveState'] != 'active' or fields['SubState'] != 'running' or fields['InvocationID'] != expected_inv or fields['ControlGroup'] != expected_group or int(fields['MainPID']) != expected_pid:
        raise ValueError('systemd identity')
    return fields
def process():
    with open('/proc/%d/stat' % expected_pid, encoding='ascii') as stream: raw = stream.read()
    fields = raw[raw.rfind(')') + 2:].split()
    if len(fields) < 20 or fields[0] in ('Z', 'X', 'x') or int(fields[19]) != expected_ticks:
        raise ValueError('process start')
    with open('/proc/%d/cgroup' % expected_pid, encoding='ascii') as stream: rows = stream.read().splitlines()
    if rows != ['0::' + expected_group]: raise ValueError('process cgroup')
    return int(fields[19]), rows[0][3:]
boot = open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip()
uid = os.getuid()
first = show()
ticks, group = process()
second = show()
if first != second or boot != open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() or uid != os.getuid():
    raise ValueError('identity changed')
sys.stdout.write(json.dumps({'bootId': boot, 'uid': uid, 'unitName': second['Id'],
    'invocationId': second['InvocationID'], 'controlGroup': second['ControlGroup'],
    'loadState': second['LoadState'], 'activeState': second['ActiveState'],
    'subState': second['SubState'], 'mainPid': int(second['MainPID']),
    'startTicks': ticks, 'procControlGroup': group}, separators=(',', ':')) + '\n')
`;

export interface SupervisorV2ExpectedIdentity { attemptId: string; workspaceId: string }

function descriptorFor(resource: WslResource,
  journal: NativeSupervisorGateState,
  expected: SupervisorV2ExpectedIdentity): NativeSupervisorGateDescriptor | null {
  const gate = resource?.gate;
  const launch = gate?.launch;
  if (!gate || gate.protocol !== 'attempt_gate_v1' || gate.payloadKind !== 'native_supervisor_v2' ||
    !launch || launch.action !== 'fixed_zero_model_v1' ||
    launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
    !journal || !expected || journal.protocol !== 'native_supervisor_v2' ||
    journal.attemptId !== expected.attemptId ||
    journal.workspaceId !== expected.workspaceId ||
    journal.phase !== 'entered' || journal.closed ||
    journal.launchWorkerEpoch !== launch.workerEpoch ||
    journal.sourceDigest !== launch.sourceDigest || journal.profileDigest !== launch.profileDigest ||
    journal.bootId !== resource.bootId || journal.uid !== resource.uid ||
    journal.unitName !== resource.unitName || journal.invocationId !== resource.invocationId ||
    journal.controlGroup !== resource.controlGroup || !Number.isSafeInteger(journal.enterPid) ||
    !Number.isSafeInteger(journal.enterStartTicks) ||
    journal.enterPid! <= 0 || journal.enterStartTicks! <= 0) return null;
  const descriptor = { attemptId: expected.attemptId, workspaceId: expected.workspaceId,
    distro: resource.distro, linuxUser: gate.linuxUser, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest };
  const parsed = parseNativeSupervisorGateOutput(JSON.stringify(journal) + '\n', descriptor);
  return parsed?.protocol === 'native_supervisor_v2' ? descriptor : null;
}

export function supervisorV2RunningSpec(resource: WslResource,
  journal: NativeSupervisorGateState,
  expected: SupervisorV2ExpectedIdentity): SupervisorV2RunningSpec {
  if (!descriptorFor(resource, journal, expected)) throw new Error('INVALID_ARGUMENT');
  return { executable: WSL_EXECUTABLE,
    args: ['-d', resource.distro, '--user', resource.gate!.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', LINUX_RUNNING_OBSERVER, resource.unitName,
      resource.controlGroup!, resource.invocationId!, String(journal.enterPid),
      String(journal.enterStartTicks)],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } };
}

type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean };

export function readSupervisorV2RunningChild(child: BoundedChild,
  timeoutMs = 7000): Promise<SupervisorV2RunningOutput> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7000)
    throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let failed = false;
    let finished = false;
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
      try { child.kill(); } catch { /* Unconfirmed even if the bridge does not close. */ }
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
    child.on('close', finish);
  });
}

export function runSupervisorV2RunningProbe(spec: SupervisorV2RunningSpec): Promise<SupervisorV2RunningOutput> {
  const child = spawn(spec.executable, spec.args,
    { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return readSupervisorV2RunningChild(child);
}

export async function observeSupervisorV2Running(resource: WslResource,
  journal: NativeSupervisorGateState,
  expected: SupervisorV2ExpectedIdentity,
  runner: SupervisorV2RunningRunner = runSupervisorV2RunningProbe): Promise<SupervisorV2RunningObservation> {
  if (!descriptorFor(resource, journal, expected)) return { kind: 'unconfirmed' };
  let result: SupervisorV2RunningOutput;
  try { result = await runner(supervisorV2RunningSpec(resource, journal, expected)); }
  catch { return { kind: 'unconfirmed' }; }
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096 ||
    !result.stdout.endsWith('\n')) return { kind: 'unconfirmed' };
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { return { kind: 'unconfirmed' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unconfirmed' };
  const value = parsed as Record<string, unknown>;
  const keys = ['bootId', 'uid', 'unitName', 'invocationId', 'controlGroup',
    'loadState', 'activeState', 'subState', 'mainPid', 'startTicks', 'procControlGroup'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value)) ||
    value.bootId !== resource.bootId || value.uid !== resource.uid ||
    value.unitName !== resource.unitName || value.invocationId !== resource.invocationId ||
    value.controlGroup !== resource.controlGroup || value.loadState !== 'loaded' ||
    value.activeState !== 'active' || value.subState !== 'running' ||
    value.mainPid !== journal.enterPid || value.startTicks !== journal.enterStartTicks ||
    value.procControlGroup !== resource.controlGroup) return { kind: 'unconfirmed' };
  return { kind: 'original_unit_running', resource: { ...resource },
    journal: { ...journal }, native: value as unknown as SupervisorV2RunningNativeState };
}

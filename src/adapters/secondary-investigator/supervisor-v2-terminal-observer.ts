import type { WslResource } from '../storage/investigation-sqlite.js';
import { runWslTerminalProbe, wslTerminalObservationSpec,
  type WslTerminalRunner } from '../codex/investigator/terminal-observer.js';
import type { NativeSupervisorGateState } from './claude-native-supervisor.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from './fixed-zero-model-profile.js';
import type { SupervisorV2RunningObservation } from './supervisor-v2-running-observer.js';

// A unit can be unloaded after a WSL user-manager restart. In that case the
// original PID and the original cgroup must be inspected independently. A
// missing systemd unit is never terminal evidence by itself.
const LINUX_UNLOADED_OBSERVER = String.raw`
import json, os, stat, subprocess, sys
unit, saved_group, pid_text, ticks_text = sys.argv[1:5]
pid, ticks = int(pid_text), int(ticks_text)
if pid <= 0 or ticks <= 0: raise ValueError('process identity')
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
    if fields.keys() != {'Id','LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup'}:
        raise ValueError('show fields')
    if fields != {'Id':unit,'LoadState':'not-found','ActiveState':'inactive','SubState':'dead',
                  'MainPID':'0','InvocationID':'','ControlGroup':''}:
        raise ValueError('unit is not exact unloaded state')
    return fields
def process_absent():
    try:
        directory = os.open('/proc/%d' % pid, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return
    try:
        fd = os.open('stat', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('proc stat type')
            raw = os.read(fd, 4096).decode('ascii')
            if len(raw) >= 4096 or not raw.startswith(str(pid) + ' ('): raise ValueError('proc stat format')
            fields = raw[raw.rfind(')') + 2:].split()
            if len(fields) < 20: raise ValueError('proc stat fields')
            observed_ticks = int(fields[19])
            if observed_ticks == ticks: raise ValueError('original process alive')
            raise ValueError('pid reused')
        finally: os.close(fd)
    finally: os.close(directory)
def group_state():
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
        for component in saved_group.split('/')[1:]:
            try:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                  dir_fd=fd)
            except FileNotFoundError:
                return 'absent'
            os.close(fd)
            fd = next_fd
        def read(name):
            item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try: return os.read(item, 1024)
            finally: os.close(item)
        events = read('cgroup.events').decode('ascii').splitlines()
        values = dict(line.split(' ', 1) for line in events)
        if values.get('populated') not in ('0', '1'): raise ValueError('cgroup events')
        procs = read('cgroup.procs')
        if len(procs) >= 1024: raise ValueError('cgroup procs')
        if values['populated'] != '0' or procs.strip(): raise ValueError('populated cgroup')
        return 'empty'
    finally: os.close(fd)
boot = open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip()
uid = os.getuid()
first = show()
process_absent()
group = group_state()
process_absent()
second = show()
if first != second or boot != open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() or uid != os.getuid():
    raise ValueError('host identity changed')
sys.stdout.write(json.dumps({'bootId':boot,'uid':uid,'unitName':unit,'invocationId':'',
    'controlGroup':'','loadState':'not-found','activeState':'inactive','subState':'dead',
    'mainPid':0,'originalPid':pid,'originalStartTicks':ticks,'processState':'absent',
    'cgroupState':group}, separators=(',', ':')) + '\n')
`;

/** The fixed journal has no child process or sibling-unit operation. This
 * observation proves its saved unit is empty, never model-worker isolation. */
export type SupervisorV2TerminalObservation =
  | { kind: 'fixed_zero_model_terminal'; resource: WslResource; journal: NativeSupervisorGateState }
  | { kind: 'unconfirmed' };

function validRunningFact(resource: WslResource, journal: NativeSupervisorGateState,
  fact: SupervisorV2RunningObservation | null | undefined): fact is Extract<SupervisorV2RunningObservation,
  { kind: 'original_unit_running' }> {
  if (fact?.kind !== 'original_unit_running') return false;
  const { resource: saved, journal: entered, native } = fact;
  if (!saved || !entered || !native) return false;
  const launch = resource.gate?.launch;
  const savedLaunch = saved?.gate?.launch;
  return saved?.gate?.protocol === 'attempt_gate_v1' &&
    saved.gate.payloadKind === 'native_supervisor_v2' &&
    savedLaunch?.action === 'fixed_zero_model_v1' &&
    savedLaunch.profileDigest === FIXED_ZERO_MODEL_PROFILE_DIGEST &&
    saved.unitName === resource.unitName && saved.distro === resource.distro &&
    saved.uid === resource.uid && saved.bootId === resource.bootId &&
    saved.invocationId === resource.invocationId && saved.controlGroup === resource.controlGroup &&
    saved.gate.linuxUser === resource.gate?.linuxUser &&
    saved.gate.root === resource.gate?.root &&
    savedLaunch.workerEpoch === launch?.workerEpoch &&
    savedLaunch.sourceDigest === launch.sourceDigest &&
    savedLaunch.profileDigest === launch.profileDigest &&
    entered.protocol === 'native_supervisor_v2' && entered.phase === 'entered' && !entered.closed &&
    entered.attemptId === journal.attemptId && entered.workspaceId === journal.workspaceId &&
    entered.bootId === journal.bootId && entered.uid === journal.uid &&
    entered.unitName === journal.unitName &&
    entered.launchWorkerEpoch === journal.launchWorkerEpoch &&
    entered.sourceDigest === journal.sourceDigest &&
    entered.profileDigest === journal.profileDigest &&
    entered.invocationId === journal.invocationId &&
    entered.controlGroup === journal.controlGroup &&
    entered.enterPid === journal.enterPid &&
    entered.enterStartTicks === journal.enterStartTicks &&
    Number.isSafeInteger(entered.enterPid) && entered.enterPid! > 0 &&
    Number.isSafeInteger(entered.enterStartTicks) && entered.enterStartTicks! > 0 &&
    native.bootId === resource.bootId && native.uid === resource.uid &&
    native.unitName === resource.unitName && native.invocationId === resource.invocationId &&
    native.controlGroup === resource.controlGroup && native.procControlGroup === resource.controlGroup &&
    native.loadState === 'loaded' && native.activeState === 'active' &&
    native.subState === 'running' && native.mainPid === entered.enterPid &&
    native.startTicks === entered.enterStartTicks;
}

export async function observeSupervisorV2Terminal(resource: WslResource,
  journal: NativeSupervisorGateState,
  runner: WslTerminalRunner = runWslTerminalProbe,
  runningFact?: SupervisorV2RunningObservation | null): Promise<SupervisorV2TerminalObservation> {
  const launch = resource?.gate?.launch;
  if (resource?.gate?.protocol !== 'attempt_gate_v1' ||
    resource.gate.payloadKind !== 'native_supervisor_v2' ||
    !launch || launch.action !== 'fixed_zero_model_v1' ||
    launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
    !resource.invocationId || !resource.controlGroup ||
    !journal || journal.protocol !== 'native_supervisor_v2' ||
    journal.phase !== 'consumed' || !journal.closed ||
    journal.launchWorkerEpoch !== launch.workerEpoch ||
    journal.sourceDigest !== launch.sourceDigest ||
    journal.profileDigest !== launch.profileDigest ||
    journal.bootId !== resource.bootId || journal.uid !== resource.uid ||
    journal.unitName !== resource.unitName ||
    journal.invocationId !== resource.invocationId ||
    journal.controlGroup !== resource.controlGroup) return { kind: 'unconfirmed' };
  let spec: ReturnType<typeof wslTerminalObservationSpec>;
  try { spec = wslTerminalObservationSpec(resource, resource.gate.linuxUser); }
  catch { return { kind: 'unconfirmed' }; }
  let output: Awaited<ReturnType<WslTerminalRunner>>;
  try { output = await runner(spec); }
  catch { return { kind: 'unconfirmed' }; }
  if (!output || output.exitCode !== 0 || typeof output.stdout !== 'string' ||
    typeof output.stderr !== 'string' || Buffer.byteLength(output.stdout) > 4096 ||
    Buffer.byteLength(output.stderr) > 4096 || !output.stdout.endsWith('\n'))
    return { kind: 'unconfirmed' };
  let parsed: unknown;
  try { parsed = JSON.parse(output.stdout); }
  catch { return { kind: 'unconfirmed' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unconfirmed' };
  const value = parsed as Record<string, unknown>;
  const keys = ['bootId', 'uid', 'unitName', 'invocationId', 'controlGroup', 'loadState',
    'activeState', 'subState', 'mainPid', 'cgroupState'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value)) ||
    value.bootId !== resource.bootId || value.uid !== resource.uid ||
    value.unitName !== resource.unitName || value.mainPid !== 0 ||
    (value.cgroupState !== 'absent' && value.cgroupState !== 'empty'))
    return { kind: 'unconfirmed' };
  if (value.loadState === 'not-found' && value.activeState === 'inactive' &&
    value.subState === 'dead' && value.invocationId === '' && value.controlGroup === '' &&
    validRunningFact(resource, journal, runningFact)) {
    const alternate = { ...spec, args: [...spec.args] };
    alternate.args[11] = LINUX_UNLOADED_OBSERVER;
    alternate.args.push(String(journal.enterPid), String(journal.enterStartTicks));
    let probe: Awaited<ReturnType<WslTerminalRunner>>;
    try { probe = await runner(alternate); }
    catch { return { kind: 'unconfirmed' }; }
    if (!probe || probe.exitCode !== 0 || typeof probe.stdout !== 'string' ||
      typeof probe.stderr !== 'string' || Buffer.byteLength(probe.stdout) > 4096 ||
      Buffer.byteLength(probe.stderr) > 4096 || !probe.stdout.endsWith('\n'))
      return { kind: 'unconfirmed' };
    let state: unknown;
    try { state = JSON.parse(probe.stdout); }
    catch { return { kind: 'unconfirmed' }; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { kind: 'unconfirmed' };
    const unloaded = state as Record<string, unknown>;
    const exact = [...keys, 'originalPid', 'originalStartTicks', 'processState'];
    if (Object.keys(unloaded).length !== exact.length || exact.some(key => !(key in unloaded)) ||
      unloaded.bootId !== resource.bootId || unloaded.uid !== resource.uid ||
      unloaded.unitName !== resource.unitName || unloaded.invocationId !== '' ||
      unloaded.controlGroup !== '' || unloaded.loadState !== 'not-found' ||
      unloaded.activeState !== 'inactive' || unloaded.subState !== 'dead' ||
      unloaded.mainPid !== 0 || unloaded.originalPid !== journal.enterPid ||
      unloaded.originalStartTicks !== journal.enterStartTicks ||
      unloaded.processState !== 'absent' ||
      (unloaded.cgroupState !== 'absent' && unloaded.cgroupState !== 'empty'))
      return { kind: 'unconfirmed' };
    return { kind: 'fixed_zero_model_terminal', resource: { ...resource }, journal: { ...journal } };
  }
  if (value.invocationId !== resource.invocationId ||
    (value.controlGroup !== resource.controlGroup && value.controlGroup !== '') ||
    value.loadState !== 'loaded') return { kind: 'unconfirmed' };
  const exited = value.activeState === 'active' && value.subState === 'exited';
  const failed = value.activeState === 'failed' && value.subState === 'failed';
  const inactive = value.activeState === 'inactive' && value.subState === 'dead';
  if (!exited && !failed && !inactive) return { kind: 'unconfirmed' };
  return { kind: 'fixed_zero_model_terminal', resource: { ...resource }, journal: { ...journal } };
}

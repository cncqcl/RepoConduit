import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import type { WslLaunchGateDescriptor } from '../codex/investigator/launch-gate.js';

export interface NativeSupervisorGateDescriptor extends WslLaunchGateDescriptor {
  launchWorkerEpoch: number;
  sourceDigest: string;
  profileDigest: string;
}
export interface NativeSupervisorUnitIdentity { invocationId: string; controlGroup: string }
export type NativeSupervisorGateOperation = 'prepare' | 'enter' | 'release' | 'close' | 'status';
export interface NativeSupervisorGateSpec {
  executable: typeof WSL_EXECUTABLE;
  args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
}
interface NativeSupervisorIdentity {
  attemptId: string; workspaceId: string; bootId: string; uid: number; unitName: string;
}
export type NativeSupervisorGateState = NativeSupervisorIdentity & {
  protocol: 'native_supervisor_v2';
  phase: 'prepared' | 'entered' | 'released' | 'consumed';
  closed: boolean;
  launchWorkerEpoch: number;
  sourceDigest: string;
  profileDigest: string;
  invocationId?: string;
  controlGroup?: string;
  enterPid?: number;
  enterStartTicks?: number;
};
export type LegacyNativeSupervisorGateState = NativeSupervisorIdentity & {
  protocol: 'native_supervisor_v1';
  kind: 'open' | 'released' | 'closed_unreleased' | 'closed_released';
  invocationId?: string;
  controlGroup?: string;
};

/** Fixed zero-model journal. The original unit process enters, waits without
 * holding a lock, then consumes a host release itself. Neither phase launches a
 * model or accepts a caller executable, shell, environment or payload. */
const LINUX_JOURNAL = String.raw`
import fcntl, json, os, re, stat, sys, time, uuid
op, root, attempt, workspace, boot, uid_text, unit, epoch_text, source_digest, profile_digest, wanted_inv, wanted_group = sys.argv[1:13]
uid, epoch = int(uid_text), int(epoch_text)
if op not in ('prepare', 'enter', 'release', 'close', 'status'): raise ValueError('operation')
if os.getuid() != uid: raise ValueError('uid')
if open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() != boot: raise ValueError('boot')
expected_group = '/user.slice/user-%d.slice/user@%d.service/app.slice/%s' % (uid, uid, unit)
if op == 'release':
    if not re.fullmatch('[0-9a-f]{32}', wanted_inv) or wanted_group != expected_group:
        raise ValueError('release identity')
elif wanted_inv or wanted_group: raise ValueError('unexpected release identity')

def open_root(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.split('/')[1:]:
            if not part or part in ('.', '..'): raise ValueError('root path')
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            s = os.fstat(nxt)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0, uid) or s.st_mode & 0o022:
                raise ValueError('root owner/mode')
            os.close(fd)
            fd = nxt
        s = os.fstat(fd)
        if s.st_uid != uid or s.st_mode & 0o077: raise ValueError('journal root owner/mode')
        return fd
    except:
        os.close(fd)
        raise

directory = open_root(root)
lock_flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
if op != 'status': lock_flags |= os.O_CREAT
lock = os.open(attempt + '.supervisor.lock', lock_flags, 0o600, dir_fd=directory)
name = attempt + '.supervisor.json'
base_identity = {'attemptId': attempt, 'workspaceId': workspace, 'bootId': boot, 'uid': uid, 'unitName': unit}
v2_identity = {'protocol': 'native_supervisor_v2', **base_identity,
               'launchWorkerEpoch': epoch, 'sourceDigest': source_digest, 'profileDigest': profile_digest}

def read_state():
    try: source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    except FileNotFoundError: return None
    try:
        s = os.fstat(source)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != uid or s.st_mode & 0o077 or s.st_size > 1536:
            raise ValueError('state owner/mode/size')
        raw = os.read(source, 1537)
        if len(raw) > 1536: raise ValueError('state size')
        state = json.loads(raw)
    finally: os.close(source)
    if not isinstance(state, dict) or any(state.get(k) != v for k, v in base_identity.items()):
        raise ValueError('state identity')
    if state.get('protocol') == 'native_supervisor_v1':
        base = set(base_identity) | {'protocol', 'kind'}
        kind = state.get('kind')
        if kind in ('open', 'closed_unreleased'):
            if set(state) != base: raise ValueError('legacy fields')
        elif kind in ('released', 'closed_released'):
            if set(state) != base | {'invocationId', 'controlGroup'} or not re.fullmatch('[0-9a-f]{32}', state['invocationId']) or state['controlGroup'] != expected_group:
                raise ValueError('legacy fields')
        else: raise ValueError('legacy kind')
        return state
    if any(state.get(k) != v for k, v in v2_identity.items()): raise ValueError('state binding')
    base = set(v2_identity) | {'phase', 'closed'}
    phase = state.get('phase')
    if type(state.get('closed')) is not bool: raise ValueError('closed flag')
    if phase == 'prepared':
        if set(state) != base: raise ValueError('prepared fields')
    elif phase in ('entered', 'released', 'consumed'):
        if set(state) != base | {'invocationId', 'controlGroup', 'enterPid', 'enterStartTicks'} or not isinstance(state['invocationId'], str) or not re.fullmatch('[0-9a-f]{32}', state['invocationId']) or state['controlGroup'] != expected_group or type(state['enterPid']) is not int or state['enterPid'] <= 0 or type(state['enterStartTicks']) is not int or state['enterStartTicks'] <= 0:
            raise ValueError('unit fields')
    else: raise ValueError('phase')
    return state

def persist(value):
    temp = attempt + '.' + uuid.uuid4().hex + '.supervisor.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=directory)
    try:
        data = (json.dumps(value, separators=(',', ':')) + '\n').encode('ascii')
        if len(data) > 1536: raise ValueError('state size')
        while data:
            count = os.write(fd, data)
            if count <= 0: raise OSError('short state write')
            data = data[count:]
        os.fsync(fd)
        os.rename(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)
        try: os.unlink(temp, dir_fd=directory)
        except FileNotFoundError: pass

def current_start_ticks(pid):
    with open('/proc/%d/stat' % pid, encoding='ascii') as stream: raw = stream.read()
    fields = raw[raw.rfind(')') + 2:].split()
    if fields[0] in ('Z', 'X', 'x'): raise ValueError('original unit exited')
    return int(fields[19])

def current_group(pid):
    with open('/proc/%d/cgroup' % pid, encoding='ascii') as stream: groups = stream.read().splitlines()
    if len(groups) != 1 or not groups[0].startswith('0::'): raise ValueError('cgroup')
    return groups[0][3:]

def locked_read():
    fcntl.flock(lock, fcntl.LOCK_EX)
    return read_state()

def unlock(): fcntl.flock(lock, fcntl.LOCK_UN)

try:
    s = os.fstat(lock)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != uid or s.st_mode & 0o077:
        raise ValueError('lock owner/mode')
    os.fsync(directory)
    state = locked_read()
    try:
        if op == 'prepare':
            if state is None:
                state = {'phase': 'prepared', 'closed': False, **v2_identity}
                persist(state)
            if state.get('protocol') != 'native_supervisor_v2' or state['phase'] != 'prepared' or state['closed']:
                raise ValueError('journal unavailable')
        elif op == 'close':
            if state is None:
                state = {'phase': 'prepared', 'closed': True, **v2_identity}
            elif state['protocol'] == 'native_supervisor_v1':
                if state['kind'] == 'open': state = {**state, 'kind': 'closed_unreleased'}
                elif state['kind'] == 'released': state = {**state, 'kind': 'closed_released'}
            elif not state['closed']:
                state = {**state, 'closed': True}
            persist(state)
            os.fsync(directory)
        elif op == 'status':
            if state is None: raise ValueError('journal missing')
        elif op == 'release':
            if state is None or state['protocol'] != 'native_supervisor_v2' or state['closed'] or state.get('invocationId') != wanted_inv or state.get('controlGroup') != wanted_group:
                raise ValueError('release unavailable')
            if state['phase'] == 'entered':
                try:
                    if current_start_ticks(state['enterPid']) != state['enterStartTicks'] or current_group(state['enterPid']) != expected_group:
                        raise ValueError('original unit exited')
                except (FileNotFoundError, ProcessLookupError): raise ValueError('original unit exited')
                state = {**state, 'phase': 'released'}
                persist(state)
            elif state['phase'] not in ('released', 'consumed'):
                raise ValueError('release unavailable')
            # Matching retries report the journal phase; they never execute or
            # reopen anything. A caller must reconcile the returned phase.
        else:
            if state is None or state['protocol'] != 'native_supervisor_v2' or state['phase'] != 'prepared' or state['closed']:
                raise ValueError('enter unavailable')
            invocation = os.environ.get('INVOCATION_ID', '')
            if not re.fullmatch('[0-9a-f]{32}', invocation) or current_group(os.getpid()) != expected_group:
                raise ValueError('original unit')
            # Start the wait budget before entered becomes visible to the host.
            deadline = time.monotonic() + 6
            state = {**state, 'phase': 'entered', 'invocationId': invocation,
                     'controlGroup': expected_group, 'enterPid': os.getpid(),
                     'enterStartTicks': current_start_ticks(os.getpid())}
            persist(state)
    finally: unlock()
    if op == 'enter':
        while True:
            state = locked_read()
            try:
                if state['closed']: raise ValueError('journal closed')
                if time.monotonic() >= deadline:
                    if state['phase'] in ('entered', 'released'):
                        state = {**state, 'closed': True}
                        persist(state)
                    raise ValueError('release timeout')
                if state['phase'] == 'released':
                    if state['enterPid'] != os.getpid() or state['enterStartTicks'] != current_start_ticks(os.getpid()) or current_group(os.getpid()) != expected_group:
                        raise ValueError('original unit changed')
                    if time.monotonic() >= deadline:
                        state = {**state, 'closed': True}
                        persist(state)
                        raise ValueError('release timeout')
                    state = {**state, 'phase': 'consumed'}
                    persist(state)
                    marker = os.open(attempt + '.supervisor.canary', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
                    try:
                        os.write(marker, b'zero-model-consumed\n')
                        os.fsync(marker)
                    finally: os.close(marker)
                    os.fsync(directory)
                    break
                if state['phase'] != 'entered': raise ValueError('enter state changed')
            finally: unlock()
            time.sleep(0.05)
    sys.stdout.write(json.dumps(state, separators=(',', ':')) + '\n')
finally:
    os.close(lock)
    os.close(directory)
`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const attemptPattern = new RegExp(`^attempt_${UUID}$`);
const workspacePattern = new RegExp(`^ws_${UUID}$`);
const unitPattern = new RegExp(`^rcac-investigator-${UUID}\\.service$`);
const uuidPattern = new RegExp(`^${UUID}$`);
const groupFor = (value: NativeSupervisorGateDescriptor) =>
  `/user.slice/user-${value.uid}.slice/user@${value.uid}.service/app.slice/${value.unitName}`;

function valid(descriptor: NativeSupervisorGateDescriptor, root: string): boolean {
  if (!descriptor || typeof descriptor !== 'object' ||
    Object.keys(descriptor).length !== 10) return false;
  return attemptPattern.test(descriptor.attemptId) && workspacePattern.test(descriptor.workspaceId) &&
    uuidPattern.test(descriptor.bootId) && unitPattern.test(descriptor.unitName) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.distro) &&
    /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(descriptor.linuxUser) &&
    Number.isSafeInteger(descriptor.uid) && descriptor.uid > 0 &&
    Number.isSafeInteger(descriptor.launchWorkerEpoch) && descriptor.launchWorkerEpoch >= 0 &&
    /^[0-9a-f]{64}$/.test(descriptor.sourceDigest) && /^[0-9a-f]{64}$/.test(descriptor.profileDigest) &&
    typeof root === 'string' && root.startsWith(`/home/${descriptor.linuxUser}/`) &&
    root.length <= 256 && !root.endsWith('/') && !root.includes('//') &&
    root.split('/').every(part => part !== '.' && part !== '..' && /^[A-Za-z0-9._-]*$/.test(part));
}

export function nativeSupervisorGateSpec(operation: NativeSupervisorGateOperation,
  descriptor: NativeSupervisorGateDescriptor, root: string,
  observed?: NativeSupervisorUnitIdentity): NativeSupervisorGateSpec {
  if (!['prepare', 'enter', 'release', 'close', 'status'].includes(operation) || !valid(descriptor, root) ||
    (operation === 'release' ? !observed || Object.keys(observed).length !== 2 ||
      !/^[0-9a-f]{32}$/.test(observed.invocationId) || observed.controlGroup !== groupFor(descriptor) :
      observed !== undefined)) throw new Error('INVALID_ARGUMENT');
  return { executable: WSL_EXECUTABLE,
    args: ['-d', descriptor.distro, '--user', descriptor.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', LINUX_JOURNAL, operation, root, descriptor.attemptId,
      descriptor.workspaceId, descriptor.bootId, String(descriptor.uid), descriptor.unitName,
      String(descriptor.launchWorkerEpoch), descriptor.sourceDigest, descriptor.profileDigest,
      observed?.invocationId ?? '', observed?.controlGroup ?? ''],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } };
}

export function parseNativeSupervisorGateOutput(stdout: string,
  descriptor: NativeSupervisorGateDescriptor): NativeSupervisorGateState | LegacyNativeSupervisorGateState | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096 || !stdout.endsWith('\n')) return null;
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const identity = ['attemptId', 'workspaceId', 'bootId', 'uid', 'unitName'] as const;
  if (identity.some(key => state[key] !== descriptor[key])) return null;
  const expectedGroup = groupFor(descriptor);
  if (state.protocol === 'native_supervisor_v1') {
    const base = ['protocol', 'kind', ...identity];
    if (state.kind === 'open' || state.kind === 'closed_unreleased') {
      if (Object.keys(state).length !== base.length || base.some(key => !(key in state))) return null;
    } else if (state.kind === 'released' || state.kind === 'closed_released') {
      if (Object.keys(state).length !== base.length + 2 ||
        [...base, 'invocationId', 'controlGroup'].some(key => !(key in state)) ||
        typeof state.invocationId !== 'string' || !/^[0-9a-f]{32}$/.test(state.invocationId) ||
        state.controlGroup !== expectedGroup) return null;
    } else return null;
    return state as unknown as LegacyNativeSupervisorGateState;
  }
  const base = ['protocol', 'phase', 'closed', ...identity,
    'launchWorkerEpoch', 'sourceDigest', 'profileDigest'];
  if (state.protocol !== 'native_supervisor_v2' ||
    state.launchWorkerEpoch !== descriptor.launchWorkerEpoch ||
    state.sourceDigest !== descriptor.sourceDigest || state.profileDigest !== descriptor.profileDigest ||
    typeof state.closed !== 'boolean') return null;
  if (state.phase === 'prepared') {
    if (Object.keys(state).length !== base.length || base.some(key => !(key in state))) return null;
  } else if (state.phase === 'entered' || state.phase === 'released' || state.phase === 'consumed') {
    if (Object.keys(state).length !== base.length + 4 ||
      [...base, 'invocationId', 'controlGroup', 'enterPid', 'enterStartTicks'].some(key => !(key in state)) ||
      typeof state.invocationId !== 'string' || !/^[0-9a-f]{32}$/.test(state.invocationId) ||
      state.controlGroup !== expectedGroup || !Number.isSafeInteger(state.enterPid) ||
      (state.enterPid as number) <= 0 || !Number.isSafeInteger(state.enterStartTicks) ||
      (state.enterStartTicks as number) <= 0) return null;
  } else return null;
  return state as unknown as NativeSupervisorGateState;
}

import { WSL_EXECUTABLE } from './preflight.js';

export interface WslLaunchGateDescriptor {
  attemptId: string;
  workspaceId: string;
  distro: string;
  linuxUser: string;
  uid: number;
  bootId: string;
  unitName: string;
}

export type WslLaunchGateOperation = 'prepare' | 'enter' | 'close' | 'status';
export interface WslLaunchGateSpec { executable: string; args: string[]; env: NodeJS.ProcessEnv }
export type WslLaunchGateState = {
  kind: 'open' | 'closed_unconsumed' | 'consumed' | 'closed_consumed';
  attemptId: string; workspaceId: string; bootId: string; uid: number; unitName: string;
  invocationId?: string; controlGroup?: string;
};

// The helper is fixed product code. No caller-controlled executable, shell, or
// environment is accepted. The only enter payload is a synthetic anchored canary.
// It is deliberately NOT wired to the production investigator scheduler.
const LINUX_GATE = String.raw`
import fcntl, json, os, re, stat, sys, uuid
op, root, attempt, workspace, boot, uid_text, unit = sys.argv[1:8]
uid = int(uid_text)
if op not in ('prepare', 'enter', 'close', 'status'): raise ValueError('operation')
if os.getuid() != uid: raise ValueError('uid')
if open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() != boot: raise ValueError('boot')

def open_root(path):
    components = path.split('/')[1:]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in components:
            if not part or part in ('.', '..'): raise ValueError('root path')
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            s = os.fstat(nxt)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0, uid) or s.st_mode & 0o022: raise ValueError('root owner/mode')
            os.close(fd)
            fd = nxt
        s = os.fstat(fd)
        if s.st_uid != uid or s.st_mode & 0o077: raise ValueError('gate root owner/mode')
        return fd
    except:
        os.close(fd)
        raise

directory = open_root(root)
try:
    lock_flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    if op != 'status': lock_flags |= os.O_CREAT
    lock = os.open(attempt + '.lock', lock_flags, 0o600, dir_fd=directory)
    try:
        s = os.fstat(lock)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != uid or s.st_mode & 0o077: raise ValueError('lock owner/mode')
        fcntl.flock(lock, fcntl.LOCK_EX)
        os.fsync(directory)
        identity = {'attemptId': attempt, 'workspaceId': workspace, 'bootId': boot, 'uid': uid, 'unitName': unit}
        name = attempt + '.json'
        try:
            source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        except FileNotFoundError:
            state = None
        else:
            try:
                s = os.fstat(source)
                if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != uid or s.st_mode & 0o077 or s.st_size > 1024:
                    raise ValueError('state owner/size')
                raw = os.read(source, 1025)
                if len(raw) > 1024: raise ValueError('state size')
                state = json.loads(raw)
            finally: os.close(source)
            if not isinstance(state, dict) or any(state.get(k) != v for k, v in identity.items()):
                raise ValueError('state identity')
            base = set(identity) | {'kind'}
            if state.get('kind') in ('open', 'closed_unconsumed'):
                if set(state) != base: raise ValueError('state fields')
            elif state.get('kind') in ('consumed', 'closed_consumed'):
                expected = '/user.slice/user-%d.slice/user@%d.service/app.slice/%s' % (uid, uid, unit)
                if set(state) != base | {'invocationId', 'controlGroup'} or not isinstance(state['invocationId'], str) or not re.fullmatch('[0-9a-f]{32}', state['invocationId']) or state['controlGroup'] != expected:
                    raise ValueError('state fields')
            else: raise ValueError('state kind')

        def persist(value):
            temp = attempt + '.' + uuid.uuid4().hex + '.tmp'
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            try:
                data = (json.dumps(value, separators=(',', ':')) + '\n').encode('ascii')
                if len(data) > 1024: raise ValueError('state size')
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

        if op == 'prepare':
            if state is None:
                state = {'kind': 'open', **identity}
                persist(state)
            if state['kind'] != 'open': raise ValueError('gate closed or consumed')
        elif op == 'close':
            if state is None or state['kind'] == 'open':
                state = {'kind': 'closed_unconsumed', **identity}
                persist(state)
            elif state['kind'] == 'consumed':
                state = {**state, 'kind': 'closed_consumed'}
                persist(state)
            # A retry must not report a previously visible but not yet durable
            # tombstone as successful after an earlier directory fsync failed.
            os.fsync(directory)
        elif op == 'status':
            if state is None: raise ValueError('gate missing')
        else:
            if state is None or state['kind'] != 'open': raise ValueError('gate not open')
            invocation = os.environ.get('INVOCATION_ID', '')
            if not re.fullmatch('[0-9a-f]{32}', invocation): raise ValueError('invocation')
            groups = open('/proc/self/cgroup', encoding='ascii').read().splitlines()
            if len(groups) != 1 or not groups[0].startswith('0::'): raise ValueError('cgroup')
            group = groups[0][3:]
            expected = '/user.slice/user-%d.slice/user@%d.service/app.slice/%s' % (uid, uid, unit)
            if group != expected: raise ValueError('unit cgroup')
            state = {'kind': 'consumed', **identity, 'invocationId': invocation, 'controlGroup': group}
            persist(state)
            # Keep the canary anchored to the already verified directory FD.
            # A later product integration must replace this fixed action with
            # a carefully fenced native process launch inside the same unit.
            marker = os.open(attempt + '.canary', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            try:
                os.write(marker, b'gate-consumed\n')
                os.fsync(marker)
            finally: os.close(marker)
            os.fsync(directory)
        sys.stdout.write(json.dumps(state, separators=(',', ':')) + '\n')
    finally: os.close(lock)
finally: os.close(directory)
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function valid(value: WslLaunchGateDescriptor, root: string): boolean {
  return /^attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.attemptId) &&
    /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.workspaceId) &&
    UUID.test(value.bootId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.distro) &&
    /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.linuxUser) &&
    Number.isSafeInteger(value.uid) && value.uid > 0 &&
    /^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(value.unitName) &&
    root.startsWith(`/home/${value.linuxUser}/`) &&
    root.length <= 256 && root.split('/').every(part => part !== '.' && part !== '..' && !part.includes('\0'));
}

export function wslLaunchGateSpec(operation: WslLaunchGateOperation,
  descriptor: WslLaunchGateDescriptor, root: string): WslLaunchGateSpec {
  if (!['prepare', 'enter', 'close', 'status'].includes(operation) || !valid(descriptor, root)) throw new Error('INVALID_ARGUMENT');
  return { executable: WSL_EXECUTABLE,
    args: ['-d', descriptor.distro, '--user', descriptor.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', LINUX_GATE, operation, root, descriptor.attemptId,
      descriptor.workspaceId, descriptor.bootId, String(descriptor.uid), descriptor.unitName],
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } };
}

export function parseWslLaunchGateOutput(stdout: string, descriptor: WslLaunchGateDescriptor): WslLaunchGateState | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096 || !stdout.endsWith('\n')) return null;
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const identity = ['attemptId', 'workspaceId', 'bootId', 'uid', 'unitName'] as const;
  if (identity.some(key => state[key] !== descriptor[key])) return null;
  const base = [...identity, 'kind'];
  if (state.kind === 'open' || state.kind === 'closed_unconsumed') {
    if (Object.keys(state).length !== base.length || base.some(key => !(key in state))) return null;
  } else if (state.kind === 'consumed' || state.kind === 'closed_consumed') {
    if (Object.keys(state).length !== base.length + 2 ||
      [...base, 'invocationId', 'controlGroup'].some(key => !(key in state)) ||
      typeof state.invocationId !== 'string' || !/^[0-9a-f]{32}$/.test(state.invocationId) ||
      typeof state.controlGroup !== 'string' || state.controlGroup !==
        `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}`) return null;
  } else return null;
  return state as WslLaunchGateState;
}

import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';

export interface PrivateFifoBinding {
  attemptId: string; workspaceId: string; workerEpoch: number;
  root: string; distro: string; linuxUser: string; uid: number; bootId: string;
  unitName: string; invocationId: string | null; controlGroup: string | null;
  deadlineEpochMs: number;
}

export interface PrivateFifoSpec {
  executable: typeof WSL_EXECUTABLE;
  args: string[];
  env: NodeJS.ProcessEnv;
  directory: string;
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const attempt = new RegExp(`^attempt_${uuid}$`);
const unit = new RegExp(`^rcac-[A-Za-z0-9_.-]{1,90}\\.service$`);

function validPath(path: string): boolean {
  return /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) &&
    !path.split('/').some(p => p === '.' || p === '..') && !path.startsWith('/mnt/');
}

/** Fixed helper; all paths are opened relative to no-follow directory descriptors. */
export const PRIVATE_FIFO_PYTHON = String.raw`
import errno, fcntl, json, os, re, stat, sys, threading, time
op, root, attempt, workspace, epoch_text, uid_text, boot, unit, invocation, group, deadline_text = sys.argv[1:12]
uid, epoch, deadline_ms = int(uid_text), int(epoch_text), int(deadline_text)
def refuse(): raise ValueError('PRIVATE_FIFO_UNAVAILABLE')
if os.getuid() != uid: refuse()
if open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() != boot: refuse()
if not re.fullmatch(r'attempt_[0-9a-f-]{36}', attempt) or epoch < 1: refuse()
if op == 'relay' and time.time() * 1000 >= deadline_ms: refuse()
identity = dict(attemptId=attempt, workspaceId=workspace, workerEpoch=epoch,
                uid=uid, bootId=boot, unitName=unit)
def open_root(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.split('/')[1:]:
            if not part or part in ('.', '..'): refuse()
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            st = os.fstat(nxt)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, uid) or st.st_mode & 0o022: refuse()
            os.close(fd); fd = nxt
        st = os.fstat(fd)
        if st.st_uid != uid or st.st_mode & 0o077: refuse()
        return fd
    except:
        os.close(fd); raise
base = open_root(root)
name = attempt + '-' + str(epoch) + '.mcp'
try:
    if op == 'prepare': os.mkdir(name, 0o700, dir_fd=base)
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=base)
    st = os.fstat(directory)
    if st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o700: refuse()
    if op == 'prepare':
        marker = os.open('identity.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        try:
            os.write(marker, json.dumps(identity, sort_keys=True).encode()); os.fsync(marker)
        finally: os.close(marker)
        os.mkfifo('in', 0o600, dir_fd=directory)
        os.mkfifo('out', 0o600, dir_fd=directory)
        helper_state = os.open('helper.lock', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        try:
            if os.write(helper_state, b'0') != 1: refuse()
            os.fsync(helper_state)
        finally: os.close(helper_state)
        os.fsync(directory)
        os.fsync(base)
    marker = os.open('identity.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        st = os.fstat(marker)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > 1024: refuse()
        if json.loads(os.read(marker, 1025)) != identity: refuse()
    finally: os.close(marker)
    helper_state = os.open('helper.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        st = os.fstat(helper_state)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size != 1: refuse()
        if os.read(helper_state, 2) not in (b'0', b'1'): refuse()
    finally: os.close(helper_state)
    for fifo in ('in', 'out'):
        fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        st = os.fstat(fd); os.close(fd)
        if not stat.S_ISFIFO(st.st_mode) or st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o600: refuse()
    if op == 'prepare':
        print(json.dumps(dict(status='prepared', attemptId=attempt, workerEpoch=epoch)))
        raise SystemExit(0)
    if op != 'relay': refuse()
    lock = os.open('relay.lock', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    incoming = os.open('out', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    if not stat.S_ISFIFO(os.fstat(incoming).st_mode) or os.fstat(incoming).st_uid != uid or stat.S_IMODE(os.fstat(incoming).st_mode) != 0o600: refuse()
    os.set_blocking(1, False)
    os.write(2, (json.dumps(dict(status='ready', attemptId=attempt, workerEpoch=epoch)) + '\n').encode())
    errors = []
    done = threading.Event()
    input_finished = threading.Event()
    input_finished_at = [None]
    connected = threading.Event()
    def write_bounded(fd, data):
        view = memoryview(data); deadline = time.monotonic() + 5
        while view and not done.is_set():
            if input_finished_at[0] is not None and time.monotonic() > input_finished_at[0] + 1: raise TimeoutError()
            try: view = view[os.write(fd, view):]
            except BlockingIOError:
                if time.monotonic() > deadline: raise TimeoutError()
                time.sleep(.01)
    def input_to_fifo():
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    outgoing = os.open('in', os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
                    if not stat.S_ISFIFO(os.fstat(outgoing).st_mode) or os.fstat(outgoing).st_uid != uid or stat.S_IMODE(os.fstat(outgoing).st_mode) != 0o600: refuse()
                    connected.set()
                    break
                except OSError as err:
                    if err.errno != errno.ENXIO or time.monotonic() > deadline: raise
                    time.sleep(.01)
            try:
                while not done.is_set():
                    chunk = os.read(0, 65536)
                    if not chunk: break
                    write_bounded(outgoing, chunk)
            finally: os.close(outgoing)
        except Exception: errors.append('input')
        finally:
            input_finished_at[0] = time.monotonic()
            input_finished.set()
    worker = threading.Thread(target=input_to_fifo, daemon=True); worker.start()
    seen = False
    try:
        deadline = time.monotonic() + 5
        finish_deadline = None
        while not done.is_set():
            if time.time() * 1000 >= deadline_ms: break
            if input_finished.is_set() and finish_deadline is None: finish_deadline = input_finished_at[0] + 1
            if finish_deadline is not None and time.monotonic() > finish_deadline: break
            try: chunk = os.read(incoming, 65536)
            except BlockingIOError:
                if finish_deadline is not None and time.monotonic() > finish_deadline: break
                if not seen and not connected.is_set() and time.monotonic() > deadline: raise TimeoutError()
                time.sleep(.01); continue
            if chunk:
                seen = True; deadline = time.monotonic() + 5
                write_bounded(1, chunk)
            elif seen: break
            elif finish_deadline is not None and time.monotonic() > finish_deadline: break
            elif not connected.is_set() and time.monotonic() > deadline: raise TimeoutError()
            else: time.sleep(.01)
    except Exception: errors.append('output')
    finally:
        done.set(); os.close(incoming); worker.join(timeout=1)
    raise SystemExit(1 if errors else 0)
finally: os.close(base)
`;

/** No caller-selectable command, environment, or path suffix. */
export function privateFifoSpec(operation: 'prepare' | 'relay', binding: PrivateFifoBinding): PrivateFifoSpec {
  if (!['prepare', 'relay'].includes(operation) || !attempt.test(binding.attemptId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(binding.workspaceId) ||
    !Number.isSafeInteger(binding.workerEpoch) || binding.workerEpoch < 1 ||
    !validPath(binding.root) || !binding.root.startsWith(`/home/${binding.linuxUser}/`) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(binding.distro) ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(binding.linuxUser) ||
    !Number.isSafeInteger(binding.uid) || binding.uid < 1 ||
    !new RegExp(`^${uuid}$`).test(binding.bootId) || !unit.test(binding.unitName) ||
    (operation === 'relay' && (!binding.invocationId || !/^[0-9a-f]{32}$/.test(binding.invocationId) ||
      binding.controlGroup !== `/user.slice/user-${binding.uid}.slice/user@${binding.uid}.service/app.slice/${binding.unitName}` ||
      !Number.isSafeInteger(binding.deadlineEpochMs) || binding.deadlineEpochMs <= Date.now() ||
      binding.deadlineEpochMs > Date.now() + 600_000)) ||
    (operation === 'prepare' && (binding.invocationId !== null || binding.controlGroup !== null)))
    throw new Error('NOT_AVAILABLE');
  return {
    executable: WSL_EXECUTABLE,
    args: ['-d', binding.distro, '--user', binding.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', PRIVATE_FIFO_PYTHON, operation, binding.root,
      binding.attemptId, binding.workspaceId, String(binding.workerEpoch), String(binding.uid),
      binding.bootId, binding.unitName, binding.invocationId ?? '', binding.controlGroup ?? '',
      String(binding.deadlineEpochMs)],
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
    directory: `${binding.root}/${binding.attemptId}-${binding.workerEpoch}.mcp`,
  };
}

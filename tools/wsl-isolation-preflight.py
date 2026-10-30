"""One bounded, synthetic-only coordinator. Not an application investigator launcher."""
import ctypes
import errno
import json
import os
import pathlib
import platform
import re
import select
import selectors
import socket
import stat
import subprocess
import sys
import time

started = time.monotonic()
deadline = started + 150
spec = json.load(sys.stdin)
help_only = spec.get('helpOnly', False)
if type(help_only) is not bool:
    raise RuntimeError('FIXED_DIAGNOSTIC_MODE')
unit = next(x[7:] for x in spec['unit'] if x.startswith('--unit='))
root = pathlib.Path(spec['controls']['credential']).parent
env = {'HOME': '/home/fixture', 'PATH': '/usr/bin:/bin'}
# Trusted manager control plane only. env-i below removes these before bwrap/payload.
management_env = dict(env, XDG_RUNTIME_DIR='/run/user/1000', DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus')
record = {'productionAvailable': False, 'modelTurn': 'not_run', 'unit': unit,
          'cleanupAtomic': False, 'stages': []}
record['scope'] = 'contained_app_server_help_only' if help_only else 'synthetic_python_canary'
child = None
identity = None
listeners = []
help_output = [bytearray(), bytearray()]
boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
record['bootId'] = boot
record['uid'] = os.getuid()


def emit(stage):
    record['stages'].append(stage)
    print(json.dumps({'stage': stage}), flush=True)


def budget(limit=8):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('DEADLINE')
    return min(limit, remaining)


def command(args):
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE,
                               env=management_env if args[0] == '/usr/bin/systemctl' else env,
                               close_fds=True, bufsize=0)
    try:
        stdout, stderr = drain(process, budget())
        if process.returncode:
            record['commandFailure'] = {'args': args, 'code': process.returncode,
                                        'stdout': stdout.decode('utf8', 'replace'),
                                        'stderr': stderr.decode('utf8', 'replace')}
            raise RuntimeError('COMMAND_FAILED')
        return stdout.decode('utf8', 'strict')
    finally:
        if process.poll() is None:
            process.kill()
        process.stdout.close()
        process.stderr.close()


def drain(process, seconds, output=None, on_part=None):
    until = min(deadline, time.monotonic() + seconds)
    if output is None:
        output = [bytearray(), bytearray()]
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, 0)
        selector.register(process.stderr, selectors.EVENT_READ, 1)
        while selector.get_map():
            if time.monotonic() >= until:
                raise RuntimeError('STREAM_TIMEOUT')
            for key, _ in selector.select(min(0.2, until - time.monotonic())):
                part = os.read(key.fileobj.fileno(), 8192)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    if on_part is not None:
                        on_part(key.data, part)
                    if sum(map(len, output)) + len(part) > 65536:
                        output[key.data].extend(part[:max(0, 65536 - sum(map(len, output)))])
                        raise RuntimeError('STREAM_OUTPUT_LIMIT')
                    output[key.data].extend(part)
    process.wait(timeout=max(0.001, until - time.monotonic()))
    return bytes(output[0]), bytes(output[1])


def line(stream, limit, seconds):
    until = min(deadline, time.monotonic() + seconds)
    data = bytearray()
    while len(data) <= limit:
        remaining = until - time.monotonic()
        if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
            raise RuntimeError('LINE_TIMEOUT')
        part = os.read(stream.fileno(), 1)
        if not part:
            return bytes(data)
        data.extend(part)
        if part == b'\n':
            return bytes(data)
    raise RuntimeError('LINE_OUTPUT_LIMIT')


def show():
    raw = command(['/usr/bin/systemctl', '--user', 'show',
                   '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unit])
    return dict(line.split('=', 1) for line in raw.splitlines())


def group_members(current):
    group = current['ControlGroup']
    if not group:
        return []
    if not group.startswith('/user.slice/') or '..' in pathlib.PurePosixPath(group).parts:
        raise RuntimeError('UNEXPECTED_GROUP')
    path = pathlib.Path('/sys/fs/cgroup' + group)
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise RuntimeError('CGROUP_LINK')
    if not path.exists():
        return []
    # Observe this group's small descendant tree, never the host process tree.
    directories = [path]
    members = set()
    for directory in directories:
        for entry in directory.iterdir():
            if entry.is_symlink():
                raise RuntimeError('CGROUP_LINK')
            if entry.is_dir():
                directories.append(entry)
        if len(directories) > 32:
            raise RuntimeError('CGROUP_DIRECTORY_LIMIT')
        members.update(int(x) for x in (directory / 'cgroup.procs').read_text().split())
        if len(members) > 32:
            raise RuntimeError('CGROUP_PROCESS_LIMIT')
    return sorted(members)


def same(current):
    return (identity is not None and pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() == boot and
            os.getuid() == record['uid'] and all(current[k] == identity[k] for k in ('Id', 'InvocationID', 'ControlGroup')))


def observed_boot_uid():
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), os.getuid()


def terminal_identity_matches(current, saved, expected_boot, current_boot, expected_uid, current_uid):
    return bool(saved is not None and saved.get('ControlGroup') and saved.get('InvocationID') and
                expected_boot == current_boot and expected_uid == current_uid and
                all(current.get(key) == saved.get(key) for key in ('Id', 'InvocationID')) and
                current.get('LoadState') == 'loaded' and current.get('ActiveState') == 'active' and
                current.get('SubState') == 'exited' and current.get('MainPID') == '0' and
                current.get('ControlGroup') in (saved['ControlGroup'], ''))


def retained_terminal(current):
    if identity is None:
        return False
    saved = identity.copy()
    current_boot, current_uid = observed_boot_uid()
    if not terminal_identity_matches(current, saved, boot, current_boot, record['uid'], current_uid):
        return False
    # Inspect the original path even when systemd clears the current property.
    members = group_members(saved)
    after = show()
    current_boot, current_uid = observed_boot_uid()
    if after != current or not terminal_identity_matches(after, saved, boot, current_boot, record['uid'], current_uid):
        return False
    record['originalGroupObservation'] = {'path': saved['ControlGroup'], 'members': members}
    return members == []


def bounded_file(path, limit=32768):
    with open(path, 'rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('OBSERVATION_LIMIT')
    return data.decode('utf8', 'strict')


def append_help_output(output, stream, part):
    total = record.get('helpOutputBytes', 0) + len(part)
    output[stream].extend(part[:max(0, 65536 - sum(map(len, output)))])
    record['helpOutputBytes'] = total
    record['helpOutputTruncated'] = total > 65536
    record['helpStdout'] = output[0].decode('utf8', 'replace')
    record['helpStderr'] = output[1].decode('utf8', 'replace')
    if total > 65536:
        raise RuntimeError('HELP_OUTPUT_LIMIT')


def run_help():
    global child, identity
    emit('launch_fixed_app_server_help')
    child = subprocess.Popen(spec['helpLaunch'][5:], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=management_env, close_fds=True, bufsize=0)
    child.stdin.close()
    child.stdin = None
    until = min(deadline, time.monotonic() + 25)
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ, 0)
        selector.register(child.stderr, selectors.EVENT_READ, 1)
        while time.monotonic() < until:
            for key, _ in selector.select(0.05):
                part = os.read(key.fileobj.fileno(), 8192)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    # Persist each consumed prefix before any later observation can fail.
                    append_help_output(help_output, key.data, part)
            current = show()
            # Fast help may already be exited. This is a reserved unit identity,
            # not a claim to have bound a running payload or full process tree.
            if identity is None and (current['LoadState'] == 'loaded' and current['Id'] == unit and
                re.fullmatch('[0-9a-f]{32}', current['InvocationID']) and
                current['ControlGroup'].startswith('/user.slice/') and
                current['ControlGroup'].endswith('/' + unit) and current['MainPID'].isdigit()):
                identity = current
                record['launchIdentity'] = identity.copy()
                record['helpRunningPidObserved'] = int(current['MainPID']) > 0
                print(json.dumps({'launchIdentity': record['launchIdentity'], 'bootId': boot, 'uid': os.getuid()}), flush=True)
            if retained_terminal(current):
                record['terminal'] = current
                record['originalGroupEmpty'] = True
                emit('help_original_group_empty')
                return
            if child.poll() is not None:
                break
    raise RuntimeError('HELP_ORIGINAL_EXIT_UNCONFIRMED')


try:
    emit('capabilities_and_fixed_dependencies')
    if platform.machine() != 'x86_64' or os.getuid() != 1000:
        raise RuntimeError('ABI_OR_UID_CHANGED')
    record['bwrapVersion'] = command(['/usr/bin/bwrap', '--version']).strip()
    if record['bwrapVersion'] != 'bubblewrap 0.6.1':
        raise RuntimeError('BWRAP_VERSION_CHANGED')
    help_text = command(['/usr/bin/bwrap', '--help'])
    for flag in ('--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
                 '--unshare-uts', '--unshare-cgroup', '--seccomp', '--perms', '--clearenv'):
        if flag not in help_text:
            raise RuntimeError('BWRAP_CAPABILITY_MISSING')
    dependencies = ['/usr/bin/python3.10', '/usr/lib/python3.10', '/usr/lib/x86_64-linux-gnu',
                    '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
                    '/home/fixture/.hermes/node/bin/node', '/home/fixture/.local/repoconduit-codex-0.157.1']
    observed = []
    record['dependencies'] = observed
    mounts = bounded_file('/proc/self/mountinfo', 65536).splitlines()
    for name in dependencies:
        path = pathlib.Path(name)
        real = path.resolve(strict=True)
        metadata = real.stat()
        observed.append({'path': name, 'canonical': str(real), 'uid': metadata.st_uid,
                         'mode': oct(stat.S_IMODE(metadata.st_mode))})
        if str(real) != name or metadata.st_uid not in (0, 1000) or metadata.st_mode & 0o022:
            raise RuntimeError('UNSAFE_DEPENDENCY_BACKING:' + name)
        if any(line.split()[4].startswith(name + '/') for line in mounts):
            raise RuntimeError('DEPENDENCY_SUBMOUNT:' + name)
    package = json.loads(bounded_file('/home/fixture/.local/repoconduit-codex-0.157.1/package/package.json'))
    record['codexPackageVersion'] = package['version']
    if record['codexPackageVersion'] != '0.157.1':
        raise RuntimeError('CODEX_PACKAGE_CHANGED')
    record['pythonVersion'] = command(['/usr/bin/python3.10', '-I', '-S', '--version']).strip()
    record['nodeVersion'] = command(['/home/fixture/.hermes/node/bin/node', '--version']).strip()
    record['initialUnit'] = show()
    if record['initialUnit']['LoadState'] != 'not-found':
        raise RuntimeError('UNIT_ALREADY_EXISTS')
    emit('prepare_create_only_synthetic_controls')
    parent = root.parent
    if parent.resolve(strict=True) != parent or parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077:
        raise RuntimeError('PRIVATE_PARENT_UNSAFE')
    root.mkdir(mode=0o700)
    workspace = root / 'workspace'
    workspace.mkdir(mode=0o700)
    fixture = workspace / 'fixture.txt'
    fixture.write_bytes(b'RCAC_SYNTHETIC_SOURCE\n')
    fixture.chmod(0o600)
    if help_only:
        run_help()
        record['sourceUnchanged'] = fixture.read_bytes() == b'RCAC_SYNTHETIC_SOURCE\n'
    else:
        credential = pathlib.Path(spec['controls']['credential'])
        descriptor = os.open(credential, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(b'SYNTHETIC_CREDENTIAL_NOT_A_SECRET\n')
        tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listeners.append(tcp)
        tcp.bind(('127.0.0.1', spec['controls']['port']))
        tcp.listen(4)
        unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listeners.append(unix)
        unix.bind(spec['controls']['unixSocket'])
        unix.listen(4)
        for family, target in ((socket.AF_INET, ('127.0.0.1', spec['controls']['port'])),
                               (socket.AF_UNIX, spec['controls']['unixSocket'])):
            with socket.socket(family, socket.SOCK_STREAM) as control:
                control.settimeout(1)
                control.connect(target)
        libc = ctypes.CDLL(None, use_errno=True)
        key = libc.syscall(250, 11, 0, 0, 0, 0)
        record['positiveControls'] = {'tcpConnect': True, 'unixConnect': True,
            'syntheticCredentialReadable': credential.read_bytes() == b'SYNTHETIC_CREDENTIAL_NOT_A_SECRET\n',
            'invalidKeyBaselineErrno': ctypes.get_errno() if key == -1 else 0}
        if key != -1 or ctypes.get_errno() == errno.EPERM:
            raise RuntimeError('KEYRING_BASELINE_NOT_DISTINGUISHABLE')
        emit('launch_single_reserved_unit')
        child = subprocess.Popen(spec['canaryLaunch'][5:], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=management_env, close_fds=True, bufsize=0)
        for attempt in range(20):
            current = show()
            if (current['LoadState'] == 'loaded' and current['Id'] == unit and
                re.fullmatch('[0-9a-f]{32}', current['InvocationID']) and
                current['ControlGroup'].startswith('/user.slice/') and
                current['ControlGroup'].endswith('/' + unit) and
                current['MainPID'].isdigit() and int(current['MainPID']) > 0):
                identity = current
                record['launchIdentity'] = identity.copy()
                print(json.dumps({'launchIdentity': record['launchIdentity'], 'bootId': boot, 'uid': os.getuid()}), flush=True)
                break
            if child.poll() is not None:
                break
            time.sleep(0.1)
        if identity is None:
            raise RuntimeError('LAUNCH_IDENTITY_UNCONFIRMED')
        ready = line(child.stdout, 128, budget(25))
        if ready != b'CANARY_READY\n':
            record['unexpectedReady'] = ready.decode('utf8', 'replace')
            raise RuntimeError('CANARY_NOT_READY')
        current = show()
        if not same(current):
            raise RuntimeError('UNIT_IDENTITY_CHANGED')
        identity = current
        if identity['ActiveState'] != 'active' or int(identity['MainPID']) <= 0 or len(identity['InvocationID']) != 32:
            raise RuntimeError('RUNNING_IDENTITY_UNCONFIRMED')
        record['running'] = identity
        members = group_members(identity)
        payloads = []
        for pid in members:
            cmdline = bounded_file('/proc/' + str(pid) + '/cmdline')
            if cmdline.split('\0')[:-1] == spec['canary'][spec['canary'].index('--') + 1:]:
                payloads.append(pid)
        if len(payloads) != 1:
            raise RuntimeError('PAYLOAD_IDENTITY_UNCONFIRMED')
        pid = payloads[0]
        namespaces = ('user', 'pid', 'net', 'ipc', 'uts', 'cgroup', 'mnt')
        comparisons = {name: os.readlink('/proc/' + str(pid) + '/ns/' + name) !=
                      os.readlink('/proc/self/ns/' + name) for name in namespaces}
        record['payload'] = {'pid': pid, 'members': members, 'namespaceDistinct': comparisons,
                             'namespaceIds': {name: os.readlink('/proc/' + str(pid) + '/ns/' + name) for name in namespaces},
                             'hostNamespaceIds': {name: os.readlink('/proc/self/ns/' + name) for name in namespaces},
                             'stdio': {str(fd): os.readlink('/proc/' + str(pid) + '/fd/' + str(fd)) for fd in range(3)},
                             'mountinfo': bounded_file('/proc/' + str(pid) + '/mountinfo'),
                             'status': bounded_file('/proc/' + str(pid) + '/status')}
        if not all(comparisons.values()) or show() != identity:
            raise RuntimeError('NAMESPACE_OR_UNIT_CHANGED')
        emit('release_observed_canary')
        # Synchronization only, not an authorization carrier. Missing/EOF never starts checks.
        child.stdin.write(b'OBSERVE_COMPLETE\n')
        child.stdin.flush()
        child.stdin.close()
        child.stdin = None
        stdout = line(child.stdout, 65536, budget(15))
        record['canaryStdout'] = stdout.decode('utf8', 'replace')
        if len(stdout) > 65536:
            raise RuntimeError('CANARY_OUTPUT_LIMIT')
        facts = json.loads(stdout)
        record['facts'] = facts
        expected = {'sourceReadable', 'sourceReadonly', 'emptyHome', 'scratchWritable',
                    'hostPathsHidden', 'hostProcHidden', 'keyringDenied', 'networkDenied',
                    'syntheticCredentialHidden', 'hostListenerDenied', 'syntheticUnixSocketDenied',
                    'userBusDenied', 'noExtraFds', 'noCapabilities', 'noNewPrivileges', 'initialEnvironmentClosed'}
        if not isinstance(facts, dict) or set(facts) != expected or any(value is not True for value in facts.values()):
            raise RuntimeError('CANARY_REJECTED')
        record['sourceUnchanged'] = fixture.read_bytes() == b'RCAC_SYNTHETIC_SOURCE\n'
        for attempt in range(20):
            terminal = show()
            if retained_terminal(terminal):
                break
            time.sleep(0.1)
        record['terminal'] = terminal
        record['originalGroupEmpty'] = retained_terminal(terminal)
        if not record['sourceUnchanged'] or not record['originalGroupEmpty']:
            raise RuntimeError('SOURCE_OR_EXIT_UNCONFIRMED')
except Exception as error:
    record['error'] = str(error)
finally:
    emit('cleanup_owned_resources')
    for listener in listeners:
        listener.close()
    record['listenersClosed'] = all(listener.fileno() == -1 for listener in listeners)
    try:
        current = show()
        # Original tuple check then stop is diagnostic, not atomic production CAS.
        if same(current) or retained_terminal(current):
            command(['/usr/bin/systemctl', '--user', 'stop', unit])
            current = show()
        record['afterCleanup'] = current
        record['unitAbsentOrEmpty'] = current['LoadState'] == 'not-found' or (same(current) and
            current['MainPID'] == '0' and current['ActiveState'] == 'inactive' and group_members(current) == [])
    except Exception as error:
        record['cleanupError'] = str(error)
    if child is not None:
        tail = [bytearray(), bytearray()]
        try:
            if child.stdin is not None:
                child.stdin.close()
                child.stdin = None
            drain(child, budget(5), tail,
                  (lambda stream, part: append_help_output(help_output, stream, part)) if help_only else None)
            record['bridgeStreamsComplete'] = True
        except Exception as error:
            record['bridgeCleanupError'] = str(error)
        finally:
            record['failureStdout'] = tail[0].decode('utf8', 'replace')
            record['failureStderr'] = tail[1].decode('utf8', 'replace')
    record['linuxBridgeExit'] = child.returncode if child is not None else None
    record['elapsedMs'] = round((time.monotonic() - started) * 1000)
    closed = bool('error' not in record and 'cleanupError' not in record and
        'bridgeCleanupError' not in record and record.get('unitAbsentOrEmpty') and
        record.get('originalGroupEmpty') and record.get('bridgeStreamsComplete') and
        record['linuxBridgeExit'] == 0 and record.get('sourceUnchanged'))
    record['containmentObserved'] = bool(not help_only and closed and
        record.get('failureStdout') == '' and record.get('failureStderr') == '')
    if help_only:
        help_stdout = record.get('helpStdout', '')
        help_stderr = record.get('helpStderr', '')
        record['helpObserved'] = bool(closed and help_stderr == '' and
            not record.get('helpOutputTruncated', False) and record.get('helpOutputBytes', 0) <= 65536 and
            all(marker in help_stdout for marker in ('Usage:', 'app-server', 'generate-json-schema')))
    print(json.dumps({'result': record}), flush=True)
    passed = record.get('helpObserved', False) if help_only else record['containmentObserved']
    sys.exit(0 if passed else 1)

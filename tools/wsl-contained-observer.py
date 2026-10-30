"""Fixed, tools-only WSL containment observation. No product admission decision.

The module is inert on import. A trusted caller executes it as
python3 -I -S - REQUEST_JSON with source on stdin in the synthetic fixture account.
Failures emit one bounded error frame, never a success frame. The pure facts
validator also supports offline synthetic tests.
"""
import hashlib
import json
import os
import pathlib
import re
import selectors
import stat
import subprocess
import sys
import time

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
NAMESPACES = ('user', 'pid', 'net', 'ipc', 'uts', 'cgroup', 'mnt')
SAVED = ('bootId', 'uid', 'unitName', 'invocationId', 'controlGroup',
         'mainPid', 'loadState', 'activeState', 'subState', 'cgroupState')
NATIVE = '/runtime/codex/package/vendor/x86_64-unknown-linux-musl/bin/codex'
RUNTIME = '/home/fixture/.local/repoconduit-codex-0.157.1'
NODE = '/home/fixture/.hermes/node/bin/node'
WRAPPER_HASH = '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70'
SEAL_SHA256 = '2a9db2058a98fce16c3c6b1aad62751a457f2d8833c1c4484bf701dbcf76b613'
MANAGEMENT_ENV = {'HOME': '/home/fixture', 'PATH': '/usr/bin:/bin',
                  'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
                  'XDG_RUNTIME_DIR': '/run/user/1000'}
DIAGNOSTIC = {'processes': {}, 'fds': {}}


def fail(code):
    raise RuntimeError(code)


def error_frame(error):
    code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z][A-Z0-9_]{1,63}', str(error)) else 'OBSERVER_FAILED'
    frame = {'error': code, 'metadata': DIAGNOSTIC}
    if code == 'OBSERVER_FAILED':
        kind = ('os' if isinstance(error, OSError) else 'encoding' if isinstance(error, UnicodeError)
                else 'value' if isinstance(error, ValueError) else 'other')
        number = error.errno if isinstance(error, OSError) else None
        frame['exception'] = {'kind': kind, 'errno': number if type(number) is int and 0 < number < 4096 else None}
    return frame


def root_for(id):
    return '/home/fixture/.local/repoconduit-private-homes/' + id


def unit_for(id):
    return 'rcac-investigator-' + id + '.service'


def group_for(uid, unit):
    return f'/user.slice/user-{uid}.slice/user@{uid}.service/app.slice/{unit}'


def validate_saved(saved, id):
    if not isinstance(saved, dict) or set(saved) not in (set(SAVED), set(SAVED) | {'groupMembers'}):
        fail('SAVED_SHAPE')
    if 'groupMembers' in saved:
        members = saved['groupMembers']
        if (not isinstance(members, list) or len(members) > 32 or
            any(type(pid) is not int or pid <= 0 for pid in members) or len(set(members)) != len(members)):
            fail('SAVED_MEMBERS')
    if saved['unitName'] != unit_for(id) or type(saved['uid']) is not int or saved['uid'] <= 0:
        fail('SAVED_IDENTITY')
    if saved['controlGroup'] != group_for(saved['uid'], saved['unitName']):
        fail('SAVED_GROUP')
    if not isinstance(saved['bootId'], str) or not UUID.fullmatch(saved['bootId']):
        fail('SAVED_BOOT')
    if not isinstance(saved['invocationId'], str) or not re.fullmatch('[0-9a-f]{32}', saved['invocationId']):
        fail('SAVED_INVOCATION')
    if type(saved['mainPid']) is not int or saved['mainPid'] <= 0:
        fail('SAVED_MAINPID')


def validate_request(request):
    if not isinstance(request, dict) or request.get('op') not in ('prepare', 'unit', 'payload', 'stop'):
        fail('REQUEST_OP')
    id = request.get('id')
    if not isinstance(id, str) or not UUID.fullmatch(id):
        fail('REQUEST_ID')
    allowed = {'op', 'id'} if request['op'] == 'prepare' else {'op', 'id', 'saved'}
    if set(request) != allowed:
        fail('REQUEST_KEYS')
    if request['op'] == 'unit' and request['saved'] is None:
        return request
    if request['op'] != 'prepare':
        validate_saved(request['saved'], id)
    return request


def bounded(path, limit=65536):
    with open(path, 'rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        fail('READ_LIMIT')
    return raw


def command(args):
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=MANAGEMENT_ENV, close_fds=True)
    output = bytearray()
    until = time.monotonic() + 2
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            selector.register(process.stderr, selectors.EVENT_READ)
            while selector.get_map():
                remaining = until - time.monotonic()
                if remaining <= 0:
                    fail('COMMAND_TIMEOUT')
                for key, _ in selector.select(remaining):
                    part = os.read(key.fileobj.fileno(), 4097)
                    if not part:
                        selector.unregister(key.fileobj)
                    elif key.fileobj is process.stderr:
                        fail('COMMAND_STDERR')
                    else:
                        output.extend(part)
                        if len(output) > 4096:
                            fail('COMMAND_LIMIT')
        process.wait(timeout=max(0.001, until - time.monotonic()))
        if process.returncode:
            fail('COMMAND_FAILED')
        return output.decode('utf8', 'strict')
    finally:
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=max(0.001, until - time.monotonic()))
            except subprocess.TimeoutExpired:
                fail('COMMAND_REAP_TIMEOUT')
        process.stdout.close()
        process.stderr.close()


def boot_uid():
    return bounded('/proc/sys/kernel/random/boot_id', 128).decode('ascii').strip(), os.getuid()


def show(id):
    raw = command(['/usr/bin/systemctl', '--user', 'show',
                   '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unit_for(id)])
    pairs = [line.split('=', 1) for line in raw.splitlines()]
    if any(len(pair) != 2 for pair in pairs) or len(pairs) != 7:
        fail('UNIT_SHOW_SHAPE')
    value = dict(pairs)
    if len(value) != 7 or value['Id'] != unit_for(id):
        fail('UNIT_SHOW_ID')
    return value


def group_members(saved):
    group = saved['controlGroup']
    if group != group_for(saved['uid'], saved['unitName']):
        fail('GROUP_PATH')
    path = pathlib.Path('/sys/fs/cgroup' + group)
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            fail('GROUP_LINK')
    if not path.exists():
        return []
    directories = [path]
    members = set()
    for directory in directories:
        for entry in directory.iterdir():
            if entry.is_symlink():
                fail('GROUP_LINK')
            if entry.is_dir():
                directories.append(entry)
        if len(directories) > 32:
            fail('GROUP_DIR_LIMIT')
        for item in bounded(directory / 'cgroup.procs').decode('ascii').split():
            if not item.isdigit() or int(item) <= 0:
                fail('GROUP_PID')
            members.add(int(item))
        if len(members) > 32:
            fail('GROUP_MEMBER_LIMIT')
    return sorted(members)


def group_exists(saved):
    path = pathlib.Path('/sys/fs/cgroup' + saved['controlGroup'])
    if any(ancestor.is_symlink() for ancestor in (path, *path.parents)):
        fail('GROUP_LINK')
    return path.exists()


def same_unit(saved, current, boot, uid):
    return (boot == saved['bootId'] and uid == saved['uid'] and
            current['Id'] == saved['unitName'] and current['LoadState'] == 'loaded' and
            current['InvocationID'] == saved['invocationId'] and
            current['ControlGroup'] in (saved['controlGroup'], '') and
            current['MainPID'] in (str(saved['mainPid']), '0'))


def unit_state(id, saved):
    before = show(id)
    boot, uid = boot_uid()
    if not same_unit(saved, before, boot, uid):
        fail('UNIT_CHANGED')
    members = group_members(saved)
    after = show(id)
    after_boot, after_uid = boot_uid()
    if after != before or (after_boot, after_uid) != (boot, uid):
        fail('UNIT_DRIFT')
    return before, members


def running(saved, current, members):
    return (current['ActiveState'] == 'active' and current['SubState'] == 'running' and
            current['MainPID'] == str(saved['mainPid']) and current['ControlGroup'] == saved['controlGroup'] and
            saved['mainPid'] in members)


def terminal(current, members):
    return (current['ActiveState'] == 'active' and current['SubState'] == 'exited' and
            current['MainPID'] == '0' and not members)


def expected_cmdline(role, id):
    # The fixed bwrap prefix is independently reconstructed here. Seal source
    # and the outer bootstrap's record are checked separately below.
    sandbox = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
               '--unshare-uts', '--unshare-cgroup', '--cap-drop', 'ALL',
               '--die-with-parent', '--new-session', '--clearenv',
               '--setenv', 'HOME', '/home/investigator', '--setenv', 'CODEX_HOME',
               '/home/investigator/.codex', '--setenv', 'PATH', '/node/bin:/usr/bin',
               '--seccomp', '3', '--ro-bind', '/usr/lib/x86_64-linux-gnu',
               '/usr/lib/x86_64-linux-gnu', '--ro-bind', '/usr/lib/python3.10',
               '/usr/lib/python3.10', '--ro-bind', '/usr/bin/python3.10',
               '/usr/bin/python3.10', '--symlink', 'usr/lib', '/lib', '--dir', '/lib64',
               '--symlink', '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
               '/lib64/ld-linux-x86-64.so.2', '--ro-bind', NODE, '/node/bin/node',
               '--ro-bind', RUNTIME, '/runtime/codex', '--ro-bind',
               root_for(id) + '/workspace', '/source', '--proc', '/proc', '--dev', '/dev',
               '--dir', '/etc', '--dir', '/run', '--perms', '0700', '--tmpfs',
               '/home/investigator', '--perms', '0700', '--dir', '/home/investigator/.codex',
               '--perms', '0700', '--tmpfs', '/scratch', '--tmpfs', '/tmp', '--chdir', '/source']
    base = ['/usr/bin/bwrap', *sandbox, '--', '/node/bin/node',
            '/runtime/codex/package/bin/codex.js', 'app-server', '--stdio']
    if role in ('monitor', 'sandbox'):
        return base[:-4] + ['/usr/bin/python3.10', '-I', '-S', '-c']
    if role == 'node':
        return base[-4:]
    if role == 'native':
        return [NATIVE, 'app-server', '--stdio']
    fail('PROCESS_ROLE')


def validate_pipe_record(record):
    if not isinstance(record, dict) or set(record) != {'pid', 'startTicks', 'bootId', 'uid', 'outerPidNs',
                                                        'stdio', 'stdioObjects', 'stdioAccess'}:
        fail('PIPE_METADATA')
    if (type(record['pid']) is not int or record['pid'] <= 0 or
        not isinstance(record['startTicks'], str) or not record['startTicks'].isdigit() or
        int(record['startTicks']) <= 0 or type(record['uid']) is not int or record['uid'] != 1000 or
        not isinstance(record['bootId'], str) or not UUID.fullmatch(record['bootId']) or
        not isinstance(record['outerPidNs'], str) or not re.fullmatch(r'pid:\[\d+\]', record['outerPidNs'])):
        fail('PIPE_METADATA')
    for key in ('stdio', 'stdioObjects', 'stdioAccess'):
        if not isinstance(record[key], dict) or set(record[key]) != {'0', '1', '2'}:
            fail('PIPE_METADATA')
    if (record['stdioAccess'] != {'0': 0, '1': 1, '2': 1} or
        any(type(value) is not int for value in record['stdioAccess'].values())):
        fail('PIPE_DIRECTION')
    objects = []
    for key in ('0', '1', '2'):
        link, obj = record['stdio'][key], record['stdioObjects'][key]
        if (not isinstance(link, str) or not re.fullmatch(r'pipe:\[\d{1,20}\]', link) or
            not isinstance(obj, list) or len(obj) != 2 or
            any(type(value) is not int or value <= 0 for value in obj)):
            fail('PIPE_METADATA')
        objects.append(tuple(obj))
    if len(set(objects)) != 3 or len(set(record['stdio'].values())) != 3:
        fail('PIPE_ALIAS')


def command_matches(role, cmd, id, record):
    if role not in ('monitor', 'sandbox'):
        return cmd == expected_cmdline(role, id)
    prefix = expected_cmdline(role, id)
    if (not isinstance(cmd, list) or len(cmd) != len(prefix) + 2 or
        cmd[:len(prefix)] != prefix or not isinstance(cmd[-2], str)):
        return False
    return (hashlib.sha256(cmd[-2].encode('utf8')).hexdigest() == SEAL_SHA256 and
            cmd[-1] == json.dumps(record, sort_keys=True, separators=(',', ':')))


def expected_sources(id):
    return {'/usr/lib/x86_64-linux-gnu': '/usr/lib/x86_64-linux-gnu',
            '/usr/lib/python3.10': '/usr/lib/python3.10',
            '/usr/bin/python3.10': '/usr/bin/python3.10',
            '/node/bin/node': NODE, '/runtime/codex': RUNTIME,
            '/source': root_for(id) + '/workspace'}


def expected_mounts(id):
    return [{'target': target, 'fstype': None, 'source': None, 'readonly': True,
             'backing': None} for target, source in expected_sources(id).items()] + [
        {'target': path, 'fstype': kind, 'source': source, 'readonly': False, 'backing': None}
        for path, kind, source in (('/', 'tmpfs', 'tmpfs'), ('/proc', 'proc', 'proc'),
                           ('/dev', 'tmpfs', 'tmpfs'), ('/dev/null', 'devtmpfs', 'none'),
                           ('/dev/zero', 'devtmpfs', 'none'), ('/dev/full', 'devtmpfs', 'none'),
                           ('/dev/random', 'devtmpfs', 'none'), ('/dev/urandom', 'devtmpfs', 'none'),
                           ('/dev/tty', 'devtmpfs', 'none'), ('/dev/pts', 'devpts', 'devpts'),
                           ('/home/investigator', 'tmpfs', 'tmpfs'), ('/scratch', 'tmpfs', 'tmpfs'),
                           ('/tmp', 'tmpfs', 'tmpfs'))]


def exact_env(raw, role):
    if not isinstance(raw, bytes) or len(raw) > 4096 or not raw.endswith(b'\0'):
        fail('ENV_TAIL')
    entries = raw[:-1].split(b'\0')
    expected = [b'HOME=/home/investigator', b'CODEX_HOME=/home/investigator/.codex',
                b'PATH=/node/bin:/usr/bin', b'PWD=/source']
    if role == 'native':
        expected += [b'CODEX_MANAGED_PACKAGE_ROOT=/runtime/codex/package', b'CODEX_MANAGED_BY_NPM=1']
    if len(entries) != len(expected) or len(set(entries)) != len(expected) or set(entries) != set(expected):
        fail('ENV_UNCLOSED')


def parse_epoll_fdinfo(raw):
    """Parse only the documented fdinfo base and epoll tfd records, including zero watches."""
    if not isinstance(raw, bytes) or not raw or len(raw) > 4096 or not raw.endswith(b'\n'):
        fail('POLL_FDINFO_BOUNDARY')
    try:
        lines = raw.decode('ascii', 'strict').split('\n')[:-1]
    except UnicodeDecodeError:
        fail('POLL_FDINFO_ASCII')
    if len(lines) < 4:
        fail('POLL_FDINFO_BASE')
    patterns = {'pos': r'[0-9]{1,20}', 'flags': r'[0-7]{1,12}',
                'mnt_id': r'[0-9]{1,10}', 'ino': r'[0-9]{1,20}'}
    base = {}
    for line in lines[:4]:
        match = re.fullmatch(r'(pos|flags|mnt_id|ino):[ \t]*([0-9]+)', line)
        if not match or match.group(1) in base or not re.fullmatch(patterns[match.group(1)], match.group(2)):
            fail('POLL_FDINFO_BASE')
        base[match.group(1)] = int(match.group(2), 8 if match.group(1) == 'flags' else 10)
    if set(base) != set(patterns):
        fail('POLL_FDINFO_BASE')
    targets = []
    seen = set()
    watch_pattern = (r'tfd:[ \t]*([0-9]{1,10})[ \t]+events:[ \t]*([0-9a-fA-F]{1,8})'
                     r'[ \t]+data:[ \t]*([0-9a-fA-F]{1,16})[ \t]+pos:[ \t]*([0-9]{1,20})'
                     r'[ \t]+ino:[ \t]*([0-9a-fA-F]{1,16})[ \t]+sdev:[ \t]*([0-9a-fA-F]{1,16})')
    for line in lines[4:]:
        match = re.fullmatch(watch_pattern, line)
        if not match:
            fail('POLL_FDINFO_WATCH')
        tfd = int(match.group(1), 10)
        if tfd in seen or len(targets) >= 64:
            fail('POLL_TARGETS')
        seen.add(tfd)
        targets.append({'tfd': tfd, 'events': int(match.group(2), 16),
                        'data': int(match.group(3), 16), 'pos': int(match.group(4), 10),
                        'ino': int(match.group(5), 16), 'sdev': int(match.group(6), 16)})
    return dict(base, targets=targets)


def validate_poll_targets(targets, fds, objects):
    if not isinstance(targets, list) or len(targets) > 64 or len({item['tfd'] for item in targets}) != len(targets):
        fail('POLL_TARGETS')
    for item in targets:
        target = item['tfd']
        if target not in fds or target not in objects:
            fail('POLL_UNKNOWN')
        dev, inode = objects[target]
        try:
            major, minor = os.major(dev), os.minor(dev)
        except (AttributeError, OverflowError, ValueError):
            fail('POLL_DEVICE_UNVERIFIED')
        if major > 255 or minor > 255 or major < 0 or minor < 0:
            fail('POLL_DEVICE_UNVERIFIED')
        # fdinfo's sdev/ino bind the current target object. They do not prove
        # the complete history of an open file description.
        if item['sdev'] != ((major << 8) | minor) or item['ino'] != inode:
            fail('POLL_OBJECT_MISMATCH')


def validate_pipe_pair(node, others, pipes, sealed):
    if not sealed:
        fail('PIPE_SEAL')
    extras = [(fd, link) for fd, link in node['fds'].items() if fd > 2 and link.startswith('pipe:[')]
    if not extras:
        return set()
    if len(extras) > 8:
        fail('PIPE_PAIR_LIMIT')
    groups = {}
    for fd, link in extras:
        if (fd not in node['fdObjects'] or fd not in node['fdFifos'] or
            not re.fullmatch(r'pipe:\[\d{1,20}\]', link) or
            node['fdObjects'][fd][1] != int(link[6:-1])):
            fail('PIPE_PAIR')
        groups.setdefault(node['fdObjects'][fd], []).append((fd, link))
    if len(groups) > 4:
        fail('PIPE_PAIR_LIMIT')
    read_flags, write_flags = {0o2000000, 0o2004000}, {0o2000001, 0o2004001}
    stdio_objects = {tuple(value) for value in pipes['stdioObjects'].values()}
    seen_links = set()
    for pair_object, endpoints in groups.items():
        if len(endpoints) != 2 or endpoints[0][1] != endpoints[1][1]:
            fail('PIPE_PAIR')
        if endpoints[0][1] in seen_links:
            fail('PIPE_ALIAS')
        seen_links.add(endpoints[0][1])
        flags = [node['fdFlags'].get(fd) for fd, _ in endpoints]
        if not ((flags[0] in read_flags and flags[1] in write_flags) or
                (flags[1] in read_flags and flags[0] in write_flags)):
            fail('PIPE_DIRECTION')
        if (pair_object in stdio_objects or
            any(obj == pair_object for proc in others for obj in proc['fdObjects'].values()) or
            any(obj == pair_object for fd, obj in node['fdObjects'].items()
                if fd not in {endpoints[0][0], endpoints[1][0]})):
            fail('PIPE_ALIAS')
    return {fd for fd, _ in extras}


def validate_fds(proc, pipes, sockets, mounts, allowed_pipes=None):
    DIAGNOSTIC.pop('rejectedFd', None)
    allowed_pipes = set() if allowed_pipes is None else allowed_pipes
    fds = proc['fds']
    if len(fds) > 64 or set(range(3)) - set(fds):
        fail('FD_LIMIT')
    for fd in range(3):
        if fds[fd] != pipes['stdio'][str(fd)] or not re.fullmatch(r'pipe:\[\d+\]', fds[fd]):
            fail('STDIO_CHAIN')
    for fd, link in fds.items():
        if fd < 3:
            continue
        kind = ('pipe' if link.startswith('pipe:[') else 'socket' if link.startswith('socket:[')
                else 'io_uring' if link == 'anon_inode:[io_uring]' else
                'eventfd' if link == 'anon_inode:[eventfd]' else
                'eventpoll' if link == 'anon_inode:[eventpoll]' else
                'anon_inode' if link.startswith('anon_inode:') else
                'file' if link.startswith('/') else 'unknown')
        DIAGNOSTIC['rejectedFd'] = {'role': proc['role'], 'pid': proc['pid'],
                                    'startTicks': str(proc['startTicks']), 'index': fd, 'kind': kind}
        if fd in allowed_pipes and link.startswith('pipe:['):
            if fd not in proc['fdFifos']:
                fail('PIPE_TYPE')
        elif re.fullmatch(r'socket:\[(\d+)\]', link):
            if int(link[8:-1]) not in sockets:
                fail('SOCKET_UNKNOWN')
        elif link == 'anon_inode:[eventfd]':
            if fd not in proc.get('eventfds', set()):
                fail('EVENTFD_UNVERIFIED')
        elif link == 'anon_inode:[eventpoll]':
            if fd not in proc.get('pollTargets', {}):
                fail('POLL_UNKNOWN')
            validate_poll_targets(proc['pollTargets'][fd], fds, proc['fdObjects'])
        elif link.startswith('/'):
            mount = next((item for item in mounts if item['id'] == proc['fdMounts'].get(fd)), None)
            if mount is not None and mount['target'] in ('/', '/proc', '/dev', '/dev/pts'):
                fail('FD_BROAD_MOUNT')
            if (mount is None or not (link == mount['target'] or
                link.startswith(mount['target'].rstrip('/') + '/')) or
                fd not in proc['fdFlags'] or (mount['readonly'] and proc['fdFlags'][fd] & 3 != 0)):
                fail('FD_PATH')
            if proc['fdObjects'].get(fd) is None or proc['fdObjects'].get(fd) != proc['pathObjects'].get(link):
                fail('FD_OBJECT')
        else:
            fail('FD_UNKNOWN')
        DIAGNOSTIC.pop('rejectedFd', None)


def validate_payload_facts(facts):
    id = facts['id']
    if not UUID.fullmatch(id) or facts['uid'] != 1000 or not facts['unitStable']:
        fail('PAYLOAD_CONTEXT')
    procs = facts['processes']
    members = facts['members']
    if len(procs) != 4 or len(members) != 4 or set(members) != {p['pid'] for p in procs}:
        fail('PROCESS_COUNT')
    monitor, sandbox, node, native = procs
    for role, proc in zip(('monitor', 'sandbox', 'node', 'native'), procs):
        if proc['role'] != role or proc['uid'] != facts['uid'] or not command_matches(role, proc['cmdline'], id, facts['pipes']):
            fail('PROCESS_IDENTITY')
        if not str(proc['startTicks']).isdigit() or int(proc['startTicks']) <= 0:
            fail('PROCESS_START')
        exe = {'monitor': '/usr/bin/bwrap', 'sandbox': '/usr/bin/bwrap',
               'node': '/node/bin/node', 'native': NATIVE}[role]
        if proc['exe'] != exe:
            fail('PROCESS_EXE')
    if monitor['pid'] != facts['mainPid'] or sandbox['ppid'] != monitor['pid'] or node['ppid'] != sandbox['pid'] or native['ppid'] != node['pid']:
        fail('PROCESS_TREE')
    if sandbox['nsPid'][-1] != 1 or node['nsPid'][-1] <= 1 or native['nsPid'][-1] <= 1:
        fail('PID_NAMESPACE_TREE')
    if sandbox['ns'] != node['ns']:
        fail('SANDBOX_NAMESPACE')
    if node['root'] != native['root'] or node['root'] == facts['hostRoot'] or node['cwd'] != facts['workspace'] or native['cwd'] != facts['workspace']:
        fail('ROOT_CWD')
    for proc in (node, native):
        if set(proc['ns']) != set(NAMESPACES) or any(proc['ns'][name] != node['ns'][name] or proc['ns'][name] == facts['hostNs'][name] for name in NAMESPACES):
            fail('NAMESPACE')
        exact_env(proc['env'], proc['role'])
        status = proc['status']
        if any(int(status[key], 16) != 0 for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')) or status['NoNewPrivs'] != '1' or status['Seccomp'] != '2':
            fail('PROCESS_STATUS')
    validate_pipe_record(facts['pipes'])
    if (facts['pipes']['pid'] != monitor['pid'] or facts['pipes']['startTicks'] != monitor['startTicks'] or
        facts['pipes']['bootId'] != facts['bootId'] or facts['pipes']['uid'] != facts['uid'] or
        facts['pipes']['outerPidNs'] != facts['hostNs']['pid']):
        fail('PIPE_METADATA')
    for proc in procs:
        for fd in range(3):
            key = str(fd)
            if (proc['fds'].get(fd) != facts['pipes']['stdio'][key] or
                proc['fdObjects'].get(fd) != tuple(facts['pipes']['stdioObjects'][key]) or
                proc['fdFlags'].get(fd, -1) & 3 != facts['pipes']['stdioAccess'][key] or
                fd not in proc['fdFifos']):
                fail('STDIO_CHAIN')
    if len(facts['mounts']) != 19 or {m['target'] for m in facts['mounts']} != {m['target'] for m in expected_mounts(id)}:
        fail('MOUNT_GRAPH')
    if (set(facts['sources']) != set(expected_sources(id)) or
        set(facts['hostBackings']) != set(expected_sources(id)) or
        any(not isinstance(item, tuple) or len(item) != 2 or item[0] <= 0 or item[1] <= 0
            for item in facts['sources'].values())):
        fail('MOUNT_BACKING_SHAPE')
    for mount in facts['mounts']:
        expected = next(m for m in expected_mounts(id) if m['target'] == mount['target'])
        backing = facts['hostBackings'].get(mount['target'])
        if backing is not None:
            if (not mount['readonly'] or mount['root'] != backing['root'] or
                mount['fstype'] != backing['fstype'] or mount['source'] != backing['source'] or
                mount['dev'] != backing['dev']):
                fail('MOUNT_HOST_BACKING')
        elif {k: mount[k] for k in ('fstype', 'source', 'readonly')} != {k: expected[k] for k in ('fstype', 'source', 'readonly')}:
            fail('MOUNT_GRAPH')
        if mount['target'] in facts['sources'] and mount['backing'] != facts['sources'][mount['target']]:
            fail('MOUNT_BACKING')
    if any('parent' in mount for mount in facts['mounts']):
        if not all('parent' in mount and 'id' in mount for mount in facts['mounts']):
            fail('MOUNT_PARENT')
        by_target = {mount['target']: mount for mount in facts['mounts']}
        root_id = by_target['/']['id']
        dev_id = by_target['/dev']['id']
        for mount in facts['mounts']:
            if mount['target'] == '/':
                if mount['parent'] in {item['id'] for item in facts['mounts']}:
                    fail('MOUNT_ROOT_PARENT')
            elif mount['parent'] != (dev_id if mount['target'].startswith('/dev/') else root_id):
                fail('MOUNT_PARENT')
    allowed_pipes = validate_pipe_pair(node, (monitor, sandbox, native), facts['pipes'],
                                       command_matches('monitor', monitor['cmdline'], id, facts['pipes']) and
                                       command_matches('sandbox', sandbox['cmdline'], id, facts['pipes']))
    validate_fds(node, facts['pipes'], facts['sockets'], facts['mounts'], allowed_pipes)
    validate_fds(native, facts['pipes'], facts['sockets'], facts['mounts'])
    return {'closed': True, 'mainPid': monitor['pid'], 'nodePid': node['pid'],
            'nativePid': native['pid'], 'members': members}


def object_id(path):
    info = os.stat(path)
    return (info.st_dev, info.st_ino)


def checked_path(path, uid, directory=None):
    target = pathlib.Path(path)
    for ancestor in (target, *target.parents):
        info = ancestor.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022 or info.st_uid not in (0, uid):
            fail('BACKING_ANCESTOR')
        private = (str(ancestor).startswith(RUNTIME + '/') or str(ancestor) == RUNTIME or
                   str(ancestor).startswith('/home/fixture/.hermes/node/') or
                   str(ancestor).startswith('/home/fixture/.local/repoconduit-private-homes/'))
        if private and info.st_uid != uid:
            fail('PRIVATE_BACKING_OWNER')
        if stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o111:
            fail('BACKING_NOT_TRAVERSABLE')
    info = target.stat()
    if info.st_uid != uid or (directory is True and not stat.S_ISDIR(info.st_mode)) or (
        directory is False and not stat.S_ISREG(info.st_mode)):
        fail('BACKING_OWNER_TYPE')
    return info


def layout_names(path, limit=32):
    with os.scandir(path) as entries:
        names = []
        for entry in entries:
            names.append(entry.name)
            if len(names) > limit:
                fail('PACKAGE_LAYOUT_LIMIT')
    return set(names)


def no_submounts(paths):
    lines = bounded('/proc/self/mountinfo').decode('utf8', 'strict').splitlines()
    for line in lines:
        left = line.split(' - ', 1)[0].split()
        if len(left) < 5:
            fail('HOST_MOUNT_PARSE')
        mounted = left[4]
        if any(mounted == path or mounted.startswith(path.rstrip('/') + '/') for path in paths):
            fail('BACKING_SUBMOUNT')


def parse_stat(pid):
    raw = bounded(f'/proc/{pid}/stat', 4096).decode('ascii')
    close = raw.rfind(')')
    if close < 0 or not raw[:raw.find(' ')].isdigit():
        fail('PROC_STAT')
    fields = raw[close + 2:].split()
    if len(fields) < 20 or int(raw[:raw.find(' ')]) != pid:
        fail('PROC_STAT')
    return int(fields[1]), fields[19]


def parse_mounts(pid, id):
    raw = bounded(f'/proc/{pid}/mountinfo').decode('utf8', 'strict')
    mounts = []
    for line in raw.splitlines():
        before, sep, after = line.partition(' - ')
        left, right = before.split(), after.split()
        if not sep or len(left) < 6 or len(right) < 3 or '\\' in left[3] + left[4]:
            fail('MOUNT_PARSE')
        target = left[4]
        mounts.append({'id': int(left[0]), 'root': left[3], 'target': target,
                       'parent': int(left[1]),
                       'dev': left[2],
                       'fstype': right[0], 'source': right[1],
                       'readonly': 'ro' in left[5].split(','), 'backing': None})
    if len(mounts) != 19:
        fail('MOUNT_COUNT')
    roots = {'/': '/newroot', '/dev/null': '/null', '/dev/zero': '/zero',
             '/dev/full': '/full', '/dev/random': '/random',
             '/dev/urandom': '/urandom', '/dev/tty': '/tty'}
    for mount in mounts:
        if mount['root'] != roots.get(mount['target'], expected_sources(id).get(mount['target'], '/')):
            fail('MOUNT_ROOT')
    host_lines = bounded('/proc/self/mountinfo').decode('utf8', 'strict').splitlines()
    host_mounts = []
    for line in host_lines:
        before, sep, after = line.partition(' - ')
        left, right = before.split(), after.split()
        if not sep or len(left) < 6 or len(right) < 2:
            fail('HOST_MOUNT_PARSE')
        host_mounts.append((left[4], right[0], right[1]))
    sources, host_backings = {}, {}
    for target, source in expected_sources(id).items():
        checked_path(source, 0 if source.startswith('/usr/') else 1000,
                     target in ('/usr/lib/x86_64-linux-gnu', '/usr/lib/python3.10',
                                '/runtime/codex', '/source'))
        if any(point == source or point.startswith(source.rstrip('/') + '/') for point, _, _ in host_mounts):
            fail('BACKING_SUBMOUNT')
        mount = next((m for m in mounts if m['target'] == target), None)
        if mount is None or mount['root'] != source:
            fail('MOUNT_SOURCE')
        source_info = os.stat(source)
        sources[target] = (source_info.st_dev, source_info.st_ino)
        mount['backing'] = object_id(f'/proc/{pid}/root{target}')
        candidates = [m for m in host_mounts if source == m[0] or source.startswith(m[0].rstrip('/') + '/')]
        if not candidates:
            fail('HOST_MOUNT_SOURCE')
        covering = max(candidates, key=lambda m: len(m[0]))
        host_backings[target] = {'root': source, 'fstype': covering[1], 'source': covering[2],
                                 'dev': f'{os.major(source_info.st_dev)}:{os.minor(source_info.st_dev)}'}
    return mounts, sources, host_backings


def parse_status(pid):
    raw = bounded(f'/proc/{pid}/status').decode('ascii', 'strict')
    values = dict(line.split(':', 1) for line in raw.splitlines() if ':' in line)
    wanted = ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp')
    if any(key not in values for key in wanted):
        fail('STATUS_FIELDS')
    uid = values.get('Uid', '').split()
    if len(uid) != 4 or len(set(uid)) != 1:
        fail('STATUS_UID')
    ns_pid = values.get('NSpid', '').split()
    if not ns_pid or any(not item.isdigit() or int(item) <= 0 for item in ns_pid):
        fail('STATUS_NSPID')
    return int(uid[0]), {key: values[key].strip() for key in wanted}, [int(item) for item in ns_pid]


def parse_environ(pid):
    return bounded(f'/proc/{pid}/environ', 4096)


def socket_inodes(pid):
    found = set()
    for name in ('unix', 'tcp', 'tcp6', 'udp', 'udp6'):
        lines = bounded(f'/proc/{pid}/net/{name}').decode('ascii', 'strict').splitlines()
        if len(lines) > 256:
            fail('SOCKET_TABLE_LIMIT')
        for line in lines[1:]:
            parts = line.split()
            index = 6 if name == 'unix' else 9
            if len(parts) <= index or not parts[index].isdigit():
                fail('SOCKET_TABLE')
            found.add(int(parts[index]))
    return found


def read_fds(pid):
    DIAGNOSTIC['readFailure'] = {'site': 'fd-enumerate', 'pid': pid}
    base = pathlib.Path(f'/proc/{pid}/fd')
    names = list(base.iterdir())
    if len(names) > 64:
        fail('FD_LIMIT')
    DIAGNOSTIC['fds'][str(pid)] = []
    fds, flags, poll, mount_ids, objects, path_objects, eventfds, fifos = {}, {}, {}, {}, {}, {}, set(), set()
    for path in names:
        if not path.name.isdigit():
            fail('FD_NAME')
        fd = int(path.name)
        DIAGNOSTIC['readFailure'] = {'site': 'fd-link', 'pid': pid, 'fd': fd}
        link = os.readlink(path)
        kind = ('pipe' if link.startswith('pipe:[') else 'socket' if link.startswith('socket:[')
                else 'anon_inode' if link.startswith('anon_inode:') else 'file' if link.startswith('/') else 'unknown')
        item = {'index': fd, 'type': kind, 'linkHash': hashlib.sha256(link.encode('utf8', 'surrogateescape')).hexdigest()}
        DIAGNOSTIC['fds'][str(pid)].append(item)
        DIAGNOSTIC['readFailure']['site'] = 'fd-info'
        info_raw = bounded(f'/proc/{pid}/fdinfo/{fd}', 4096)
        DIAGNOSTIC['readFailure']['site'] = 'fd-parse'
        info = info_raw.decode('ascii', 'strict')
        values = dict(line.split(':', 1) for line in info.splitlines() if ':' in line)
        epoll = parse_epoll_fdinfo(info_raw) if link == 'anon_inode:[eventpoll]' else None
        if 'flags' not in values and epoll is None:
            fail('FD_INFO')
        flags[fd] = epoll['flags'] if epoll is not None else int(values['flags'].strip(), 8)
        item['flags'] = flags[fd]
        mount_id = epoll['mnt_id'] if epoll is not None else (
            int(values['mnt_id'].strip()) if values.get('mnt_id', '').strip().isdigit() else None)
        if mount_id is not None:
            item['mountId'] = mount_id
        fds[fd] = link
        DIAGNOSTIC['readFailure']['site'] = 'fd-object'
        objects[fd] = object_id(path)
        DIAGNOSTIC['readFailure']['site'] = 'fd-type'
        if stat.S_ISFIFO(os.stat(path).st_mode):
            fifos.add(fd)
        if link.startswith('/'):
            if mount_id is None or '(deleted)' in link:
                fail('FD_MOUNT_ID')
            mount_ids[fd] = mount_id
            mode = os.stat(path).st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or
                    (link in ('/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom', '/dev/tty') and stat.S_ISCHR(mode))):
                fail('FD_FILE_TYPE')
            DIAGNOSTIC['readFailure']['site'] = 'fd-path-object'
            path_objects[link] = object_id(f'/proc/{pid}/root{link}')
        if link == 'anon_inode:[eventpoll]':
            poll[fd] = epoll['targets']
        if link == 'anon_inode:[eventfd]':
            if 'eventfd-count' not in values or 'eventfd-id' not in values:
                fail('EVENTFD_INFO')
            eventfds.add(fd)
    DIAGNOSTIC.pop('readFailure', None)
    return fds, flags, poll, mount_ids, objects, path_objects, eventfds, fifos


def read_process(pid, role, id):
    DIAGNOSTIC['readFailure'] = {'site': 'process-stat', 'pid': pid}
    ppid, start = parse_stat(pid)
    DIAGNOSTIC['readFailure']['site'] = 'process-status'
    uid, status, ns_pid = parse_status(pid)
    DIAGNOSTIC['readFailure']['site'] = 'process-namespaces'
    namespaces = {name: os.readlink(f'/proc/{pid}/ns/{name}') for name in NAMESPACES}
    DIAGNOSTIC['processes'][str(pid)] = {'pid': pid, 'startTicks': start, 'namespaces': namespaces}
    DIAGNOSTIC['readFailure']['site'] = 'process-cmdline'
    raw_cmd = bounded(f'/proc/{pid}/cmdline', 65536)
    if not raw_cmd.endswith(b'\0'):
        fail('CMDLINE_TAIL')
    cmd = [part.decode('utf8', 'strict') for part in raw_cmd[:-1].split(b'\0')]
    fds, flags, poll, mount_ids, objects, path_objects, eventfds, fifos = read_fds(pid)
    DIAGNOSTIC['readFailure'] = {'site': 'process-tail', 'pid': pid}
    result = {'pid': pid, 'ppid': ppid, 'startTicks': start, 'uid': uid,
            'role': role, 'cmdline': cmd, 'exe': os.readlink(f'/proc/{pid}/exe'),
            'nsPid': ns_pid,
            'exeObject': object_id(f'/proc/{pid}/exe'),
            'root': object_id(f'/proc/{pid}/root'), 'cwd': object_id(f'/proc/{pid}/cwd'),
            'ns': namespaces,
            'env': parse_environ(pid) if role in ('node', 'native') else b'',
            'status': status, 'fds': fds, 'fdFlags': flags, 'pollTargets': poll,
            'fdMounts': mount_ids, 'fdObjects': objects, 'pathObjects': path_objects,
            'eventfds': eventfds, 'fdFifos': fifos}
    DIAGNOSTIC.pop('readFailure', None)
    return result


def payload_summary(facts):
    processes = []
    for proc in facts['processes']:
        fds = []
        for index, link in sorted(proc['fds'].items()):
            kind = ('pipe' if link.startswith('pipe:[') else 'socket' if link.startswith('socket:[')
                    else 'eventfd' if link == 'anon_inode:[eventfd]' else
                    'eventpoll' if link == 'anon_inode:[eventpoll]' else 'file')
            entry = {'index': index, 'type': kind, 'flags': proc['fdFlags'][index],
                     'mountId': proc['fdMounts'].get(index),
                     'object': list(proc['fdObjects'][index]) if index in proc['fdObjects'] else None,
                     'pipeBinding': index < 3 and link == facts['pipes']['stdio'][str(index)],
                     'pollTargets': proc['pollTargets'].get(index, []),
                     'socketInode': int(link[8:-1]) if kind == 'socket' else None}
            if kind == 'pipe':
                entry['pipeInode'] = int(link[6:-1])
            fds.append(entry)
        env_keys = (['HOME', 'CODEX_HOME', 'PATH', 'PWD'] +
                    (['CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_MANAGED_BY_NPM'] if proc['role'] == 'native' else []))
        processes.append({'role': proc['role'], 'pid': proc['pid'], 'ppid': proc['ppid'],
                          'startTicks': proc['startTicks'], 'uid': proc['uid'],
                          'exeObject': list(proc['exeObject']), 'root': list(proc['root']),
                          'cwd': list(proc['cwd']), 'namespaces': proc['ns'],
                          'nsPid': proc['nsPid'], 'status': proc['status'],
                          'environment': {'exact': True, 'keys': env_keys} if proc['role'] in ('node', 'native') else None,
                          'fds': fds})
    mounts = [{'id': mount['id'], 'parent': mount['parent'], 'target': mount['target'],
               'root': mount['root'], 'source': mount['source'], 'dev': mount['dev'],
               'readonly': mount['readonly'],
               'backing': list(mount['backing']) if mount['backing'] is not None else None}
              for mount in facts['mounts']]
    return {'processes': processes, 'mounts': mounts, 'members': facts['members'],
            'hostRoot': list(facts['hostRoot']), 'workspace': list(facts['workspace']),
            'hostNamespaces': facts['hostNs'], 'stdio': facts['pipes']}


def collect_payload(id, saved):
    before, members = unit_state(id, saved)
    if not running(saved, before, members) or len(members) != 4:
        fail('UNIT_NOT_RUNNING')
    pipes = json.loads(bounded(root_for(id) + '/launch-pipes.json', 4096))
    validate_pipe_record(pipes)
    # Assignment uses complete argv/executable, not a process name.
    snapshots = [read_process(pid, 'monitor', id) for pid in members]
    roles = []
    for proc in snapshots:
        cmd = proc['cmdline']
        exe = proc['exeObject']
        if command_matches('monitor', cmd, id, pipes) and exe == object_id('/usr/bin/bwrap'):
            roles.append('bwrap')
        elif cmd == expected_cmdline('node', id) and exe == object_id(NODE):
            roles.append('node')
        elif cmd == expected_cmdline('native', id) and exe == object_id(RUNTIME + '/package/vendor/x86_64-unknown-linux-musl/bin/codex'):
            roles.append('native')
        else:
            fail('PROCESS_UNKNOWN')
    if roles.count('bwrap') != 2 or roles.count('node') != 1 or roles.count('native') != 1:
        fail('PROCESS_COUNT')
    by_pid = {proc['pid']: proc for proc in snapshots}
    monitor = by_pid.get(saved['mainPid'])
    if monitor is None or roles[snapshots.index(monitor)] != 'bwrap':
        fail('MAINPID_ROLE')
    sandbox = next((p for p in snapshots if p['ppid'] == monitor['pid'] and p['pid'] != monitor['pid']), None)
    node = next((p for p, role in zip(snapshots, roles) if role == 'node'), None)
    native = next((p for p, role in zip(snapshots, roles) if role == 'native'), None)
    if sandbox is None or node is None or native is None or sandbox['ppid'] != monitor['pid'] or node['ppid'] != sandbox['pid'] or native['ppid'] != node['pid']:
        fail('PROCESS_TREE')
    # Re-read the two payloads with their now-proven roles so initial exec
    # environ is collected before any protocol frame can be sent.
    first_node, first_native = node, native
    node = read_process(node['pid'], 'node', id)
    native = read_process(native['pid'], 'native', id)
    for before_role, after_role in ((first_node, node), (first_native, native)):
        if any(before_role[key] != after_role[key] for key in ('startTicks', 'ppid', 'exeObject', 'root', 'ns')):
            fail('PROCESS_DRIFT')
    for proc, role in ((monitor, 'monitor'), (sandbox, 'sandbox'), (node, 'node'), (native, 'native')):
        proc['role'] = role
        proc['exe'] = {'monitor': '/usr/bin/bwrap', 'sandbox': '/usr/bin/bwrap',
                       'node': '/node/bin/node', 'native': NATIVE}[role]
    mount_items, sources, host_backings = parse_mounts(node['pid'], id)
    if bounded(f'/proc/{node["pid"]}/mountinfo') != bounded(f'/proc/{native["pid"]}/mountinfo'):
        fail('MOUNT_MISMATCH')
    facts = {'id': id, 'uid': saved['uid'], 'mainPid': saved['mainPid'], 'members': members,
             'processes': [monitor, sandbox, node, native], 'hostNs': {
                 name: os.readlink('/proc/self/ns/' + name) for name in NAMESPACES},
             'hostRoot': object_id('/'), 'workspace': object_id(root_for(id) + '/workspace'),
             'pipes': pipes, 'bootId': saved['bootId'], 'mounts': mount_items,
             'sources': sources, 'hostBackings': host_backings,
             'sockets': socket_inodes(native['pid']), 'unitStable': True}
    result = validate_payload_facts(facts)
    after, after_members = unit_state(id, saved)
    if after != before or after_members != members:
        fail('UNIT_DRIFT')
    second_procs = []
    for proc in facts['processes']:
        fresh = read_process(proc['pid'], proc['role'], id)
        fresh['exe'] = proc['exe']
        second_procs.append(fresh)
    second_mounts, second_sources, second_backings = parse_mounts(node['pid'], id)
    if bounded(f'/proc/{node["pid"]}/mountinfo') != bounded(f'/proc/{native["pid"]}/mountinfo'):
        fail('MOUNT_DRIFT')
    second = dict(facts, processes=second_procs, mounts=second_mounts,
                  sources=second_sources, hostBackings=second_backings,
                  sockets=socket_inodes(native['pid']),
                  pipes=json.loads(bounded(root_for(id) + '/launch-pipes.json', 4096)),
                  hostNs={name: os.readlink('/proc/self/ns/' + name) for name in NAMESPACES},
                  hostRoot=object_id('/'), workspace=object_id(root_for(id) + '/workspace'))
    validate_payload_facts(second)
    if second != facts:
        fail('PAYLOAD_DRIFT')
    final, final_members = unit_state(id, saved)
    if final != before or final_members != members:
        fail('UNIT_DRIFT')
    result['facts'] = {key: True for key in ('processTreeMatched', 'namespacesMatched',
        'mountsMatched', 'environmentMatched', 'privilegesMatched', 'stdioMatched', 'fdScopeMatched')}
    result['metadata'] = {'stable': True, 'snapshots': [payload_summary(facts), payload_summary(second)]}
    if len(json.dumps(result, separators=(',', ':')).encode('utf8')) > 65536:
        fail('PAYLOAD_SUMMARY_LIMIT')
    return result


def prepare(id):
    initial = show(id)
    if initial['LoadState'] != 'not-found':
        fail('UNIT_EXISTS')
    boot, uid = boot_uid()
    if uid != 1000 or not UUID.fullmatch(boot):
        fail('OBSERVER_UID_BOOT')
    # Fixed points only; no scan of an installed runtime tree.
    system = ('/usr/bin/bwrap', '/usr/bin/python3.10', '/usr/lib/python3.10',
              '/usr/lib/x86_64-linux-gnu',
              '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2')
    for path in system:
        info = checked_path(path, 0, path.endswith('python3.10') and path.startswith('/usr/lib') or
                            path == '/usr/lib/x86_64-linux-gnu')
        if not stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o111:
            fail('DEPENDENCY_NOT_EXECUTABLE')
    if not checked_path(NODE, uid, False).st_mode & 0o111:
        fail('NODE_NOT_EXECUTABLE')
    checked_path(RUNTIME, uid, True)
    parent = pathlib.Path(root_for(id)).parent
    checked_path(parent, uid, True)
    if parent.stat().st_mode & 0o077:
        fail('PRIVATE_PARENT')
    package = json.loads(bounded(RUNTIME + '/package/package.json'))
    if package.get('version') != '0.157.1' or not pathlib.Path(RUNTIME + '/package/vendor/x86_64-unknown-linux-musl/bin/codex').is_file():
        fail('PACKAGE_LAYOUT')
    if (layout_names(RUNTIME) != {'bin', 'package'} or
        layout_names(RUNTIME + '/package') != {'README.md', 'bin', 'package.json', 'vendor'} or
        layout_names(RUNTIME + '/package/vendor') != {'x86_64-unknown-linux-musl'}):
        fail('PACKAGE_LAYOUT')
    wrapper = RUNTIME + '/package/bin/codex.js'
    native = RUNTIME + '/package/vendor/x86_64-unknown-linux-musl/bin/codex'
    for name in (wrapper, native, RUNTIME + '/package/package.json'):
        info = checked_path(name, uid, False)
        if name == native and not info.st_mode & 0o111:
            fail('NATIVE_NOT_EXECUTABLE')
    no_submounts(('/usr/lib/x86_64-linux-gnu', '/usr/lib/python3.10',
                  '/usr/bin/python3.10', NODE, RUNTIME))
    if hashlib.sha256(bounded(wrapper)).hexdigest() != WRAPPER_HASH:
        fail('WRAPPER_HASH')
    root = pathlib.Path(root_for(id))
    root.mkdir(mode=0o700)
    workspace = root / 'workspace'
    workspace.mkdir(mode=0o700)
    checked_path(workspace, uid, True)
    no_submounts((str(workspace),))
    if root.stat().st_mode & 0o077 or workspace.stat().st_mode & 0o077:
        fail('PRIVATE_ROOT_MODE')
    fixture = workspace / 'fixture.txt'
    with open(fixture, 'xb') as stream:
        stream.write(b'RCAC_SYNTHETIC_SOURCE\n')
    fixture.chmod(0o600)
    return {'root': str(root), 'workspace': str(workspace), 'bootId': boot, 'uid': uid}


def observe_unit(id, saved):
    if saved is None:
        current = show(id)
        boot, uid = boot_uid()
        if uid != 1000 or not UUID.fullmatch(boot):
            fail('INITIAL_UNIT_CONTEXT')
        no_identity = (current['MainPID'] == '0' and current['InvocationID'] == '' and
                       current['ControlGroup'] == '')
        pending = no_identity and (
            (current['LoadState'] == 'not-found' and current['ActiveState'] == 'inactive' and
             current['SubState'] == 'dead') or
            (current['LoadState'] == 'loaded' and current['ActiveState'] == 'activating' and
             current['SubState'] in ('start-pre', 'start', 'start-post')))
        if pending:
            if show(id) != current or boot_uid() != (boot, uid):
                fail('INITIAL_UNIT_DRIFT')
            return {'pending': True, 'bootId': boot, 'uid': uid, 'unitName': unit_for(id)}
        if (current['LoadState'] != 'loaded' or
            current['ActiveState'] != 'active' or current['SubState'] != 'running' or
            not re.fullmatch('[0-9a-f]{32}', current['InvocationID']) or
            not current['MainPID'].isdigit() or int(current['MainPID']) <= 0 or
            current['ControlGroup'] != group_for(uid, unit_for(id))):
            fail('INITIAL_UNIT_UNBOUND')
        identity = {'bootId': boot, 'uid': uid, 'unitName': unit_for(id),
                    'invocationId': current['InvocationID'], 'controlGroup': current['ControlGroup'],
                    'mainPid': int(current['MainPID']), 'loadState': current['LoadState'],
                    'activeState': current['ActiveState'], 'subState': current['SubState'],
                    'cgroupState': 'populated'}
        members = group_members(identity)
        after = show(id)
        if after != current or boot_uid() != (boot, uid) or identity['mainPid'] not in members:
            fail('INITIAL_UNIT_DRIFT')
        saved = identity
    else:
        current, members = unit_state(id, saved)
    return {'bootId': saved['bootId'], 'uid': saved['uid'], 'unitName': current['Id'],
            'invocationId': current['InvocationID'], 'controlGroup': current['ControlGroup'],
            'mainPid': int(current['MainPID']), 'loadState': current['LoadState'],
            'activeState': current['ActiveState'], 'subState': current['SubState'],
            'cgroupState': 'populated' if members else ('empty' if group_exists(saved) else 'absent'),
            'groupMembers': members}


def stop(id, saved):
    current, members = unit_state(id, saved)
    if not (running(saved, current, members) or terminal(current, members)):
        fail('STOP_STATE')
    command(['/usr/bin/systemctl', '--user', 'stop', unit_for(id)])
    after = show(id)
    after_boot, after_uid = boot_uid()
    if (after_boot, after_uid) != (saved['bootId'], saved['uid']):
        fail('STOP_BOOT_CHANGED')
    if group_members(saved):
        fail('STOP_GROUP_POPULATED')
    if after['LoadState'] == 'not-found':
        if after['MainPID'] != '0' or after['ActiveState'] != 'inactive' or after['SubState'] != 'dead':
            fail('STOP_ABSENT_SHAPE')
    else:
        if not same_unit(saved, after, after_boot, after_uid) or after['MainPID'] != '0' or group_members(saved):
            fail('STOP_UNCLOSED')
    return {'afterUnit': after}


def main():
    if len(sys.argv) != 2:
        fail('REQUEST_ARGV')
    request = validate_request(json.loads(sys.argv[1]))
    id = request['id']
    if request['op'] == 'prepare':
        result = prepare(id)
    elif request['op'] == 'unit':
        result = observe_unit(id, request['saved'])
    elif request['op'] == 'stop':
        result = stop(id, request['saved'])
    else:
        result = collect_payload(id, request['saved'])
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(error_frame(error), sort_keys=True), flush=True)
        sys.exit(1)

import { createHash } from 'node:crypto';
import type { InvestigationSourcePlan } from '../../../application/investigation-source-plan.js';
import { portablePathKey, validateRelativePath } from '../../repository/path-policy.js';
import { WSL_EXECUTABLE } from './preflight.js';

export type SourceViewOperation = 'materialize' | 'close' | 'status';
export interface SourceViewDescriptor {
  distro: string;
  linuxUser: string;
  uid: number;
  attemptId: string;
  workspaceId: string;
  workerEpoch: number;
  sourceDigest: string;
  bootId: string;
}
export interface SourceViewSpec { executable: string; args: string[]; env: NodeJS.ProcessEnv; input: string }
export interface SourceViewState {
  attemptId: string;
  workspaceId: string;
  uid: number;
  workerEpoch: number;
  bootId: string;
  kind: 'ready' | 'closed';
  digest: string;
}

// Source materialization only. This helper is not a process sandbox, an
// investigator launch grant, or a durable scheduling claim.
const LINUX_SOURCE_VIEW = String.raw`
import base64, binascii, ctypes, fcntl, hashlib, json, os, re, stat, sys, unicodedata, uuid
op, root, attempt, workspace, uid_text, epoch_text, digest, boot = sys.argv[1:9]
uid = int(uid_text)
epoch = int(epoch_text)
if op not in ('materialize', 'close', 'status') or os.getuid() != uid: raise ValueError('identity')
current_boot = open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip()
if op == 'materialize' and current_boot != boot: raise ValueError('boot')
os.umask(0o077)
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
def open_root(path):
    if not path.startswith('/home/') or '\\' in path or '\x00' in path: raise ValueError('root')
    fd = os.open('/', O_DIR)
    try:
        parts = path.split('/')[1:]
        for part in parts:
            if not part or part in ('.', '..'): raise ValueError('root')
            nxt = os.open(part, O_DIR, dir_fd=fd)
            st = os.fstat(nxt)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, uid) or st.st_mode & 0o022: raise ValueError('root owner')
            os.close(fd); fd = nxt
        st = os.fstat(fd)
        if st.st_uid != uid or st.st_mode & 0o077: raise ValueError('private root')
        return fd
    except:
        os.close(fd); raise
def regular(fd, limit):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_nlink != 1 or st.st_mode & 0o077 or st.st_size > limit: raise ValueError('unsafe file')
def read_state(directory):
    try: fd = os.open(attempt + '.json', O_FILE, dir_fd=directory)
    except FileNotFoundError: return None
    try:
        regular(fd, 2048)
        data = os.read(fd, 2049)
        state = json.loads(data)
    finally: os.close(fd)
    if not isinstance(state, dict) or state.get('attemptId') != attempt or state.get('workspaceId') != workspace or state.get('uid') != uid or state.get('workerEpoch') != epoch or state.get('bootId') != boot or state.get('kind') not in ('ready', 'closed') or set(state) != {'attemptId','workspaceId','uid','workerEpoch','bootId','kind','digest'} or state.get('digest') != digest:
        raise ValueError('state identity')
    return state
def persist(directory, value):
    temp = attempt + '.' + uuid.uuid4().hex + '.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o600, dir_fd=directory)
    try:
        data = (json.dumps(value, separators=(',', ':')) + '\n').encode('ascii')
        if len(data) > 2048: raise ValueError('state size')
        while data:
            n = os.write(fd, data)
            if n <= 0: raise OSError('short write')
            data = data[n:]
        os.fsync(fd)
        os.rename(temp, attempt + '.json', src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)
        try: os.unlink(temp, dir_fd=directory)
        except FileNotFoundError: pass
def file_hash(fd, limit):
    regular(fd, limit)
    h = hashlib.sha256(); size = 0
    while True:
        chunk = os.read(fd, 65536)
        if not chunk: break
        size += len(chunk)
        if size > limit: raise ValueError('file limit')
        h.update(chunk)
    return size, h.hexdigest()
def expected_tree(files):
    file_map = {item['path']: item for item in files}
    dirs = set()
    for path in file_map:
        parts = path.split('/')
        for n in range(1, len(parts)): dirs.add('/'.join(parts[:n]))
    return file_map, dirs
def inspect_tree(directory, name, marker, complete):
    files, dirs = expected_tree(marker['files'])
    rootfd = os.open(name, O_DIR, dir_fd=directory)
    observed_files, observed_dirs = set(), set()
    try:
        st = os.fstat(rootfd)
        if st.st_uid != uid or st.st_mode & 0o077: raise ValueError('unsafe tree')
        def walk(fd, prefix):
            for item in os.listdir(fd):
                path = prefix + item
                if not prefix and item == '.source-view.json': continue
                try: child = os.open(item, O_DIR, dir_fd=fd)
                except NotADirectoryError:
                    if path not in files: raise ValueError('unexpected file')
                    candidate = os.open(item, O_FILE, dir_fd=fd)
                    try:
                        size, found = file_hash(candidate, 16 * 1024 * 1024)
                        if size != files[path]['sizeBytes'] or found != files[path]['sha256']: raise ValueError('changed file')
                        observed_files.add(path)
                    finally: os.close(candidate)
                else:
                    try:
                        st = os.fstat(child)
                        if path not in dirs or st.st_uid != uid or st.st_mode & 0o077: raise ValueError('unexpected directory')
                        observed_dirs.add(path)
                        walk(child, path + '/')
                    finally: os.close(child)
        walk(rootfd, '')
        if complete and (observed_files != set(files) or observed_dirs != dirs): raise ValueError('incomplete view')
    finally: os.close(rootfd)
def clean_tree(parent, name, marker, complete):
    inspect_tree(parent, name, marker, complete)
    files, dirs = expected_tree(marker['files'])
    fd = os.open(name, O_DIR, dir_fd=parent)
    try:
        for path in sorted(files, key=lambda value: (value.count('/'), value), reverse=True):
            parts = path.split('/')
            current = os.dup(fd)
            try:
                for part in parts[:-1]:
                    try: nxt = os.open(part, O_DIR, dir_fd=current)
                    except FileNotFoundError: break
                    os.close(current); current = nxt
                else:
                    try: candidate = os.open(parts[-1], O_FILE, dir_fd=current)
                    except FileNotFoundError: continue
                    try:
                        size, found = file_hash(candidate, 16 * 1024 * 1024)
                        if size != files[path]['sizeBytes'] or found != files[path]['sha256']: raise ValueError('changed file')
                    finally: os.close(candidate)
                    os.unlink(parts[-1], dir_fd=current)
                    os.fsync(current)
            finally: os.close(current)
        for path in sorted(dirs, key=lambda value: (value.count('/'), value), reverse=True):
            parts = path.split('/')
            current = os.dup(fd)
            try:
                for part in parts[:-1]:
                    try: nxt = os.open(part, O_DIR, dir_fd=current)
                    except FileNotFoundError: break
                    os.close(current); current = nxt
                else:
                    try: os.rmdir(parts[-1], dir_fd=current)
                    except FileNotFoundError: pass
                    else: os.fsync(current)
            finally: os.close(current)
        markerfd = os.open('.source-view.json', O_FILE, dir_fd=fd)
        try: regular(markerfd, 1024 * 1024)
        finally: os.close(markerfd)
        os.unlink('.source-view.json', dir_fd=fd)
        os.fsync(fd)
    finally: os.close(fd)
    os.rmdir(name, dir_fd=parent)
    os.fsync(parent)
def staging_names(directory):
    for item in os.listdir(directory):
        if item.startswith(attempt + '.') and item.endswith('.staging') and len(item) == len(attempt) + 1 + 32 + len('.staging') and all(c in '0123456789abcdef' for c in item[len(attempt)+1:-len('.staging')]):
            yield item
def claim_names(directory):
    for name in os.listdir(directory):
        stage = name[:-len('.claim')]
        if name.endswith('.claim') and stage.startswith(attempt + '.') and stage.endswith('.staging') and len(stage) == len(attempt) + 1 + 32 + len('.staging') and all(c in '0123456789abcdef' for c in stage[len(attempt)+1:-len('.staging')]):
            yield name
def claim_temp_names(directory):
    for name in os.listdir(directory):
        if name.endswith('.claim.tmp'):
            stage = name[:-len('.claim.tmp')]
            if stage.startswith(attempt + '.') and stage.endswith('.staging') and len(stage) == len(attempt) + 1 + 32 + len('.staging') and all(c in '0123456789abcdef' for c in stage[len(attempt)+1:-len('.staging')]):
                yield name
def verify_closed(directory):
    try: os.stat(attempt + '.view', dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError: pass
    else: raise ValueError('view remains')
    if any(staging_names(directory)): raise ValueError('staging remains')
    if any(claim_names(directory)): raise ValueError('claim remains')
    if any(claim_temp_names(directory)): raise ValueError('unverified claim temp')
def make_tree(parent, path):
    fd = os.dup(parent)
    try:
        for part in path.split('/'):
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
            os.fsync(fd)
            nxt = os.open(part, O_DIR, dir_fd=fd)
            st = os.fstat(nxt)
            if st.st_uid != uid or st.st_mode & 0o077: raise ValueError('unsafe directory')
            os.close(fd); fd = nxt
        return fd
    except:
        os.close(fd); raise
def read_marker(directory, name):
    view = os.open(name, O_DIR, dir_fd=directory)
    try:
        marker = os.open('.source-view.json', O_FILE, dir_fd=view)
        try:
            regular(marker, 1024 * 1024)
            identity = json.loads(os.read(marker, 1024 * 1024 + 1))
        finally: os.close(marker)
    finally: os.close(view)
    return validate_identity(identity)
def validate_identity(identity):
    if not isinstance(identity, dict) or set(identity) != {'attemptId','workspaceId','uid','workerEpoch','bootId','digest','binding','sourceConsistency','files'} or any(identity.get(key) != value for key,value in {'attemptId':attempt,'workspaceId':workspace,'uid':uid,'workerEpoch':epoch,'bootId':boot,'digest':digest}.items()): raise ValueError('marker identity')
    if not isinstance(identity['binding'], dict) or not isinstance(identity['files'], list) or identity['binding'].get('attemptId') != attempt or identity['binding'].get('workspaceId') != workspace or identity['binding'].get('workerEpoch') != epoch or len(identity['files']) > 128: raise ValueError('marker plan')
    for item in identity['files']:
        if not isinstance(item, dict) or set(item) != {'path','sizeBytes','sha256'} or not isinstance(item['path'], str) or not isinstance(item['sizeBytes'], int) or not isinstance(item['sha256'], str): raise ValueError('marker files')
    compact = json.dumps({'binding':identity['binding'],'sourceConsistency':identity['sourceConsistency'],'files':identity['files']}, ensure_ascii=False, separators=(',', ':'))
    if hashlib.sha256(compact.encode('utf8')).hexdigest() != digest: raise ValueError('marker digest')
    return identity
def read_claim(directory, name):
    fd = os.open(name + '.claim', O_FILE, dir_fd=directory)
    try:
        regular(fd, 1024 * 1024)
        return validate_identity(json.loads(os.read(fd, 1024 * 1024 + 1)))
    finally: os.close(fd)
def write_claim(directory, name, marker):
    data = json.dumps(marker, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    if len(data) > 1024 * 1024: raise ValueError('claim size')
    # Anonymous inode: interruption during the write leaves no named partial claim.
    fd = os.open('.', os.O_WRONLY | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=directory)
    try:
        while data:
            n = os.write(fd, data)
            if n <= 0: raise OSError('short claim write')
            data = data[n:]
        os.fsync(fd)
        link_complete_file(fd, directory, name + '.claim')
    finally: os.close(fd)
def link_complete_file(fd, parent, name):
    linkat = ctypes.CDLL(None, use_errno=True).linkat
    linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    linkat.restype = ctypes.c_int
    if linkat(fd, b'', parent, name.encode('utf8'), 0x1000) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    os.fsync(parent)
def rename_view_noreplace(directory, source, target):
    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(directory, source.encode('utf8'), directory, target.encode('utf8'), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
def remove_claim(directory, name):
    read_claim(directory, name)
    os.unlink(name + '.claim', dir_fd=directory)
    os.fsync(directory)
def inspect_partial_stage(directory, name, marker):
    files, dirs = expected_tree(marker['files'])
    fd = os.open(name, O_DIR, dir_fd=directory)
    try:
        st = os.fstat(fd)
        if st.st_uid != uid or st.st_mode & 0o077: raise ValueError('unsafe stage')
        def walk(parent, prefix):
            for item in os.listdir(parent):
                path = prefix + item
                if not prefix and item == '.source-view.json':
                    candidate = os.open(item, O_FILE, dir_fd=parent)
                    try:
                        regular(candidate, 1024 * 1024)
                        raw = os.read(candidate, 1024 * 1024 + 1)
                        expected = json.dumps(marker, ensure_ascii=False, separators=(',', ':')).encode('utf8')
                        if not expected.startswith(raw): raise ValueError('changed marker')
                    finally: os.close(candidate)
                    continue
                if path in dirs:
                    child = os.open(item, O_DIR, dir_fd=parent)
                    try:
                        st = os.fstat(child)
                        if st.st_uid != uid or st.st_mode & 0o077: raise ValueError('unsafe directory')
                        walk(child, path + '/')
                    finally: os.close(child)
                elif path in files:
                    candidate = os.open(item, O_FILE, dir_fd=parent)
                    try:
                        regular(candidate, files[path]['sizeBytes'])
                        size, found = file_hash(candidate, files[path]['sizeBytes'])
                        if size != files[path]['sizeBytes'] or found != files[path]['sha256']: raise ValueError('unverified staged file')
                    finally: os.close(candidate)
                else: raise ValueError('unknown staged content')
        walk(fd, '')
    finally: os.close(fd)
def clean_partial_stage(directory, name, marker):
    inspect_partial_stage(directory, name, marker)
    files, dirs = expected_tree(marker['files'])
    fd = os.open(name, O_DIR, dir_fd=directory)
    try:
        for path in sorted(files, key=lambda value: (value.count('/'), value), reverse=True):
            parts = path.split('/'); current = os.dup(fd)
            try:
                for part in parts[:-1]:
                    try: nxt = os.open(part, O_DIR, dir_fd=current)
                    except FileNotFoundError: break
                    os.close(current); current = nxt
                else:
                    try: candidate = os.open(parts[-1], O_FILE, dir_fd=current)
                    except FileNotFoundError: continue
                    try:
                        size, found = file_hash(candidate, files[path]['sizeBytes'])
                        if size != files[path]['sizeBytes'] or found != files[path]['sha256']: raise ValueError('changed staged file')
                    finally: os.close(candidate)
                    os.unlink(parts[-1], dir_fd=current); os.fsync(current)
            finally: os.close(current)
        for path in sorted(dirs, key=lambda value: (value.count('/'), value), reverse=True):
            parts = path.split('/'); current = os.dup(fd)
            try:
                for part in parts[:-1]:
                    try: nxt = os.open(part, O_DIR, dir_fd=current)
                    except FileNotFoundError: break
                    os.close(current); current = nxt
                else:
                    try: os.rmdir(parts[-1], dir_fd=current)
                    except FileNotFoundError: pass
                    else: os.fsync(current)
            finally: os.close(current)
        try: os.unlink('.source-view.json', dir_fd=fd)
        except FileNotFoundError: pass
        else: os.fsync(fd)
    finally: os.close(fd)
    os.rmdir(name, dir_fd=directory); os.fsync(directory)
def verify_view(directory):
    marker = read_marker(directory, attempt + '.view')
    inspect_tree(directory, attempt + '.view', marker, True)
    return marker
def verified_stages(directory):
    stages = []
    for name in staging_names(directory):
        marker = read_marker(directory, name)
        inspect_tree(directory, name, marker, False)
        stages.append((name, marker))
    return stages
def empty_owned(directory, name):
    fd = os.open(name, O_DIR, dir_fd=directory)
    try:
        st = os.fstat(fd)
        if st.st_uid != uid or st.st_mode & 0o077 or os.listdir(fd): raise ValueError('unknown content')
    finally: os.close(fd)
def recovery_tree(directory, name):
    try: marker = read_marker(directory, name)
    except FileNotFoundError:
        empty_owned(directory, name)
        return None
    inspect_tree(directory, name, marker, False)
    return marker
def recovery_stage(directory, name, allow_empty):
    try: claim = read_claim(directory, name)
    except FileNotFoundError:
        if allow_empty: return recovery_tree(directory, name), False
        marker = read_marker(directory, name)
        inspect_tree(directory, name, marker, False)
        return marker, False
    inspect_partial_stage(directory, name, claim)
    return claim, True
def remove_empty(directory, name):
    empty_owned(directory, name)
    os.rmdir(name, dir_fd=directory)
    os.fsync(directory)
def materialize(directory, state):
    if any(claim_temp_names(directory)): raise ValueError('unverified claim temp')
    data = sys.stdin.buffer.read(180 * 1024 * 1024 + 1)
    if len(data) > 180 * 1024 * 1024: raise ValueError('input limit')
    plan = json.loads(data)
    if not isinstance(plan, dict) or set(plan) != {'binding','sourceConsistency','files','totalBytes','digest'}: raise ValueError('plan')
    binding = plan['binding']
    if not isinstance(binding, dict) or set(binding) != {'workspaceId','collaborationId','workingCopyId','snapshotRef','contextRevisionId','recipient','requestId','attemptId','workerEpoch'} or binding.get('attemptId') != attempt or binding.get('workspaceId') != workspace or binding.get('workerEpoch') != epoch or any(not isinstance(value, str) or not value for key,value in binding.items() if key != 'workerEpoch'): raise ValueError('binding')
    if plan['sourceConsistency'] not in ('verified_git_tree', 'best_effort_capture'): raise ValueError('consistency')
    files = plan['files']
    if not isinstance(files, list) or not (1 <= len(files) <= 128): raise ValueError('file count')
    if plan['digest'] != digest: raise ValueError('digest')
    if not isinstance(plan['totalBytes'], int) or plan['totalBytes'] < 0 or plan['totalBytes'] > 128 * 1024 * 1024: raise ValueError('total')
    keys, prefixes, decoded, total = set(), {}, [], 0
    for file in files:
        if not isinstance(file, dict) or set(file) != {'path','sizeBytes','sha256','base64'}: raise ValueError('file fields')
        path = file['path']
        if not isinstance(path, str) or not path or path == '.source-view.json' or len(path.encode('utf8')) > 4096 or path.startswith('/') or '\\' in path or '\x00' in path: raise ValueError('path')
        for part in path.split('/'):
            if not part or part in ('.','..') or unicodedata.normalize('NFC', part) != part or part[-1] in '. ' or any(ord(c) < 32 or c in '<>:"|?*' for c in part) or re.match(r'^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$', part, re.I) or re.match(r'^(?:\.git|\.agent-collab|\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$', part, re.I): raise ValueError('path')
        key = path.casefold()
        if key in keys or any(key.startswith(other + '/') or other.startswith(key + '/') for other in keys): raise ValueError('alias')
        parts = path.split('/')
        for n in range(1, len(parts)+1):
            prefix = '/'.join(parts[:n]); folded = prefix.casefold()
            if folded in prefixes and prefixes[folded] != prefix: raise ValueError('alias')
            prefixes[folded] = prefix
        keys.add(key)
        if not isinstance(file['sizeBytes'], int) or file['sizeBytes'] < 0 or file['sizeBytes'] > 16 * 1024 * 1024: raise ValueError('size')
        try: raw = base64.b64decode(file['base64'], validate=True)
        except (ValueError, binascii.Error): raise ValueError('base64')
        if len(raw) != file['sizeBytes'] or hashlib.sha256(raw).hexdigest() != file['sha256']: raise ValueError('hash')
        total += len(raw)
        if total > 128 * 1024 * 1024: raise ValueError('total')
        decoded.append((path, raw))
    if total != plan['totalBytes']: raise ValueError('total')
    meta = [{'path': f['path'], 'sizeBytes': f['sizeBytes'], 'sha256': f['sha256']} for f in files]
    compact = json.dumps({'binding': binding, 'sourceConsistency': plan['sourceConsistency'], 'files': meta}, ensure_ascii=False, separators=(',', ':'))
    if hashlib.sha256(compact.encode('utf8')).hexdigest() != plan['digest']: raise ValueError('plan digest')
    stages = verified_stages(directory)
    if state is not None:
        if state['kind'] == 'closed' or state['digest'] != plan['digest']: raise ValueError('closed or conflicting')
        verify_view(directory)
        for name, marker in stages: clean_tree(directory, name, marker, False)
        for claim_name in claim_names(directory): remove_claim(directory, claim_name[:-len('.claim')])
        return state
    try:
        verify_view(directory)
    except FileNotFoundError:
        pass
    else:
        recovered = {'attemptId': attempt, 'workspaceId': workspace, 'uid': uid, 'workerEpoch': epoch, 'bootId': boot, 'kind': 'ready', 'digest': digest}
        persist(directory, recovered)
        for name, marker in stages: clean_tree(directory, name, marker, False)
        for claim_name in claim_names(directory): remove_claim(directory, claim_name[:-len('.claim')])
        return recovered
    stage = attempt + '.' + uuid.uuid4().hex + '.staging'
    marker = {'attemptId': attempt, 'workspaceId': workspace, 'uid': uid, 'workerEpoch': epoch, 'bootId': boot, 'digest': plan['digest'], 'binding':binding, 'sourceConsistency':plan['sourceConsistency'],'files':meta}
    write_claim(directory, stage, marker)
    os.mkdir(stage, 0o700, dir_fd=directory)
    stagefd = os.open(stage, O_DIR, dir_fd=directory)
    try:
        fd = os.open('.source-view.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o400, dir_fd=stagefd)
        try:
            marker_bytes = json.dumps(marker, ensure_ascii=False, separators=(',', ':')).encode('utf8')
            if len(marker_bytes) > 1024 * 1024: raise ValueError('marker size')
            while marker_bytes:
                n = os.write(fd, marker_bytes)
                if n <= 0: raise OSError('short marker write')
                marker_bytes = marker_bytes[n:]
            os.fsync(fd)
        finally: os.close(fd)
        os.fsync(stagefd)
        for path, raw in decoded:
            parts = path.split('/')
            parent = make_tree(stagefd, '/'.join(parts[:-1])) if len(parts) > 1 else os.dup(stagefd)
            try:
                # Anonymous inode: an interrupted write cannot leave a named partial source file.
                fd = os.open('.', os.O_WRONLY | os.O_TMPFILE | os.O_CLOEXEC, 0o400, dir_fd=parent)
                try:
                    remaining = raw
                    while remaining:
                        n = os.write(fd, remaining)
                        if n <= 0: raise OSError('short write')
                        remaining = remaining[n:]
                    os.fsync(fd)
                    link_complete_file(fd, parent, parts[-1])
                finally: os.close(fd)
            finally: os.close(parent)
        os.fsync(stagefd)
    finally: os.close(stagefd)
    try: rename_view_noreplace(directory, stage, attempt + '.view')
    except FileExistsError:
        clean_tree(directory, stage, marker, True)
        verify_view(directory)
    os.fsync(directory)
    state = {'attemptId': attempt, 'workspaceId': workspace, 'uid': uid, 'workerEpoch': epoch, 'bootId': boot, 'kind': 'ready', 'digest': plan['digest']}
    persist(directory, state)
    remove_claim(directory, stage)
    for name, prior in stages: clean_tree(directory, name, prior, False)
    for claim_name in claim_names(directory): remove_claim(directory, claim_name[:-len('.claim')])
    return state
directory = open_root(root)
try:
    try:
        lock = os.open(attempt + '.lock', (os.O_RDONLY if op == 'status' else os.O_RDWR | os.O_CREAT) | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o600, dir_fd=directory)
    except FileNotFoundError:
        if op != 'status': raise
        if attempt + '.view' in os.listdir(directory) or any(staging_names(directory)) or any(claim_names(directory)) or any(claim_temp_names(directory)) or attempt + '.json' in os.listdir(directory): raise ValueError('missing lock with artifacts')
        sys.stdout.write('null\n')
        sys.exit(0)
    try:
        regular(lock, 1024)
        fcntl.flock(lock, (fcntl.LOCK_SH if op == 'status' else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        if op != 'status': os.fsync(directory)
        state = read_state(directory)
        if op == 'materialize': state = materialize(directory, state)
        elif op == 'close':
            if any(claim_temp_names(directory)): raise ValueError('unverified claim temp')
            recovering = state is not None and state['kind'] == 'closed'
            try: os.stat(attempt + '.view', dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                if state is not None and state['kind'] == 'ready': raise ValueError('ready view missing')
                view_marker = None
                view_exists = False
            else:
                view_exists = True
                view_marker = recovery_tree(directory, attempt + '.view') if recovering else verify_view(directory)
            stages = [(name, *recovery_stage(directory, name, recovering)) for name in staging_names(directory)]
            claims = list(claim_names(directory))
            for claim_name in claims: read_claim(directory, claim_name[:-len('.claim')])
            if state is None: state = {'attemptId': attempt, 'workspaceId': workspace, 'uid': uid, 'workerEpoch': epoch, 'bootId': boot, 'kind': 'closed', 'digest': digest}
            elif state['kind'] != 'closed': state = {**state, 'kind': 'closed'}
            persist(directory, state)
            if view_exists:
                if view_marker is None: remove_empty(directory, attempt + '.view')
                else: clean_tree(directory, attempt + '.view', view_marker, not recovering)
            for name, marker, claimed in stages:
                if claimed: clean_partial_stage(directory, name, marker); remove_claim(directory, name)
                elif marker is None: remove_empty(directory, name)
                else: clean_tree(directory, name, marker, False)
            for claim_name in claims:
                if claim_name[:-len('.claim')] not in [item[0] for item in stages]:
                    remove_claim(directory, claim_name[:-len('.claim')])
            os.fsync(directory)
            verify_closed(directory)
        elif op == 'status':
            if sys.stdin.buffer.read(1): raise ValueError('unexpected input')
            if state is None:
                if attempt + '.view' in os.listdir(directory) or any(staging_names(directory)) or any(claim_names(directory)) or any(claim_temp_names(directory)): raise ValueError('unreconciled artifacts')
            else:
                if state['kind'] == 'ready':
                    if current_boot != boot: raise ValueError('old boot ready')
                    verify_view(directory)
                    if any(staging_names(directory)) or any(claim_names(directory)) or any(claim_temp_names(directory)): raise ValueError('staging remains')
                else: verify_closed(directory)
        sys.stdout.write(json.dumps(state, separators=(',', ':')) + '\n')
    finally: os.close(lock)
finally: os.close(directory)
`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const invalid = (): never => { throw new Error('INVALID_ARGUMENT'); };
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function validatePlan(plan: InvestigationSourcePlan, descriptor: SourceViewDescriptor): void {
  if (!plan || Object.keys(plan).sort().join(',') !== 'binding,digest,files,sourceConsistency,totalBytes' ||
      !plan.binding || !Array.isArray(plan.files) || plan.files.length < 1 || plan.files.length > 128 ||
      plan.binding.attemptId !== descriptor.attemptId || plan.binding.workspaceId !== descriptor.workspaceId ||
      plan.binding.workerEpoch !== descriptor.workerEpoch || plan.digest !== descriptor.sourceDigest ||
      Object.keys(plan.binding).sort().join(',') !==
        'attemptId,collaborationId,contextRevisionId,recipient,requestId,snapshotRef,workerEpoch,workingCopyId,workspaceId' ||
      !['verified_git_tree', 'best_effort_capture'].includes(plan.sourceConsistency)) invalid();
  const keys = new Set<string>();
  const prefixes = new Map<string, string>();
  let total = 0;
  for (const file of plan.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'base64,path,sha256,sizeBytes' ||
        typeof file.path !== 'string' || file.path === '.source-view.json' ||
        Buffer.byteLength(file.path) > 4096) invalid();
    try { validateRelativePath(file.path); } catch { invalid(); }
    const key = portablePathKey(file.path);
    if (keys.has(key) || [...keys].some(other => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) invalid();
    keys.add(key);
    const parts = file.path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const folded = portablePathKey(prefix);
      if (prefixes.has(folded) && prefixes.get(folded) !== prefix) invalid();
      prefixes.set(folded, prefix);
    }
    if (typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) invalid();
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.sizeBytes || bytes.length > 16 * 1024 * 1024 || sha(bytes) !== file.sha256) invalid();
    total += bytes.length;
  }
  if (total !== plan.totalBytes || total > 128 * 1024 * 1024) invalid();
  const digest = sha(JSON.stringify({ binding: plan.binding, sourceConsistency: plan.sourceConsistency,
    files: plan.files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })) }));
  if (digest !== plan.digest) invalid();
}

export function wslSourceViewSpec(operation: SourceViewOperation, descriptor: SourceViewDescriptor,
  root: string, plan?: InvestigationSourcePlan): SourceViewSpec {
  if (!['materialize', 'close', 'status'].includes(operation) ||
      !new RegExp(`^attempt_${UUID}$`).test(descriptor.attemptId) ||
      !new RegExp(`^ws_${UUID}$`).test(descriptor.workspaceId) ||
      !new RegExp(`^${UUID}$`).test(descriptor.bootId) ||
      !/^[0-9a-f]{64}$/.test(descriptor.sourceDigest) ||
      !Number.isSafeInteger(descriptor.workerEpoch) || descriptor.workerEpoch < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(descriptor.distro) ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(descriptor.linuxUser) ||
      !Number.isSafeInteger(descriptor.uid) || descriptor.uid < 1 ||
      typeof root !== 'string' || !root.startsWith(`/home/${descriptor.linuxUser}/`) ||
      root.length > 256 || root.split('/').slice(1).some(part => !part || part === '.' || part === '..' || part.includes('\0')) ||
      (operation === 'materialize' ? !plan : plan !== undefined)) invalid();
  if (operation === 'materialize') validatePlan(plan!, descriptor);
  const input = plan ? JSON.stringify(plan) : '';
  if (Buffer.byteLength(input) > 180 * 1024 * 1024) invalid();
  return { executable: WSL_EXECUTABLE,
    args: ['-d', descriptor.distro, '--user', descriptor.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', LINUX_SOURCE_VIEW, operation, root,
      descriptor.attemptId, descriptor.workspaceId, String(descriptor.uid),
      String(descriptor.workerEpoch), descriptor.sourceDigest, descriptor.bootId],
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' }, input };
}

/** A missing status is null. A successful close returns a durable closed tombstone. */
export function parseWslSourceViewOutput(stdout: string, descriptor: SourceViewDescriptor): SourceViewState | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 2048 || !stdout.endsWith('\n')) invalid();
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { invalid(); }
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const state = value as Record<string, unknown>;
  if (Object.keys(state).sort().join(',') !== 'attemptId,bootId,digest,kind,uid,workerEpoch,workspaceId' ||
      state.attemptId !== descriptor.attemptId || state.workspaceId !== descriptor.workspaceId ||
      state.uid !== descriptor.uid || state.workerEpoch !== descriptor.workerEpoch ||
      state.bootId !== descriptor.bootId || state.digest !== descriptor.sourceDigest ||
      (state.kind !== 'ready' && state.kind !== 'closed')) invalid();
  return state as unknown as SourceViewState;
}

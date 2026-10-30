import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import type { ClaudeMcpSandboxPaths } from './claude-mcp-sandbox-spec.js';
import type { ClaudeModelLaunchProfile } from './claude-model-launch-config.js';
import { buildClaudeModelSealedLaunch } from './claude-model-sealed-launch.js';
import { CLAUDE_MODEL_CONFIG_READER_PYTHON } from './claude-model-config-wire.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, CLAUDE_MODEL_BOOTSTRAP_SHA256 } from
  './claude-model-bootstrap.js';

export interface ClaudeModelSupervisorDescriptor {
  attemptId: string; workspaceId: string; distro: string; linuxUser: string; uid: number;
  bootId: string; unitName: string; launchWorkerEpoch: number;
  sourceDigest: string; profileDigest: string; commandDigest: string;
}
export interface ClaudeModelUnitIdentity { invocationId: string; controlGroup: string }
export interface ClaudeModelLaunchLimits { maxWallSeconds: number; maxTurns: number }
export function validClaudeModelLaunchLimits(value: unknown): value is ClaudeModelLaunchLimits {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value,'maxWallSeconds') &&
    Object.hasOwn(value,'maxTurns') &&
    Number.isSafeInteger((value as ClaudeModelLaunchLimits).maxWallSeconds) &&
    (value as ClaudeModelLaunchLimits).maxWallSeconds >= 1 &&
    (value as ClaudeModelLaunchLimits).maxWallSeconds <= 600 &&
    Number.isSafeInteger((value as ClaudeModelLaunchLimits).maxTurns) &&
    (value as ClaudeModelLaunchLimits).maxTurns >= 1 &&
    (value as ClaudeModelLaunchLimits).maxTurns <= 8;
}
export type ClaudeModelSupervisorOperation = 'prepare' | 'status' | 'close' | 'release' | 'enter_wait_exec';
export type ClaudeModelSupervisorState = {
  protocol: 'claude_model_v1'; action: 'claude_model_v1';
  phase: 'prepared' | 'entered' | 'released' | 'consumed'; closed: boolean;
  attemptId: string; workspaceId: string; bootId: string; uid: number; unitName: string;
  launchWorkerEpoch: number; sourceDigest: string; profileDigest: string; commandDigest: string;
  invocationId?: string; controlGroup?: string; enterPid?: number; enterStartTicks?: number;
};
export interface ClaudeModelSupervisorSpec {
  executable: typeof WSL_EXECUTABLE;
  args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
  startupInput?: Buffer;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ATTEMPT = new RegExp(`^attempt_${UUID}$`);
const WORKSPACE = new RegExp(`^ws_${UUID}$`);
const UNIT = new RegExp(`^rcac-investigator-${UUID}\\.service$`);
const BOOT = new RegExp(`^${UUID}$`);
const SHA = /^[0-9a-f]{64}$/;
const INVOCATION = /^[0-9a-f]{32}$/;

/** The digest commits fixed bootstrap and exact sealed configuration metadata. */
export function claudeModelCommandDigest(paths: ClaudeMcpSandboxPaths,
  profile: ClaudeModelLaunchProfile, maxTurns: number): string {
  return buildClaudeModelSealedLaunch(paths, profile, maxTurns).commandDigest;
}

function valid(d: ClaudeModelSupervisorDescriptor, root: string): boolean {
  return !!d && Object.keys(d).length === 11 && ATTEMPT.test(d.attemptId) &&
    WORKSPACE.test(d.workspaceId) && BOOT.test(d.bootId) && UNIT.test(d.unitName) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(d.distro) &&
    /^[a-z_][a-z0-9_-]{0,31}$/.test(d.linuxUser) &&
    Number.isSafeInteger(d.uid) && d.uid > 0 &&
    Number.isSafeInteger(d.launchWorkerEpoch) && d.launchWorkerEpoch >= 1 &&
    SHA.test(d.sourceDigest) && SHA.test(d.profileDigest) && SHA.test(d.commandDigest) &&
    typeof root === 'string' && root.startsWith(`/home/${d.linuxUser}/`) &&
    root.length <= 256 && !root.endsWith('/') && !root.includes('//') &&
    root.split('/').every(part => part !== '.' && part !== '..' && /^[A-Za-z0-9._-]*$/.test(part));
}

const MODEL_JOURNAL_PYTHON = String.raw`
import errno, fcntl, hashlib, json, os, re, select, stat, subprocess, sys, time, uuid
op, root, attempt, workspace, boot, uid_text, unit, epoch_text, source_digest, profile_digest, command_digest, wanted_inv, wanted_group, command_text, limit_text, bootstrap_text = sys.argv[1:17]
uid, epoch = int(uid_text), int(epoch_text)
if op not in ('prepare','status','close','release','enter_wait_exec'): raise ValueError('operation')
if os.getuid() != uid: raise ValueError('uid')
if open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() != boot: raise ValueError('boot')
group = '/user.slice/user-%d.slice/user@%d.service/app.slice/%s' % (uid,uid,unit)
if op == 'release':
    if not re.fullmatch('[0-9a-f]{32}', wanted_inv) or wanted_group != group: raise ValueError('release identity')
elif wanted_inv or wanted_group: raise ValueError('unexpected identity')
if op == 'enter_wait_exec':
    limit=int(limit_text)
    if limit<1 or limit>600: raise ValueError('wall limit')
    if not command_text or hashlib.sha256(command_text.encode()).hexdigest() != command_digest: raise ValueError('command digest')
    if hashlib.sha256(bootstrap_text.encode()).hexdigest() != '${CLAUDE_MODEL_BOOTSTRAP_SHA256}': raise ValueError('bootstrap digest')
    command = json.loads(command_text)
    if set(command) != {'recipe','bootstrapSha256','configFiles','file','argv','env'} or command['recipe'] != 'claude_model_bootstrap_config_v3' or command['bootstrapSha256'] != '${CLAUDE_MODEL_BOOTSTRAP_SHA256}' or command['file'] != '/usr/bin/bwrap' or not isinstance(command['argv'],list) or not all(isinstance(a,str) for a in command['argv']) or command['argv'][-11:] != ['--ro-bind-data','10','/opt/rcac-bootstrap.py','--info-fd','11','--','/usr/bin/python3','-I','-S','/opt/rcac-bootstrap.py',command['argv'][-1]] or command['argv'][-1] not in ('1','2','3','4','5','6','7','8') or command['env'] != {'HOME':'/home/claude','PATH':'/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin','LD_LIBRARY_PATH':'/runtime/deps/usr/lib/x86_64-linux-gnu'}:
        raise ValueError('command shape')
elif command_text or limit_text or bootstrap_text: raise ValueError('unexpected command')
${CLAUDE_MODEL_CONFIG_READER_PYTHON}
config_fds=[]
if op=='enter_wait_exec':
    config_fds=read_sealed_config(command['configFiles'],time.monotonic()+min(5,limit))
owned_fds=set(config_fds)
def open_root(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.split('/')[1:]:
            if not part or part in ('.','..'): raise ValueError('root path')
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            s = os.fstat(nxt)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0,uid) or s.st_mode & 0o022: raise ValueError('root owner/mode')
            os.close(fd); fd=nxt
        s=os.fstat(fd)
        if s.st_uid != uid or stat.S_IMODE(s.st_mode) != 0o700: raise ValueError('root mode')
        return fd
    except:
        os.close(fd); raise
directory=open_root(root)
lock=os.open(attempt+'.model-supervisor.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
name=attempt+'.model-supervisor.json'
identity={'protocol':'claude_model_v1','action':'claude_model_v1','attemptId':attempt,'workspaceId':workspace,'bootId':boot,'uid':uid,'unitName':unit,'launchWorkerEpoch':epoch,'sourceDigest':source_digest,'profileDigest':profile_digest,'commandDigest':command_digest}
base=set(identity)|{'phase','closed'}
native={'invocationId','controlGroup','enterPid','enterStartTicks'}
def read_state():
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
    except FileNotFoundError: return None
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size>2048: raise ValueError('state mode')
        state=json.loads(os.read(fd,2049))
    finally: os.close(fd)
    if not isinstance(state,dict) or any(state.get(k)!=v for k,v in identity.items()) or type(state.get('closed')) is not bool: raise ValueError('state identity')
    if state.get('phase')=='prepared':
        if set(state)!=base: raise ValueError('prepared fields')
    elif state.get('phase') in ('entered','released','consumed'):
        if set(state)!=base|native or not re.fullmatch('[0-9a-f]{32}',state['invocationId']) or state['controlGroup']!=group or type(state['enterPid']) is not int or state['enterPid']<=0 or type(state['enterStartTicks']) is not int or state['enterStartTicks']<=0: raise ValueError('native fields')
    else: raise ValueError('phase')
    return state
def persist(value):
    temp=attempt+'.'+uuid.uuid4().hex+'.model-supervisor.tmp'
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
    try:
        data=(json.dumps(value,separators=(',',':'))+'\n').encode('ascii')
        if len(data)>2048: raise ValueError('state size')
        while data: data=data[os.write(fd,data):]
        os.fsync(fd)
        os.rename(temp,name,src_dir_fd=directory,dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)
        try: os.unlink(temp,dir_fd=directory)
        except FileNotFoundError: pass
def ticks(pid):
    with open('/proc/%d/stat'%pid,encoding='ascii') as f: raw=f.read()
    fields=raw[raw.rfind(')')+2:].split()
    if fields[0] in ('Z','X','x'): raise ValueError('unit exited')
    return int(fields[19])
def cgroup(pid):
    with open('/proc/%d/cgroup'%pid,encoding='ascii') as f: rows=f.read().splitlines()
    if len(rows)!=1 or not rows[0].startswith('0::'): raise ValueError('cgroup')
    return rows[0][3:]
def locked():
    fcntl.flock(lock,fcntl.LOCK_EX)
    return read_state()
def unlock(): fcntl.flock(lock,fcntl.LOCK_UN)

def strict_object(pairs):
    value={}
    for key,item in pairs:
        if key in value: raise ValueError('duplicate key')
        value[key]=item
    return value
def frame_ready(fd, deadline, child):
    while True:
        if child.poll() is not None:
            child.wait(timeout=0)
            raise ValueError('model child exited before frame')
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError('frame deadline')
        if select.select([fd],[],[],min(.05,remaining))[0]: return
def read_line(fd, cap, deadline, child):
    result=bytearray()
    while True:
        frame_ready(fd,deadline,child)
        part=os.read(fd,1)
        if not part or len(result)>=cap: raise ValueError('line size/eof')
        result.extend(part)
        if part==b'\n': return bytes(result)
def read_frame(deadline,child):
    os.set_blocking(0,False)
    header=json.loads(read_line(0,512,deadline,child)[:-1].decode('ascii'),object_pairs_hook=strict_object)
    if type(header) is not dict or set(header)!={'protocol','byteLength','sha256'} or header['protocol']!='claude_model_bootstrap_v1' or type(header['byteLength']) is not int or not 1<=header['byteLength']<=16384 or type(header['sha256']) is not str or not re.fullmatch('[0-9a-f]{64}',header['sha256']): raise ValueError('frame header')
    body=bytearray()
    while len(body)<header['byteLength']:
        frame_ready(0,deadline,child)
        part=os.read(0,header['byteLength']-len(body))
        if not part: raise ValueError('short body')
        body.extend(part)
    frame_ready(0,deadline,child)
    if os.read(0,1): raise ValueError('frame trailer')
    if hashlib.sha256(body).hexdigest()!=header['sha256']: raise ValueError('frame hash')
    return json.dumps(header,separators=(',',':')).encode('ascii')+b'\n'+bytes(body)
def reserve(fd):
    try: fcntl.fcntl(fd,fcntl.F_GETFD)
    except OSError as exc:
        if exc.errno==errno.EBADF: return
        raise
    raise ValueError('fixed fd occupied')

def stage_fd(fd):
    owned_fds.add(fd)
    try:
        high=fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,32)
        owned_fds.add(high)
        return high
    finally: close_owned(fd)

def close_owned(fd):
    if fd in owned_fds:
        owned_fds.remove(fd)
        os.close(fd)
def native_candidate(info, ready):
    keys={'child-pid','cgroup-namespace','ipc-namespace','mnt-namespace','pid-namespace','uts-namespace'}
    if type(info) is not dict or set(info)!=keys or type(info['child-pid']) is not int or info['child-pid']<=0 or any(type(info[k]) is not int or info[k]<=0 for k in keys-{'child-pid'}): raise ValueError('bwrap info')
    pid=info['child-pid']
    with open('/proc/%d/stat'%pid,encoding='ascii') as source: raw=source.read(4096)
    if len(raw)>=4096 or not raw.startswith(str(pid)+' ('): raise ValueError('outer stat')
    fields=raw[raw.rfind(')')+2:].split()
    if len(fields)<20 or fields[0] in ('Z','X','x'): raise ValueError('outer state')
    ticks=int(fields[19]); ns=os.readlink('/proc/%d/ns/pid'%pid)
    with open('/proc/%d/status'%pid,encoding='ascii') as source: rows=source.read(8192).splitlines()
    nsrows=[row for row in rows if row.startswith('NSpid:')]
    if len(nsrows)!=1: raise ValueError('outer nspid')
    nspid=[int(item) for item in nsrows[0].split()[1:]]
    if ticks<=0 or ns!='pid:[%d]'%info['pid-namespace'] or not nspid or nspid[0]!=pid or nspid[-1]!=1: raise ValueError('outer mismatch')
    if type(ready) is not dict or set(ready)!={'protocol','kind','pid','ppid','startTicks','namespaces','capEff','noNewPrivs'} or ready['protocol']!='claude_model_bootstrap_v1' or ready['kind']!='ready' or type(ready['pid']) is not int or ready['pid']<=1 or ready['ppid']!=1 or type(ready['startTicks']) is not int or ready['startTicks']<=0 or ready['capEff']!='0' or ready['noNewPrivs']!=1: raise ValueError('bootstrap ready')
    names=ready['namespaces']
    if type(names) is not dict or set(names)!={'pid','mnt','net','user','ipc','uts','cgroup'} or names['pid']!=ns or any(names[k]!='%s:[%d]'%(k,info[k+'-namespace']) for k in ('mnt','ipc','uts','cgroup')): raise ValueError('bootstrap namespaces')
    return {'hostPid':pid,'startTicks':ticks,'pidNamespace':ns,'nspid':nspid}
def relay(child, wall_deadline):
    streams={child.stdout.fileno():1,child.stderr.fileno():2}
    pending={1:bytearray(),2:bytearray()}; totals={1:0,2:0}
    for fd in [*streams,1,2]: os.set_blocking(fd,False)
    while streams or pending[1] or pending[2]:
        if time.monotonic()>=wall_deadline: raise TimeoutError('model relay')
        readable,writable,_=select.select([fd for fd,to in streams.items() if len(pending[to])<65536],
            [fd for fd in (1,2) if pending[fd]],[],.5)
        for fd in readable:
            dest=streams[fd]; chunk=os.read(fd,4096)
            if chunk:
                totals[dest]+=len(chunk)
                if totals[dest]>(262144 if dest==1 else 8192): raise ValueError('model output bound')
                pending[dest].extend(chunk)
            else: del streams[fd]
        for fd in writable:
            used=os.write(fd,pending[fd]); del pending[fd][:used]
    return child.wait(timeout=max(.1,wall_deadline-time.monotonic()))
def startup(child, info_read, consumed, deadline):
    info_raw=bytearray(); ready_raw=bytearray(); error_bytes=0
    descriptors={info_read:'info',child.stdout.fileno():'ready',child.stderr.fileno():'stderr'}
    for fd in descriptors: os.set_blocking(fd,False)
    info=None; ready=None
    while info is None or ready is None:
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError('startup')
        readable,_,_=select.select(list(descriptors),[],[],remaining)
        if not readable: raise TimeoutError('startup')
        for fd in readable:
            part=os.read(fd,1024)
            if not part:
                if descriptors[fd] in ('info','ready') and (info if descriptors[fd]=='info' else ready) is None: raise ValueError('startup eof')
                del descriptors[fd]; continue
            role=descriptors[fd]
            if role=='stderr':
                error_bytes+=len(part)
                if error_bytes: raise ValueError('bootstrap startup stderr')
            elif role=='info':
                info_raw.extend(part)
                if len(info_raw)>2048: raise ValueError('info bound')
                try: info=json.loads(info_raw.decode('ascii'),object_pairs_hook=strict_object)
                except json.JSONDecodeError: pass
            else:
                ready_raw.extend(part)
                if len(ready_raw)>512: raise ValueError('ready bound')
                if ready_raw.endswith(b'\n'):
                    ready=json.loads(ready_raw[:-1].decode('ascii'),object_pairs_hook=strict_object)
    outer=native_candidate(info,ready)
    value={'protocol':'claude_model_startup_v1','kind':'bootstrap_ready_candidate',
        'journal':consumed,'bootstrapSha256':'${CLAUDE_MODEL_BOOTSTRAP_SHA256}',
        'bwrapInfo':info,'outerCandidate':outer,'bootstrapReady':ready}
    line=(json.dumps(value,separators=(',',':'))+'\n').encode('ascii')
    if len(line)>4096: raise ValueError('startup line bound')
    if os.write(1,line)!=len(line): raise ValueError('startup short write')
try:
    s=os.fstat(lock)
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600: raise ValueError('lock mode')
    state=locked()
    try:
        if op=='prepare':
            if state is None:
                state={**identity,'phase':'prepared','closed':False}; persist(state)
            if state['phase']!='prepared' or state['closed']: raise ValueError('unavailable')
        elif op=='status':
            if state is None: raise ValueError('missing')
        elif op=='close':
            if state is None: state={**identity,'phase':'prepared','closed':True}
            elif not state['closed']: state={**state,'closed':True}
            persist(state)
        elif op=='release':
            if state is None or state['closed'] or state.get('invocationId')!=wanted_inv or state.get('controlGroup')!=wanted_group: raise ValueError('release unavailable')
            if state['phase']=='entered':
                if ticks(state['enterPid'])!=state['enterStartTicks'] or cgroup(state['enterPid'])!=group: raise ValueError('original unit exited')
                state={**state,'phase':'released'}; persist(state)
            elif state['phase'] not in ('released','consumed'): raise ValueError('release phase')
        else:
            if state is None or state['phase']!='prepared' or state['closed']: raise ValueError('enter unavailable')
            invocation=os.environ.get('INVOCATION_ID','')
            if not re.fullmatch('[0-9a-f]{32}',invocation) or cgroup(os.getpid())!=group: raise ValueError('original unit')
            deadline=time.monotonic()+min(10,limit)
            state={**state,'phase':'entered','invocationId':invocation,'controlGroup':group,'enterPid':os.getpid(),'enterStartTicks':ticks(os.getpid())}
            persist(state)
    finally: unlock()
    if op=='enter_wait_exec':
        while True:
            state=locked()
            try:
                if state['closed']: raise ValueError('closed')
                if time.monotonic()>=deadline:
                    state={**state,'closed':True}; persist(state)
                    raise TimeoutError('release timeout')
                if state['phase']=='released':
                    if state['enterPid']!=os.getpid() or state['enterStartTicks']!=ticks(os.getpid()) or cgroup(os.getpid())!=group: raise ValueError('original unit changed')
                    break
                if state['phase']!='entered': raise ValueError('phase')
            finally: unlock()
            time.sleep(.05)
        child=None; info_read=None
        try:
            frame_deadline=time.monotonic()+5
            for fd in (10,11,12,13,14): reserve(fd)
            script=stage_fd(os.memfd_create('rcac-bootstrap',os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING))
            data=bootstrap_text.encode('utf-8')
            while data: data=data[os.write(script,data):]
            os.lseek(script,0,os.SEEK_SET)
            fcntl.fcntl(script,fcntl.F_ADD_SEALS,fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
            raw_read,raw_write=os.pipe2(os.O_CLOEXEC)
            owned_fds.update((raw_read,raw_write))
            info_read=stage_fd(raw_read); info_write=stage_fd(raw_write)
            for fd in (10,11,12,13,14): reserve(fd)
            for source,target in zip((script,info_write,*config_fds),(10,11,12,13,14)):
                os.dup2(source,target,inheritable=True); owned_fds.add(target)
            close_owned(script); close_owned(info_write)
            state=locked()
            try:
                if state['closed'] or state['phase']!='released' or state['enterPid']!=os.getpid() or state['enterStartTicks']!=ticks(os.getpid()) or cgroup(os.getpid())!=group:
                    raise ValueError('closed before spawn')
                consumed={**state,'phase':'consumed'}; persist(consumed)
                child=subprocess.Popen(['/usr/bin/bwrap',*command['argv']],stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=command['env'],
                    close_fds=True,pass_fds=(10,11,12,13,14))
            finally:
                unlock()
                for fd in (10,11,12,13,14): close_owned(fd)
            startup(child,info_read,consumed,frame_deadline)
            frame=read_frame(frame_deadline,child)
            state=locked()
            try:
                if state['closed'] or state['phase']!='consumed' or state['enterPid']!=os.getpid() or state['enterStartTicks']!=ticks(os.getpid()) or cgroup(os.getpid())!=group: raise ValueError('closed before frame')
                target=child.stdin.fileno(); os.set_blocking(target,False)
                view=memoryview(frame)
                while view:
                    remaining=frame_deadline-time.monotonic()
                    if remaining<=0 or not select.select([],[target],[],remaining)[1]: raise TimeoutError('frame delivery')
                    used=os.write(target,view)
                    if used<=0: raise ValueError('frame delivery')
                    view=view[used:]
                child.stdin.close()
            finally: unlock()
            outcome=relay(child,time.monotonic()+limit)
            if outcome!=0: raise ValueError('model child exited')
        except:
            state=locked()
            try:
                if state['phase'] in ('released','consumed') and not state['closed']: persist({**state,'closed':True})
            finally: unlock()
            if child is not None and child.poll() is None:
                child.terminate()
                try: child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    child.kill(); child.wait(timeout=1)
            raise
        finally:
            if info_read is not None: close_owned(info_read)
    else:
        sys.stdout.write(json.dumps(state,separators=(',',':'))+'\n')
finally:
    for fd in tuple(owned_fds): close_owned(fd)
    os.close(lock); os.close(directory)
`;

export function claudeModelSupervisorSpec(operation: ClaudeModelSupervisorOperation,
  descriptor: ClaudeModelSupervisorDescriptor, root: string,
  paths?: ClaudeMcpSandboxPaths, observed?: ClaudeModelUnitIdentity,
  limits?: ClaudeModelLaunchLimits, profile?: ClaudeModelLaunchProfile): ClaudeModelSupervisorSpec {
  const launch = operation === 'enter_wait_exec' && paths && profile && validClaudeModelLaunchLimits(limits) ?
    buildClaudeModelSealedLaunch(paths, profile, limits.maxTurns) : undefined;
  if (!['prepare', 'status', 'close', 'release', 'enter_wait_exec'].includes(operation) ||
    !valid(descriptor, root) ||
    (operation === 'enter_wait_exec' ? !paths || !limits || !launch ||
      !validClaudeModelLaunchLimits(limits) ||
      !paths.privateFifoDirectory.endsWith(`/${descriptor.attemptId}-${descriptor.launchWorkerEpoch}.mcp`) ||
      launch.commandDigest !== descriptor.commandDigest : paths !== undefined || limits !== undefined || profile !== undefined) ||
    (operation === 'release' ? !observed || Object.keys(observed).length !== 2 ||
      !INVOCATION.test(observed.invocationId) ||
      observed.controlGroup !== `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}` :
      observed !== undefined)) throw new Error('INVALID_ARGUMENT');
  const cmd = launch ? JSON.stringify(launch.recipe) : '';
  const pyArgs = ['/usr/bin/python3', '-I', '-S', '-c', MODEL_JOURNAL_PYTHON,
    operation, root, descriptor.attemptId, descriptor.workspaceId, descriptor.bootId,
    String(descriptor.uid), descriptor.unitName, String(descriptor.launchWorkerEpoch),
    descriptor.sourceDigest, descriptor.profileDigest, descriptor.commandDigest,
    observed?.invocationId ?? '', observed?.controlGroup ?? '', cmd,
    limits ? String(limits.maxWallSeconds) : '', paths ? CLAUDE_MODEL_BOOTSTRAP_PYTHON : ''];
  const prefix = ['-d', descriptor.distro, '--user', descriptor.linuxUser, '--cd', '/', '--exec'];
  const args = operation === 'enter_wait_exec' ? [...prefix, '/usr/bin/systemd-run', '--user', '--quiet',
    '--pipe', '--wait', '--service-type=exec', '--unit', descriptor.unitName,
    '--property=Restart=no', '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes', '--property=TimeoutStopSec=2s',
    `--property=RuntimeMaxSec=${limits!.maxWallSeconds}s`, '--', ...pyArgs] : [...prefix, ...pyArgs];
  return { executable: WSL_EXECUTABLE, args, ...(launch ? { startupInput: Buffer.from(launch.startupInput) } : {}), env: {
    SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows',
  } };
}

export function parseClaudeModelSupervisorOutput(stdout: string,
  d: ClaudeModelSupervisorDescriptor): ClaudeModelSupervisorState | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096 || !stdout.endsWith('\n')) return null;
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const identity = { protocol: 'claude_model_v1', action: 'claude_model_v1',
    attemptId: d.attemptId, workspaceId: d.workspaceId, bootId: d.bootId, uid: d.uid,
    unitName: d.unitName, launchWorkerEpoch: d.launchWorkerEpoch,
    sourceDigest: d.sourceDigest, profileDigest: d.profileDigest, commandDigest: d.commandDigest };
  if (Object.entries(identity).some(([key, expected]) => s[key] !== expected) ||
    typeof s.closed !== 'boolean') return null;
  const base = ['protocol', 'action', 'phase', 'closed', ...Object.keys(identity).slice(2)];
  if (s.phase === 'prepared') {
    if (Object.keys(s).length !== base.length || base.some(key => !(key in s))) return null;
  } else if (s.phase === 'entered' || s.phase === 'released' || s.phase === 'consumed') {
    const extra = ['invocationId', 'controlGroup', 'enterPid', 'enterStartTicks'];
    if (Object.keys(s).length !== base.length + extra.length ||
      [...base, ...extra].some(key => !(key in s)) ||
      typeof s.invocationId !== 'string' || !INVOCATION.test(s.invocationId) ||
      s.controlGroup !== `/user.slice/user-${d.uid}.slice/user@${d.uid}.service/app.slice/${d.unitName}` ||
      !Number.isSafeInteger(s.enterPid) || (s.enterPid as number) <= 0 ||
      !Number.isSafeInteger(s.enterStartTicks) || (s.enterStartTicks as number) <= 0) return null;
  } else return null;
  return s as ClaudeModelSupervisorState;
}


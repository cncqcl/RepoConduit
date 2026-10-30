import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { TextDecoder } from 'node:util';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import type { ClaudeMcpSandboxPaths } from './claude-mcp-sandbox-spec.js';
import type { ClaudeModelLaunchProfile } from './claude-model-launch-config.js';
import type { ClaudeModelRunningObservation } from './claude-model-running-observer.js';
import { claudeModelRunningSpec } from './claude-model-running-observer.js';
import { buildClaudeModelSealedLaunch } from './claude-model-sealed-launch.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON } from './claude-model-bootstrap.js';
import { parseClaudeModelStartup, type ClaudeModelStartupRecord } from './claude-model-startup.js';
import type { ClaudeModelSupervisorDescriptor } from './claude-model-supervisor.js';
import { validClaudeModelLaunchLimits, type ClaudeModelLaunchLimits } from './claude-model-supervisor.js';
import { parseLinuxMountinfo } from './linux-mountinfo.js';

type Running = Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }>;
export interface ClaudeModelOuterProbeInput {
  running: Running;
  startup: ClaudeModelStartupRecord;
  descriptor: ClaudeModelSupervisorDescriptor;
  paths: ClaudeMcpSandboxPaths;
  profile: ClaudeModelLaunchProfile;
  limits?: ClaudeModelLaunchLimits;
}
export interface ClaudeModelOuterProbeSpec {
  executable: typeof WSL_EXECUTABLE;
  args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
}
export interface ClaudeModelOuterProbeOutput {
  exitCode: number | null; stdout: Buffer; stderr: Buffer;
}
export type ClaudeModelOuterProbeRunner =
  (spec: ClaudeModelOuterProbeSpec) => Promise<ClaudeModelOuterProbeOutput>;
export interface ClaudeModelOuterProcessSnapshot {
  pid: number; ppid: number; startTicks: number; state: string; statRaw: string; statusRaw: string;
  selectedStatus: Record<string, string>; uidMap: string; gidMap: string; cgroup: string;
  namespaces: Record<'pid' | 'mnt' | 'net' | 'user' | 'ipc' | 'uts' | 'cgroup', string>;
  exe: string; cmdline: string; cwd: string; root: string;
  fds: { fd: number; target: string; fdinfo: string; direction: string }[];
  mountinfoRaw?: string; mountinfoRawAfter?: string;
}
export interface ClaudeModelOuterIdentity {
  pid: number; ppid: number; startTicks: number; state: string; statRaw: string;
  namespaces: Record<'pid' | 'mnt' | 'net' | 'user' | 'ipc' | 'uts' | 'cgroup', string>;
}
export interface ClaudeModelSandboxPathStat {
  dev: number; ino: number; mode: number; uid: number; gid: number;
}
export interface ClaudeModelOuterRawProbe {
  bootId: string; uid: number; observerNamespaces: Record<string, string>;
  unitBefore: Record<string, string>; unitAfter: Record<string, string>;
  processes: Record<'parent' | 'wrapper' | 'outer' | 'bootstrap', ClaudeModelOuterProcessSnapshot>;
  sandboxPidView: Record<'outer' | 'bootstrap', {
    localPid: number; startTicks: number; pidNamespace: string; statRaw: string }>;
  sandboxPaths: {
    outer: { root: ClaudeModelSandboxPathStat; cwd: ClaudeModelSandboxPathStat };
    bootstrap: { root: ClaudeModelSandboxPathStat; cwd: ClaudeModelSandboxPathStat };
    work: ClaudeModelSandboxPathStat; workEmpty: true;
  };
  endingIdentities: Record<'parent' | 'wrapper' | 'outer' | 'bootstrap', ClaudeModelOuterIdentity>;
  hostMountinfoRaw: string; hostMountinfoRawAfter: string;
  backingPaths: { source: string; target: string; realpath: string;
    host: { dev: number; ino: number; mode: number };
    sandbox: { dev: number; ino: number; mode: number } }[];
  mountedFixedFiles: { target: string; byteLength: number; sha256: string;
    stat: { dev: number; ino: number; mode: number; uid: number; gid: number;
      nlink: number; size: number } }[];
}
export type ClaudeModelOuterProbeObservation =
  | { kind: 'outer_probe_candidate'; running: Running; startup: ClaudeModelStartupRecord;
      probe: ClaudeModelOuterRawProbe }
  | { kind: 'unconfirmed' };

const LINUX_OUTER_PROBE = String.raw`
import hashlib, json, os, re, signal, stat, subprocess, sys, time
unit, group, inv, parent_pid, parent_ticks, outer_pid, outer_ticks, ready_ticks, boot, uid, config_text, backing_text, bootstrap_sha, bootstrap_size, startup_ns_text = sys.argv[1:16]
parent_pid, parent_ticks, outer_pid, outer_ticks, ready_ticks, uid, bootstrap_size = map(int, (parent_pid,parent_ticks,outer_pid,outer_ticks,ready_ticks,uid,bootstrap_size))
config = json.loads(config_text)
backing = json.loads(backing_text)
startup_ns = json.loads(startup_ns_text)
deadline = time.monotonic() + 2
def expired(*_): raise TimeoutError('outer probe deadline')
signal.signal(signal.SIGALRM, expired)
signal.setitimer(signal.ITIMER_REAL, 2)
def check():
    if time.monotonic() >= deadline: raise TimeoutError('outer probe deadline')
def bounded(path, limit):
    check()
    with open(path, 'rb', buffering=0) as stream:
        return read_bounded(stream.read, limit)
def bounded_fd(fd, limit):
    return read_bounded(lambda count: os.read(fd, count), limit)
def read_bounded(read, limit):
    data = bytearray()
    while len(data) <= limit:
        check()
        part = read(limit + 1 - len(data))
        if not part: break
        data.extend(part)
    check()
    if len(data) > limit: raise ValueError('oversize read')
    return bytes(data)
def utf8(data): return data.decode('utf-8', 'strict')
def lines(path, limit): return utf8(bounded(path,limit)).splitlines()
def mount(path):
    raw = utf8(bounded(path, 131072))
    if not raw.endswith('\n') or raw.count('\n') > 128 or '\r' in raw or '\x00' in raw:
        raise ValueError('mountinfo framing')
    return raw
def show():
    check()
    result=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup',unit],
        capture_output=True,timeout=max(.01,deadline-time.monotonic()),check=True)
    if result.stderr or len(result.stdout)>2048: raise ValueError('systemctl output')
    values={}
    for row in result.stdout.decode('ascii','strict').splitlines():
        key,sep,value=row.partition('=')
        if not sep or key in values: raise ValueError('systemctl duplicate')
        values[key]=value
    if set(values)!={'Id','LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup'} or values!={
        'Id':unit,'LoadState':'loaded','ActiveState':'active','SubState':'running',
        'MainPID':str(parent_pid),'InvocationID':inv,'ControlGroup':group}:
        raise ValueError('unit changed')
    return values
def identity(pid):
    base='/proc/%d' % pid
    raw=utf8(bounded(base+'/stat',4096))
    fields=raw[raw.rfind(')')+2:].split()
    if len(fields)<20 or fields[0] in ('Z','X','x'): raise ValueError('stat shape')
    namespaces={name:os.readlink(base+'/ns/'+name) for name in ('pid','mnt','net','user','ipc','uts','cgroup')}
    return {'pid':pid,'startTicks':int(fields[19]),'state':fields[0],
            'ppid':int(fields[1]),'statRaw':raw,'namespaces':namespaces}
def process(pid, include_mount):
    check()
    base='/proc/%d' % pid
    item=identity(pid)
    status=utf8(bounded(base+'/status',8192))
    selected={}
    needed={'PPid','Uid','Gid','NSpid','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs'}
    for row in status.splitlines():
        key,sep,value=row.partition(':')
        if sep and key in needed:
            if key in selected: raise ValueError('duplicate status field')
            selected[key]=value.strip()
    if set(selected)!=needed: raise ValueError('status missing')
    names=os.listdir(base+'/fd')
    if len(names)>32 or any(not name.isdecimal() for name in names): raise ValueError('fd count')
    fds=[]
    for name in sorted(names,key=int):
        fdinfo=utf8(bounded(base+'/fdinfo/'+name,4096))
        flags=[row.partition(':')[2].strip() for row in fdinfo.splitlines() if row.startswith('flags:')]
        if len(flags)!=1: raise ValueError('fd flags')
        access=int(flags[0],8)&3
        fds.append({'fd':int(name),'target':os.readlink(base+'/fd/'+name),
                    'fdinfo':fdinfo,'direction':('read','write','readwrite','invalid')[access]})
    item.update({'statusRaw':status,'selectedStatus':selected,
        'uidMap':utf8(bounded(base+'/uid_map',4096)),'gidMap':utf8(bounded(base+'/gid_map',4096)),
        'cgroup':utf8(bounded(base+'/cgroup',4096)),
        'exe':os.readlink(base+'/exe'),'cmdline':utf8(bounded(base+'/cmdline',32768 if pid==parent_pid else 4096)),
        'cwd':os.readlink(base+'/cwd'),'root':os.readlink(base+'/root'),'fds':fds})
    if include_mount: item['mountinfoRaw']=mount(base+'/mountinfo')
    return item
def file_stat(info): return {'dev':info.st_dev,'ino':info.st_ino,'mode':info.st_mode,
    'uid':info.st_uid,'gid':info.st_gid,'nlink':info.st_nlink,'size':info.st_size}
def path_stat(path):
    check()
    info=os.stat(path)
    return {'dev':info.st_dev,'ino':info.st_ino,'mode':info.st_mode,
            'uid':info.st_uid,'gid':info.st_gid}
def sandbox_pid(local_pid, expected_ticks, expected_ns):
    base='/proc/%d/root/proc/%d' % (outer_pid,local_pid)
    raw=utf8(bounded(base+'/stat',4096))
    close=raw.rfind(')')
    if close<0 or not raw[:close].startswith(str(local_pid)+' ('):
        raise ValueError('sandbox stat pid')
    fields=raw[close+2:].split()
    if len(fields)<20 or fields[0] in ('Z','X','x'):
        raise ValueError('sandbox stat shape')
    ticks=int(fields[19])
    namespace=os.readlink(base+'/ns/pid')
    if ticks!=expected_ticks or namespace!=expected_ns:
        raise ValueError('sandbox pid identity')
    return {'localPid':local_pid,'startTicks':ticks,'pidNamespace':namespace,'statRaw':raw}
def sandbox_paths(bootstrap_pid):
    outer_base='/proc/%d' % outer_pid
    bootstrap_base='/proc/%d' % bootstrap_pid
    outer_paths={'root':path_stat(outer_base+'/root'),'cwd':path_stat(outer_base+'/cwd')}
    bootstrap_paths={'root':path_stat(bootstrap_base+'/root'),
                     'cwd':path_stat(bootstrap_base+'/cwd')}
    work_path=outer_base+'/root/work'
    work=path_stat(work_path)
    if outer_paths['root']!=bootstrap_paths['root'] or \
            outer_paths['cwd']!=work or bootstrap_paths['cwd']!=work:
        raise ValueError('sandbox path identity')
    check()
    with os.scandir(work_path) as entries:
        empty=next(entries,None) is None
    check()
    if not empty: raise ValueError('work not empty')
    return {'outer':outer_paths,'bootstrap':bootstrap_paths,'work':work,'workEmpty':True}
def fixed_files():
    expected=config+[{'target':'/opt/rcac-bootstrap.py','byteLength':bootstrap_size,'sha256':bootstrap_sha}]
    found=[]
    for item in expected:
        path='/proc/%d/root%s' % (outer_pid,item['target'])
        check()
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode): raise ValueError('fixed file kind')
            data=bounded_fd(fd,65536)
            if len(data)>65536 or len(data)!=item['byteLength'] or hashlib.sha256(data).hexdigest()!=item['sha256']:
                raise ValueError('fixed file body')
            found.append({'target':item['target'],'byteLength':len(data),
                          'sha256':hashlib.sha256(data).hexdigest(),'stat':file_stat(info)})
        finally: os.close(fd)
    return found
def mount_unescape(text):
    for escape,actual in (('\\040',' '),('\\011','\t'),('\\012','\n'),('\\134','\\')):
        text=text.replace(escape,actual)
    return text
def backing_paths(host_raw):
    pairs=list(backing)
    host_mounts=[]
    for row in host_raw.splitlines():
        pre,separator,post=row.partition(' - ')
        if not separator: raise ValueError('host mount line')
        fields=pre.split(' ')
        if len(fields)<6: raise ValueError('host mount fields')
        host_mounts.append(mount_unescape(fields[4]))
    for item in backing[:5]:
        if item['target'] not in ('/usr','/bin','/lib','/lib64','/etc/alternatives/which'):
            continue
        real=os.path.realpath(item['source'])
        for mounted in host_mounts:
            if mounted!=real and mounted.startswith(real+'/'):
                relative=mounted[len(real):]
                pairs.append({'source':mounted,'target':item['target']+relative})
    if len(pairs)>128: raise ValueError('backing pair count')
    seen=set(); found=[]
    for item in pairs:
        source,target=item['source'],item['target']
        if target in seen: continue
        seen.add(target)
        check()
        realpath=os.path.realpath(source)
        host=os.stat(realpath,follow_symlinks=False)
        sandbox=os.stat('/proc/%d/root%s' % (outer_pid,target),follow_symlinks=False)
        found.append({'source':source,'target':target,'realpath':realpath,
                      'host':{'dev':host.st_dev,'ino':host.st_ino,'mode':host.st_mode},
                      'sandbox':{'dev':sandbox.st_dev,'ino':sandbox.st_ino,'mode':sandbox.st_mode}})
    return found
if os.getuid()!=uid or utf8(bounded('/proc/sys/kernel/random/boot_id',128)).strip()!=boot:
    raise ValueError('observer host identity')
observer_ns={name:os.readlink('/proc/self/ns/'+name) for name in ('pid','mnt','net','user','ipc','uts','cgroup')}
unit_before=show()
host_before=mount('/proc/self/mountinfo')
outer=process(outer_pid,True)
wrapper=process(outer['ppid'],False)
parent=process(parent_pid,False)
children=utf8(bounded('/proc/%d/task/%d/children' % (outer_pid,outer_pid),512)).split()
if len(children)!=1: raise ValueError('bootstrap child count')
bootstrap=process(int(children[0]),True)
if parent['startTicks']!=parent_ticks or outer['startTicks']!=outer_ticks or \
        wrapper['ppid']!=parent_pid or outer['ppid']!=wrapper['pid'] or bootstrap['ppid']!=outer_pid or \
        bootstrap['startTicks']!=ready_ticks or \
        outer['selectedStatus']['NSpid'].split()!=[str(outer_pid),'1'] or \
        bootstrap['selectedStatus']['NSpid'].split()!=[str(bootstrap['pid']),'2'] or \
        outer['namespaces']!=startup_ns or bootstrap['namespaces']!=startup_ns or \
        os.path.realpath(wrapper['exe'])!=os.path.realpath('/usr/bin/bwrap') or \
        os.path.realpath(outer['exe'])!=os.path.realpath('/usr/bin/bwrap'):
    raise ValueError('lineage')
mounted=fixed_files()
backed=backing_paths(host_before)
sandbox_pid_view={'outer':sandbox_pid(1,outer_ticks,startup_ns['pid']),
                  'bootstrap':sandbox_pid(2,ready_ticks,startup_ns['pid'])}
sandbox_path_view=sandbox_paths(bootstrap['pid'])
host_after=mount('/proc/self/mountinfo')
outer['mountinfoRawAfter']=mount('/proc/%d/mountinfo' % outer_pid)
bootstrap['mountinfoRawAfter']=mount('/proc/%d/mountinfo' % bootstrap['pid'])
ending={}
for name,item in (('parent',parent),('wrapper',wrapper),('outer',outer),('bootstrap',bootstrap)):
    later=identity(item['pid'])
    if any(item[key]!=later[key] for key in ('pid','startTicks','ppid','namespaces')):
        raise ValueError('process changed')
    ending[name]=later
unit_after=show()
if unit_before!=unit_after or os.getuid()!=uid or utf8(bounded('/proc/sys/kernel/random/boot_id',128)).strip()!=boot:
    raise ValueError('observer identity changed')
result={'bootId':boot,'uid':uid,'observerNamespaces':observer_ns,
        'unitBefore':unit_before,'unitAfter':unit_after,
        'processes':{'parent':parent,'wrapper':wrapper,'outer':outer,'bootstrap':bootstrap},
        'sandboxPidView':sandbox_pid_view,'sandboxPaths':sandbox_path_view,
        'endingIdentities':ending,
        'hostMountinfoRaw':host_before,'hostMountinfoRawAfter':host_after,
        'backingPaths':backed,'mountedFixedFiles':mounted}
check()
encoded=(json.dumps(result,separators=(',',':'),ensure_ascii=False)+'\n').encode('utf-8')
if len(encoded)>262144: raise ValueError('outer probe output too large')
sys.stdout.buffer.write(encoded)
`;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const namespaceKeys = ['pid','mnt','net','user','ipc','uts','cgroup'] as const;
const unitKeys = ['Id','LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup'] as const;
const selectedKeys = ['PPid','Uid','Gid','NSpid','CapInh','CapPrm','CapEff',
  'CapBnd','CapAmb','NoNewPrivs'] as const;
const processKeys = ['pid','ppid','startTicks','state','statRaw','namespaces','statusRaw',
  'selectedStatus','uidMap','gidMap','cgroup','exe','cmdline','cwd','root','fds'];
const identityKeys = ['pid','ppid','startTicks','state','statRaw','namespaces'];
const pathStatKeys = ['dev','ino','mode','uid','gid'];
function safeNumber(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function stringRecord(value: unknown, keys: readonly string[]): boolean {
  return exactKeys(value, keys) && keys.every(key => typeof value[key] === 'string');
}
function statShape(value: unknown, keys: readonly string[]): boolean {
  return exactKeys(value, keys) && keys.every(key => safeNumber(value[key]));
}
function processShape(value: unknown, mounted: boolean): boolean {
  const keys = mounted ? [...processKeys, 'mountinfoRaw', 'mountinfoRawAfter'] : processKeys;
  if (!exactKeys(value, keys) || !safeNumber(value.pid) || !safeNumber(value.ppid) ||
      !safeNumber(value.startTicks) || typeof value.state !== 'string' ||
      !stringRecord(value.namespaces, namespaceKeys) ||
      !stringRecord(value.selectedStatus, selectedKeys)) return false;
  for (const key of ['statRaw','statusRaw','uidMap','gidMap','cgroup','exe','cmdline','cwd','root']) {
    if (typeof value[key] !== 'string') return false;
  }
  if (!Array.isArray(value.fds) || value.fds.length > 32 ||
      !value.fds.every((fd: unknown) => exactKeys(fd, ['fd','target','fdinfo','direction']) &&
        safeNumber(fd.fd) && typeof fd.target === 'string' &&
        typeof fd.fdinfo === 'string' && typeof fd.direction === 'string')) return false;
  return !mounted || typeof value.mountinfoRaw === 'string' &&
    typeof value.mountinfoRawAfter === 'string';
}
function identityShape(value: unknown): boolean {
  return exactKeys(value, identityKeys) && safeNumber(value.pid) &&
    safeNumber(value.ppid) && safeNumber(value.startTicks) &&
    typeof value.state === 'string' && value.state !== 'Z' &&
    value.state !== 'X' && value.state !== 'x' &&
    typeof value.statRaw === 'string' && stringRecord(value.namespaces, namespaceKeys);
}
function sandboxPidShape(value: unknown): boolean {
  return exactKeys(value, ['localPid','startTicks','pidNamespace','statRaw']) &&
    safeNumber(value.localPid) && safeNumber(value.startTicks) &&
    typeof value.pidNamespace === 'string' && typeof value.statRaw === 'string';
}
function sandboxPathsShape(value: unknown): boolean {
  return exactKeys(value, ['outer','bootstrap','work','workEmpty']) &&
    exactKeys(value.outer, ['root','cwd']) && exactKeys(value.bootstrap, ['root','cwd']) &&
    statShape(value.outer.root, pathStatKeys) && statShape(value.outer.cwd, pathStatKeys) &&
    statShape(value.bootstrap.root, pathStatKeys) &&
    statShape(value.bootstrap.cwd, pathStatKeys) &&
    statShape(value.work, pathStatKeys) && value.workEmpty === true &&
    isDeepStrictEqual(value.outer.root, value.bootstrap.root) &&
    isDeepStrictEqual(value.outer.cwd, value.work) &&
    isDeepStrictEqual(value.bootstrap.cwd, value.work);
}

function probeShape(probe: Record<string, unknown>): boolean {
  if (!stringRecord(probe.observerNamespaces, namespaceKeys) ||
      !stringRecord(probe.unitBefore, unitKeys) || !stringRecord(probe.unitAfter, unitKeys) ||
      !exactKeys(probe.processes, ['parent','wrapper','outer','bootstrap']) ||
      !processShape(probe.processes.parent, false) ||
      !processShape(probe.processes.wrapper, false) ||
      !processShape(probe.processes.outer, true) ||
      !processShape(probe.processes.bootstrap, true) ||
      !exactKeys(probe.sandboxPidView, ['outer','bootstrap']) ||
      !sandboxPidShape(probe.sandboxPidView.outer) ||
      !sandboxPidShape(probe.sandboxPidView.bootstrap) ||
      !sandboxPathsShape(probe.sandboxPaths) ||
      !exactKeys(probe.endingIdentities, ['parent','wrapper','outer','bootstrap']) ||
      !['parent','wrapper','outer','bootstrap'].every(key =>
        identityShape((probe.endingIdentities as Record<string, unknown>)[key])) ||
      !Array.isArray(probe.backingPaths) || probe.backingPaths.length > 128 ||
      !probe.backingPaths.every((item: unknown) => exactKeys(item,
        ['source','target','realpath','host','sandbox']) &&
        ['source','target','realpath'].every(key => typeof item[key] === 'string') &&
        statShape(item.host, ['dev','ino','mode']) &&
        statShape(item.sandbox, ['dev','ino','mode'])) ||
      !Array.isArray(probe.mountedFixedFiles) || probe.mountedFixedFiles.length !== 4)
    return false;
  return probe.mountedFixedFiles.every((item: unknown) => exactKeys(item,
    ['target','byteLength','sha256','stat']) && typeof item.target === 'string' &&
    safeNumber(item.byteLength) && typeof item.sha256 === 'string' &&
    statShape(item.stat, ['dev','ino','mode','uid','gid','nlink','size']));
}

function validatedInput(input: ClaudeModelOuterProbeInput):
  { saved: ClaudeModelOuterProbeInput; configFiles: readonly {target:string;byteLength:number;sha256:string}[] } | null {
  let saved: ClaudeModelOuterProbeInput;
  try { saved = structuredClone(input); } catch { return null; }
  if (!exactKeys(saved, ['running','startup','descriptor','paths','profile','limits']) ||
      !validClaudeModelLaunchLimits(saved.limits) ||
      saved.running?.kind !== 'claude_model_running' ||
      !exactKeys(saved.running.native, ['bootId','uid','unitName','invocationId','controlGroup',
        'loadState','activeState','subState','mainPid','startTicks','procControlGroup'])) return null;
  try { claudeModelRunningSpec(saved.running.resource, saved.running.journal, saved.descriptor); }
  catch { return null; }
  let parsed: ClaudeModelStartupRecord | null;
  try { parsed = parseClaudeModelStartup(JSON.stringify(saved.startup) + '\n', saved.descriptor); }
  catch { return null; }
  if (!parsed || !isDeepStrictEqual(parsed, saved.startup) ||
      !isDeepStrictEqual(saved.startup.journal,
        { ...saved.running.journal, phase: 'consumed' }) ||
      saved.running.native.bootId !== saved.descriptor.bootId ||
      saved.running.native.uid !== saved.descriptor.uid ||
      saved.running.native.unitName !== saved.descriptor.unitName ||
      saved.running.native.invocationId !== saved.running.resource.invocationId ||
      saved.running.native.controlGroup !== saved.running.resource.controlGroup ||
      saved.running.native.mainPid !== saved.running.journal.enterPid ||
      saved.running.native.startTicks !== saved.running.journal.enterStartTicks ||
      saved.running.native.procControlGroup !== saved.running.resource.controlGroup ||
      saved.running.native.loadState !== 'loaded' ||
      saved.running.native.activeState !== 'active' ||
      saved.running.native.subState !== 'running') return null;
  try {
    const sealed = buildClaudeModelSealedLaunch(saved.paths, saved.profile, saved.limits.maxTurns);
    if (sealed.commandDigest !== saved.descriptor.commandDigest) return null;
    return { saved, configFiles: sealed.recipe.configFiles };
  } catch { return null; }
}

function specFor(input: ClaudeModelOuterProbeInput,
  configFiles: readonly {target:string;byteLength:number;sha256:string}[]): ClaudeModelOuterProbeSpec {
  const { running, startup, descriptor, paths } = input;
  const backing = [
    { source: '/usr', target: '/usr' }, { source: '/bin', target: '/bin' },
    { source: '/lib', target: '/lib' }, { source: '/lib64', target: '/lib64' },
    { source: '/usr/bin/which.debianutils', target: '/etc/alternatives/which' },
    { source: `${paths.installRoot}/node_modules`, target: '/runtime/node_modules' },
    { source: `${paths.installRoot}/deps`, target: '/runtime/deps' },
    { source: paths.nodeRoot, target: '/node' },
    { source: paths.privateAuthHome, target: '/home/claude' },
    { source: paths.privateFifoDirectory, target: '/relay' },
  ];
  return { executable: WSL_EXECUTABLE, env: {
    SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows',
  }, args: ['-d', descriptor.distro, '--user', descriptor.linuxUser, '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', LINUX_OUTER_PROBE,
    descriptor.unitName, running.resource.controlGroup!, running.resource.invocationId!,
    String(running.journal.enterPid), String(running.journal.enterStartTicks),
    String(startup.outerCandidate.hostPid), String(startup.outerCandidate.startTicks),
    String(startup.bootstrapReady.startTicks), descriptor.bootId, String(descriptor.uid),
    JSON.stringify(configFiles), JSON.stringify(backing), startup.bootstrapSha256,
    String(Buffer.byteLength(CLAUDE_MODEL_BOOTSTRAP_PYTHON, 'utf8')),
    JSON.stringify(startup.bootstrapReady.namespaces)] };
}

type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean; unref(): void };
export function readClaudeModelOuterProbeChild(child: BoundedChild): Promise<ClaudeModelOuterProbeOutput> {
  return new Promise(resolve => {
    const out: Buffer[] = []; const err: Buffer[] = [];
    let totalOut = 0; let totalErr = 0; let failed = false; let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); if (grace) clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy(); if (code === null) child.unref();
      resolve({ exitCode: failed ? null : code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    };
    const fail = () => {
      if (failed || finished) return;
      failed = true;
      try { child.kill(); } catch { /* Windows bridge is not Linux terminal proof. */ }
      grace = setTimeout(() => finish(null), 500);
    };
    const timer = setTimeout(fail, 3000);
    child.stdout.on('data', (part: Buffer) => {
      totalOut += part.length; if (totalOut > 262144) { fail(); return; }
      out.push(Buffer.from(part));
    });
    child.stderr.on('data', (part: Buffer) => {
      totalErr += part.length; if (totalErr > 4096) { fail(); return; }
      err.push(Buffer.from(part));
    });
    child.stdout.on('error', fail); child.stderr.on('error', fail); child.on('error', fail);
    child.on('close', finish);
  });
}

export function runClaudeModelOuterProbe(spec: ClaudeModelOuterProbeSpec):
  Promise<ClaudeModelOuterProbeOutput> {
  const child = spawn(spec.executable, [...spec.args],
    { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return readClaudeModelOuterProbeChild(child);
}

export async function observeClaudeModelOuterCandidate(input: ClaudeModelOuterProbeInput,
  runner: ClaudeModelOuterProbeRunner = runClaudeModelOuterProbe):
  Promise<ClaudeModelOuterProbeObservation> {
  const validated = validatedInput(input);
  if (!validated) return { kind: 'unconfirmed' };
  let output: ClaudeModelOuterProbeOutput;
  try { output = await runner(specFor(validated.saved, validated.configFiles)); }
  catch { return { kind: 'unconfirmed' }; }
  if (!output || output.exitCode !== 0 || !Buffer.isBuffer(output.stdout) ||
      !Buffer.isBuffer(output.stderr) || output.stdout.length > 262144 ||
      output.stderr.length > 4096) return { kind: 'unconfirmed' };
  let probe: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(output.stdout);
    if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return { kind: 'unconfirmed' };
    probe = JSON.parse(text);
  } catch { return { kind: 'unconfirmed' }; }
  if (!exactKeys(probe, ['bootId','uid','observerNamespaces','unitBefore','unitAfter',
    'processes','sandboxPidView','sandboxPaths','endingIdentities',
    'hostMountinfoRaw','hostMountinfoRawAfter','backingPaths','mountedFixedFiles']) ||
      probe.bootId !== validated.saved.descriptor.bootId ||
      probe.uid !== validated.saved.descriptor.uid ||
      !probeShape(probe))
    return { kind: 'unconfirmed' };
  const raw = probe as Record<string, unknown>;
  const processes = raw.processes as ClaudeModelOuterRawProbe['processes'];
  const view = raw.sandboxPidView as ClaudeModelOuterRawProbe['sandboxPidView'];
  const ending = raw.endingIdentities as ClaudeModelOuterRawProbe['endingIdentities'];
  if (view.outer.localPid !== 1 || view.bootstrap.localPid !== 2 ||
      view.outer.startTicks !== processes.outer.startTicks ||
      view.bootstrap.startTicks !== processes.bootstrap.startTicks ||
      view.outer.pidNamespace !== processes.outer.namespaces.pid ||
      view.bootstrap.pidNamespace !== processes.bootstrap.namespaces.pid ||
      !(['parent','wrapper','outer','bootstrap'] as const).every(key =>
        ending[key].pid === processes[key].pid &&
        ending[key].ppid === processes[key].ppid &&
        ending[key].startTicks === processes[key].startTicks &&
        isDeepStrictEqual(ending[key].namespaces, processes[key].namespaces)))
    return { kind: 'unconfirmed' };
  try {
    parseLinuxMountinfo(probe.hostMountinfoRaw as string);
    parseLinuxMountinfo(probe.hostMountinfoRawAfter as string);
    for (const subject of ['outer','bootstrap'] as const) {
      const process = (probe.processes as Record<string, Record<string, unknown>>)[subject]!;
      parseLinuxMountinfo(process.mountinfoRaw as string);
      parseLinuxMountinfo(process.mountinfoRawAfter as string);
    }
  } catch { return { kind: 'unconfirmed' }; }
  return { kind: 'outer_probe_candidate', running: validated.saved.running,
    startup: validated.saved.startup, probe: probe as unknown as ClaudeModelOuterRawProbe };
}

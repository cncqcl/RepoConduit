/** Pure, tools-only candidate. No process, account, filesystem preparation or production admission. */
export function isHelpOnlyDiagnostic(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === '--app-server-help') return true;
  throw new Error('FIXED_DIAGNOSTIC_ENTRY_ONLY');
}

export const keyringDenyFilter = Object.freeze([
  [0x20, 0, 0, 4], [0x15, 1, 0, 0xc000003e], [0x06, 0, 0, 0x80000000],
  [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001],
  [0x15, 6, 0, 248], [0x15, 5, 0, 249], [0x15, 4, 0, 250],
  [0x15, 3, 0, 425], [0x15, 2, 0, 426], [0x15, 1, 0, 427],
  [0x06, 0, 0, 0x7fff0000], [0x06, 0, 0, 0x00050001],
].map(row => Object.freeze(row)));

/** The only initialize payload entry. The outer bootstrap supplies its own closed stdio record. */
export const sealSource = String.raw`import errno,fcntl,json,os,re,stat,sys
NODE=['/node/bin/node','/runtime/codex/package/bin/codex.js','app-server','--stdio']
ENV={'HOME':'/home/investigator','CODEX_HOME':'/home/investigator/.codex','PATH':'/node/bin:/usr/bin','PWD':'/source'}
def seal():
 if len(sys.argv)!=2 or len(sys.argv[1])>4096: raise RuntimeError('SEAL_ARGV')
 record=json.loads(sys.argv[1])
 if not isinstance(record,dict) or set(record)!={'pid','startTicks','bootId','uid','outerPidNs','stdio','stdioObjects','stdioAccess'}: raise RuntimeError('SEAL_RECORD')
 if type(record['pid']) is not int or record['pid']<=0 or type(record['uid']) is not int or record['uid']!=1000 or not isinstance(record['startTicks'],str) or not record['startTicks'].isdigit() or int(record['startTicks'])<=0: raise RuntimeError('SEAL_RECORD')
 if not isinstance(record['bootId'],str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',record['bootId']): raise RuntimeError('SEAL_RECORD')
 if not isinstance(record['outerPidNs'],str) or not re.fullmatch(r'pid:\[[0-9]+\]',record['outerPidNs']): raise RuntimeError('SEAL_RECORD')
 if any(not isinstance(record[key],dict) or set(record[key])!={'0','1','2'} for key in ('stdio','stdioObjects','stdioAccess')): raise RuntimeError('SEAL_RECORD')
 for fd in range(3):
  key=str(fd);obj=record['stdioObjects'][key]
  if not isinstance(record['stdio'][key],str) or not re.fullmatch(r'pipe:\[[0-9]+\]',record['stdio'][key]): raise RuntimeError('SEAL_RECORD')
  if not isinstance(obj,list) or len(obj)!=2 or any(type(value) is not int or value<=0 for value in obj): raise RuntimeError('SEAL_RECORD')
 if len({tuple(value) for value in record['stdioObjects'].values()})!=3 or len(set(record['stdio'].values()))!=3: raise RuntimeError('SEAL_ALIAS')
 if record['stdioAccess']!={'0':0,'1':1,'2':1} or any(type(value) is not int for value in record['stdioAccess'].values()): raise RuntimeError('SEAL_DIRECTION')
 if os.getuid()!=1000 or os.getcwd()!='/source' or os.readlink('/proc/self/ns/pid')==record['outerPidNs']: raise RuntimeError('SEAL_CONTEXT')
 with open('/proc/self/status','rb') as stream: status=stream.read(4097)
 if len(status)>4096: raise RuntimeError('SEAL_STATUS')
 fields=dict(line.split(b':',1) for line in status.splitlines() if b':' in line)
 ns=fields.get(b'NSpid',b'').split()
 if fields.get(b'Threads',b'').strip()!=b'1' or len(ns)!=1 or not ns[0].isdigit() or int(ns[0])!=os.getpid() or os.getpid()<=1: raise RuntimeError('SEAL_THREADS_OR_PIDNS')
 with open('/proc/self/environ','rb') as stream: raw_env=stream.read(4097)
 entries=raw_env[:-1].split(b'\0') if raw_env.endswith(b'\0') else []
 if len(raw_env)>4096 or len(entries)!=4 or len(set(entries))!=4 or set(entries)!={x.encode() for x in (k+'='+v for k,v in ENV.items())}: raise RuntimeError('SEAL_ENV')
 names=os.listdir('/proc/self/fd')
 if len(names)>64 or any(not name.isdigit() for name in names): raise RuntimeError('SEAL_FD_LIMIT')
 for name in names:
  fd=int(name)
  if fd>2:
   try: os.close(fd)
   except OSError as error:
    if error.errno!=errno.EBADF: raise
 names=os.listdir('/proc/self/fd')
 if len(names)>64 or any(not name.isdigit() for name in names): raise RuntimeError('SEAL_FD_LIMIT')
 for name in names:
  fd=int(name)
  if fd>2:
   try: os.fstat(fd)
   except OSError as error:
    if error.errno!=errno.EBADF: raise
   else: raise RuntimeError('SEAL_FD_REMAINED')
 for fd in range(3):
  info=os.fstat(fd)
  if not stat.S_ISFIFO(info.st_mode) or [info.st_dev,info.st_ino]!=record['stdioObjects'][str(fd)]: raise RuntimeError('SEAL_STDIO_OBJECT')
  if os.readlink('/proc/self/fd/'+str(fd))!=record['stdio'][str(fd)]: raise RuntimeError('SEAL_STDIO_LINK')
  if fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE!=record['stdioAccess'][str(fd)]: raise RuntimeError('SEAL_STDIO_DIRECTION')
 os.execve('/node/bin/node',NODE,ENV)
seal()
`;

/** This bootstrap is future native code, not executed by the builder or offline tests.
 * Unit must be reserved before launch. It closes ambient FDs and supplies only its filter FD.
 * The filter denies Linux key APIs even with the same host UID. It is NOT a syscall allowlist.
 */
function bootstrap(argv: readonly string[], pipeRecord?: string): string {
  return `
import errno, json, os, pathlib, stat, struct
argv=${JSON.stringify(['/usr/bin/bwrap', ...argv])}
env={'HOME':'/home/fixture','PATH':'/usr/bin:/bin'}
def close_ambient_fds():
 fds=os.listdir('/proc/self/fd')
 if len(fds)>64: raise RuntimeError('FD_LIMIT')
 for name in fds:
  fd=int(name)
  if fd>2:
   try: os.close(fd)
   except OSError as error:
    if error.errno!=errno.EBADF: raise
close_ambient_fds()
${pipeRecord === undefined ? '' : `pipe_record=${JSON.stringify(pipeRecord)}
stdio={str(fd):os.readlink('/proc/self/fd/'+str(fd)) for fd in range(3)}
if not all(stat.S_ISFIFO(os.fstat(fd).st_mode) and stdio[str(fd)].startswith('pipe:[') for fd in range(3)):
 raise RuntimeError('PROTOCOL_PIPE_UNCONFIRMED')
metadata={'pid':os.getpid(),'startTicks':pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],
 'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'uid':os.getuid(),
 'outerPidNs':os.readlink('/proc/self/ns/pid'),'stdio':stdio,
 'stdioObjects':{str(fd):[os.fstat(fd).st_dev,os.fstat(fd).st_ino] for fd in range(3)},
 'stdioAccess':{str(fd):__import__('fcntl').fcntl(fd,__import__('fcntl').F_GETFL)&os.O_ACCMODE for fd in range(3)}}
if metadata['stdioAccess']!={'0':0,'1':1,'2':1}: raise RuntimeError('PROTOCOL_PIPE_DIRECTION')
directory=os.open(str(pathlib.Path(pipe_record).parent),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 record_fd=os.open('launch-pipes.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
 try:
  data=json.dumps(metadata).encode('ascii')
  if os.write(record_fd,data)!=len(data): raise RuntimeError('PIPE_RECORD_SHORT_WRITE')
  os.fsync(record_fd)
 finally: os.close(record_fd)
finally: os.close(directory)
if argv[-1]!='__PIPE_RECORD__': raise RuntimeError('PIPE_SEAL_ENTRY')
argv[-1]=json.dumps(metadata,sort_keys=True,separators=(',',':'))
`}
fd=os.memfd_create('rcac-keyring-deny',os.MFD_CLOEXEC)
data=b''.join(struct.pack('<HBBI',*row) for row in ${JSON.stringify(keyringDenyFilter)})
if os.write(fd,data)!=len(data): raise RuntimeError('FILTER_SHORT_WRITE')
os.lseek(fd,0,os.SEEK_SET)
if fd!=3:
 os.dup2(fd,3,inheritable=True)
 os.close(fd)
else: os.set_inheritable(3,True)
os.execve(argv[0],argv,env)
`;
}

export const isolationCanary = String.raw`
import ctypes, errno, json, os, pathlib, socket, sys
def inaccessible(path):
 try:
  fd=os.open(path,os.O_RDONLY);os.close(fd)
 except OSError as e: return e.errno in (errno.ENOENT,errno.EACCES,errno.ENOTDIR)
 return False
def denied_connect(family,target,controlled=False):
 s=socket.socket(family,socket.SOCK_STREAM)
 s.settimeout(0.5)
 try: s.connect(target)
 except OSError as e: return e.errno in (errno.ENOENT,errno.EACCES,errno.EPERM,errno.ENETUNREACH) or (controlled and e.errno==errno.ECONNREFUSED)
 finally: s.close()
 return False
def main():
 credential,port,unix_socket=sys.argv[1:]
 # Internal process synchronization only: EOF refuses execution, never grants permission.
 print('CANARY_READY',flush=True)
 if sys.stdin.readline()!='OBSERVE_COMPLETE\n': raise RuntimeError('OBSERVATION_NOT_RELEASED')
 source=pathlib.Path('/source/fixture.txt')
 readable=source.read_bytes()==b'RCAC_SYNTHETIC_SOURCE\n'
 try: source.write_bytes(b'MUST_NOT_WRITE')
 except OSError as e: readonly=e.errno==errno.EROFS
 else: readonly=False
 home=pathlib.Path('/home/investigator')
 empty_home=list(home.iterdir())==[home/'.codex'] and list((home/'.codex').iterdir())==[]
 scratch=pathlib.Path('/scratch/check.txt');scratch.write_bytes(b'LOCAL_SCRATCH')
 libc=ctypes.CDLL(None,use_errno=True)
 # KEYCTL_READ of invalid key 0: no real credential or key is inspected if filter fails.
 key=libc.syscall(250,11,0,0,0,0);key_denied=key==-1 and ctypes.get_errno()==errno.EPERM
 status=dict(x.split(':',1) for x in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in x)
 fd_names=os.listdir('/proc/self/fd')
 fds=[]
 for name in fd_names:
  try: os.fstat(int(name))
  except OSError: continue
  fds.append(int(name))
 # Python may coerce its locale after exec. Observe bounded initial exec environment, not a projected dict.
 with open('/proc/self/environ','rb') as stream: initial_env=stream.read(4097)
 # bwrap 0.6.1 always adds PWD after applying --clearenv/--unsetenv (bubblewrap.c:3145).
 expected_env={b'HOME=/home/investigator',b'CODEX_HOME=/home/investigator/.codex',b'PATH=/node/bin:/usr/bin',b'PWD=/source'}
 initial_closed=initial_env.endswith(b'\0') and len(initial_env)<=4096 and len(initial_env.split(b'\0')[:-1])==4 and set(initial_env.split(b'\0')[:-1])==expected_env
 facts={'sourceReadable':readable,'sourceReadonly':readonly,'emptyHome':empty_home,
  'scratchWritable':scratch.read_bytes()==b'LOCAL_SCRATCH',
  'hostPathsHidden':all(inaccessible(p) for p in ['/home/fixture','/mnt/c','/mnt/d','/etc/codex','/run/user/1000/bus']),
  'hostProcHidden':not pathlib.Path('/proc/1/root/home/fixture').exists(),
  'keyringDenied':key_denied,'networkDenied':denied_connect(socket.AF_INET,('192.0.2.1',9)),
  'syntheticCredentialHidden':inaccessible(credential),
  'hostListenerDenied':denied_connect(socket.AF_INET,('127.0.0.1',int(port)),True),
  'syntheticUnixSocketDenied':denied_connect(socket.AF_UNIX,unix_socket,True),
  'userBusDenied':denied_connect(socket.AF_UNIX,'/run/user/1000/bus'),
  'noExtraFds':set(fds)=={0,1,2},
  'noCapabilities':all(int(status[k].strip(),16)==0 for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']),
  'noNewPrivileges':status['NoNewPrivs'].strip()=='1',
  'initialEnvironmentClosed':initial_closed}
 print(json.dumps(facts,sort_keys=True))
 sys.exit(0 if all(facts.values()) else 1)
main()
`;

export function buildWslIsolationCandidate(id: unknown) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new Error('INVALID_CANDIDATE_ID');
  const root = `/home/fixture/.local/repoconduit-private-homes/${id}`;
  const controls = Object.freeze({ credential: `${root}/credential-canary.txt`, unixSocket: `${root}/canary.sock`,
    port: 30768 + parseInt(id.slice(0, 4), 16) % 2048 });
  const sandbox = Object.freeze([
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
    '--setenv', 'HOME', '/home/investigator', '--setenv', 'CODEX_HOME', '/home/investigator/.codex',
    '--setenv', 'PATH', '/node/bin:/usr/bin', '--seccomp', '3',
    '--ro-bind', '/usr/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu',
    '--ro-bind', '/usr/lib/python3.10', '/usr/lib/python3.10',
    '--ro-bind', '/usr/bin/python3.10', '/usr/bin/python3.10',
    '--symlink', 'usr/lib', '/lib', '--dir', '/lib64',
    '--symlink', '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/lib64/ld-linux-x86-64.so.2',
    '--ro-bind', '/home/fixture/.hermes/node/bin/node', '/node/bin/node',
    '--ro-bind', '/home/fixture/.local/repoconduit-codex-0.157.1', '/runtime/codex',
    '--ro-bind', `${root}/workspace`, '/source',
    '--proc', '/proc', '--dev', '/dev', '--dir', '/etc', '--dir', '/run',
    '--perms', '0700', '--tmpfs', '/home/investigator', '--perms', '0700', '--dir', '/home/investigator/.codex',
    '--perms', '0700', '--tmpfs', '/scratch', '--tmpfs', '/tmp', '--chdir', '/source',
  ]);
  const unit = Object.freeze([
    '-d', 'Ubuntu-22.04', '--user', 'fixture', '--exec', '/usr/bin/systemd-run', '--user', '--quiet',
    `--unit=rcac-investigator-${id}.service`, '--service-type=exec',
    '--property=Restart=no', '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
    '--property=RuntimeMaxSec=30s', '--property=TimeoutStopSec=2s', '--remain-after-exit',
    '--pipe', '--wait', '/usr/bin/bwrap',
  ]);
  const canary = Object.freeze([...unit, ...sandbox, '--', '/usr/bin/python3.10', '-I', '-S', '-c', isolationCanary,
    controls.credential, String(controls.port), controls.unixSocket]);
  const appServerHelp = Object.freeze([...unit, ...sandbox, '--', '/node/bin/node',
    '/runtime/codex/package/bin/codex.js', 'app-server', '--stdio', '--help']);
  const appServerInitialize = Object.freeze([...unit, ...sandbox, '--', '/usr/bin/python3.10',
    '-I', '-S', '-c', sealSource, '__PIPE_RECORD__']);
  const nativeCommand = (command: readonly string[], pipeRecord?: string) => Object.freeze([
    ...unit.slice(0, -1), '/usr/bin/env', '-i', 'HOME=/home/fixture', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3.10', '-I', '-S', '-c', bootstrap(command.slice(unit.length), pipeRecord),
  ]);
  return Object.freeze({ nativeExecuted: false, productionAvailable: false, unit, sandbox, controls, canary, appServerHelp,
    appServerInitialize, canaryLaunch: nativeCommand(canary), helpLaunch: nativeCommand(appServerHelp),
    initializeLaunch: nativeCommand(appServerInitialize, `${root}/launch-pipes.json`) });
}

/** Only the fixed tools observer can supply these facts; this is not production authority. */
export function checkContainedPayload(value: unknown): void {
  const expected = ['processTreeMatched', 'namespacesMatched', 'mountsMatched', 'environmentMatched',
    'privilegesMatched', 'stdioMatched', 'fdScopeMatched'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTAINED_PAYLOAD_UNVERIFIED');
  const facts = (value as Record<string, unknown>).facts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts) ||
    Object.keys(facts).length !== expected.length ||
    expected.some(key => (facts as Record<string, unknown>)[key] !== true))
    throw new Error('CONTAINED_PAYLOAD_UNVERIFIED');
}

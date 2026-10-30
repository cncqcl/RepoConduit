import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildWslIsolationCandidate, isolationCanary, keyringDenyFilter, isHelpOnlyDiagnostic, sealSource } from '../../tools/wsl-isolation-candidate.js';

const id = '148d2ffc-55cb-47be-9d99-23f103de2ab5';
const root = `/home/fixture/.local/repoconduit-private-homes/${id}`;

test('diagnostic CLI has only canary and fixed help modes, without arbitrary command arguments', () => {
  assert.equal(isHelpOnlyDiagnostic([]), false);
  assert.equal(isHelpOnlyDiagnostic(['--app-server-help']), true);
  for (const argv of [['--help'], ['--app-server-help', 'extra'], ['sh', '-c', 'echo test'], ['--model=x']])
    assert.throws(() => isHelpOnlyDiagnostic(argv), /FIXED_DIAGNOSTIC_ENTRY_ONLY/);
});

test('candidate has a fixed no-model entry and closed input', () => {
  const spec = buildWslIsolationCandidate(id);
  assert.equal(spec.nativeExecuted, false);
  assert.equal(spec.productionAvailable, false);
  assert.deepEqual(spec.appServerHelp.slice(-5), ['/node/bin/node', '/runtime/codex/package/bin/codex.js', 'app-server', '--stdio', '--help']);
  for (const bad of ['', '../home', 'A'.repeat(36), `${id}/other`, null, { id, command: 'sh' }])
    assert.throws(() => buildWslIsolationCandidate(bad), /INVALID_CANDIDATE_ID/);
});

test('positive-control endpoints and synthetic credential paths derive only from the owned UUID', () => {
  const spec = buildWslIsolationCandidate(id);
  assert.deepEqual(spec.controls, { credential: `${root}/credential-canary.txt`,
    unixSocket: `${root}/canary.sock`, port: 30768 + parseInt(id.slice(0, 4), 16) % 2048 });
  assert.deepEqual(spec.canary.slice(-3), [spec.controls.credential, String(spec.controls.port), spec.controls.unixSocket]);
  assert.equal(Object.isFrozen(spec.controls), true);
});

test('namespace recipe has no inherited environment, mounts, network or authority sockets', () => {
  const { sandbox } = buildWslIsolationCandidate(id);
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
    '--unshare-uts', '--unshare-cgroup', '--clearenv', '--die-with-parent', '--new-session'])
    assert.equal(sandbox.filter(x => x === flag).length, 1, flag);
  assert.deepEqual(sandbox.slice(sandbox.indexOf('--cap-drop'), sandbox.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.equal(sandbox.includes('--share-net'), false);
  assert.equal(sandbox.some(x => x.endsWith('-try')), false);
  assert.equal(sandbox.includes('--bind'), false);
  const bindings: string[][] = [];
  for (let i = 0; i < sandbox.length; i++) if (sandbox[i] === '--ro-bind') bindings.push(sandbox.slice(i + 1, i + 3));
  assert.deepEqual(bindings, [
    ['/usr/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu'],
    ['/usr/lib/python3.10', '/usr/lib/python3.10'], ['/usr/bin/python3.10', '/usr/bin/python3.10'],
    ['/home/fixture/.hermes/node/bin/node', '/node/bin/node'],
    ['/home/fixture/.local/repoconduit-codex-0.157.1', '/runtime/codex'],
    [`${root}/workspace`, '/source'],
  ]);
  assert.deepEqual(sandbox.slice(sandbox.indexOf('--proc'), sandbox.indexOf('--proc') + 2), ['--proc', '/proc']);
  for (const path of ['/home', '/home/fixture', '/run', '/etc', '/mnt', '/proc'])
    assert.equal(bindings.some(([source]) => source === path), false, path);
});

test('fixed seccomp program denies key APIs and alternate ABI without blocking ordinary reads', () => {
  // Independent classic-BPF evaluation; no kernel filter or native syscall is installed/executed.
  function evaluate(arch: number, syscall: number): number {
    let accumulator = 0;
    for (let pc = 0; pc < keyringDenyFilter.length; pc++) {
      const [code, yes, no, k] = keyringDenyFilter[pc]!;
      assert.ok(code !== undefined && yes !== undefined && no !== undefined && k !== undefined);
      if (code === 0x20) accumulator = k === 4 ? arch : syscall;
      else if (code === 0x15) pc += accumulator === k ? yes : no;
      else if (code === 0x45) pc += (accumulator & k) !== 0 ? yes : no;
      else if (code === 0x06) return k;
      else assert.fail('unexpected BPF opcode');
    }
    assert.fail('filter did not return');
  }
  for (const call of [248, 249, 250, 425, 426, 427, 0x40000000, 0x40000000 | 250])
    assert.equal(evaluate(0xc000003e, call), 0x50001);
  for (const call of [0, 1, 3, 9, 41, 59, 247, 251, 257, 424, 428, 435])
    assert.equal(evaluate(0xc000003e, call), 0x7fff0000);
  for (const arch of [0x40000003, 0xc00000b7, 0]) assert.equal(evaluate(arch, 0), 0x80000000);
  assert.equal(Object.isFrozen(keyringDenyFilter[0]), true);
});

test('native launch supplies the filter through a fixed bootstrap, not an ambient descriptor', () => {
  const spec = buildWslIsolationCandidate(id);
  assert.deepEqual(spec.canaryLaunch.slice(0, spec.unit.length - 1), spec.unit.slice(0, -1));
  assert.deepEqual(spec.canaryLaunch.slice(-5, -1), ['/usr/bin/python3.10', '-I', '-S', '-c']);
  assert.deepEqual(spec.canaryLaunch.slice(spec.unit.length - 1, spec.unit.length + 3),
    ['/usr/bin/env', '-i', 'HOME=/home/fixture', 'PATH=/usr/bin:/bin']);
  const program = spec.canaryLaunch.at(-1)!;
  assert.ok(program.includes("os.listdir('/proc/self/fd')"));
  assert.ok(program.includes('if fd>2:'));
  assert.ok(program.includes('os.execve(argv[0],argv,env)'));
  assert.ok(program.includes("os.memfd_create('rcac-keyring-deny'"));
  assert.ok(program.includes('os.dup2(fd,3,inheritable=True)'));
  assert.ok(program.includes("'PATH':'/usr/bin:/bin'"));
  assert.equal(program.includes('os.environ'), false);
});

test('initialize alone uses a fixed in-bwrap seal with one metadata argument', () => {
  const spec = buildWslIsolationCandidate(id);
  const suffix = ['/usr/bin/python3.10', '-I', '-S', '-c', sealSource, '__PIPE_RECORD__'];
  assert.deepEqual(spec.appServerInitialize.slice(-suffix.length), suffix);
  assert.deepEqual(spec.initializeLaunch.slice(-5, -1), ['/usr/bin/python3.10', '-I', '-S', '-c']);
  assert.ok(spec.initializeLaunch.at(-1)!.includes("argv[-1]=json.dumps(metadata"));
  assert.deepEqual(spec.appServerHelp.slice(-5), ['/node/bin/node', '/runtime/codex/package/bin/codex.js', 'app-server', '--stdio', '--help']);
  assert.ok(sealSource.includes("os.execve('/node/bin/node'"));
  assert.equal(sealSource.includes('subprocess'), false);
});

test('factory seal source is pinned by the independent observer', () => {
  const observer = readFileSync('tools/wsl-contained-observer.py', 'utf8');
  const digest = createHash('sha256').update(sealSource).digest('hex');
  assert.match(observer, new RegExp(`^SEAL_SHA256 = '${digest}'$`, 'm'));
});

test('seal offline mock reaches only the fixed Node exec and failures reach no exec', () => {
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'),
    ['-I', '-S', '-c', String.raw`import ast,io,json,sys,types
tree=ast.parse(sys.stdin.read());tree.body.pop();tree.body.pop(0)  # Offline mocks replace imports; suppress final seal() call.
scope={'__name__':'seal_offline','errno':__import__('errno'),'json':json,'re':__import__('re'),'stat':__import__('stat')}
exec(compile(tree,'seal-offline','exec'),scope)
record={'pid':11,'startTicks':'187','bootId':'148d2ffc-55cb-47be-9d99-23f103de2ab5','uid':1000,
 'outerPidNs':'pid:[111]',
 'stdio':{'0':'pipe:[10]','1':'pipe:[11]','2':'pipe:[12]'},
 'stdioObjects':{'0':[1,10],'1':[1,11],'2':[1,12]},'stdioAccess':{'0':0,'1':1,'2':1}}
status=b'Threads:\t1\nNSpid:\t2\n'
env=b'HOME=/home/investigator\0CODEX_HOME=/home/investigator/.codex\0PATH=/node/bin:/usr/bin\0PWD=/source\0'
def attempt(change=None):
 state={'record':json.loads(json.dumps(record)),'status':status,'env':env,'argv':['-c'],
        'cwd':'/source','close_error':None,'remain':False,'object_error':False,'calls':[],'closed':[],
        'pidns':'pid:[222]'}
 if change:change(state)
 state['argv'].append(json.dumps(state['record'],sort_keys=True,separators=(',',':')))
 class FakeOs:
  O_ACCMODE=3
  def getuid(self):return 1000
  def getpid(self):return 2
  def getcwd(self):return state['cwd']
  def listdir(self,path):return ['0','1','2','3'] if not state['closed'] or state['remain'] else ['0','1','2']
  def close(self,fd):
   if state['close_error'] is not None:raise OSError(state['close_error'],'close')
   state['closed'].append(fd)
  def fstat(self,fd):
   if fd>2 and not state['remain']:raise OSError(9,'gone')
   ino=10+fd+(1 if state['object_error'] else 0)
   return types.SimpleNamespace(st_dev=1,st_ino=ino,st_mode=0o010000)
  def readlink(self,path):return state['pidns'] if path=='/proc/self/ns/pid' else record['stdio'][path.rsplit('/',1)[-1]]
  def execve(self,path,argv,env):state['calls'].append((path,argv,env))
 def fake_open(path,mode):return io.BytesIO(state['status'] if path.endswith('/status') else state['env'])
 scope.update(os=FakeOs(),sys=types.SimpleNamespace(argv=state['argv']),open=fake_open,
              fcntl=types.SimpleNamespace(F_GETFL=3,fcntl=lambda fd,code:0 if fd==0 else 1))
 try:scope['seal']()
 except (RuntimeError,OSError):pass
 return state
good=attempt()
assert len(good['calls'])==1 and good['closed']==[3]
path,argv,environment=good['calls'][0]
assert path=='/node/bin/node' and argv==scope['NODE'] and environment==scope['ENV']
bad=[lambda s:s['record']['stdioObjects']['1'].__setitem__(1,99),
     lambda s:s.update(status=b'Threads:\t2\nNSpid:\t2\n'),
     lambda s:s.update(status=b'Threads:\t1\nNSpid:\t13 2\n'),
     lambda s:s.update(pidns='pid:[111]'),
     lambda s:s.update(env=env+b'SECRET=x\0'),
     lambda s:s.update(env=env+b'HOME=/home/investigator\0'),
     lambda s:s.update(cwd='/tmp'),
     lambda s:s.update(close_error=5),
     lambda s:s.update(remain=True),
     lambda s:s.update(object_error=True),
     lambda s:s['record'].__setitem__('uid',True),
     lambda s:s['record']['stdioAccess'].__setitem__('1',True),
     lambda s:s['record']['stdioObjects']['1'].__setitem__(1,True),
     lambda s:s['argv'].append('other')]
for change in bad:assert attempt(change)['calls']==[],change
sys.stdout.buffer.write(b'SEAL_OFFLINE\n')`],
    { input: sealSource, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'SEAL_OFFLINE\n');
  assert.equal(result.stderr, '');
});

test('prepared native scripts compile offline without running canary or reading host paths', () => {
  const spec = buildWslIsolationCandidate(id);
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'),
    ['-I', '-S', '-c', 'import json,sys\nfor source in json.load(sys.stdin): compile(source,"candidate","exec")\nsys.stdout.buffer.write(b"COMPILED_ONLY\\n")'],
    { input: JSON.stringify([isolationCanary, sealSource, spec.canaryLaunch.at(-1), spec.helpLaunch.at(-1),
      readFileSync('tools/wsl-isolation-preflight.py', 'utf8')]),
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'COMPILED_ONLY\n');
});

test('help output preserves consumed bytes and enforces one total byte budget including the final tail', () => {
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'),
    ['-I', '-S', '-c', String.raw`import ast,sys
tree=ast.parse(sys.stdin.read())
selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='append_help_output']
assert len(selected)==1
scope={'record':{}}
exec(compile(ast.Module(body=selected,type_ignores=[]),'output-only','exec'),scope)
append=scope['append_help_output']; output=[bytearray(),bytearray()]
append(output,0,b'a'*20000)
append(output,0,b'b'*40000)
assert scope['record']['helpStdout']=='a'*20000+'b'*40000
assert scope['record']['helpOutputBytes']==60000
assert not scope['record']['helpOutputTruncated']
append(output,1,b'e'*5536)
assert scope['record']['helpOutputBytes']==65536
try: append(output,0,b'z'*8192)
except RuntimeError as error: assert str(error)=='HELP_OUTPUT_LIMIT'
else: raise AssertionError('over-budget output accepted')
assert scope['record']['helpOutputBytes']==73728
assert scope['record']['helpOutputTruncated']
assert scope['record']['helpStdout']=='a'*20000+'b'*40000
assert scope['record']['helpStderr']=='e'*5536
assert sum(map(len,output))==65536
sys.stdout.buffer.write(b'OUTPUT_ONLY\n')`],
    { input: readFileSync('tools/wsl-isolation-preflight.py', 'utf8'), encoding: 'utf8',
      timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OUTPUT_ONLY\n');
  assert.equal(result.stderr, '');
});

test('retained diagnostic exit accepts a cleared current group only after checking the saved group', () => {
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'),
    ['-I', '-S', '-c', String.raw`import ast,sys
tree=ast.parse(sys.stdin.read())
selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('terminal_identity_matches','retained_terminal')]
assert len(selected)==2
saved={'Id':'unit.service','InvocationID':'original-invocation','ControlGroup':'/user.slice/original/unit.service','MainPID':'12'}
current=dict(saved,LoadState='loaded',ActiveState='active',SubState='exited',MainPID='0',ControlGroup='')
scope={'identity':saved,'boot':'original-boot','record':{'uid':1000},'observed_boot_uid':lambda:('original-boot',1000)}
exec(compile(ast.Module(body=selected,type_ignores=[]),'terminal-only','exec'),scope)
matches=scope['terminal_identity_matches']
assert matches(current,saved,'original-boot','original-boot',1000,1000)
assert matches(dict(current,ControlGroup=saved['ControlGroup']),saved,'original-boot','original-boot',1000,1000)
for key,value in [('Id','other'),('InvocationID','replacement'),('MainPID','1'),('LoadState','not-found'),('ActiveState','inactive'),('SubState','running'),('ControlGroup','/other')]:
 assert not matches(dict(current,**{key:value}),saved,'original-boot','original-boot',1000,1000),key
assert not matches(current,None,'original-boot','original-boot',1000,1000)
assert not matches(current,saved,'original-boot','new-boot',1000,1000)
assert not matches(current,saved,'original-boot','original-boot',1000,1001)
visited=[]
def members(arg):
 visited.append(arg.copy()); return []
scope['group_members']=members
scope['show']=lambda:current.copy()
assert scope['retained_terminal'](current)
assert visited==[saved]  # Never inspect current's empty ControlGroup.
scope['group_members']=lambda arg:[99]
assert not scope['retained_terminal'](current)
scope['group_members']=members
scope['show']=lambda:dict(current,InvocationID='replacement')
assert not scope['retained_terminal'](current)
def unreadable(arg): raise OSError('denied')
scope['group_members']=unreadable
try: scope['retained_terminal'](current)
except OSError: pass
else: raise AssertionError('unreadable original group accepted')
scope['identity']=None
assert not scope['retained_terminal'](current)
sys.stdout.buffer.write(b'TERMINAL_ONLY\n')`],
    { input: readFileSync('tools/wsl-isolation-preflight.py', 'utf8'), encoding: 'utf8',
      timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TERMINAL_ONLY\n');
  assert.equal(result.stderr, '');
});

test('trusted coordinator has explicit manager connection while payload keeps env-i boundary', () => {
  const source = readFileSync('tools/wsl-isolation-preflight.py', 'utf8');
  const result = spawnSync(process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'),
    ['-I', '-S', '-c', String.raw`import ast,sys
tree=ast.parse(sys.stdin.read())
selected=[node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('env','management_env') for t in node.targets)]
scope={'__builtins__':{'dict':dict}}
exec(compile(ast.Module(body=selected,type_ignores=[]),'environment-only','exec'),scope)
assert scope['env']=={'HOME':'/home/fixture','PATH':'/usr/bin:/bin'}
assert scope['management_env']==dict(scope['env'],XDG_RUNTIME_DIR='/run/user/1000',DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus')
sys.stdout.buffer.write(b'ENVIRONMENT_ONLY\n')`],
    { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ENVIRONMENT_ONLY\n');
  assert.equal(result.stderr, '');
  for (const command of [buildWslIsolationCandidate(id).canaryLaunch, buildWslIsolationCandidate(id).helpLaunch]) {
    assert.ok(command.includes('-i'));
    assert.equal(command.at(-1)!.includes('DBUS_SESSION_BUS_ADDRESS'), false);
    assert.equal(command.at(-1)!.includes('XDG_RUNTIME_DIR'), false);
  }
});

test('home, scratch and temp are fresh tmpfs and source is the fixed readonly fixture', () => {
  const spec = buildWslIsolationCandidate(id);
  for (const path of ['/home/investigator', '/scratch', '/tmp'])
    assert.ok(spec.sandbox.some((x, i) => x === '--tmpfs' && spec.sandbox[i + 1] === path));
  for (const path of ['/home/investigator', '/home/investigator/.codex', '/scratch']) {
    const position = spec.sandbox.indexOf(path, spec.sandbox.indexOf('--proc'));
    assert.deepEqual(spec.sandbox.slice(position - 3, position - 1), ['--perms', '0700']);
  }
  const env: Record<string, string> = {};
  for (let i = 0; i < spec.sandbox.length; i++) if (spec.sandbox[i] === '--setenv') env[spec.sandbox[i + 1]!] = spec.sandbox[i + 2]!;
  assert.deepEqual(env, { HOME: '/home/investigator', CODEX_HOME: '/home/investigator/.codex', PATH: '/node/bin:/usr/bin' });
  assert.equal(spec.sandbox.at(-2), '--chdir');
  assert.equal(spec.sandbox.at(-1), '/source');
  assert.equal(spec.sandbox.includes(`${root}/home`), false);
});

test('canary and help-only commands use the same bounded unit and sandbox recipe', () => {
  const spec = buildWslIsolationCandidate(id);
  for (const command of [spec.canary, spec.appServerHelp]) {
    assert.deepEqual(command.slice(0, spec.unit.length), spec.unit);
    assert.deepEqual(command.slice(spec.unit.length, spec.unit.length + spec.sandbox.length), spec.sandbox);
    assert.equal(command[spec.unit.length + spec.sandbox.length], '--');
  }
  assert.ok(spec.unit.includes('--property=KillMode=control-group'));
  assert.ok(spec.unit.includes('--property=RuntimeMaxSec=30s'));
  assert.ok(spec.unit.includes('--remain-after-exit'));
  assert.equal(spec.unit.at(-1), '/usr/bin/bwrap');
  assert.ok(spec.canary.includes('-I'));
  assert.ok(spec.canary.includes('-S'));
  assert.equal(Object.isFrozen(spec.canary), true);
  assert.equal(Object.isFrozen(spec), true);
});

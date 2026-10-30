import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sealSource } from '../../tools/wsl-isolation-candidate.js';

const python = process.env.RCAC_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const source = readFileSync('tools/wsl-contained-observer.py', 'utf8');
function run(script: string) {
  const result = spawnSync(python, ['-I', '-S', '-c', script], { input: source, encoding: 'utf8',
    timeout: 5000, maxBuffer: 8192, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
}

test('observer imports without touching a host and has a closed request surface', () => run(String.raw`
import ast,sys
source=sys.stdin.read(); tree=ast.parse(source)
compile(source,'observer','exec')
assert not any(isinstance(n,ast.Call) for n in tree.body)
scope={'__name__':'test_observer'}; exec(compile(tree,'observer','exec'),scope)
id='148d2ffc-55cb-47be-9d99-23f103de2ab5'
assert scope['validate_request']({'op':'unit','id':id,'saved':None})['saved'] is None
for value in ({'op':'other','id':'148d2ffc-55cb-47be-9d99-23f103de2ab5'},
              {'op':'unit','id':'bad'},
              {'op':'stop','id':'148d2ffc-55cb-47be-9d99-23f103de2ab5','saved':None},
              {'op':'unit','id':'148d2ffc-55cb-47be-9d99-23f103de2ab5','command':['sh']}):
 try: scope['validate_request'](value)
 except RuntimeError: pass
 else: raise AssertionError(value)
print('CLOSED')
`));

test('observer reports closed read sites for failed FD links, info, objects and next processes', () => run(String.raw`
import sys,types,errno,json
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
def broken(*args):raise FileNotFoundError(errno.ENOENT,'SECRET_MESSAGE','/SECRET_PATH')
scope['pathlib'].Path.iterdir=lambda path:[types.SimpleNamespace(name='17')]
scope['os'].readlink=lambda path:'pipe:[99]'
scope['bounded']=lambda path,limit=65536:b'flags: 00\nmnt_id: 9\n'
scope['object_id']=lambda path:(1,99)
scope['os'].stat=lambda path:types.SimpleNamespace(st_mode=0o010000)
for site,owner,key in (('fd-link',scope['os'],'readlink'),('fd-info',scope,'bounded'),
                       ('fd-object',scope,'object_id'),('fd-type',scope['os'],'stat')):
 old=owner[key] if isinstance(owner,dict) else getattr(owner,key)
 if isinstance(owner,dict):owner[key]=broken
 else:setattr(owner,key,broken)
 try:scope['read_fds'](466)
 except OSError as error:
  frame=scope['error_frame'](error)
  assert frame['error']=='OBSERVER_FAILED'
  assert frame['metadata']['readFailure']=={'site':site,'pid':466,'fd':17}
  assert frame['exception']=={'kind':'os','errno':2}
  assert 'SECRET' not in json.dumps(frame)
 else:raise AssertionError('failed read accepted')
 if isinstance(owner,dict):owner[key]=old
 else:setattr(owner,key,old)
scope['read_fds'](466)
assert 'readFailure' not in scope['DIAGNOSTIC']
scope['os'].readlink=lambda path:'/runtime/file'
scope['os'].stat=lambda path:types.SimpleNamespace(st_mode=0o100000)
scope['object_id']=lambda path:broken() if str(path).startswith('/proc/466/root') else (1,99)
try:scope['read_fds'](466)
except OSError as error:
 assert scope['error_frame'](error)['metadata']['readFailure']=={'site':'fd-path-object','pid':466,'fd':17}
 assert 'SECRET' not in json.dumps(scope['error_frame'](error))
else:raise AssertionError('missing path object accepted')
scope['parse_stat']=broken
try:scope['read_process'](467,'monitor','unused')
except OSError as error:
 assert scope['error_frame'](error)['metadata']['readFailure']=={'site':'process-stat','pid':467}
else:raise AssertionError('missing process accepted')
`));

test('observer error output keeps known refusals and sanitizes unexpected exceptions', () => run(String.raw`
import sys,json
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
for error,kind in ((ValueError('SECRET'), 'value'),(UnicodeError('SECRET'),'encoding'),
                   (KeyError('SECRET'),'other'),(RuntimeError('SECRET_PATH/message'),'other')):
 frame=scope['error_frame'](error)
 assert frame['error']=='OBSERVER_FAILED' and frame['exception']=={'kind':kind,'errno':None}
 assert 'SECRET' not in json.dumps(frame)
for number in (-1,0,4096,None):
 assert scope['error_frame'](OSError(number,'SECRET','/SECRET'))['exception']['errno'] is None
assert scope['error_frame'](PermissionError(13,'SECRET','/SECRET'))['exception']=={'kind':'os','errno':13}
assert scope['error_frame'](RuntimeError('FD_UNKNOWN'))=={'error':'FD_UNKNOWN','metadata':{'processes':{},'fds':{}}}
`));

test('epoll fdinfo parses an empty watch set and binds a watched target object', () => run(String.raw`
import sys
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
base=b'pos:\t0\nflags:\t02\nmnt_id:\t9\nino:\t63107\n'
empty=scope['parse_epoll_fdinfo'](base)
assert empty['flags']==2 and empty['mnt_id']==9 and empty['ino']==63107 and empty['targets']==[]
one=scope['parse_epoll_fdinfo'](base+b'tfd: 5 events: 1d data: ffffffffffffffff pos:0 ino:61af sdev:807\n')
assert one['targets']==[{'tfd':5,'events':0x1d,'data':0xffffffffffffffff,'pos':0,'ino':0x61af,'sdev':0x807}]
scope['os'].major=lambda dev:8
scope['os'].minor=lambda dev:7
scope['validate_poll_targets'](one['targets'],{5:'anon_inode:[eventfd]'},{5:(1,0x61af)})
for objects,links in (({5:(1,0x61ae)},{5:'anon_inode:[eventfd]'}), ({},{5:'anon_inode:[eventfd]'}), ({5:(1,0x61af)},{})):
 try:scope['validate_poll_targets'](one['targets'],links,objects)
 except RuntimeError:pass
 else:raise AssertionError('unknown or reused target accepted')
scope['os'].major=lambda dev:256
try:scope['validate_poll_targets'](one['targets'],{5:'anon_inode:[eventfd]'},{5:(1,0x61af)})
except RuntimeError as error:assert str(error)=='POLL_DEVICE_UNVERIFIED'
else:raise AssertionError('high device accepted')
print('EPOLL_OBJECT')
`));

test('epoll fdinfo rejects malformed, duplicate and over-limit records', () => run(String.raw`
import sys
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
base=b'pos: 0\nflags: 02\nmnt_id: 9\nino: 63107\n'
watch=b'tfd: 5 events: 1d data: ff pos:0 ino:61af sdev:807\n'
bad=[base[:-1],base+b'junk\n',base+b'ino: 63107\n',base.replace(b'flags: 02\n',b''),
     base+b'tfd: x events: 1d data: ff pos:0 ino:61af sdev:807\n',
     base+b'tfd: 5 events: ZZ data: ff pos:0 ino:61af sdev:807\n',
     base+watch+watch,base+b'\xff\n',base+b'\r\n',base+b'x'*4097,
     base+b''.join(b'tfd: %d events: 1d data: ff pos:0 ino:61af sdev:807\n'%i for i in range(65))]
for raw in bad:
 try:scope['parse_epoll_fdinfo'](raw)
 except RuntimeError:pass
 else:raise AssertionError('malformed fdinfo accepted')
print('EPOLL_REJECTED')
`));

test('actual Node descriptor shape rejects io_uring then an extra pipe with bounded context', () => run(String.raw`
import sys,json
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
proc={'role':'node','pid':13,'startTicks':'221',
 'fds':{0:'pipe:[10]',1:'pipe:[11]',2:'pipe:[12]',3:'anon_inode:[io_uring]',4:'pipe:[999]'},
 'fdFlags':{},'pollTargets':{},'fdObjects':{},'fdMounts':{},'pathObjects':{},'eventfds':set()}
pipes={'stdio':{'0':'pipe:[10]','1':'pipe:[11]','2':'pipe:[12]'}}
for rejected,kind in ((3,'io_uring'),(4,'pipe')):
 try:scope['validate_fds'](proc,pipes,set(),[])
 except RuntimeError as error:assert str(error)=='FD_UNKNOWN'
 else:raise AssertionError('extra descriptor accepted')
 context=scope['DIAGNOSTIC']['rejectedFd']
 assert context=={'role':'node','pid':13,'startTicks':'221','index':rejected,'kind':kind}
 text=json.dumps(scope['DIAGNOSTIC'])
 assert 'pipe:[999]' not in text and 'anon_inode:[io_uring]' not in text
 proc['fds'].pop(rejected)
print('FD_REJECT_CONTEXT')
`));

test('pipe pair requires closed seal chain and unique read/write objects', () => run(String.raw`
import sys,copy
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
node={'role':'node','pid':13,'startTicks':'221',
 'fds':{0:'pipe:[10]',1:'pipe:[11]',2:'pipe:[12]',3:'pipe:[99]',4:'pipe:[99]'},
 'fdFlags':{0:0,1:1,2:1,3:0o2000000,4:0o2000001},
 'fdObjects':{0:(1,10),1:(1,11),2:(1,12),3:(1,99),4:(1,99)},
 'fdFifos':{0,1,2,3,4},'pollTargets':{},'fdMounts':{},'pathObjects':{},'eventfds':set()}
other=[{'role':role,'fds':{0:'pipe:[10]',1:'pipe:[11]',2:'pipe:[12]'},
        'fdObjects':{0:(1,10),1:(1,11),2:(1,12)}} for role in ('monitor','sandbox','native')]
pipes={'stdio':{'0':'pipe:[10]','1':'pipe:[11]','2':'pipe:[12]'},
 'stdioObjects':{'0':[1,10],'1':[1,11],'2':[1,12]},'stdioAccess':{'0':0,'1':1,'2':1},
 'outerPidNs':'pid:[2]'}
scope['validate_pipe_pair'](node,other,pipes,True)
four=copy.deepcopy(node)
for key in ('fds','fdObjects','fdFlags'):
 for fd in (3,4):four[key].pop(fd)
four['fdFifos'].difference_update({3,4})
for read_fd,write_fd,ino,nonblock in ((5,6,99,False),(7,8,100,True),(12,13,101,True),(17,18,102,True)):
 four['fds'].update({read_fd:f'pipe:[{ino}]',write_fd:f'pipe:[{ino}]'})
 four['fdObjects'].update({read_fd:(1,ino),write_fd:(1,ino)})
 four['fdFlags'].update({read_fd:0o2000000 | (0o4000 if nonblock else 0),
                         write_fd:0o2000001 | (0o4000 if nonblock else 0)})
 four['fdFifos'].update({read_fd,write_fd})
assert scope['validate_pipe_pair'](four,other,pipes,True)=={5,6,7,8,12,13,17,18}
alias=copy.deepcopy(four)
for fd in (7,8):
 alias['fds'][fd]='pipe:[99]';alias['fdObjects'][fd]=(2,99)
try:scope['validate_pipe_pair'](alias,other,pipes,True)
except RuntimeError:pass
else:raise AssertionError('same pipe link with a second device accepted')
fifth=copy.deepcopy(four)
fifth['fds'].update({19:'pipe:[103]',20:'pipe:[103]'})
fifth['fdObjects'].update({19:(1,103),20:(1,103)})
fifth['fdFlags'].update({19:0o2004000,20:0o2004001})
fifth['fdFifos'].update({19,20})
try:scope['validate_pipe_pair'](fifth,other,pipes,True)
except RuntimeError as error:assert str(error)=='PIPE_PAIR_LIMIT'
else:raise AssertionError('fifth pair accepted')
for mutate in (
 lambda x,y:x['fds'].pop(4),
 lambda x,y:x['fdFlags'].__setitem__(4,0o2000000),
 lambda x,y:x['fdObjects'].__setitem__(4,(1,100)),
 lambda x,y:x['fds'].__setitem__(4,'pipe:[10]'),
 lambda x,y:y[0]['fdObjects'].__setitem__(3,(1,99)),
 lambda x,y:y[1]['fdObjects'].__setitem__(3,(1,99)),
 lambda x,y:y[2]['fdObjects'].__setitem__(3,(1,99)),
 lambda x,y:x['fdFlags'].__setitem__(3,0o2000000|0o100000)):
 x,y=copy.deepcopy(node),copy.deepcopy(other);mutate(x,y)
 try:scope['validate_pipe_pair'](x,y,pipes,True)
 except RuntimeError:pass
 else:raise AssertionError('bad pipe pair accepted')
try:scope['validate_pipe_pair'](node,other,pipes,False)
except RuntimeError:pass
else:raise AssertionError('missing seal accepted')
print('PIPE_PAIR')
`));

test('pure payload facts reject process tree, start, environment, root, namespace, socket, poll and limits', () => run(String.raw`
import ast,sys,copy
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
seal_source=${JSON.stringify(sealSource)}
id='148d2ffc-55cb-47be-9d99-23f103de2ab5'
root='/home/fixture/.local/repoconduit-private-homes/'+id
ns={k:k+':[1]' for k in ('user','pid','net','ipc','uts','cgroup','mnt')}
host={k:k+':[2]' for k in ns}
def proc(pid,ppid,role,cmd,exe):
 return {'pid':pid,'ppid':ppid,'startTicks':str(pid*17),'uid':1000,'role':role,
  'cmdline':cmd,'exe':exe,'root':(8,10),'cwd':(8,20),'ns':ns.copy(),
  'nsPid':[pid],
  'env':b'HOME=/home/investigator\0CODEX_HOME=/home/investigator/.codex\0PATH=/node/bin:/usr/bin\0PWD=/source\0',
  'status':{'CapInh':'0','CapPrm':'0','CapEff':'0','CapBnd':'0','CapAmb':'0','NoNewPrivs':'1','Seccomp':'2'},
  'fds':{0:'pipe:[10]',1:'pipe:[11]',2:'pipe:[12]'},'fdFlags':{0:0,1:1,2:1}}
procs=[proc(11,1,'monitor',['/usr/bin/bwrap','--fixed'],'/usr/bin/bwrap'),
 proc(12,11,'sandbox',['/usr/bin/bwrap','--fixed'],'/usr/bin/bwrap'),
 proc(13,12,'node',['/node/bin/node','/runtime/codex/package/bin/codex.js','app-server','--stdio'],'/node/bin/node'),
 proc(14,13,'native',['/runtime/codex/package/vendor/x86_64-unknown-linux-musl/bin/codex','app-server','--stdio'],'/runtime/codex/package/vendor/x86_64-unknown-linux-musl/bin/codex')]
procs[3]['env']+=b'CODEX_MANAGED_PACKAGE_ROOT=/runtime/codex/package\0CODEX_MANAGED_BY_NPM=1\0'
procs[1]['nsPid']=[12,1]
procs[2]['nsPid']=[13,2]
procs[3]['nsPid']=[14,3]
for p in procs: p['cmdline']=scope['expected_cmdline'](p['role'],id)
mounts=scope['expected_mounts'](id)
for i,m in enumerate(mounts):m['id']=100+i
for m in mounts:
 m['parent']=99 if m['target']=='/' else (mounts[8]['id'] if m['target'].startswith('/dev/') else mounts[6]['id'])
 m['backing']=(8,100+i) if m['target'] in scope['expected_sources'](id) else None
 m['root']=scope['expected_sources'](id).get(m['target'],'/newroot' if m['target']=='/' else '/')
 m['dev']='8:48' if m['target'] in scope['expected_sources'](id) else '0:90'
sources={m['target']:m['backing'] for m in mounts if m['target'] in scope['expected_sources'](id)}
hostBackings={target:{'root':source,'fstype':'ext4','source':'/dev/test','dev':'8:48'}
 for target,source in scope['expected_sources'](id).items()}
for m in mounts:
 if m['target'] in hostBackings:m['fstype']='ext4';m['source']='/dev/test'
for p in procs:
 p['fdMounts']={};p['fdObjects']={0:(1,10),1:(1,11),2:(1,12)};p['fdFifos']={0,1,2};p['pathObjects']={};p['eventfds']=set();p['pollTargets']={};p['exeObject']=(1,1)
procs[2]['fds'][3]='/runtime/codex/package/package.json'
procs[2]['fdFlags'][3]=0
procs[2]['fdMounts'][3]=next(m['id'] for m in mounts if m['target']=='/runtime/codex')
procs[2]['fdObjects'][3]=(8,201)
procs[2]['pathObjects']['/runtime/codex/package/package.json']=(8,201)
procs[2]['fds'][4]='anon_inode:[eventpoll]'
procs[2]['fdFlags'][4]=2
procs[2]['fdObjects'][4]=(8,202)
procs[2]['pollTargets'][4]=[]
facts={'id':id,'uid':1000,'mainPid':11,'members':[11,12,13,14], 'processes':procs,
 'hostNs':host,'hostRoot':(8,1),'workspace':(8,20),
 'pipes':{'pid':11,'startTicks':procs[0]['startTicks'],'bootId':id,'uid':1000,
  'stdio':{'0':'pipe:[10]','1':'pipe:[11]','2':'pipe:[12]'},
  'stdioObjects':{'0':[1,10],'1':[1,11],'2':[1,12]},'stdioAccess':{'0':0,'1':1,'2':1},
  'outerPidNs':'pid:[2]'},
 'bootId':id,'mounts':mounts, 'sources':sources,'hostBackings':hostBackings,
 'sockets':set(),'unitStable':True}
for p in procs[:2]:
 p['cmdline'] += [seal_source,__import__('json').dumps(facts['pipes'],sort_keys=True,separators=(',',':'))]
scope['validate_payload_facts'](facts)
paired=copy.deepcopy(facts)
pair=paired['processes'][2]
pair['fds'].update({5:'pipe:[99]',6:'pipe:[99]'})
pair['fdObjects'].update({5:(1,99),6:(1,99)})
pair['fdFlags'].update({5:0o2000000,6:0o2000001})
pair['fdFifos'].update({5,6})
scope['validate_payload_facts'](paired)
def reject(change):
 x=copy.deepcopy(facts);change(x)
 try:scope['validate_payload_facts'](x)
 except RuntimeError:return
 raise AssertionError('accepted mutation')
reject(lambda x:x['members'].append(15))
reject(lambda x:x['processes'][3].update(ppid=11))
reject(lambda x:x['processes'][0]['cmdline'].__setitem__(-2,'print("other")'))
reject(lambda x:x['processes'][1]['cmdline'].__setitem__(-1,'{}'))
reject(lambda x:x['processes'][1].update(nsPid=[12,2]))
reject(lambda x:x['processes'][3].update(startTicks='0'))
reject(lambda x:x['processes'][2].update(exe='/tmp/node'))
reject(lambda x:x['processes'][2].update(env=x['processes'][2]['env']+b'API_KEY=secret\0'))
reject(lambda x:x['processes'][2].update(env=x['processes'][2]['env']+b'HOME=/other\0'))
reject(lambda x:x['processes'][3].update(root=(8,11)))
reject(lambda x:x['mounts'][0].update(backing=(99,99)))
reject(lambda x:x['mounts'][0].update(dev='8:49'))
reject(lambda x:x['mounts'][0].update(root='/other'))
reject(lambda x:x['processes'][3]['ns'].update(net=host['net']))
reject(lambda x:x['processes'][3]['fds'].update({3:'socket:[999]'}))
reject(lambda x:x['processes'][3]['fds'].update({3:'anon_inode:[eventpoll]'}))
reject(lambda x:x['processes'][3]['fds'].update({3:'pipe:[99]'}))
reject(lambda x:x['processes'][3]['fds'].update({3:'anon_inode:[pidfd]'}))
reject(lambda x:x['processes'][3]['fds'].update({3:'net:[4026532345]'}))
reject(lambda x:x['processes'][2]['fds'].update({3:'/home/fixture/.aws/credentials'}))
reject(lambda x:x['processes'][2]['fdObjects'].update({3:(8,202)}))
reject(lambda x:x['processes'][2]['fdMounts'].update({3:999}))
reject(lambda x:x['processes'][2]['fdMounts'].update({3:next(m['id'] for m in x['mounts'] if m['target']=='/')}))
reject(lambda x:x['processes'][2]['fdFlags'].update({3:1}))
reject(lambda x:x.update(unitStable=False))
reject(lambda x:x['mounts'].append({'target':'/host','fstype':'ext4','source':'/dev/sda','readonly':False,'backing':(1,2)}))
reject(lambda x:x['processes'][2].update(fds={i:'pipe:[10]' for i in range(65)}))
saved={'bootId':id,'uid':1000,'unitName':scope['unit_for'](id),'invocationId':'a'*32,
 'controlGroup':scope['group_for'](1000,scope['unit_for'](id)),'mainPid':11,
 'loadState':'loaded','activeState':'active','subState':'running','cgroupState':'populated'}
unit={'Id':saved['unitName'],'InvocationID':saved['invocationId'],'ControlGroup':saved['controlGroup'],
 'MainPID':'11','LoadState':'loaded','ActiveState':'active','SubState':'running'}
scope['unit_state']=lambda actual_id,actual_saved:(unit.copy(),facts['members'].copy())
object_map={'/usr/bin/bwrap':(1,1),scope['NODE']:(1,2),scope['RUNTIME']+'/package/vendor/x86_64-unknown-linux-musl/bin/codex':(1,3),
 '/':(8,1),root+'/workspace':(8,20)}
scope['object_id']=lambda path:object_map[path]
scope['parse_mounts']=lambda pid,actual_id:(copy.deepcopy(mounts),copy.deepcopy(sources),copy.deepcopy(hostBackings))
scope['socket_inodes']=lambda pid:set()
scope['bounded']=lambda path,limit=65536: b'M' if path.endswith('/mountinfo') else __import__('json').dumps(facts['pipes']).encode()
scope['os'].readlink=lambda path:host[path.split('/')[-1]] if path.startswith('/proc/self/ns/') else (_ for _ in ()).throw(AssertionError(path))
scope['os'].major=lambda dev:8
scope['os'].minor=lambda dev:48
calls=[0];drift=['none']
def read(pid,role,actual_id):
 calls[0]+=1
 p=copy.deepcopy(next(p for p in procs if p['pid']==pid))
 p['role']=role
 p['exeObject']=object_map['/usr/bin/bwrap' if pid in (11,12) else scope['NODE'] if pid==13 else scope['RUNTIME']+'/package/vendor/x86_64-unknown-linux-musl/bin/codex']
 if drift[0]=='env' and calls[0]>6 and pid==13:p['env']+=b'API_KEY=unexpected\0'
 if drift[0]=='valid_fd' and calls[0]>6 and pid==13:
  p['fds'][4]='anon_inode:[eventfd]';p['fdFlags'][4]=0;p['eventfds'].add(4)
 if drift[0]=='poll' and calls[0]>6 and pid==13:
  p['pollTargets'][4]=[{'tfd':3,'events':0x1d,'data':0xff,'pos':0,'ino':201,'sdev':0x830}]
 if drift[0]=='valid_pipe' and calls[0]>6 and pid==13:
  p['fds'].update({5:'pipe:[99]',6:'pipe:[99]'})
  p['fdObjects'].update({5:(1,99),6:(1,99)})
  p['fdFlags'].update({5:0o2000000,6:0o2000001})
  p['fdFifos'].update({5,6})
 return p
scope['read_process']=read
success=scope['collect_payload'](id,saved)
assert success['facts']['environmentMatched']
assert success['metadata']['stable'] is True
assert success['metadata']['snapshots'][0]==success['metadata']['snapshots'][1]
node_summary=success['metadata']['snapshots'][0]['processes'][2]
assert node_summary['pid']==13 and node_summary['ppid']==12
assert node_summary['exeObject']==[1,2] and node_summary['root']==[8,10]
assert node_summary['environment']=={'exact':True,'keys':['HOME','CODEX_HOME','PATH','PWD']}
assert node_summary['fds'][3]['mountId']==next(m['id'] for m in mounts if m['target']=='/runtime/codex')
assert success['metadata']['snapshots'][0]['mounts'][0]['backing']==list(mounts[0]['backing'])
assert b'API_KEY' not in __import__('json').dumps(success).encode()
calls[0]=0;drift[0]='env'
try:scope['collect_payload'](id,saved)
except RuntimeError:pass
else:raise AssertionError('second snapshot drift accepted')
calls[0]=0;drift[0]='valid_fd'
try:scope['collect_payload'](id,saved)
except RuntimeError as error:assert str(error)=='PAYLOAD_DRIFT'
else:raise AssertionError('valid but changed FD snapshot accepted')
calls[0]=0;drift[0]='poll'
try:scope['collect_payload'](id,saved)
except RuntimeError as error:assert str(error)=='PAYLOAD_DRIFT'
else:raise AssertionError('empty-to-nonempty epoll watch drift accepted')
calls[0]=0;drift[0]='valid_pipe'
try:scope['collect_payload'](id,saved)
except RuntimeError as error:assert str(error)=='PAYLOAD_DRIFT'
else:raise AssertionError('new sealed-shape pipe pair drift accepted')
print('REJECTED')
`));

test('invalid request emits one bounded failure frame and no success frame', () => {
  const result = spawnSync(python, ['-I', '-S', '-c',
    'import sys;sys.argv=["observer",sys.argv[1]];exec(compile(sys.stdin.read(),"observer","exec"))',
    JSON.stringify({ op: 'payload', id: 'bad' })],
    { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const frame = JSON.parse(result.stdout.trim());
  assert.equal(frame.error, 'REQUEST_ID');
  assert.deepEqual(frame.metadata, { processes: {}, fds: {} });
});

test('mount parser binds fixed targets to the current host source instead of an old device name', () => run(String.raw`
import sys,types,os
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
id='148d2ffc-55cb-47be-9d99-23f103de2ab5'
sources=scope['expected_sources'](id);mounts=scope['expected_mounts'](id)
lines=[]
for i,m in enumerate(mounts):
 target=m['target'];bind=target in sources
 root=sources[target] if bind else '/newroot' if target=='/' else '/'+target.rsplit('/',1)[-1] if target.startswith('/dev/') and target!='/dev/pts' else '/'
 fs='ext4' if bind else m['fstype'];source='/dev/new' if bind else m['source']
 lines.append(f'{100+i} {99 if target=="/" else 106} {"8:48" if bind else "0:90"} {root} {target} {"ro" if bind else "rw"},nosuid - {fs} {source} rw')
payload=('\n'.join(lines)+'\n').encode()
host=b'1 0 8:48 / / rw - ext4 /dev/new rw\n'
scope['bounded']=lambda path,limit=65536:host if path=='/proc/self/mountinfo' else payload
scope['os'].stat=lambda path:types.SimpleNamespace(st_dev=1,st_ino=123)
scope['os'].major=lambda dev:8
scope['os'].minor=lambda dev:48
scope['object_id']=lambda path:(1,123)
scope['checked_path']=lambda path,uid,directory:None
parsed,backing,current=scope['parse_mounts'](13,id)
assert len(parsed)==19
assert all(current[target]['source']=='/dev/new' for target in sources)
assert all(backing[target]==(1,123) for target in sources)
print('CURRENT_BACKING')
`));

test('unit and stop use saved original group and refuse stale or absent ownership', () => run(String.raw`
import sys
scope={'__name__':'test_observer'};exec(compile(sys.stdin.read(),'observer','exec'),scope)
id='148d2ffc-55cb-47be-9d99-23f103de2ab5'
saved={'bootId':id,'uid':1000,'unitName':scope['unit_for'](id),'invocationId':'a'*32,
 'controlGroup':scope['group_for'](1000,scope['unit_for'](id)),'mainPid':21,
 'loadState':'loaded','activeState':'active','subState':'running','cgroupState':'populated'}
scope['validate_saved'](saved,id)
initial=dict(Id=saved['unitName'],InvocationID=saved['invocationId'],ControlGroup=saved['controlGroup'],
 MainPID='21',LoadState='loaded',ActiveState='active',SubState='running')
scope['show']=lambda actual_id:initial.copy()
scope['boot_uid']=lambda:(id,1000)
scope['group_members']=lambda actual_saved:[21]
scope['group_exists']=lambda actual_saved:True
absent=dict(initial,LoadState='not-found',ActiveState='inactive',SubState='dead',
 MainPID='0',InvocationID='',ControlGroup='')
scope['show']=lambda actual_id:absent.copy()
assert scope['observe_unit'](id,None)=={'pending':True,'bootId':id,'uid':1000,'unitName':saved['unitName']}
scope['show']=lambda actual_id:dict(absent,LoadState='loaded',ActiveState='activating',SubState='start')
assert scope['observe_unit'](id,None)['pending'] is True
scope['show']=lambda actual_id:dict(absent,LoadState='loaded',ActiveState='activating',SubState='start',InvocationID='a'*32)
try:scope['observe_unit'](id,None)
except RuntimeError:pass
else:raise AssertionError('partial activating identity accepted')
seen=[0]
def changed(actual_id):
 seen[0]+=1
 return absent.copy() if seen[0]==1 else initial.copy()
scope['show']=changed
try:scope['observe_unit'](id,None)
except RuntimeError as error:assert str(error)=='INITIAL_UNIT_DRIFT'
else:raise AssertionError('pending transition accepted without a fresh observation')
scope['show']=lambda actual_id:initial.copy()
first=scope['observe_unit'](id,None)
assert first['mainPid']==21 and first['controlGroup']==saved['controlGroup']
assert first['invocationId']==saved['invocationId'] and first['groupMembers']==[21]
assert scope['validate_request']({'op':'payload','id':id,'saved':first})['saved']==first
scope['show']=lambda actual_id:dict(initial,MainPID='0')
try:scope['observe_unit'](id,None)
except RuntimeError:pass
else:raise AssertionError('initial zero MainPID accepted')
current={'Id':saved['unitName'],'InvocationID':saved['invocationId'],'ControlGroup':'',
 'MainPID':'0','LoadState':'loaded','ActiveState':'active','SubState':'exited'}
scope['group_exists']=lambda actual_saved:False
scope['unit_state']=lambda actual_id,actual_saved:(current.copy(),[])
terminal_observation=scope['observe_unit'](id,saved)
assert terminal_observation['mainPid']==0 and terminal_observation['controlGroup']==''
assert terminal_observation['groupMembers']==[] and terminal_observation['cgroupState']=='absent'
assert scope['same_unit'](saved,current,id,1000)
assert scope['terminal'](current,[])
assert not scope['terminal'](current,[22])
assert not scope['same_unit'](saved,dict(current,InvocationID='b'*32),id,1000)
assert not scope['same_unit'](saved,current,'b'*36,1000)
assert not scope['same_unit'](saved,current,id,1001)
visited=[]
scope['unit_state']=lambda actual_id, actual_saved:(visited.append(actual_saved.copy()) or current,[])
scope['command']=lambda args:visited.append(args)
scope['show']=lambda actual_id:dict(current,LoadState='not-found',ActiveState='inactive',SubState='dead')
scope['group_members']=lambda actual_saved:[]
scope['stop'](id,saved)
assert visited[0]==saved and visited[1][-1]==saved['unitName']
scope['show']=lambda actual_id:dict(current,LoadState='not-found',ActiveState='active',SubState='running')
try:scope['stop'](id,saved)
except RuntimeError:pass
else:raise AssertionError('inconsistent absent unit accepted')
for bad in (None,{},dict(saved,controlGroup='')):
 try:scope['validate_request']({'op':'stop','id':id,'saved':bad})
 except RuntimeError:pass
 else:raise AssertionError('unsafe stop accepted')
print('SAVED_GROUP')
`));

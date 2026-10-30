import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { authorize } from '../../src/core/policy/authorize.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { buildClaudeModelSealedLaunch } from
  '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { CLAUDE_MODEL_CONFIG_READER_PYTHON } from
  '../../src/adapters/secondary-investigator/claude-model-config-wire.js';
import { runClaudeModelOriginalOwner } from '../../src/runtime/claude-model-original-owner.js';
import { createClaudeModelRunningTickets } from '../../src/runtime/claude-model-running-tickets.js';
import { createClaudeModelOuterTickets } from '../../src/runtime/claude-model-outer-tickets.js';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const DISTRO = 'Ubuntu-22.04';
const USER = 'investigator';
const INSTALL_ROOT = '/home/investigator/.local/share/rcac-second-runtime-20260929';
const NODE_ROOT = '/home/investigator/.hermes/node';
const PROFILE = { allowedDomains: [] as string[] };
const LIMITS = { maxWallSeconds: 60, maxTurns: 2 };
const PROFILE_REVISION = 'synthetic-empty-auth';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function wsl(args: string[], timeout = 8000): string {
  return execFileSync(WSL, ['-d', DISTRO, '--user', USER, '--cd', '/', '--exec', ...args],
    { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

// This fixed canary replaces ONLY the product bootstrap/Claude workload. The exact
// replacement and its distinct digest are persisted in the run evidence.
const SRT_CANARY = String.raw`import errno,json,os,select,socket,subprocess,sys,time
def check(condition,label):
 if not condition: raise AssertionError(label)
def unavailable(path):
 try:
  with open(path,'rb') as source: source.read(1)
  return False
 except (FileNotFoundError,PermissionError): return True
def denied_write(path):
 try:
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  os.close(fd); os.unlink(path); return False
 except (PermissionError,OSError) as error:
  if isinstance(error,OSError) and error.errno not in (errno.EACCES,errno.EPERM,errno.EROFS): raise
  return True
def loopback_denied(parent_ns,child_ns,code):
 def valid(value):
  return isinstance(value,str) and value.startswith('net:[') and value.endswith(']') and value[5:-1].isdigit()
 if not valid(parent_ns) or not valid(child_ns) or code==0: return False
 if child_ns==parent_ns: return code in (errno.EACCES,errno.EPERM)
 return code==errno.ECONNREFUSED
def next_line(stream,deadline):
 buffer=bytearray()
 while True:
  remaining=deadline-time.monotonic()
  if remaining<=0 or not select.select([stream],[],[],remaining)[0]: raise TimeoutError('mcp response')
  part=os.read(stream.fileno(),1)
  if not part or len(buffer)>32768: raise ValueError('mcp response bound')
  if part==b'\n': return json.loads(buffer)
  buffer.extend(part)
def call(child,identifier,method,params,deadline):
 frame={'jsonrpc':'2.0','id':identifier,'method':method,'params':params}
 child.stdin.write(json.dumps(frame,separators=(',',':')).encode()+b'\n');child.stdin.flush()
 reply=next_line(child.stdout,deadline)
 check(reply.get('jsonrpc')=='2.0' and reply.get('id')==identifier,'mcp id')
 return reply
fixture=json.load(open('/opt/rcac-canary-input.json',encoding='ascii'))
fields={}
for row in open('/proc/self/status',encoding='ascii'):
 key,sep,value=row.partition(':')
 if sep and key in ('Seccomp','NoNewPrivs','CapEff'):
  check(key not in fields,'duplicate process status');fields[key]=value.strip()
child_stat=open('/proc/self/stat').read()
print(json.dumps({'kind':'test_only_srt_child_birth','pid':os.getpid(),
 'startTicks':int(child_stat[child_stat.rfind(')')+2:].split()[19]),
 'pidNamespace':os.readlink('/proc/self/ns/pid'),
 'mountNamespace':os.readlink('/proc/self/ns/mnt'),
 'netNamespace':os.readlink('/proc/self/ns/net'),
 'seccomp':fields.get('Seccomp'),'noNewPrivs':fields.get('NoNewPrivs'),
 'capEff':fields.get('CapEff')}),file=sys.stderr,flush=True)
check(set(fixture)=={'workspaceId','otherWorkspaceId','collaborationId','workingCopyId','snapshotId','path','expectedHash','expectedText','hostOnlyPath','loopbackPort','parentNetNs'},'fixture keys')
check(unavailable(fixture['hostOnlyPath']),'host file visible')
check(not os.path.exists('/run/user/%d/bus'%os.getuid()),'host bus visible')
check(fields=={'Seccomp':'2','NoNewPrivs':'1','CapEff':'0000000000000000'},'effective seccomp/capability')
check(denied_write('/work/added.txt'),'work write allowed')
check(denied_write('/relay/added.txt'),'new relay file allowed')
sock=socket.socket(); sock.settimeout(.5)
try:
 error=sock.connect_ex(('127.0.0.1',fixture['loopbackPort']))
 child_net=os.readlink('/proc/self/ns/net')
 print(json.dumps({'kind':'test_only_srt_loopback_result','errno':error,
  'childNetNamespace':child_net,'parentNetNamespace':fixture['parentNetNs']}),file=sys.stderr,flush=True)
 check(loopback_denied(fixture['parentNetNs'],child_net,error),
  'loopback connection not denied for namespace pair: %d'%error)
finally: sock.close()
deadline=time.monotonic()+12
helper=subprocess.Popen(['/usr/bin/python3','-I','-S','/opt/mcp-fifo.py'],
 stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
 initialized=call(helper,1,'initialize',{'protocolVersion':'2025-11-25','capabilities':{},
  'clientInfo':{'name':'rcac-sealed-canary','version':'1'}},deadline)
 check('result' in initialized,'initialize failed')
 helper.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n');helper.stdin.flush()
 listed=call(helper,2,'tools/list',{},deadline)
 tools=listed['result']['tools']
 check([tool['name'] for tool in tools]==['repo.read'],'tool inventory')
 scope={'workspaceId':fixture['workspaceId'],'collaborationId':fixture['collaborationId']}
 payload={'workingCopyId':fixture['workingCopyId'],'snapshotId':fixture['snapshotId'],'path':fixture['path']}
 defcall=lambda identifier,s,p:call(helper,identifier,'tools/call',{'name':'repo.read',
  'arguments':{'scope':s,'payload':p}},deadline)
 other=defcall(3,{**scope,'workspaceId':fixture['otherWorkspaceId']},payload)
 check(other.get('result',{}).get('isError') is True,'other project accepted')
 wrong=defcall(4,scope,{**payload,'path':'src/secret.ts'})
 check(wrong.get('result',{}).get('isError') is True,'out-of-scope path accepted')
 good=defcall(5,scope,payload)
 check(good.get('result',{}).get('isError') is not True,'allowed read denied')
 body=json.loads(good['result']['content'][0]['text'])
 check(body['content']==fixture['expectedText'] and body['contentHash']==fixture['expectedHash'],'read/hash mismatch')
 budget=defcall(6,scope,payload)
 check(budget.get('result',{}).get('isError') is True,'tool budget expanded')
 absent=call(helper,7,'tools/call',{'name':'investigate.submit','arguments':{'scope':scope,'payload':{}}},deadline)
 check('error' in absent or absent.get('result',{}).get('isError') is True,'unexpected write tool')
 survivor=subprocess.Popen(['/usr/bin/python3','-I','-S','-c','import time;time.sleep(30)'],
  stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 check(survivor.poll() is None,'fixed descendant not alive')
 survivor_stat=open('/proc/%d/stat'%survivor.pid).read()
 survivor_ticks=int(survivor_stat[survivor_stat.rfind(')')+2:].split()[19])
 survivor_pid_ns=os.readlink('/proc/%d/ns/pid'%survivor.pid)
 print(json.dumps({'kind':'test_only_srt_canary','srtChildPid':os.getpid(),
  'mountNs':os.readlink('/proc/self/ns/mnt'),'netNs':child_net,
  'parentNetNs':fixture['parentNetNs'],'loopbackErrno':error,
  'seccomp':fields['Seccomp'],'noNewPrivs':fields['NoNewPrivs'],'capEff':fields['CapEff'],
  'survivorNamespacePid':survivor.pid,'survivorStartTicks':survivor_ticks,
  'survivorPidNamespace':survivor_pid_ns,'survivorAliveAtReport':True,
  'hostFileDenied':True,'hostBusAbsent':True,'workWriteDenied':True,
  'newRelayFileDenied':True,'loopbackDenied':True,'mcpInitialized':True,
  'tools':['repo.read'],'otherProjectDenied':True,'pathDenied':True,
  'readHash':body['contentHash'],'budgetDenied':True,'writeToolDenied':True}),flush=True)
 time.sleep(.5)
finally:
 helper.stdin.close()
 try: helper.wait(timeout=2)
 except subprocess.TimeoutExpired: helper.kill();helper.wait(timeout=1)
`;

// Uses the production sealed-config reader and production recipe prefix. It
// deliberately binds a different canary body/input and never claims the fixed
// Claude bootstrap or a model execution receipt.
const SRT_HARNESS = String.raw`import fcntl,hashlib,json,os,select,socket,subprocess,sys,time
${CLAUDE_MODEL_CONFIG_READER_PYTHON}
recipe=json.loads(sys.argv[1]); canary_bytes=bytes.fromhex(sys.argv[2]); fixture=json.loads(bytes.fromhex(sys.argv[3])); expected_unit=sys.argv[4]
unit_show=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
 '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup',expected_unit],
 capture_output=True,timeout=3)
unit_before=dict(row.split('=',1) for row in unit_show.stdout.decode().splitlines() if '=' in row)
assert unit_show.returncode==0 and unit_before.get('Id')==expected_unit
assert unit_before.get('InvocationID')==os.environ.get('INVOCATION_ID') and unit_before.get('MainPID')==str(os.getpid())
with open('/proc/sys/kernel/random/boot_id',encoding='ascii') as source: boot=source.read().strip()
group=open('/proc/self/cgroup').read().strip().split('0::',1)[1]
parent_ticks=int(open('/proc/self/stat').read().rsplit(')',1)[1].split()[19])
print(json.dumps({'kind':'test_only_srt_unit_birth','unit':expected_unit,
 'unitBefore':unit_before,'invocationId':unit_before['InvocationID'],
 'controlGroup':group,'bootId':boot,'parentPid':os.getpid(),
 'parentTicks':parent_ticks}),flush=True)
deadline=time.monotonic()+15
config=read_sealed_config(recipe['configFiles'],deadline)
assert len(config)==3 and all(fd>=32 for fd in config)
host_file=fixture['hostOnlyPath']
fd=os.open(host_file,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
os.write(fd,b'HOST_ONLY');os.close(fd)
control=socket.socket();control.bind(('127.0.0.1',0));control.listen(4);control.settimeout(.5)
port=control.getsockname()[1]
parent_net=os.readlink('/proc/self/ns/net')
def recv_exact(sock,count):
 body=b''
 while len(body)<count:
  part=sock.recv(count-len(body))
  if not part: break
  body+=part
 return body
def probe_listener():
 client=socket.socket();client.settimeout(.5)
 try:
  code=client.connect_ex(('127.0.0.1',port))
  if code!=0: return {'connectErrno':code,'accepted':False,'port':port,
   'acknowledged':False,'netNs':os.readlink('/proc/self/ns/net')}
  nonce=os.urandom(8);client.sendall(nonce)
  own_peer=client.getsockname();accepted_own=False;acknowledged=False
  for _ in range(3):
   try: incoming,peer=control.accept()
   except socket.timeout: break
   try:
    if peer==own_peer:
     accepted_own=True;incoming.settimeout(.5)
     if recv_exact(incoming,8)==nonce:
      incoming.sendall(nonce)
      acknowledged=recv_exact(client,8)==nonce
     break
   finally: incoming.close()
  return {'connectErrno':code,'accepted':accepted_own,
   'acknowledged':acknowledged,'port':port,
   'netNs':os.readlink('/proc/self/ns/net')}
 except OSError as failure:
  return {'connectErrno':failure.errno,'accepted':False,'acknowledged':False,
   'port':port,'netNs':os.readlink('/proc/self/ns/net')}
 finally: client.close()
listener_before=probe_listener()
assert listener_before['connectErrno']==0 and listener_before['accepted'] and listener_before['acknowledged']
listener_after={}
def observe_listener_after():
 if not listener_after: listener_after.update(probe_listener())
 return listener_after
fixture['loopbackPort']=port
fixture['parentNetNs']=parent_net
def memfd(body,name):
 fd=os.memfd_create(name,os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
 os.write(fd,body);os.lseek(fd,0,os.SEEK_SET)
 fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
 return fd
script=memfd(canary_bytes,'rcac-srt-canary')
data=memfd(json.dumps(fixture,separators=(',',':')).encode(),'rcac-canary-input')
allfds=(script,*config,data)
for target,source in zip((10,12,13,14,15),allfds): os.dup2(source,target,inheritable=True)
separator=recipe['argv'].index('--')
assert recipe['argv'][separator-5:separator]==['--ro-bind-data','10','/opt/rcac-bootstrap.py','--info-fd','11']
prefix=recipe['argv'][:separator-5]
info_read,info_write=os.pipe2(os.O_CLOEXEC)
os.dup2(info_write,11,inheritable=True);os.close(info_write)
argv=['/usr/bin/bwrap',*prefix,'--ro-bind-data','10','/opt/rcac-canary.py',
 '--ro-bind-data','15','/opt/rcac-canary-input.json','--',
 '/runtime/node_modules/.bin/srt','--settings','/opt/srt.json','--',
 '/usr/bin/python3','-I','-S','/opt/rcac-canary.py']
argv[argv.index('--'):argv.index('--')]=['--info-fd','11']
proc=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
 env=recipe['env'],pass_fds=(10,11,12,13,14,15))
work_deadline=time.monotonic()+22
out=bytearray();err=bytearray()
streams={proc.stdout.fileno():(out,32768),proc.stderr.fileno():(err,4096)}
for stream_fd in streams: os.set_blocking(stream_fd,False)
def collect_nested(until_line):
 while streams:
  if until_line and b'\n' in out: return 'line'
  remaining=work_deadline-time.monotonic()
  if remaining<=0: return 'deadline'
  ready,_,_=select.select(list(streams),[],[],remaining)
  for stream_fd in ready:
   part=os.read(stream_fd,4096)
   if not part: del streams[stream_fd];continue
   body,limit=streams[stream_fd]
   room=limit-len(body)
   body.extend(part[:room])
   if len(part)>room: return 'output_bound'
 return 'eof'
def nested_failure(stage,reason):
 # The same absolute deadline bounds collection after an early child failure.
 collection=collect_nested(False)
 if proc.poll() is None: proc.kill()
 try: proc.wait(timeout=max(0.01,min(1,work_deadline-time.monotonic())))
 except subprocess.TimeoutExpired: pass
 print(json.dumps({'kind':'test_only_srt_nested_failure','stage':stage,
  'reason':str(reason)[:160],'collection':collection,'exitCode':proc.poll(),
  'parentListenerBefore':listener_before,
  'parentListenerAfter':observe_listener_after(),
  'stdoutHex':bytes(out[:8192]).hex(),'stderrHex':bytes(err).hex(),
  'stdoutCapturedBytes':len(out),'stderrCapturedBytes':len(err),
  'stdoutPrefixTruncated':len(out)>8192,
  'streamLimitHit':str(reason)=='output_bound' or collection=='output_bound',
  'stdoutCapturedSha256':hashlib.sha256(out).hexdigest(),
  'stderrCapturedSha256':hashlib.sha256(err).hexdigest()}),flush=True)
 raise RuntimeError('nested SRT canary failed at '+stage)
for fd in (10,11,12,13,14,15): os.close(fd)
for fd in allfds:
 if fd not in (10,11,12,13,14,15): os.close(fd)
try: wrapper_ticks=int(open('/proc/%d/stat'%proc.pid).read().rsplit(')',1)[1].split()[19])
except Exception as failure: nested_failure('wrapper_identity',failure)
info_body=bytearray();info_deadline=min(work_deadline,time.monotonic()+5);info=None
try:
 while info is None:
  remaining=info_deadline-time.monotonic()
  if remaining<=0 or not select.select([info_read],[],[],remaining)[0]: raise TimeoutError('bwrap info')
  part=os.read(info_read,512)
  if not part or len(info_body)+len(part)>2048: raise ValueError('bwrap info bound')
  info_body.extend(part)
  try: info=json.loads(info_body)
  except json.JSONDecodeError: pass
except (TimeoutError,ValueError) as failure: nested_failure('bwrap_info',failure)
os.close(info_read)
try:
 outer_pid=info['child-pid']; assert type(outer_pid) is int and outer_pid>0
 outer_ticks=int(open('/proc/%d/stat'%outer_pid).read().rsplit(')',1)[1].split()[19])
except Exception as failure: nested_failure('outer_identity',failure)
def process_identity(pid):
 raw=open('/proc/%d/stat'%pid).read();parts=raw[raw.rfind(')')+2:].split()
 ticks=int(parts[19]);state=parts[0]
 assert state not in ('Z','X','x')
 status=open('/proc/%d/status'%pid).read().splitlines()
 nspid=[int(row.split(':',1)[1].split()[-1]) for row in status if row.startswith('NSpid:')]
 assert len(nspid)==1
 return {'pid':pid,'ticks':ticks,'state':state,'namespacePid':nspid[0],
  'pidNamespace':os.readlink('/proc/%d/ns/pid'%pid)}
def self_status():
 fields={}
 for row in open('/proc/self/status'):
  key,sep,value=row.partition(':')
  if sep and key in ('Seccomp','NoNewPrivs','CapEff'): fields[key]=value.strip()
 return fields
try:
 parent_mount=os.readlink('/proc/self/ns/mnt')
 parent_status=self_status()
except Exception as failure: nested_failure('parent_identity',failure)
collection=collect_nested(True)
if collection!='line': nested_failure('canary_report',collection)
listener_checked=observe_listener_after()
if listener_checked['connectErrno']!=0 or not listener_checked['accepted'] or not listener_checked['acknowledged']:
 nested_failure('parent_listener_after','unreachable')
try:
 canary_report=json.loads(bytes(out).split(b'\n',1)[0])
 assert canary_report['survivorAliveAtReport'] is True
 live_pids=[int(value) for value in open('/sys/fs/cgroup'+group+'/cgroup.procs').read().split()]
 live=[process_identity(pid) for pid in live_pids]
 matching=[item for item in live if item['namespacePid']==canary_report['survivorNamespacePid']
  and item['ticks']==canary_report['survivorStartTicks']
  and item['pidNamespace']==canary_report['survivorPidNamespace']]
 assert len(matching)==1 and matching[0]['pid'] not in (os.getpid(),proc.pid,outer_pid)
except Exception as failure: nested_failure('live_identity',failure)
collection=collect_nested(False)
if collection!='eof': nested_failure('canary_exit',collection)
try: proc.wait(timeout=max(0.01,work_deadline-time.monotonic()))
except subprocess.TimeoutExpired: nested_failure('canary_exit','deadline')
if proc.returncode!=0: nested_failure('canary_exit','exit '+str(proc.returncode))
try:
 result=json.loads(bytes(out).split(b'\n',1)[0])
 assert result['kind']=='test_only_srt_canary'
except Exception as failure: nested_failure('canary_result',failure)
unit=os.environ.get('INVOCATION_ID','')
print(json.dumps({'canary':result,'canarySha256':hashlib.sha256(canary_bytes).hexdigest(),
 'unitInvocationId':unit,'controlGroup':group,'bootId':boot,
 'unitBefore':unit_before,
 'parentListenerBefore':listener_before,'parentListenerAfter':listener_checked,
 'parentMountNs':parent_mount,'parentNetNs':parent_net,'parentStatus':parent_status,
 'liveCgroupProcesses':live,'survivorHostIdentity':matching[0],
 'parentPid':os.getpid(),'parentTicks':parent_ticks,
 'wrapperPid':proc.pid,'wrapperTicks':wrapper_ticks,
 'outerPid':outer_pid,'outerTicks':outer_ticks}),flush=True)
`;

interface NativeResult { code: number | null; stdout: Buffer; stderr: Buffer; uncertain: boolean }

async function runNamedCanary(unitName: string, recipe: ReturnType<typeof buildClaudeModelSealedLaunch>['recipe'],
  configInput: Buffer, fixture: Record<string, unknown>, signal: AbortSignal): Promise<NativeResult> {
  const args = ['-d', DISTRO, '--user', USER, '--cd', '/', '--exec', '/usr/bin/systemd-run', '--user',
    '--quiet', '--pipe', '--wait', '--service-type=exec', '--unit', unitName,
    '--property=Restart=no', '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=2s', '--property=RuntimeMaxSec=35s', '--',
    '/usr/bin/python3', '-I', '-S', '-c', SRT_HARNESS, JSON.stringify(recipe),
    Buffer.from(SRT_CANARY).toString('hex'), Buffer.from(JSON.stringify(fixture)).toString('hex'), unitName];
  const child = spawn(WSL, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } });
  return new Promise(resolve => {
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let outputSize = 0; let failed = false; let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (grace) clearTimeout(grace);
      signal.removeEventListener('abort', fail);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (code === null) child.unref();
      resolve({ code: failed ? null : code, stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr), uncertain: failed });
    };
    const fail = () => {
      if (settled || failed) return;
      failed = true;
      try { child.kill(); } catch { /* A Windows bridge kill is not Linux termination. */ }
      grace = setTimeout(() => settle(null), 1000);
    };
    const timer = setTimeout(fail, 40000);
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 32768) fail(); else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 32768) fail(); else stderr.push(Buffer.from(chunk));
    });
    child.on('error', fail); child.stdin.on('error', fail);
    child.stdout.on('error', fail); child.stderr.on('error', fail);
    child.once('close', code => settle(code));
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) { fail(); return; }
    try { child.stdin.end(configInput); } catch { fail(); }
  });
}

const inspectUnit = String.raw`import json,os,subprocess,sys
unit,group,identities,expected_boot,expected_inv=sys.argv[1:6]
boot=open('/proc/sys/kernel/random/boot_id').read().strip()
result=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
 '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup',unit],
 capture_output=True,timeout=3)
fields=dict(row.split('=',1) for row in result.stdout.decode().splitlines() if '=' in row)
pids=[]
for item in json.loads(identities):
 pid,ticks=item['pid'],item['ticks']
 try:
  raw=open('/proc/%d/stat'%pid).read(); current=int(raw[raw.rfind(')')+2:].split()[19])
  pids.append(dict(pid=pid,exists=True,sameTicks=current==ticks))
 except FileNotFoundError:pids.append(dict(pid=pid,exists=False,sameTicks=False))
path='/sys/fs/cgroup'+group
exists=os.path.exists(path);populated=None
if exists:
 populated=dict(row.split(' ',1) for row in open(path+'/cgroup.events').read().splitlines()).get('populated')
print(json.dumps(dict(showExit=result.returncode,fields=fields,bootMatches=boot==expected_boot,
 cgroupExists=exists,cgroupPopulated=populated,pids=pids,
 exactLoaded=fields.get('Id')==unit and fields.get('LoadState')=='loaded' and fields.get('InvocationID')==expected_inv and (fields.get('ActiveState'),fields.get('SubState')) in (('inactive','dead'),('failed','failed')),
 exactNotFound=fields.get('Id')==unit and fields.get('LoadState')=='not-found' and fields.get('ActiveState')=='inactive' and fields.get('SubState')=='dead' and fields.get('InvocationID')=='')))
`;

const stopExactUnit = String.raw`import json,subprocess,sys
unit,expected_inv=sys.argv[1:3]
query=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
 '--property=Id,LoadState,ActiveState,MainPID,InvocationID,ControlGroup',unit],
 capture_output=True,timeout=3)
fields=dict(row.split('=',1) for row in query.stdout.decode().splitlines() if '=' in row)
matched=query.returncode==0 and fields.get('Id')==unit and fields.get('InvocationID')==expected_inv
stopped=None
if matched and fields.get('ActiveState') not in ('inactive','failed'):
 stopped=subprocess.run(['/usr/bin/systemctl','--user','stop',unit],capture_output=True,timeout=4).returncode
print(json.dumps(dict(matched=matched,before=fields,stopExit=stopped)))
`;

test('sealed SRT canary reaches persisted scoped MCP through real FIFO without a model turn',
  { timeout: 90000 }, async t => {
    if (process.platform !== 'win32') { t.skip('Windows WSL only'); return; }
    if (process.env.RCAC_RUN_SEALED_SRT_MCP_TEST !== '1') {
      t.skip('requires explicit RCAC_RUN_SEALED_SRT_MCP_TEST=1'); return;
    }
    const runId = randomUUID();
    const evidencePath = join(process.cwd(), '.local', 'qualification', `SEALED_SRT_MCP_${runId}.json`);
    const rawStdoutPath = join(process.cwd(), '.local', 'qualification',
      `SEALED_SRT_MCP_${runId}.stdout.bin`);
    const rawStderrPath = join(process.cwd(), '.local', 'qualification',
      `SEALED_SRT_MCP_${runId}.stderr.bin`);
    mkdirSync(dirname(evidencePath), { recursive: true });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirtyScope = execFileSync('git', ['status', '--short', '--untracked-files=normal'],
      { encoding: 'utf8' });
    const evidence: Record<string, unknown> = { schema: 'sealed_srt_mcp_canary_v1', runId,
      sourceCommit, dirtyScope, result: 'started', stage: 'preflight',
      route: 'test_only_srt_canary', modelAccount: 'not_used', modelTurn: 'not_run',
      canaryRuntimeMaxSec: 35, originalOwnerRuntimeMaxSec: LIMITS.maxWallSeconds,
      productionSrtOrClaudeProof: false, isolationReceipt: 'synthetic_fixture_only' };
    const save = () => { writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n'); };
    save();
    let host: { uid: number; boot: string; ready: boolean };
    try {
      host = JSON.parse(wsl(['/usr/bin/python3', '-I', '-S', '-c',
        `import json,os
print(json.dumps(dict(uid=os.getuid(),boot=open('/proc/sys/kernel/random/boot_id').read().strip(),
 ready=all(os.path.isdir(p) for p in ${JSON.stringify([
          `${INSTALL_ROOT}/node_modules`, `${INSTALL_ROOT}/deps`, NODE_ROOT])}))))`])) as typeof host;
    } catch {
      evidence.result = 'skipped'; evidence.reason = 'private_wsl_unavailable'; save();
      t.skip('private WSL fixture unavailable'); return;
    }
    if (!host.ready) {
      evidence.result = 'skipped'; evidence.reason = 'private_runtime_unavailable'; save();
      t.skip('private WSL runtime unavailable'); return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'rcac-sealed-srt-'));
    const sourceDir = join(dir, 'source-workspace');
    const otherDir = join(dir, 'other-workspace');
    mkdirSync(sourceDir);
    mkdirSync(otherDir);
    const root = `/home/${USER}/.local/share/rcac-srt-${randomUUID()}`;
    const dbPath = join(dir, 'state.sqlite');
    const db = new SqliteStore(dbPath);
    const tickets = createClaudeModelRunningTickets();
    const outerTickets = createClaudeModelOuterTickets();
    const workspaceId = `ws_${randomUUID()}`;
    const otherWorkspaceId = `ws_${randomUUID()}`;
    const workerId = `worker_${randomUUID()}`;
    const recordId = `inv-${randomUUID()}`;
    const snapshot = createSnapshotFromFiles('wc-srt', 'synthetic-commit', {
      'src/entry.ts': Buffer.from('export const allowed = "SEALED_SRT_TEST";\n'),
      'src/secret.ts': Buffer.from('export const forbidden = true;\n'),
    }).toPersisted();
    let store: SqliteInvestigationStore | undefined;
    let owner: Awaited<ReturnType<typeof runClaudeModelOriginalOwner>> | undefined;
    let rootCreated = false; let testError: unknown;
    let canaryUnit: string | undefined;
    let ownerUnit: string | undefined;
    let ownerGroup: string | undefined;
    let ownerBoot: string | undefined;
    let ownerInvocation: string | undefined;
    let ownerPids: { pid: number; ticks: number }[] = [];
    let canaryGroup: string | undefined;
    let canaryBoot: string | undefined;
    let canaryInvocation: string | undefined;
    let canaryPids: { pid: number; ticks: number }[] = [];
    let canaryFullIdentity = false;
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 75000);
    try {
      evidence.stage = 'fixture';
      db.insertWorkspace({ id: workspaceId, name: 'SRT synthetic fixture', canonicalRoot: sourceDir,
        registeredBy: 'owner' });
      db.insertWorkspace({ id: otherWorkspaceId, name: 'Other synthetic fixture', canonicalRoot: otherDir,
        registeredBy: 'owner' });
      db.insertCollaboration({ id: 'col-srt', workspaceId, purpose: 'SRT fixture',
        openedBy: 'owner', hostThreadId: null, state: 'open' });
      db.insertCollaboration({ id: 'col-other', workspaceId: otherWorkspaceId,
        purpose: 'Other fixture', openedBy: 'owner', hostThreadId: null, state: 'open' });
      db.insertWorkingCopy({ id: 'wc-srt', workspaceId, canonicalRoot: sourceDir });
      db.insertWorkingCopy({ id: 'wc-other', workspaceId: otherWorkspaceId, canonicalRoot: otherDir });
      await db.saveSnapshot({ workspaceId, collaborationId: 'col-srt', workingCopyId: 'wc-srt', snapshot },
        { workspaceId, collaborationId: 'col-srt', workingCopyId: 'wc-srt', commitRef: 'synthetic-commit' },
        'capture', 'owner', 'local_cli');
      const now = new Date();
      db.insertGrant({ id: 'request', principal: 'external', audience: 'chatgpt', recipient: 'web',
        workspaceId, collaborationId: 'col-srt', permissions: ['investigation.request'],
        revokedAt: null, expiresAt: null });
      db.insertGrant({ id: 'external-read', principal: 'external', audience: 'chatgpt', recipient: 'web',
        workspaceId, collaborationId: 'col-srt', permissions: ['data.read'],
        dataPaths: ['src/entry.ts'], revokedAt: null, expiresAt: null });
      db.insertGrant({ id: 'worker-read', principal: workerId, audience: 'investigator', recipient: 'local',
        workspaceId, collaborationId: 'col-srt', permissions: ['data.read'],
        dataPaths: ['src/entry.ts'], revokedAt: null,
        expiresAt: new Date(now.getTime() + 120000).toISOString() });
      const record: InvestigationRecord = { id: recordId, workspaceId, collaborationId: 'col-srt',
        workingCopyId: 'wc-srt', principal: 'external', audience: 'chatgpt', recipient: 'web',
        grantId: 'request', profileRef: PROFILE_REVISION, budgetRef: 'synthetic-one-tool',
        budget: { maxWallSeconds: LIMITS.maxWallSeconds, maxTurns: 2, maxToolCalls: 1 },
        snapshotRef: snapshot.id, contextRevisionId: 'ctx-srt', question: 'Read synthetic entry',
        scope: { paths: ['src/entry.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
        parentInvestigationId: null, state: 'queued', cancelRequested: false,
        attempts: [], result: null, createdAt: now.toISOString() };
      store = new SqliteInvestigationStore(dbPath, { verifyIsolation: () => true,
        verifyNativeReceipt: tickets.verifyNativeStart,
        verifyModelRunningObservationReceipt: tickets.verifyRunningObservation,
        verifyModelOuterReceipt: outerTickets.verifyOuter,
        verifyModelPromptWindowReceipt: outerTickets.verifyPromptWindow,
        verifyOutcomeReceipt: () => true });
      store.enqueue(record, 'submit', 'synthetic-fingerprint');
      let claim = store.claimRequest(recordId, { workerId, isolationEvidence: 'synthetic-only',
        profileRevision: PROFILE_REVISION, permissionEpoch: 0,
        launchProtocol: 'resource_reservation_v1', now })!;
      const paths = { installRoot: INSTALL_ROOT, nodeRoot: NODE_ROOT,
        srtSettingsFile: `${root}/host-srt.json`, mcpConfigFile: `${root}/host-mcp.json`,
        helperFile: `${root}/host-helper.py`, privateAuthHome: `${root}/auth`,
        privateFifoDirectory: `${root}/${claim.attemptId}-${claim.workerEpoch}.mcp` };
      const sealed = buildClaudeModelSealedLaunch(paths, PROFILE, LIMITS.maxTurns);
      const originalSeparator = sealed.recipe.argv.indexOf('--');
      assert.ok(originalSeparator >= 5);
      const canaryRecipe = { file: sealed.recipe.file,
        argv: [...sealed.recipe.argv.slice(0, originalSeparator - 5),
          '--ro-bind-data', '10', '/opt/rcac-canary.py',
          '--ro-bind-data', '15', '/opt/rcac-canary-input.json',
          '--info-fd', '11', '--', '/runtime/node_modules/.bin/srt',
          '--settings', '/opt/srt.json', '--', '/usr/bin/python3', '-I', '-S',
          '/opt/rcac-canary.py'], env: sealed.recipe.env,
        configFiles: sealed.recipe.configFiles, canarySourceSha256: sha(SRT_CANARY) };
      ownerUnit = `rcac-investigator-${randomUUID()}.service`;
      const launch = { workerEpoch: claim.workerEpoch, sourceDigest: sha('synthetic-source'),
        profileDigest: sha('explicit-empty-domains'), commandDigest: sealed.commandDigest,
        action: 'claude_model_v1' as const };
      const descriptor = { attemptId: claim.attemptId, workspaceId, distro: DISTRO,
        linuxUser: USER, uid: host.uid, bootId: host.boot, unitName: ownerUnit,
        launchWorkerEpoch: claim.workerEpoch, sourceDigest: launch.sourceDigest,
        profileDigest: launch.profileDigest, commandDigest: launch.commandDigest };
      claim = store.reserveWslResource(claim, { unitName: ownerUnit, distro: DISTRO,
        uid: host.uid, bootId: host.boot, gate: { protocol: 'attempt_gate_v1',
          linuxUser: USER, root, payloadKind: 'claude_model_v1', launch } }, now);
      evidence.identity = { workspaceId, otherWorkspaceId, requestId: recordId,
        attemptId: claim.attemptId, workerEpoch: claim.workerEpoch, ownerUnit, root };
      evidence.sealed = { productionRecipeDigest: sealed.commandDigest,
        productionRecipe: sealed.recipe, canaryRecipe,
        configFiles: sealed.recipe.configFiles,
        productionBootstrapSha256: sealed.recipe.bootstrapSha256,
        canarySourceSha256: sha(SRT_CANARY), configReaderSha256: sha(CLAUDE_MODEL_CONFIG_READER_PYTHON),
        canaryDiff: 'replace bootstrap ro-bind-data/exec with sealed canary plus sealed fixture input; retain production bwrap prefix and three sealed config files',
        canaryRecipeDigest: sha(JSON.stringify(canaryRecipe)) };
      save();
      wsl(['/usr/bin/python3', '-I', '-S', '-c', String.raw`import os,sys
root=sys.argv[1];os.mkdir(root,0o700);os.mkdir(root+'/auth',0o700)
for name,body in [('host-srt.json',b'{}'),('host-mcp.json',b'{}'),('host-helper.py',b'# placeholder\n')]:
 fd=os.open(root+'/'+name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 os.write(fd,body);os.close(fd)
assert os.listdir(root+'/auth')==[]`, root]);
      rootCreated = true;
      const repository = new RepositoryApplication({
        authorize: async request => {
          await request.context.assertFreshAuthority?.();
          const context = { ...request.context, now: new Date() };
          return authorize(context, request.operation, { workspaceId: request.workspaceId,
            collaborationId: request.collaborationId }, db.grantsFor(context.principal, context.audience));
        },
        getWorkingCopy: (ws, wc) => db.getWorkingCopy(ws, wc),
        collaborationBelongsToWorkspace: (ws, col) => db.collaborationBelongsToWorkspace(ws, col),
        lookupCapture: (input, key, principal, audience) =>
          db.lookupCapture(input, key, principal, audience),
        saveSnapshot: (saved, input, key, principal, audience) =>
          db.saveSnapshot(saved, input, key, principal, audience),
        getSnapshot: (id, ws, col) => db.getSnapshot(id, ws, col),
      });
      const dispatcher = new DispatchService(db, undefined, undefined, { repository });
      const binding = { collaborationId: 'col-srt', workingCopyId: 'wc-srt', snapshotId: snapshot.id,
        paths: ['src/entry.ts'], workerGrantId: 'worker-read', workerAudience: 'investigator',
        workerRecipient: 'local' };
      evidence.stage = 'real_original_owner'; save();
      owner = await runClaudeModelOriginalOwner({ claim, store, binding, descriptor,
        paths, profile: PROFILE, profileRevision: PROFILE_REVISION, limits: LIMITS,
        runningTickets: tickets, outerTickets, dispatcher, signal: controller.signal });
      const fact = owner.fact;
      assert.equal(fact.kind, 'model_outer_confined_v1');
      assert.deepEqual(store.getModelOuterFact(store.listUnsettled()[0]!), fact);
      assert.equal(store.getModelPromptIntent(store.listUnsettled()[0]!), null);
      ownerGroup = fact.observation.candidate.running.resource.controlGroup ?? undefined;
      ownerBoot = fact.observation.candidate.running.resource.bootId;
      ownerInvocation = fact.observation.candidate.probe.unitAfter.InvocationID;
      if (!ownerInvocation) throw new Error('original invocation identity unavailable');
      assert.match(ownerInvocation, /^[0-9a-f]{32}$/);
      assert.equal(fact.observation.candidate.probe.unitAfter.Id, ownerUnit);
      assert.equal(fact.observation.candidate.probe.unitAfter.ControlGroup, ownerGroup);
      ownerPids = Object.values(fact.observation.candidate.probe.processes).map(item =>
        ({ pid: item.pid, ticks: item.startTicks }));
      evidence.owner = { factSha256: sha(JSON.stringify(fact)),
        pidCount: ownerPids.length, controlGroup: ownerGroup, bootId: ownerBoot,
        noPromptIntent: true };
      evidence.ownerFullFact = fact;
      save();
      assert.equal(ownerPids.length, 4);
      evidence.stage = 'sealed_srt_canary'; save();
      canaryUnit = `rcac-investigator-${randomUUID()}.service`;
      evidence.canaryUnit = canaryUnit;
      const result = await runNamedCanary(canaryUnit, sealed.recipe, sealed.startupInput, {
        workspaceId, otherWorkspaceId, collaborationId: 'col-srt', workingCopyId: 'wc-srt',
        snapshotId: snapshot.id, path: 'src/entry.ts',
        expectedText: 'export const allowed = "SEALED_SRT_TEST";\n',
        expectedHash: sha('export const allowed = "SEALED_SRT_TEST";\n'),
        hostOnlyPath: `${root}/host-only.txt`, loopbackPort: 0,
      }, controller.signal);
      // Failed stdout/stderr are also evidence; both are bounded and synthetic.
      writeFileSync(rawStdoutPath, result.stdout);
      writeFileSync(rawStderrPath, result.stderr);
      evidence.canaryProcess = { exitCode: result.code,
        stdoutSha256: sha(result.stdout), stdoutBytes: result.stdout.length,
        stderrSha256: sha(result.stderr), stderrBytes: result.stderr.length,
        stdoutPath: rawStdoutPath, stderrPath: rawStderrPath, uncertain: result.uncertain };
      const frames = result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
      const birth = frames.find(frame => frame.kind === 'test_only_srt_unit_birth');
      const nestedFailure = frames.find(frame => frame.kind === 'test_only_srt_nested_failure');
      if (nestedFailure) evidence.canaryNestedFailure = nestedFailure;
      if (birth && birth.unit === canaryUnit && birth.bootId === host.boot &&
        typeof birth.invocationId === 'string' && /^[0-9a-f]{32}$/.test(birth.invocationId) &&
        typeof birth.controlGroup === 'string' && birth.controlGroup.endsWith(`/${canaryUnit}`) &&
        typeof birth.parentPid === 'number' && birth.parentPid > 0 &&
        typeof birth.parentTicks === 'number' && birth.parentTicks > 0 &&
        typeof birth.unitBefore === 'object' && birth.unitBefore !== null &&
        (birth.unitBefore as Record<string, unknown>).Id === canaryUnit &&
        (birth.unitBefore as Record<string, unknown>).InvocationID === birth.invocationId &&
        (birth.unitBefore as Record<string, unknown>).MainPID === String(birth.parentPid) &&
        (birth.unitBefore as Record<string, unknown>).ControlGroup === birth.controlGroup) {
        canaryInvocation = birth.invocationId;
        canaryGroup = birth.controlGroup;
        canaryBoot = birth.bootId as string;
        canaryPids = [{ pid: birth.parentPid, ticks: birth.parentTicks }];
        evidence.canaryBirth = birth;
      }
      save();
      assert.equal(result.code, 0, `canary stderr bytes=${result.stderr.length}`);
      const data = frames.find(frame => frame.canary !== undefined) as unknown as {
        canary: Record<string, unknown>; canarySha256: string; unitInvocationId: string;
        controlGroup: string; bootId: string; parentPid: number; parentTicks: number;
        wrapperPid: number; wrapperTicks: number; outerPid: number; outerTicks: number;
        parentMountNs: string; parentNetNs: string; parentStatus: Record<string, string>;
        parentListenerBefore: { connectErrno: number; accepted: boolean; acknowledged: boolean;
          port: number; netNs: string };
        parentListenerAfter: { connectErrno: number; accepted: boolean; acknowledged: boolean;
          port: number; netNs: string };
        unitBefore: Record<string, string>; liveCgroupProcesses: {
          pid: number; ticks: number; state: string; namespacePid: number;
          pidNamespace: string }[];
        survivorHostIdentity: { pid: number; ticks: number; state: string;
          namespacePid: number; pidNamespace: string } };
      assert.equal(data.canarySha256, sha(SRT_CANARY));
      assert.equal(data.canary.readHash, sha('export const allowed = "SEALED_SRT_TEST";\n'));
      assert.deepEqual(data.canary.tools, ['repo.read']);
      assert.match(data.unitInvocationId, /^[0-9a-f]{32}$/);
      assert.equal(data.unitBefore.Id, canaryUnit);
      assert.equal(data.unitBefore.InvocationID, data.unitInvocationId);
      assert.equal(data.unitBefore.MainPID, String(data.parentPid));
      assert.equal(data.unitBefore.ControlGroup, data.controlGroup);
      assert.equal(data.canary.seccomp, '2');
      assert.equal(data.canary.noNewPrivs, '1');
      assert.equal(data.canary.capEff, '0000000000000000');
      assert.notEqual(data.canary.mountNs, data.parentMountNs);
      // The outer bwrap shares its parent's netns; SRT may give the command a
      // separate namespace. Prove the same parent listener stayed reachable.
      for (const listener of [data.parentListenerBefore, data.parentListenerAfter]) {
        assert.equal(listener.connectErrno, 0);
        assert.equal(listener.accepted, true);
        assert.equal(listener.acknowledged, true);
        assert.equal(listener.netNs, data.parentNetNs);
        assert.ok(Number.isInteger(listener.port) && listener.port > 0 && listener.port <= 65535);
      }
      assert.equal(data.parentListenerBefore.port, data.parentListenerAfter.port);
      assert.equal(data.canary.parentNetNs, data.parentNetNs);
      assert.match(data.parentNetNs, /^net:\[\d+\]$/);
      assert.match(data.canary.netNs as string, /^net:\[\d+\]$/);
      assert.notEqual(data.canary.loopbackErrno, 0);
      if (data.canary.netNs === data.parentNetNs) {
        assert.ok(data.canary.loopbackErrno === 1 || data.canary.loopbackErrno === 13);
      } else {
        assert.equal(data.canary.loopbackErrno, 111); // Linux ECONNREFUSED, isolated loopback.
      }
      assert.notEqual(data.parentStatus.Seccomp, undefined);
      assert.equal(data.canary.survivorAliveAtReport, true);
      assert.ok(data.liveCgroupProcesses.some(item => item.pid === data.parentPid &&
        item.ticks === data.parentTicks));
      assert.ok(data.liveCgroupProcesses.some(item => item.pid === data.wrapperPid &&
        item.ticks === data.wrapperTicks));
      assert.ok(data.liveCgroupProcesses.some(item => item.pid === data.outerPid &&
        item.ticks === data.outerTicks));
      assert.ok(data.liveCgroupProcesses.some(item => item.pid === data.survivorHostIdentity.pid &&
        item.ticks === data.survivorHostIdentity.ticks));
      assert.equal(data.survivorHostIdentity.namespacePid, data.canary.survivorNamespacePid);
      assert.equal(data.survivorHostIdentity.ticks, data.canary.survivorStartTicks);
      assert.equal(data.survivorHostIdentity.pidNamespace, data.canary.survivorPidNamespace);
      assert.equal(data.bootId, host.boot);
      assert.ok(data.controlGroup.endsWith(`/${canaryUnit}`));
      canaryGroup = data.controlGroup; canaryBoot = data.bootId;
      canaryInvocation = data.unitInvocationId;
      canaryPids = [{ pid: data.parentPid, ticks: data.parentTicks },
        { pid: data.wrapperPid, ticks: data.wrapperTicks },
        { pid: data.outerPid, ticks: data.outerTicks },
        { pid: data.survivorHostIdentity.pid, ticks: data.survivorHostIdentity.ticks }];
      canaryFullIdentity = true;
      evidence.canary = data;
      const activeStore = store;
      const current = activeStore.listUnsettled()[0]!;
      activeStore.assertRunningReadAuthority(current, binding, new Date());
      assert.throws(() => activeStore.reserveRunningRead(current, binding, {
        workspaceId, collaborationId: 'col-srt', workingCopyId: 'wc-srt',
        snapshotId: snapshot.id, path: 'src/entry.ts',
      }, new Date()));
      const readOnly = new DatabaseSync(dbPath, { readOnly: true });
      let reservedCalls: number | undefined;
      try {
        reservedCalls = (readOnly.prepare(`SELECT reserved_calls FROM investigation_read_budget
          WHERE request_id=?`).get(recordId) as { reserved_calls: number } | undefined)?.reserved_calls;
      } finally { readOnly.close(); }
      assert.equal(reservedCalls, 1);
      evidence.budget = { maxToolCalls: 1, reservedCalls, currentReadAuthority: true,
        secondReserveDenied: true };
      assert.equal(store.getModelPromptIntent(store.listUnsettled()[0]!), null);
      assert.equal(store.get(recordId)?.result, null);
      evidence.stage = 'cleanup_and_terminal'; save();
    } catch (error) { testError = error; }
    finally {
      const failedStage = evidence.stage;
      try { await owner?.close(); } catch (error) { testError ??= error; }
      const stops: Record<string, unknown> = {};
      for (const [role, unit, invocation] of [
        ['canary', canaryUnit, canaryInvocation],
        ['owner', ownerUnit, ownerInvocation],
      ] as const) {
        if (!unit || !invocation) {
          stops[role] = { attempted: false, reason: 'missing_original_identity' }; continue;
        }
        try {
          const stop = JSON.parse(wsl(['/usr/bin/python3', '-I', '-S', '-c',
            stopExactUnit, unit, invocation])) as {
            matched: boolean; before: Record<string, string>; stopExit: number | null };
          stops[role] = stop;
          if (stop.before.ActiveState === 'active' && !stop.matched ||
            stop.stopExit !== null && stop.stopExit !== 0) {
            testError ??= new Error('exact unit stop was not confirmed');
          }
        } catch (error) { stops[role] = { attempted: true, confirmed: false }; testError ??= error; }
      }
      evidence.stops = stops;
      const terminals: Record<string, unknown> = {};
      for (const [role, unit, group, boot, invocation, identities] of [
        ['owner', ownerUnit, ownerGroup, ownerBoot, ownerInvocation, ownerPids],
        ['canary', canaryUnit, canaryGroup, canaryBoot, canaryInvocation, canaryPids],
      ] as const) {
        if (!unit || !group || !boot || !invocation || identities.length === 0) {
          terminals[role] = { confirmed: false, reason: 'incomplete_identity' }; continue;
        }
        try {
          const checked = JSON.parse(wsl(['/usr/bin/python3', '-I', '-S', '-c', inspectUnit,
            unit, group, JSON.stringify(identities), boot, invocation])) as {
            showExit: number; fields: { Id?: string; LoadState?: string; ActiveState?: string;
              SubState?: string;
              MainPID?: string; ControlGroup?: string; InvocationID?: string };
            bootMatches: boolean; cgroupExists: boolean; cgroupPopulated: string | null;
            exactLoaded: boolean; exactNotFound: boolean;
            pids: { pid: number; exists: boolean; sameTicks: boolean }[] };
          const confirmed = checked.showExit === 0 && checked.bootMatches &&
            (checked.exactLoaded && ['inactive','failed'].includes(checked.fields.ActiveState ?? '') ||
              checked.exactNotFound) &&
            checked.fields.MainPID === '0' && checked.fields.ControlGroup === '' &&
            (!checked.cgroupExists || checked.cgroupPopulated === '0') &&
            checked.pids.length === identities.length && checked.pids.every(item => !item.exists);
          terminals[role] = { confirmed, observation: checked };
        } catch { terminals[role] = { confirmed: false, reason: 'inspection_failed' }; }
      }
      evidence.terminals = terminals;
      const confirmedTerminal = (terminals.owner as { confirmed?: boolean })?.confirmed === true &&
        canaryFullIdentity && (terminals.canary as { confirmed?: boolean })?.confirmed === true;
      if (!confirmedTerminal) testError ??= new Error('original unit or canary descendants unconfirmed');
      try { store?.close(); } catch (error) { testError ??= error; }
      db.close();
      evidence.result = testError ? 'failed' : 'passed'; evidence.stage = failedStage;
      evidence.fixtureRetained = true; save();
      if (!testError && rootCreated && confirmedTerminal) {
        try {
          // Preserve the evidence and confirmed terminal observations before deleting fixtures.
          wsl(['/usr/bin/python3', '-I', '-S', '-c', String.raw`import os,shutil,sys
root=sys.argv[1]
assert root.startswith('/home/investigator/.local/share/rcac-srt-') and not os.path.islink(root)
shutil.rmtree(root)`, root]);
          const actual = realpathSync(dir);
          assert.equal(dirname(actual), realpathSync(tmpdir()));
          assert.ok(basename(actual).startsWith('rcac-sealed-srt-'));
          rmSync(actual, { recursive: true });
          evidence.fixtureRetained = false; save();
        } catch (error) { testError ??= error; evidence.result = 'failed'; save(); }
      }
      if (testError) t.diagnostic(`Retained or unconfirmed fixture: ${dir} and ${root}; evidence ${evidencePath}`);
      clearTimeout(watchdog);
    }
    if (testError) throw testError;
    assert.equal(evidence.result, 'passed');
  });

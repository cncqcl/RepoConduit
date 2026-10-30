import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { CLAUDE_MCP_FIFO_PYTHON } from '../../src/adapters/secondary-investigator/claude-mcp-fifo-helper.js';

const WSL = 'C:\\Windows\\System32\\wsl.exe';

test('Claude MCP FIFO helper has fixed paths and no argument, model, or source authority', () => {
  assert.match(CLAUDE_MCP_FIFO_PYTHON, /['"]\/relay['"]/);
  assert.match(CLAUDE_MCP_FIFO_PYTHON, /helper\.lock/);
  assert.doesNotMatch(CLAUDE_MCP_FIFO_PYTHON, /sys\.argv\[|subprocess|os\.environ|\/snapshot|\/home\/claude/);
});

test('real WSL bwrap helper transfers raw MCP bytes and refuses second connection', { timeout: 30000 }, t => {
  if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
  const controller = String.raw`
import base64, errno, json, os, select, shutil, stat, subprocess, sys, tempfile, threading, time
source = base64.b64decode(sys.argv[1]); root = tempfile.mkdtemp(prefix='rcac-helper-', dir='/home/fixture')
relay = os.path.join(root, 'relay'); os.mkdir(relay, 0o700)
for name in ('in','out'): os.mkfifo(os.path.join(relay,name), 0o600)
with open(os.path.join(relay,'helper.lock'),'xb') as marker: marker.write(b'0')
os.chmod(os.path.join(relay,'helper.lock'),0o600)
helper = os.path.join(root,'mcp-fifo.py')
with open(helper,'wb') as f: f.write(source)
os.chmod(helper,0o600)
cmd = ['bwrap','--unshare-all','--share-net','--die-with-parent','--new-session',
 '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib',
 '--ro-bind','/lib64','/lib64','--dev-bind','/dev','/dev','--proc','/proc',
 '--dir','/opt','--ro-bind',helper,'/opt/mcp-fifo.py','--bind',relay,'/relay',
 '--','/usr/bin/python3','-I','-S','/opt/mcp-fifo.py']
child = None; safe_cleanup = False
try:
 child = subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 inbound = os.open(os.path.join(relay,'out'), os.O_RDONLY|os.O_NONBLOCK)
 deadline = time.monotonic()+5
 while True:
  try: outbound = os.open(os.path.join(relay,'in'), os.O_WRONLY|os.O_NONBLOCK); break
  except OSError as e:
   if e.errno != errno.ENXIO or time.monotonic()>deadline: raise
   time.sleep(.01)
 first = bytes(range(256))*600; second = b'\x00\xff\x0aMCP response'
 got = bytearray()
 def reader():
  reader_end = time.monotonic()+7
  while len(got)<len(first):
   if time.monotonic()>=reader_end: raise AssertionError('stdin-to-out deadline')
   ready,_,_ = select.select([inbound],[],[],max(0,min(.1,reader_end-time.monotonic())))
   if not ready: continue
   data = os.read(inbound,65536)
   if data: got.extend(data)
 th = threading.Thread(target=reader); th.start()
 child.stdin.write(first[:11]); child.stdin.flush(); child.stdin.write(first[11:]); child.stdin.flush()
 th.join(7); assert not th.is_alive() and bytes(got)==first
 os.write(outbound,second[:2]); os.write(outbound,second[2:])
 ready,_,_ = select.select([child.stdout],[],[],5); assert ready
 assert child.stdout.read(len(second))==second
 assert child.poll() is None, 'connected idle helper exited'
 repeat = subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=4)
 assert repeat.returncode != 0 and not repeat.stdout
 child.stdin.close(); os.close(outbound)
 assert child.wait(timeout=4)==0
 assert not child.stderr.read(), 'stderr mixed with MCP bytes'
 assert stat.S_IMODE(os.stat(os.path.join(relay,'helper.lock')).st_mode)==0o600
 assert open(os.path.join(relay,'helper.lock'),'rb').read()==b'1'
 restart = subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=4)
 assert restart.returncode != 0 and not restart.stdout
 os.close(inbound); safe_cleanup=True
 print(json.dumps({'bytes':len(first)+len(second),'secondDenied':True,'idle':True}))
finally:
 if child is not None and child.poll() is None:
  child.kill(); child.wait(timeout=3)
 if safe_cleanup: shutil.rmtree(root)
 else: print('retained fixture '+root,file=sys.stderr)
`;
  let output: string;
  try {
    output = execFileSync(WSL, ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', controller, Buffer.from(CLAUDE_MCP_FIFO_PYTHON).toString('base64')],
    { encoding: 'utf8', timeout: 26000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const message = String(error);
    if (/ENOENT|WSL_E_DISTRO_NOT_FOUND|bwrap: Creating new namespace failed/.test(message)) {
      t.skip(`WSL/bwrap fixture unavailable: ${message.slice(0, 160)}`); return;
    }
    throw error;
  }
  assert.deepEqual(JSON.parse(output.slice(output.lastIndexOf('{'))),
    { bytes: 153600 + 15, secondDenied: true, idle: true });
});

test('real WSL helper refuses absent, malformed and shared state before opening FIFO peers', { timeout: 15000 }, t => {
  if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
  const controller = String.raw`
import base64, os, shutil, subprocess, sys, tempfile
root=tempfile.mkdtemp(prefix='rcac-helper-state-',dir='/home/fixture')
helper=os.path.join(root,'helper.py')
with open(helper,'wb') as f: f.write(base64.b64decode(sys.argv[1]))
try:
 for case in ('missing','empty','oversize','consumed','invalid','mode','hardlink','symlink'):
  relay=os.path.join(root,case); os.mkdir(relay,0o700)
  for n in ('in','out'): os.mkfifo(os.path.join(relay,n),0o600)
  state=os.path.join(relay,'helper.lock')
  if case!='missing':
   with open(state,'xb') as f: f.write({'empty':b'','oversize':b'00','consumed':b'1','invalid':b'x'}.get(case,b'0'))
   os.chmod(state,0o644 if case=='mode' else 0o600)
  if case=='hardlink': os.link(state,os.path.join(relay,'alias'))
  if case=='symlink': os.rename(state,os.path.join(relay,'alias')); os.symlink('alias',state)
  cmd=['bwrap','--unshare-all','--die-with-parent','--new-session',
   '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib',
   '--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev',
   '--dir','/opt','--ro-bind',helper,'/opt/mcp-fifo.py','--bind',relay,'/relay',
   '--','/usr/bin/python3','-I','-S','/opt/mcp-fifo.py']
  result=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=2)
  assert result.returncode!=0 and result.stdout==b'',case
 print('state-refusals:8')
finally:
 assert root.startswith('/home/fixture/rcac-helper-state-') and not os.path.islink(root)
 shutil.rmtree(root)
`;
  const output = execFileSync(WSL, ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', controller, Buffer.from(CLAUDE_MCP_FIFO_PYTHON).toString('base64')],
  { encoding: 'utf8', timeout: 13000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output.trim(), 'state-refusals:8');
});

test('real WSL helper bounds idle peer EOF, argv, and sustained EOF backpressure', { timeout: 30000 }, t => {
  if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
  const controller = String.raw`
import base64, errno, json, os, shutil, subprocess, sys, tempfile, threading, time
source=base64.b64decode(sys.argv[1]); root=tempfile.mkdtemp(prefix='rcac-helper-fault-',dir='/home/fixture')
relay=os.path.join(root,'relay'); os.mkdir(relay,0o700)
for n in ('in','out'): os.mkfifo(os.path.join(relay,n),0o600)
with open(os.path.join(relay,'helper.lock'),'xb') as marker: marker.write(b'0')
os.chmod(os.path.join(relay,'helper.lock'),0o600)
helper=os.path.join(root,'helper.py')
with open(helper,'wb') as f: f.write(source)
os.chmod(helper,0o600)
cmd=['bwrap','--unshare-all','--share-net','--die-with-parent','--new-session',
 '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib',
 '--ro-bind','/lib64','/lib64','--dev-bind','/dev','/dev','--proc','/proc',
 '--dir','/opt','--ro-bind',helper,'/opt/mcp-fifo.py','--bind',relay,'/relay',
 '--','/usr/bin/python3','-I','-S','/opt/mcp-fifo.py']
children=[]; clean=False
def start():
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE); children.append(p)
 reader=os.open(os.path.join(relay,'out'),os.O_RDONLY|os.O_NONBLOCK)
 end=time.monotonic()+5
 while True:
  try: writer=os.open(os.path.join(relay,'in'),os.O_WRONLY|os.O_NONBLOCK); break
  except OSError as e:
   if e.errno!=errno.ENXIO or time.monotonic()>end: raise
   time.sleep(.01)
 return p,reader,writer
try:
 argv=subprocess.run(cmd+['unexpected'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=4)
 assert argv.returncode!=0 and not argv.stdout
 # Argument refusal happens before a one-use lock is claimed.
 p,r,w=start(); time.sleep(5.2)
 assert p.poll() is None, 'connected idle helper died'
 os.close(w); began=time.monotonic(); assert p.wait(timeout=3)==0
 assert time.monotonic()-began<2.5, 'peer EOF did not bound drain'
 os.close(r)
 # A separate transport fixture, never reset the consumed marker.
 oldrelay=relay; relay=os.path.join(root,'relay-flood'); os.mkdir(relay,0o700)
 for n in ('in','out'): os.mkfifo(os.path.join(relay,n),0o600)
 with open(os.path.join(relay,'helper.lock'),'xb') as marker: marker.write(b'0')
 os.chmod(os.path.join(relay,'helper.lock'),0o600)
 cmd=[relay if part==oldrelay else part for part in cmd]
 p,r,w=start(); running=True
 def flood():
  while running:
   try: os.write(w,b'x'*65536)
   except BlockingIOError: time.sleep(.001)
   except BrokenPipeError: break
 th=threading.Thread(target=flood); th.start()
 try:
  time.sleep(.1); p.stdin.close(); began=time.monotonic()
  assert p.wait(timeout=3)!=0, 'truncated output was reported successful'
  assert time.monotonic()-began<2.5, 'continuous peer output extended EOF deadline'
 finally:
  running=False; th.join(2)
 assert not th.is_alive(); os.close(w); os.close(r)
 clean=True; print(json.dumps({'argvDenied':True,'idleEofBounded':True,'floodBounded':True}))
finally:
 for p in children:
  if p.poll() is None: p.kill()
  p.wait(timeout=3)
 if clean: shutil.rmtree(root)
 else: print('retained fixture '+root,file=sys.stderr)
`;
  const output = execFileSync(WSL, ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', controller, Buffer.from(CLAUDE_MCP_FIFO_PYTHON).toString('base64')],
  { encoding: 'utf8', timeout: 26000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(output.slice(output.lastIndexOf('{'))),
    { argvDenied: true, idleEofBounded: true, floodBounded: true });
});

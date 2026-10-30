import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { claudeModelCommandDigest, claudeModelSupervisorSpec,
  parseClaudeModelSupervisorOutput, type ClaudeModelSupervisorDescriptor } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { boundedClaudeModelPrompt, readClaudeModelSupervisorControl } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor-runner.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, CLAUDE_MODEL_BOOTSTRAP_SHA256 } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import { buildClaudeMcpSandboxSpec } from
  '../../src/adapters/secondary-investigator/claude-mcp-sandbox-spec.js';
import { parseClaudeModelStartup } from
  '../../src/adapters/secondary-investigator/claude-model-startup.js';

const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
  srtSettingsFile: '/home/fixture/settings/srt.json', mcpConfigFile: '/home/fixture/settings/mcp.json',
  helperFile: '/home/fixture/settings/mcp-fifo.py',
  privateFifoDirectory: '/home/fixture/private/attempt_11111111-1111-4111-8111-111111111111-1.mcp',
  privateAuthHome: '/home/fixture/auth' };
const profile = { allowedDomains: [] };
const base: ClaudeModelSupervisorDescriptor = {
  attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000,
  bootId: '33333333-3333-4333-8333-333333333333',
  unitName: 'rcac-investigator-44444444-4444-4444-8444-444444444444.service',
  launchWorkerEpoch: 1, sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
  commandDigest: claudeModelCommandDigest(paths, profile, 3),
};

test('model journal is separate and entry fixes bwrap, command digest and exact operation', () => {
  const spec = claudeModelSupervisorSpec('enter_wait_exec', base, '/home/fixture/model-gates', paths,
    undefined, { maxWallSeconds: 60, maxTurns: 3 }, profile);
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.ok(spec.args.includes('/usr/bin/systemd-run'));
  assert.ok(spec.args.includes('--pipe'));
  assert.ok(spec.args.includes('--wait'));
  assert.ok(spec.args.includes('--property=RuntimeMaxSec=60s'));
  assert.equal(spec.args.includes('--remain-after-exit'), false);
  assert.ok(spec.args.includes(base.commandDigest));
  assert.ok(Buffer.isBuffer(spec.startupInput));
  assert.ok(spec.startupInput.length > 0);
  assert.equal(spec.args.includes(spec.startupInput.toString('utf8')), false);
  assert.equal(spec.args.includes('/bin/sh'), false);
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec', { ...base,
    commandDigest: 'c'.repeat(64) }, '/home/fixture/model-gates', paths,
  undefined, { maxWallSeconds: 60, maxTurns: 3 }, profile));
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec', base,
    '/home/fixture/model-gates', paths, undefined, { maxWallSeconds: 601, maxTurns: 3 }, profile));
  for (const cap of [undefined,0,9,1.5])
    assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec',base,
      '/home/fixture/model-gates',paths,undefined,{maxWallSeconds:60,maxTurns:cap} as never,profile),
      {message:'INVALID_ARGUMENT'});
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec',base,
    '/home/fixture/model-gates',paths,undefined,undefined,profile),{message:'INVALID_ARGUMENT'});
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec',base,
    '/home/fixture/model-gates',paths,undefined,{maxWallSeconds:60,maxTurns:3,extra:true} as never,
    profile),{message:'INVALID_ARGUMENT'});
  assert.throws(() => claudeModelSupervisorSpec('release', base, '/home/fixture/model-gates'));
  assert.throws(() => claudeModelSupervisorSpec('prepare', base, '/home/fixture/../other'));
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec', base, '/home/fixture/model-gates',
    { ...paths, privateFifoDirectory: '/mnt/d/leak' }, undefined, { maxWallSeconds: 60, maxTurns: 3 }, profile));
});

test('new model recipe binds sealed bootstrap and fixed FD launch while old digest cannot enter', () => {
  const old = buildClaudeMcpSandboxSpec(paths);
  const oldDigest = createHash('sha256').update(JSON.stringify(old)).digest('hex');
  assert.notEqual(claudeModelCommandDigest(paths, profile, 3), oldDigest);
  assert.notEqual(claudeModelCommandDigest(paths, profile, 3),
    claudeModelCommandDigest(paths, { allowedDomains: ['example.test'] }, 3));
  const spec = claudeModelSupervisorSpec('enter_wait_exec', base, '/home/fixture/model-gates', paths,
    undefined, { maxWallSeconds: 60, maxTurns: 3 }, profile);
  assert.ok(spec.args.includes(CLAUDE_MODEL_BOOTSTRAP_PYTHON));
  assert.ok(spec.args.some(value => value.includes(CLAUDE_MODEL_BOOTSTRAP_SHA256)));
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec',
    { ...base, commandDigest: oldDigest }, '/home/fixture/model-gates', paths,
    undefined, { maxWallSeconds: 60, maxTurns: 3 }, profile));
  assert.throws(() => claudeModelSupervisorSpec('enter_wait_exec', base,
    '/home/fixture/model-gates', paths, undefined, { maxWallSeconds: 60, maxTurns: 3 },
    { allowedDomains: ['example.test'] }));
  assert.doesNotThrow(() => claudeModelSupervisorSpec('status',
    { ...base, commandDigest: oldDigest }, '/home/fixture/model-gates'));
});

test('model state parser refuses canary, widened, mismatched and partial native facts', () => {
  const state = { protocol: 'claude_model_v1', action: 'claude_model_v1', phase: 'prepared',
    closed: false, attemptId: base.attemptId, workspaceId: base.workspaceId,
    bootId: base.bootId, uid: base.uid, unitName: base.unitName,
    launchWorkerEpoch: base.launchWorkerEpoch, sourceDigest: base.sourceDigest,
    profileDigest: base.profileDigest, commandDigest: base.commandDigest };
  assert.deepEqual(parseClaudeModelSupervisorOutput(JSON.stringify(state) + '\n', base), state);
  for (const changed of [{ ...state, protocol: 'native_supervisor_v2' },
    { ...state, commandDigest: 'c'.repeat(64) }, { ...state, phase: 'entered' },
    { ...state, extra: true }])
    assert.equal(parseClaudeModelSupervisorOutput(JSON.stringify(changed) + '\n', base), null);
});

test('offline extracted supervisor frame reader polls exited owned child before input wait', t => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const available = spawnSync(python, ['-I', '-S', '-c', 'print(1)'],
    {encoding: 'utf8', timeout: 2000});
  if (available.error && (available.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('local Python interpreter unavailable for extracted logic'); return;
  }
  assert.equal(available.status, 0, available.stderr);
  const spec = claudeModelSupervisorSpec('enter_wait_exec', base, '/home/fixture/model-gates', paths,
    undefined, { maxWallSeconds: 60, maxTurns: 3 }, profile);
  const script = spec.args[spec.args.indexOf('-c') + 1]!;
  const start = script.indexOf('def strict_object(');
  const end = script.indexOf('def reserve(', start);
  assert.ok(start > 0 && end > start);
  const extracted = script.slice(start, end);
  const harness = String.raw`import hashlib,json,os,re,select,subprocess,sys,time
source,mode=json.loads(sys.stdin.read())
body=b'A'
header={'protocol':'claude_model_bootstrap_v1','byteLength':1,'sha256':hashlib.sha256(body).hexdigest()}
frame=(json.dumps(header,separators=(',',':'))+'\n').encode('ascii')+body
if mode=='partial': frame=frame[:-1]
if mode=='eof': frame=b''
if mode=='bad_hash': frame=frame[:-1]+b'B'
position=0
events=[]
def fake_read(fd,count):
 global position
 events.append('read')
 part=frame[position:position+count]
 position+=len(part)
 return part
def fake_select(read,write,errors,timeout):
 events.append('select')
 if mode in ('child_exit','real_child_exit','deadline'):
  time.sleep(timeout)
  return ([],[],[])
 return (read,[],[])
os.read=fake_read
os.set_blocking=lambda fd,enabled: None
select.select=fake_select
class Child:
 def poll(self):
  events.append('poll')
  return 7 if mode=='child_exit' else None
 def wait(self,timeout=None):
  events.append('wait')
  return 7
namespace={'hashlib':hashlib,'json':json,'os':os,'re':re,'select':select,'time':time}
exec(source,namespace)
child=Child()
if mode=='real_child_exit':
 child=subprocess.Popen([sys.executable,'-I','-S','-c','pass'],stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 time.sleep(.1)
begin=time.monotonic()
try:
 result=namespace['read_frame'](time.monotonic()+.15,child)
 print(json.dumps({'kind':'returned','resultHex':result.hex(),'elapsedMs':(time.monotonic()-begin)*1000,'events':events,'returncode':child.returncode if mode=='real_child_exit' else None}))
except Exception as exc:
 print(json.dumps({'kind':type(exc).__name__,'message':str(exc),'elapsedMs':(time.monotonic()-begin)*1000,'events':events,'returncode':child.returncode if mode=='real_child_exit' else None}))
`;
  const run = (mode: string) => {
    const result = spawnSync(python, ['-I', '-S', '-c', harness],
      {encoding: 'utf8', timeout: 2000, input: JSON.stringify([extracted, mode])});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as {kind: string; message?: string;
      elapsedMs: number; resultHex?: string; events: string[]; returncode?: number};
  };
  const exited = run('child_exit');
  assert.equal(exited.kind, 'ValueError');
  assert.match(exited.message!, /model child exited before frame/);
  assert.deepEqual(exited.events.slice(0, 2), ['poll', 'wait']);
  assert.equal(exited.events.includes('read'), false);
  assert.equal(exited.events.includes('select'), false);
  assert.ok(exited.elapsedMs < 120, JSON.stringify(exited));
  const localPopen = run('real_child_exit');
  assert.equal(localPopen.kind, 'ValueError');
  assert.match(localPopen.message!, /model child exited before frame/);
  assert.equal(localPopen.returncode, 0);
  assert.ok(localPopen.elapsedMs < 120, JSON.stringify(localPopen));
  assert.equal(run('valid').kind, 'returned');
  assert.equal(run('partial').kind, 'ValueError');
  assert.equal(run('eof').kind, 'ValueError');
  assert.equal(run('bad_hash').kind, 'ValueError');
  assert.equal(run('deadline').kind, 'TimeoutError');
});

test('prompt bridge accepts only exact bounded bytes committed by hash', () => {
  const bytes = Buffer.from([0, 255, 10, 13, 65]);
  const digest = '7324c9525db64f21dac0fb72486637a83b959ce4bf38804a7021f11a97ebd205';
  assert.deepEqual(boundedClaudeModelPrompt(bytes, digest), bytes);
  assert.throws(() => boundedClaudeModelPrompt(bytes, 'a'.repeat(64)));
  assert.throws(() => boundedClaudeModelPrompt(Buffer.alloc(16_385), 'a'.repeat(64)));
  assert.throws(() => boundedClaudeModelPrompt(Buffer.alloc(0), 'a'.repeat(64)));
});

test('uncertain control bridge closes its pipes and unrefs after missing child close', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    kills: 0, unrefs: 0, kill() { this.kills++; return true; },
    unref() { this.unrefs++; } });
  const output = await readClaudeModelSupervisorControl(child, 5);
  assert.equal(output.uncertain, true);
  assert.equal(output.exitCode, null);
  assert.equal(child.kills, 1);
  assert.equal(child.unrefs, 1);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('real WSL model journal close before launch is irreversible without model call',
  { timeout: 15000 }, t => {
    if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: readonly string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    const live = { ...base, uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
      attemptId: `attempt_${randomUUID()}`, unitName: `rcac-investigator-${randomUUID()}.service` };
    const root = `/home/fixture/model-gate-${live.attemptId}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const call = (op: 'prepare' | 'status' | 'close') => {
      const spec = claudeModelSupervisorSpec(op, live, root);
      return spawnSync(spec.executable, spec.args,
        { env: spec.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    };
    let clean = false;
    try {
      assert.equal(call('prepare').status, 0);
      assert.equal(parseClaudeModelSupervisorOutput(call('status').stdout, live)?.phase, 'prepared');
      const prelaunchRelease = claudeModelSupervisorSpec('release', live, root, undefined, {
        invocationId: 'a'.repeat(32),
        controlGroup: `/user.slice/user-${live.uid}.slice/user@${live.uid}.service/app.slice/${live.unitName}`,
      });
      assert.notEqual(spawnSync(prelaunchRelease.executable, prelaunchRelease.args,
        { env: prelaunchRelease.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 }).status, 0);
      assert.equal(call('close').status, 0);
      assert.equal(parseClaudeModelSupervisorOutput(call('status').stdout, live)?.closed, true);
      assert.notEqual(call('prepare').status, 0);
      clean = true;
    } finally {
      if (clean) {
        assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.json`]).status, 0);
        assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.lock`]).status, 0);
        assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
      }
    }
  });

test('real WSL rejects invalid or incomplete sealed startup before journal entry, including close race',
  { timeout: 45000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: readonly string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    for (const mode of ['bad-hash', 'truncated', 'close-partial'] as const) {
      const attemptId = `attempt_${randomUUID()}`;
      const livePaths = { ...paths, privateFifoDirectory: `/home/fixture/private/${attemptId}-1.mcp` };
      const live = { ...base, uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
        attemptId, unitName: `rcac-investigator-${randomUUID()}.service`,
        commandDigest: claudeModelCommandDigest(livePaths, profile, 3) };
      const root = `/home/fixture/model-config-reject-${attemptId}`;
      assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
      const call = (op: 'prepare' | 'status' | 'close') => {
        const spec = claudeModelSupervisorSpec(op, live, root);
        return spawnSync(spec.executable, spec.args,
          { env: spec.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
      };
      let child: ReturnType<typeof spawn> | undefined;
      let bridgeClosed = false; let safeCleanup = false;
      let stderr = '';
      const terminalEvidence = () => {
        const unit = run(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
          '--property=LoadState,ActiveState,MainPID,ControlGroup', live.unitName]);
        if (unit.status !== 0) return false;
        const values = Object.fromEntries(unit.stdout.trim().split(/\r?\n/).map(row => row.split('=', 2)));
        if (!['inactive', 'failed'].includes(values.ActiveState ?? '') &&
          values.LoadState !== 'not-found') return false;
        if (values.MainPID !== '0' || values.ControlGroup) return false;
        const group = `/user.slice/user-${live.uid}.slice/user@${live.uid}.service/app.slice/${live.unitName}`;
        const empty = run(['/usr/bin/python3', '-I', '-S', '-c',
          'import os,sys; p="/sys/fs/cgroup"+sys.argv[1]; assert not os.path.exists(p) or "populated 0" in open(p+"/cgroup.events").read().splitlines()', group]);
        return empty.status === 0;
      };
      try {
        assert.equal(call('prepare').status, 0);
        const spec = claudeModelSupervisorSpec('enter_wait_exec', live, root, livePaths,
          undefined, { maxWallSeconds: 12, maxTurns: 3 }, profile);
        assert.ok(spec.startupInput);
        child = spawn(spec.executable, [...spec.args],
          { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr!.on('data', (part: Buffer) => { stderr += part.toString('utf8'); });
        const exited = new Promise<number | null>(resolve => child!.once('close', code => {
          bridgeClosed = true; resolve(code);
        }));
        const input = Buffer.from(spec.startupInput);
        if (mode === 'bad-hash') {
          input[input.length - 1]! ^= 1;
          child.stdin!.write(input);
        } else if (mode === 'truncated') {
          child.stdin!.end(input.subarray(0, input.length - 1));
        } else {
          const split = input.indexOf(10) + 2;
          assert.ok(split > 1 && split < input.length);
          child.stdin!.write(input.subarray(0, split));
          assert.equal(call('close').status, 0);
          child.stdin!.end(input.subarray(split));
        }
        assert.notEqual(await Promise.race([exited,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 6000))]), null);
        const expectedError = mode === 'bad-hash' ? 'config body digest mismatch' :
          mode === 'truncated' ? 'truncated config input' : 'enter unavailable';
        assert.ok(stderr.includes(`ValueError: ${expectedError}`) ||
          mode === 'truncated' && stderr.includes(`EOFError: ${expectedError}`), stderr);
        const status = call('status');
        assert.equal(status.status, 0);
        const journal = parseClaudeModelSupervisorOutput(status.stdout, live);
        assert.equal(journal?.phase, 'prepared');
        assert.equal(journal.closed, mode === 'close-partial');
        if (!terminalEvidence()) {
          assert.equal(run(['/usr/bin/systemctl', '--user', 'stop', live.unitName]).status, 0);
          t.diagnostic(`Assisted exact-unit stop after ${mode}: ${live.unitName}`);
        }
        assert.equal(terminalEvidence(), true, `Exact unit/cgroup not terminal after ${mode}`);
        safeCleanup = true;
      } finally {
        if (child && !bridgeClosed) {
          child.kill();
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 1500);
            child!.once('close', () => { bridgeClosed = true; clearTimeout(timer); resolve(); });
          });
        }
        if (safeCleanup) {
          assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.json`]).status, 0);
          assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.lock`]).status, 0);
          assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
        } else t.diagnostic(`Retained unconfirmed sealed-config fixture: ${root}`);
      }
    }
  });

test('real WSL original unit enters, then close wins before prompt or model exec',
  { timeout: 20000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: readonly string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    const attemptId = `attempt_${randomUUID()}`;
    const livePaths = { ...paths, privateFifoDirectory: `/home/fixture/private/${attemptId}-1.mcp` };
    const live = { ...base, uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
      attemptId, unitName: `rcac-investigator-${randomUUID()}.service`,
      commandDigest: claudeModelCommandDigest(livePaths, profile, 3) };
    const root = `/home/fixture/model-gate-${attemptId}`;
    assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
    const call = (op: 'prepare' | 'status' | 'close') => {
      const spec = claudeModelSupervisorSpec(op, live, root);
      return spawnSync(spec.executable, spec.args,
        { env: spec.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    };
    let child: ReturnType<typeof spawn> | undefined;
    let closed = false;
    let safeCleanup = false;
    try {
      assert.equal(call('prepare').status, 0);
      const spec = claudeModelSupervisorSpec('enter_wait_exec', live, root, livePaths,
        undefined, { maxWallSeconds: 12, maxTurns: 3 }, profile);
      child = spawn(spec.executable, [...spec.args],
        { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin!.write(spec.startupInput);
      const closedPromise = new Promise<number | null>(resolve => child!.once('close', code => {
        closed = true; resolve(code);
      }));
      const deadline = Date.now() + 5000;
      let entered: ReturnType<typeof parseClaudeModelSupervisorOutput> = null;
      while (Date.now() < deadline) {
        const status = call('status');
        entered = status.status === 0 ? parseClaudeModelSupervisorOutput(status.stdout, live) : null;
        if (entered?.phase === 'entered') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(entered?.phase, 'entered');
      assert.equal(entered.closed, false);
      assert.equal(call('close').status, 0);
      assert.notEqual(await Promise.race([closedPromise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 4000))]), null);
      assert.equal(closed, true);
      assert.equal(parseClaudeModelSupervisorOutput(call('status').stdout, live)?.closed, true);
      const stop = run(['/usr/bin/systemctl', '--user', 'stop', live.unitName]);
      assert.equal(stop.status, 0);
      const absent = run(['/usr/bin/python3', '-I', '-S', '-c',
        'import os,sys; pid=int(sys.argv[1]); group=sys.argv[2]; assert not os.path.exists("/proc/%d"%pid); path="/sys/fs/cgroup"+group; assert not os.path.exists(path) or open(path+"/cgroup.events").read().split("populated ")[1][0]=="0"',
        String(entered.enterPid), entered.controlGroup!]);
      assert.equal(absent.status, 0, absent.stderr);
      safeCleanup = true;
    } finally {
      if (child && !closed) {
        child.kill();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1500);
          child!.once('close', () => { closed = true; clearTimeout(timer); resolve(); });
        });
      }
      if (safeCleanup) {
        assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.json`]).status, 0);
        assert.equal(run(['/usr/bin/unlink', `${root}/${live.attemptId}.model-supervisor.lock`]).status, 0);
        assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
      }
    }
  });

test('real WSL released original parent emits candidate startup then EOF closes consumed journal',
  { timeout: 30000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL fixture requires Windows'); return; }
    const prefix = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec'];
    const run = (args: readonly string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    const attemptId = `attempt_${randomUUID()}`;
    const unitName = `rcac-investigator-${randomUUID()}.service`;
    const root = `/home/fixture/rcac-model-bootstrap-${attemptId}`;
    const gateRoot = `${root}/gate`;
    const livePaths = { installRoot: `${root}/runtime`, nodeRoot: `${root}/node`,
      srtSettingsFile: `${root}/settings/srt.json`, mcpConfigFile: `${root}/settings/mcp.json`,
      helperFile: `${root}/settings/helper.py`, privateFifoDirectory: `${root}/${attemptId}-1.mcp`,
      privateAuthHome: `${root}/auth` };
    const live = { ...base, uid: Number(uid.stdout.trim()), bootId: boot.stdout.trim(),
      attemptId, unitName, commandDigest: claudeModelCommandDigest(livePaths, profile, 3) };
    const setup = String.raw`import os,sys
root,attempt=sys.argv[1:3]
os.mkdir(root,0o700)
for name in ('gate','runtime','runtime/node_modules','runtime/deps','node','settings','auth',attempt+'-1.mcp'):
 os.mkdir(root+'/'+name,0o700)
for name in ('in','out'): os.mkfifo(root+'/'+attempt+'-1.mcp/'+name,0o600)
for name,body in (('srt.json','{}'),('mcp.json','{}'),('helper.py','# synthetic')):
 with open(root+'/settings/'+name,'w',encoding='ascii') as target: target.write(body)
`;
    assert.equal(run(['/usr/bin/python3', '-I', '-S', '-c', setup, root, attemptId]).status, 0);
    const call = (op: 'prepare' | 'status' | 'close') => {
      const spec = claudeModelSupervisorSpec(op, live, gateRoot);
      return spawnSync(spec.executable, spec.args,
        { env: spec.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    };
    let child: ReturnType<typeof spawn> | undefined; let bridgeClosed = false; let safeCleanup = false;
    try {
      assert.equal(call('prepare').status, 0);
      const spec = claudeModelSupervisorSpec('enter_wait_exec', live, gateRoot, livePaths,
        undefined, { maxWallSeconds: 15, maxTurns: 3 }, profile);
      child = spawn(spec.executable, [...spec.args],
        { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin!.write(spec.startupInput);
      const exit = new Promise<number | null>(resolve => child!.once('close', code => {
        bridgeClosed = true; resolve(code);
      }));
      let entered: ReturnType<typeof parseClaudeModelSupervisorOutput> = null;
      const enterDeadline = Date.now() + 5000;
      while (Date.now() < enterDeadline) {
        const status = call('status');
        entered = status.status === 0 ? parseClaudeModelSupervisorOutput(status.stdout, live) : null;
        if (entered?.phase === 'entered') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(entered?.phase, 'entered');
      const release = claudeModelSupervisorSpec('release', live, gateRoot, undefined,
        { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! });
      assert.equal(spawnSync(release.executable, release.args,
        { env: release.env, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 }).status, 0);
      let afterStartup = Buffer.alloc(0);
      const startupLine = await new Promise<string>((resolve, reject) => {
        let bytes = Buffer.alloc(0); let found = false;
        const timer = setTimeout(() => reject(new Error('startup line timeout')), 6000);
        child!.stdout!.on('data', (part: Buffer) => {
          if (found) { afterStartup = Buffer.concat([afterStartup, part]); return; }
          bytes = Buffer.concat([bytes, part]);
          const newline = bytes.indexOf(10);
          if (bytes.length > 4096 || newline < 0) return;
          found = true;
          afterStartup = bytes.subarray(newline + 1);
          clearTimeout(timer); resolve(bytes.subarray(0, newline + 1).toString('utf8'));
        });
      });
      const startup = parseClaudeModelStartup(startupLine, live);
      assert.ok(startup);
      assert.equal(startup.journal.enterPid, entered.enterPid);
      assert.equal(startup.journal.phase, 'consumed');
      assert.notEqual(startup.outerCandidate.hostPid, entered.enterPid);
      assert.equal(parseClaudeModelSupervisorOutput(call('status').stdout, live)?.enterPid,
        entered.enterPid);
      child.stdin!.end(); // No frame: the unmodified bootstrap cannot reach SRT or Claude.
      assert.notEqual(await Promise.race([exit,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 6000))]), null);
      const closed = parseClaudeModelSupervisorOutput(call('status').stdout, live);
      assert.equal(closed?.phase, 'consumed');
      assert.equal(closed.closed, true);
      assert.equal(afterStartup.length, 0);
      assert.equal(run(['/usr/bin/systemctl', '--user', 'stop', unitName]).status, 0);
      const absent = run(['/usr/bin/python3', '-I', '-S', '-c',
        'import os,sys; pid=int(sys.argv[1]); outer=int(sys.argv[3]); group=sys.argv[2]; assert not os.path.exists("/proc/%d"%pid); assert not os.path.exists("/proc/%d"%outer); path="/sys/fs/cgroup"+group; assert not os.path.exists(path) or open(path+"/cgroup.events").read().split("populated ")[1][0]=="0"',
        String(entered.enterPid), entered.controlGroup!, String(startup.outerCandidate.hostPid)]);
      assert.equal(absent.status, 0, absent.stderr);
      t.diagnostic(JSON.stringify({ parent: { pid: entered.enterPid,
        startTicks: entered.enterStartTicks, absent: true },
      startup: { journalPhase: startup.journal.phase, journalClosed: startup.journal.closed,
        outer: startup.outerCandidate, ready: { pid: startup.bootstrapReady.pid,
          ppid: startup.bootstrapReady.ppid, startTicks: startup.bootstrapReady.startTicks,
          pidNamespace: startup.bootstrapReady.namespaces.pid } },
      afterEof: { phase: closed.phase, closed: closed.closed, originalAbsent: true,
        outerAbsent: true, savedGroupUnpopulated: true, stdoutAfterStartupBytes: afterStartup.length } }));
      safeCleanup = true;
    } finally {
      if (child && !bridgeClosed) {
        child.kill();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1500);
          child!.once('close', () => { bridgeClosed = true; clearTimeout(timer); resolve(); });
        });
      }
      if (safeCleanup) assert.equal(run(['/usr/bin/python3', '-I', '-S', '-c',
        'import os,re,shutil,stat,sys; p=sys.argv[1]; assert re.fullmatch(r"/home/fixture/rcac-model-bootstrap-attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",p); s=os.lstat(p); assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and os.path.realpath(p)==p; shutil.rmtree(p)', root]).status, 0);
    }
  });

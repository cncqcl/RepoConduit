import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { CLAUDE_MODEL_BOOTSTRAP_SHA256 } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import { buildClaudeModelSealedLaunch } from
  '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { observeClaudeModelOuterCandidate } from
  '../../src/adapters/secondary-investigator/claude-model-outer-probe.js';

const id = '11111111-1111-4111-8111-111111111111';
const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
  srtSettingsFile: '/home/fixture/config/srt.json', mcpConfigFile: '/home/fixture/config/mcp.json',
  helperFile: '/home/fixture/config/helper.py', privateAuthHome: '/home/fixture/auth',
  privateFifoDirectory: `/home/fixture/relay/attempt_${id}-1.mcp` };
const profile = { allowedDomains: [] };
const digest = buildClaudeModelSealedLaunch(paths, profile, 3).commandDigest;
const descriptor = { attemptId: `attempt_${id}`, workspaceId: `ws_${id}`,
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000, bootId: id,
  unitName: `rcac-investigator-${id}.service`, launchWorkerEpoch: 1,
  sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), commandDigest: digest };
const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${descriptor.unitName}`;

function input() {
  const journal = { protocol: 'claude_model_v1' as const, action: 'claude_model_v1' as const,
    phase: 'entered' as const, closed: false, attemptId: descriptor.attemptId,
    workspaceId: descriptor.workspaceId, bootId: descriptor.bootId, uid: descriptor.uid,
    unitName: descriptor.unitName, launchWorkerEpoch: 1, sourceDigest: descriptor.sourceDigest,
    profileDigest: descriptor.profileDigest, commandDigest: digest,
    invocationId: 'd'.repeat(32), controlGroup: group, enterPid: 200, enterStartTicks: 500 };
  const resource = { distro: descriptor.distro, uid: descriptor.uid, bootId: descriptor.bootId,
    unitName: descriptor.unitName, invocationId: journal.invocationId, controlGroup: group,
    gate: { protocol: 'attempt_gate_v1' as const, payloadKind: 'claude_model_v1' as const,
      linuxUser: 'fixture', root: `/home/fixture/attempt_${id}`,
      launch: { action: 'claude_model_v1' as const, workerEpoch: 1,
        sourceDigest: descriptor.sourceDigest, profileDigest: descriptor.profileDigest,
        commandDigest: digest } } };
  const startup = { protocol: 'claude_model_startup_v1' as const,
    kind: 'bootstrap_ready_candidate' as const,
    journal: { ...journal, phase: 'consumed' as const }, bootstrapSha256: CLAUDE_MODEL_BOOTSTRAP_SHA256,
    bwrapInfo: { 'child-pid': 202, 'cgroup-namespace': 1001, 'ipc-namespace': 1002,
      'mnt-namespace': 1003, 'pid-namespace': 1004, 'uts-namespace': 1005 },
    outerCandidate: { hostPid: 202, startTicks: 501, pidNamespace: 'pid:[1004]', nspid: [202, 1] },
    bootstrapReady: { protocol: 'claude_model_bootstrap_v1' as const, kind: 'ready' as const,
      pid: 2, ppid: 1, startTicks: 502,
      namespaces: { pid: 'pid:[1004]', mnt: 'mnt:[1003]', net: 'net:[1006]',
        user: 'user:[1007]', ipc: 'ipc:[1002]', uts: 'uts:[1005]', cgroup: 'cgroup:[1001]' },
      capEff: '0' as const, noNewPrivs: 1 as const } };
  const running = { kind: 'claude_model_running' as const, resource, journal,
    native: { bootId: id, uid: 1000, unitName: descriptor.unitName,
      invocationId: journal.invocationId, controlGroup: group,
      loadState: 'loaded' as const, activeState: 'active' as const,
      subState: 'running' as const, mainPid: 200, startTicks: 500, procControlGroup: group } };
  return { running, startup, descriptor: { ...descriptor }, paths: { ...paths },
    profile: { ...profile }, limits: {maxWallSeconds:20,maxTurns:3} };
}

function candidateProbe() {
  const mountinfo = '1 0 0:1 / / rw - tmpfs tmpfs rw\n';
  const namespaces = { pid:'pid:[1004]', mnt:'mnt:[1]', net:'net:[1]',
    user:'user:[1]', ipc:'ipc:[1]', uts:'uts:[1]', cgroup:'cgroup:[1]' };
  const unit = { Id:descriptor.unitName, LoadState:'loaded', ActiveState:'active',
    SubState:'running', MainPID:'200', InvocationID:'d'.repeat(32), ControlGroup:group };
  const selectedStatus = Object.fromEntries(['PPid','Uid','Gid','NSpid','CapInh','CapPrm',
    'CapEff','CapBnd','CapAmb','NoNewPrivs'].map(key => [key, '1']));
  const process = (pid:number, mounted:boolean) => ({ pid, ppid:1,
    startTicks:pid === 202 ? 501 : pid === 203 ? 502 : 500,
    state:'S', statRaw:'stat', statusRaw:'status', selectedStatus, namespaces,
    uidMap:'map', gidMap:'map', cgroup:group, exe:'/usr/bin/python3', cmdline:'cmd',
    cwd:'/', root:'/', fds:[], ...(mounted ? {mountinfoRaw:mountinfo,
      mountinfoRawAfter:mountinfo} : {}) });
  const processes = { parent: process(200,false), wrapper: process(201,false),
    outer: process(202,true), bootstrap: process(203,true) };
  const identity = (pid:number) => ({pid, ppid:1,
    startTicks:pid === 202 ? 501 : pid === 203 ? 502 : 500,
    state:'R', statRaw:'later stat', namespaces});
  const directory = { dev:1, ino:2, mode:0o40700, uid:1000, gid:1000 };
  const stat = { ...directory, nlink:1, size:1 };
  return {
    bootId: id, uid: 1000, observerNamespaces:namespaces, unitBefore:unit, unitAfter:unit,
    processes,
    sandboxPidView: {
      outer: {localPid:1,startTicks:501,pidNamespace:'pid:[1004]',statRaw:'1 (outer) S ...'},
      bootstrap: {localPid:2,startTicks:502,pidNamespace:'pid:[1004]',statRaw:'2 (bootstrap) S ...'},
    },
    sandboxPaths: {outer:{root:directory,cwd:directory},
      bootstrap:{root:directory,cwd:directory},work:directory,workEmpty:true},
    endingIdentities: {parent:identity(200),wrapper:identity(201),
      outer:identity(202),bootstrap:identity(203)},
    hostMountinfoRaw: mountinfo, hostMountinfoRawAfter: mountinfo,
    backingPaths: [], mountedFixedFiles: ['/opt/srt.json','/opt/mcp.json',
      '/opt/mcp-fifo.py','/opt/rcac-bootstrap.py'].map(target =>
      ({target,byteLength:1,sha256:'0'.repeat(64),stat})),
  };
}

async function observeFixture(probe: unknown) {
  return observeClaudeModelOuterCandidate(input(), async () => ({ exitCode: 0,
    stdout: Buffer.from(JSON.stringify(probe) + '\n'), stderr: Buffer.alloc(0) }));
}

test('rejects inconsistent original binding and recipe before invoking WSL runner', async () => {
  let calls = 0;
  const runner = async () => { calls++; throw new Error('unexpected I/O'); };
  const bad = input(); bad.startup.journal.closed = true;
  assert.deepEqual(await observeClaudeModelOuterCandidate(bad, runner), { kind: 'unconfirmed' });
  const changed = input(); changed.descriptor.commandDigest = '0'.repeat(64);
  assert.deepEqual(await observeClaudeModelOuterCandidate(changed, runner), { kind: 'unconfirmed' });
  const mixed = input(); mixed.startup.journal.enterStartTicks++;
  assert.deepEqual(await observeClaudeModelOuterCandidate(mixed, runner), { kind: 'unconfirmed' });
  const missingNative = input();
  (missingNative.running as {native?: unknown}).native = undefined;
  assert.deepEqual(await observeClaudeModelOuterCandidate(missingNative as never, runner),
    { kind: 'unconfirmed' });
  const nullNative = input();
  (nullNative.running as {native: unknown}).native = null;
  assert.deepEqual(await observeClaudeModelOuterCandidate(nullNative as never, runner),
    { kind: 'unconfirmed' });
  assert.equal(calls, 0);
});

test('validated candidate uses snapshots and fixed WSL read-only probe', async () => {
  const original = input();
  let release!: (value: {exitCode:number;stdout:Buffer;stderr:Buffer}) => void;
  const pending = new Promise<{exitCode:number;stdout:Buffer;stderr:Buffer}>(resolve => { release = resolve; });
  let args: readonly string[] = [];
  const observing = observeClaudeModelOuterCandidate(original, spec => {
    args = spec.args;
    return pending;
  });
  original.startup.outerCandidate.hostPid = 999;
  original.running.resource.gate!.launch!.commandDigest = '0'.repeat(64);
  assert.deepEqual(args.slice(0, 8), ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3']);
  assert.ok(args.includes('-I') && args.includes('-S') && args.includes('-c'));
  release({ exitCode: 0, stdout: Buffer.from(JSON.stringify(candidateProbe()) + '\n'),
    stderr: Buffer.alloc(0) });
  const result = await observing;
  assert.equal(result.kind, 'outer_probe_candidate');
  if (result.kind === 'outer_probe_candidate') {
    assert.equal(result.startup.outerCandidate.hostPid, 202);
    assert.equal(result.running.resource.gate!.launch!.commandDigest, digest);
  }
});

test('new identity and path observations are required in the closed candidate shape', async () => {
  const valid = candidateProbe();
  assert.equal((await observeFixture(valid)).kind, 'outer_probe_candidate');
  for (const key of ['sandboxPidView','sandboxPaths','endingIdentities'] as const) {
    const missing = structuredClone(valid) as Record<string, unknown>;
    delete missing[key];
    assert.deepEqual(await observeFixture(missing), {kind:'unconfirmed'}, key);
  }
  const wrongPid = structuredClone(valid);
  wrongPid.sandboxPidView.outer.localPid = 202;
  assert.deepEqual(await observeFixture(wrongPid), {kind:'unconfirmed'});
  const wrongWork = structuredClone(valid);
  wrongWork.sandboxPaths.workEmpty = false;
  assert.deepEqual(await observeFixture(wrongWork), {kind:'unconfirmed'});
  const wrongRoot = structuredClone(valid);
  wrongRoot.sandboxPaths.bootstrap.root = { ...wrongRoot.sandboxPaths.bootstrap.root,
    ino: wrongRoot.sandboxPaths.bootstrap.root.ino + 1 };
  assert.deepEqual(await observeFixture(wrongRoot), {kind:'unconfirmed'});
  const wrongEnding = structuredClone(valid);
  wrongEnding.endingIdentities.outer.startTicks++;
  assert.deepEqual(await observeFixture(wrongEnding), {kind:'unconfirmed'});
  const missingEnding = structuredClone(valid) as Record<string, unknown>;
  delete (missingEnding.endingIdentities as Record<string, unknown>).bootstrap;
  assert.deepEqual(await observeFixture(missingEnding), {kind:'unconfirmed'});
});

test('fixed Python helpers reject wrong sandbox PID and nonempty or changed work',
  { timeout: 10000 }, async () => {
    let source = '';
    await observeClaudeModelOuterCandidate(input(), async spec => {
      source = spec.args[11]!;
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const body = source.slice(source.indexOf('def path_stat('), source.indexOf('def fixed_files('));
    const script = `import types\n${body}
def raw(pid,ticks):
    return ('%d (case) S ' % pid + ' '.join(['1']*18+[str(ticks)]) + '\\n').encode()
samples={1:raw(1,501),2:raw(2,502)}
def bounded(path,limit):
    assert limit==4096
    return samples[int(path.split('/')[5])]
state={'empty':True,'same':True}
class Entries:
    def __enter__(self): return iter([] if state['empty'] else ['x'])
    def __exit__(self,*_): pass
def fake_stat(path):
    ino=2 if state['same'] or not path.endswith('/203/root') else 3
    return types.SimpleNamespace(st_dev=1,st_ino=ino,st_mode=0o40700,st_uid=1000,st_gid=1000)
os=types.SimpleNamespace(readlink=lambda path:'pid:[1004]',stat=fake_stat,
    scandir=lambda path:Entries())
check=lambda:None
utf8=lambda data:data.decode('utf-8','strict')
outer_pid=202
assert sandbox_pid(1,501,'pid:[1004]')['localPid']==1
assert sandbox_pid(2,502,'pid:[1004]')['startTicks']==502
for pid,ticks in ((1,502),(2,501)):
    try: sandbox_pid(pid,ticks,'pid:[1004]')
    except ValueError: pass
    else: raise AssertionError('wrong sandbox ticks accepted')
samples[1]=raw(9,501)
try: sandbox_pid(1,501,'pid:[1004]')
except ValueError: pass
else: raise AssertionError('wrong local PID accepted')
samples[1]=raw(1,501)
assert sandbox_paths(203)['workEmpty'] is True
state['empty']=False
try: sandbox_paths(203)
except ValueError: pass
else: raise AssertionError('nonempty work accepted')
state['empty']=True; state['same']=False
try: sandbox_paths(203)
except ValueError: pass
else: raise AssertionError('changed root accepted')
`;
    // Every OS operation in this extracted helper is replaced above. Exercise
    // its Python behavior locally, without a cold WSL boot or a native probe.
    const python=process.env.RCAC_TEST_PYTHON??(process.platform==='win32'?'python.exe':'python3');
    const checked = spawnSync(python,['-I','-S','-c',script],
      { timeout: 6000, maxBuffer: 4096 });
    assert.equal(checked.error, undefined);
    assert.equal(checked.status, 0, checked.stderr.toString());
  });

test('invalid UTF-8, oversized, malformed or nonzero probe output stays unconfirmed', async () => {
  const original = input();
  for (const output of [
    { exitCode: 0, stdout: Buffer.from([0xff, 0x0a]), stderr: Buffer.alloc(0) },
    { exitCode: 0, stdout: Buffer.alloc(256 * 1024 + 1), stderr: Buffer.alloc(0) },
    { exitCode: 0, stdout: Buffer.from('{}\n'), stderr: Buffer.alloc(0) },
    { exitCode: 1, stdout: Buffer.from('{}\n'), stderr: Buffer.alloc(0) },
  ]) assert.deepEqual(await observeClaudeModelOuterCandidate(original, async () => output),
    { kind: 'unconfirmed' });
});

test('fixed WSL collector source parses without invoking a model', { timeout: 10000 }, async t => {
  if (process.platform !== 'win32') { t.skip('WSL only'); return; }
  let source = '';
  await observeClaudeModelOuterCandidate(input(), async spec => {
    source = spec.args[11]!;
    return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  assert.ok(source.includes("'/proc/%d/mountinfo'"));
  const checked = spawnSync('C:\\Windows\\System32\\wsl.exe',
    ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3',
      '-I', '-S', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'],
    { input: Buffer.from(source, 'utf8'), timeout: 6000, maxBuffer: 4096 });
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, checked.stderr.toString());
});

test('Python collector reads short streams through EOF within bounds and deadline',
  { timeout: 10000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL only'); return; }
    let source = '';
    await observeClaudeModelOuterCandidate(input(), async spec => {
      source = spec.args[11]!;
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    assert.match(source, /data=bounded_fd\(fd,65536\)/);
    const body = source.slice(source.indexOf('def bounded('), source.indexOf('def utf8('));
    const script = `import types\n${body}
class Short:
    def __init__(self, data): self.data, self.pos = data, 0
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, count):
        result = self.data[self.pos:self.pos + min(count, 4005)]
        self.pos += len(result)
        return result
payload = b'x' * 4350
check = lambda: None
open = lambda *_args, **_kw: Short(payload)
assert bounded('/synthetic/mountinfo', 131072) == payload
os = types.SimpleNamespace(read=lambda fd, count: fd.read(count))
assert bounded_fd(Short(payload), 65536) == payload
open = lambda *_args, **_kw: Short(b'x' * 65537)
try: bounded('/oversize', 65536)
except ValueError: pass
else: raise AssertionError('path oversize accepted')
try: bounded_fd(Short(b'x' * 65537), 65536)
except ValueError: pass
else: raise AssertionError('fd oversize accepted')
def timed_out(): raise TimeoutError('outer probe deadline')
check = timed_out
try: bounded('/deadline', 65536)
except TimeoutError: pass
else: raise AssertionError('path deadline accepted')
try: bounded_fd(Short(payload), 65536)
except TimeoutError: pass
else: raise AssertionError('fd deadline accepted')
`;
    const checked = spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3',
        '-I', '-S', '-c', script], { timeout: 6000, maxBuffer: 4096 });
    assert.equal(checked.error, undefined);
    assert.equal(checked.status, 0, checked.stderr.toString());
  });

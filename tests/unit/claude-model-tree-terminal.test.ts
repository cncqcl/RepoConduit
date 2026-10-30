import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import type { ClaudeModelTerminalObservation } from
  '../../src/adapters/secondary-investigator/claude-model-terminal-observer.js';
import { observeClaudeModelTreeTerminal, validateClaudeModelTreeTerminal,
  claudeModelTreeSpec, type ClaudeModelTreeOuterAbsence,
  type ClaudeModelTreeTerminalObservation } from
  '../../src/adapters/secondary-investigator/claude-model-tree-terminal.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
function fixture(): ModelOuterConfinedFact {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  return { kind: 'model_outer_confined_v1', networkMode: 'host_shared_pre_srt',
    srtState: 'not_started', expectation: { descriptor: meta.descriptor, paths: meta.paths,
      profile: meta.profile, profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20 } },
    observation: { kind: 'outer_journal_candidate', journalAfter: meta.startup.journal,
      candidate: { kind: 'outer_probe_candidate', running: meta.running, startup: meta.startup,
        probe: JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8')) } } } as unknown as ModelOuterConfinedFact;
}
function closed(fact: ModelOuterConfinedFact) {
  return { ...fact.observation.journalAfter, closed: true };
}
function absence(fact: ModelOuterConfinedFact,
  signal: 'none' | 'pidfd_sigkill' = 'none'): ClaudeModelTreeOuterAbsence {
  const probe = fact.observation.candidate.probe;
  return { kind: 'outer_absent_v1', bootId: probe.bootId, uid: probe.uid,
    observerPidNamespace: probe.observerNamespaces.pid!,
    outerPid: probe.processes.outer.pid, outerStartTicks: probe.processes.outer.startTicks,
    outerPidNamespace: probe.processes.outer.namespaces.pid,
    processState: 'absent', signal };
}
function unit(fact: ModelOuterConfinedFact): Extract<ClaudeModelTerminalObservation,
  { kind: 'model_unit_terminal' }> {
  const running = fact.observation.candidate.running;
  const journal = closed(fact);
  return { kind: 'model_unit_terminal', resource: structuredClone(running.resource),
    journal, runningFact: structuredClone(running), native: {
      bootId: running.resource.bootId, uid: running.resource.uid,
      unitName: running.resource.unitName, invocationId: running.resource.invocationId!,
      controlGroup: running.resource.controlGroup!, loadState: 'loaded',
      activeState: 'inactive', subState: 'dead', mainPid: 0,
      originalPid: running.journal.enterPid!, originalStartTicks: running.journal.enterStartTicks!,
      processState: 'absent', cgroupState: 'empty',
    } };
}
function observation(fact: ModelOuterConfinedFact): Extract<ClaudeModelTreeTerminalObservation,
  { kind: 'model_tree_terminal_v1' }> {
  return { kind: 'model_tree_terminal_v1', outerBefore: absence(fact, 'pidfd_sigkill'),
    unitTerminal: unit(fact), outerAfter: absence(fact) };
}

test('validated deidentified outer fact and closed consumed unit bind a two-sided tree death sample', () => {
  const fact = fixture(); const observed = observation(fact);
  assert.equal(validateClaudeModelTreeTerminal(fact, observed), true);
  assert.equal(isDeepStrictEqual(fact, fixture()), true);
});

test('offline extracted tree terminal waits for zombie absence without signaling or accepting reuse', t => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const available = spawnSync(python, ['-I', '-S', '-c', 'print(1)'],
    { encoding: 'utf8', timeout: 2000 });
  if ((available.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    t.skip('local Python unavailable'); return;
  }
  assert.equal(available.status, 0, available.stderr);
  const source = readFileSync('src/adapters/secondary-investigator/claude-model-tree-terminal.ts',
    'utf8').replaceAll('\r\n', '\n');
  const script = source.split('const LINUX_OUTER_TERMINAL = String.raw`')[1]?.split('`;')[0];
  assert.ok(script);
  const identityStart = script.indexOf('def identity(role):');
  const identityEnd = script.indexOf('\nhost()\nsignal_state=', identityStart);
  const loopEnd = script.indexOf('\nhost()\nouter=', identityEnd);
  assert.ok(identityStart > 0 && identityEnd > identityStart && loopEnd > identityEnd);
  const extracted = script.slice(identityStart, loopEnd);
  const harness = String.raw`import io,json,os,signal,stat,sys,time,types
source,scenario=json.loads(sys.stdin.read())
for name in ('O_DIRECTORY','O_NOFOLLOW','O_CLOEXEC'):
 if not hasattr(os,name): setattr(os,name,0)
roles=[{'name':name,'pid':100+i,'ticks':200+i,'ns':'pid:[2]' if i==0 else 'pid:[1]',
        'nspid':[100+i,1] if i==0 else [100+i]} for i,name in enumerate(('outer','wrapper','parent'))]
uid=1000; boot='boot'; observer_ns='pid:[1]'; group='/owned'
mode='observe' if scenario.startswith('observe_') else 'terminate'
now=[0.0]; signals=[]; opens={}; next_fd=[10]
states={100:'S' if scenario=='observe_live' else
        ('X' if scenario=='exited_state' else 'Q' if scenario=='unknown_state' else 'Z'),
        101:'absent',102:'absent'}
def monotonic(): return now[0]
def sleep(duration):
 now[0]+=duration
 if scenario in ('z_then_absent','observe_z_then_absent'): states[100]='absent'
 if scenario=='reuse': states[100]='reused'
time.monotonic=monotonic; time.sleep=sleep
def open_fd(path,flags,dir_fd=None):
 pid=int(path.split('/')[-1]) if path.startswith('/proc/') else opens[dir_fd][0]
 if states[pid]=='absent': raise FileNotFoundError(path)
 fd=next_fd[0]; next_fd[0]+=1; opens[fd]=[pid,path,0]; return fd
def read_fd(fd,count):
 pid,name,pos=opens[fd]
 role=next(r for r in roles if r['pid']==pid)
 state=states[pid] if states[pid] in ('Z','X','Q') else 'S'
 ticks=role['ticks']+(1 if states[pid]=='reused' else 0)
 data={'stat':f"{pid} (fixture) {state} "+'0 '*18+str(ticks)+'\n',
       'status':f"Uid:\t{uid} {uid} {uid} {uid}\nNSpid:\t"+' '.join(map(str,role['nspid']))+'\n',
       'cgroup':'0::'+group+'\n'}[name].encode()
 opens[fd][2]+=len(data[pos:pos+count]); return data[pos:pos+count]
os.open=open_fd; os.read=read_fd; os.close=lambda fd:opens.pop(fd,None)
os.fstat=lambda fd:types.SimpleNamespace(st_mode=stat.S_IFREG)
os.pidfd_open=lambda pid,flags: 900+pid if states[pid]!='absent' else (_ for _ in ()).throw(ProcessLookupError())
def close_fd(fd):
 if fd<900: opens.pop(fd,None)
os.close=close_fd
os.readlink=lambda path,dir_fd=None: observer_ns if path=='/proc/self/ns/pid' else roles[opens[dir_fd][0]-100]['ns']
os.getuid=lambda:uid
def pidfd_signal(fd,sig,info,flags): signals.append(fd)
signal.pidfd_send_signal=pidfd_signal
def host(): pass
deadline=3.0
namespace=globals()
try:
 exec(source,namespace)
 result={'kind':'returned','signals':signals,'elapsed':now[0]}
except Exception as exc:
 result={'kind':type(exc).__name__,'message':str(exc),'signals':signals,'elapsed':now[0]}
print(json.dumps(result))
`;
  const run = (scenario: string) => {
    const result = spawnSync(python, ['-I', '-S', '-c', harness], { encoding: 'utf8', timeout: 2000,
      input: JSON.stringify([extracted, scenario]) });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as { kind: string; message?: string;
      signals: number[]; elapsed: number };
  };
  const cleared = run('z_then_absent');
  assert.equal(cleared.kind, 'returned', JSON.stringify(cleared));
  assert.deepEqual(cleared.signals, []);
  assert.ok(cleared.elapsed > 0 && cleared.elapsed <= 3);
  const persistent = run('persistent_z');
  assert.equal(persistent.kind, 'ValueError');
  assert.match(persistent.message!, /process present/);
  assert.deepEqual(persistent.signals, []);
  assert.ok(persistent.elapsed >= 3);
  const observed = run('observe_z_then_absent');
  assert.equal(observed.kind, 'returned', JSON.stringify(observed));
  assert.deepEqual(observed.signals, []);
  const observedLive = run('observe_live');
  assert.equal(observedLive.kind, 'ValueError');
  assert.match(observedLive.message!, /process present/);
  assert.deepEqual(observedLive.signals, []);
  const reused = run('reuse');
  assert.equal(reused.kind, 'ValueError');
  assert.match(reused.message!, /pid reused/);
  assert.deepEqual(reused.signals, []);
  for (const scenario of ['exited_state', 'unknown_state']) {
    const rejected = run(scenario);
    assert.equal(rejected.kind, 'ValueError');
    assert.match(rejected.message!, /process state/);
    assert.deepEqual(rejected.signals, []);
  }
});

test('wrong or incomplete outer identity, second sample, and unit history fail closed', () => {
  const changes: ((o: Extract<ClaudeModelTreeTerminalObservation,
    { kind: 'model_tree_terminal_v1' }>) => void)[] = [
    o => { o.outerBefore.outerPid++; },
    o => { o.outerBefore.outerStartTicks++; },
    o => { o.outerBefore.outerPidNamespace = o.outerBefore.observerPidNamespace; },
    o => { o.outerBefore.observerPidNamespace = 'pid:[9999]'; },
    o => { o.outerBefore.processState = 'zombie' as 'absent'; },
    o => { o.outerAfter.outerPid++; },
    o => { o.outerAfter.signal = 'pidfd_sigkill'; },
    o => { o.unitTerminal.journal.closed = false; },
    o => { o.unitTerminal.journal.enterStartTicks!++; },
    o => { o.unitTerminal.runningFact!.native.startTicks++; },
    o => { o.unitTerminal.native.cgroupState = 'populated' as 'empty'; },
    o => { o.unitTerminal.native.originalStartTicks++; },
    o => { o.unitTerminal.resource.unitName += '-other'; },
  ];
  for (const change of changes) {
    const fact = fixture(); const observed = observation(fact); change(observed);
    assert.equal(validateClaudeModelTreeTerminal(fact, observed), false);
  }
});

test('invalid historical fact and extra receipt fields fail closed', () => {
  const fact = fixture(); const observed = observation(fact);
  fact.observation.candidate.probe.processes.outer.startTicks++;
  assert.equal(validateClaudeModelTreeTerminal(fact, observed), false);
  const good = fixture(); const extra = observation(good);
  Object.assign(extra.outerAfter, { other: true });
  assert.equal(validateClaudeModelTreeTerminal(good, extra), false);
});

test('owner orders exact outer absence, existing unit terminal, second outer absence', async () => {
  const fact = fixture(); const sequence: string[] = [];
  const runner = async (spec: { args: readonly string[] }) => {
    const mode = spec.args.at(-1);
    sequence.push(`outer:${mode}`);
    return { exitCode: 0, stdout: JSON.stringify(absence(fact,
      mode === 'terminate' ? 'pidfd_sigkill' : 'none')) + '\n', stderr: '' };
  };
  const terminal = async () => {
    sequence.push('unit');
    return unit(fact);
  };
  const result = await observeClaudeModelTreeTerminal(fact, closed(fact), runner, terminal);
  assert.equal(result.kind, 'model_tree_terminal_v1');
  assert.deepEqual(sequence, ['outer:terminate', 'unit', 'outer:observe']);
});

test('wrong closed journal stops before any signal or unit probe', async () => {
  const fact = fixture(); let called = false;
  const wrong = { ...closed(fact), commandDigest: '0'.repeat(64) };
  const result = await observeClaudeModelTreeTerminal(fact, wrong,
    async () => { called = true; throw new Error('unexpected'); },
    async () => { called = true; throw new Error('unexpected'); });
  assert.deepEqual(result, { kind: 'unconfirmed' });
  assert.equal(called, false);
});

test('failed, reused, or zombie outer sample never grants terminal', async () => {
  for (const failed of ['reused', 'zombie', 'bridge_error']) {
    const fact = fixture(); let unitCalled = false;
    const result = await observeClaudeModelTreeTerminal(fact, closed(fact),
      async () => failed === 'bridge_error' ?
        { exitCode: 1, stdout: '', stderr: 'error' } :
        { exitCode: 0, stdout: JSON.stringify({ ...absence(fact),
          processState: failed }) + '\n', stderr: '' },
      async () => { unitCalled = true; return unit(fact); });
    assert.deepEqual(result, { kind: 'unconfirmed' }); assert.equal(unitCalled, false);
  }
});

test('fixed proc reader consumes to EOF under byte cap and uses pinned proc directory', () => {
  const fact = fixture(); const args = claudeModelTreeSpec(fact, 'terminate').args;
  const script = args[args.indexOf('-c') + 1]!;
  assert.match(script, /while len\(data\) <= limit:/);
  assert.match(script, /os\.readlink\('ns\/pid',dir_fd=directory\)/);
  assert.match(script, /os\.pidfd_open\(role\['pid'\],0\)/);
  assert.match(script, /signal\.pidfd_send_signal\(pidfd,signal\.SIGKILL,None,0\)/);
  assert.doesNotMatch(script, /\bos\.kill\s*\(|\bsubprocess\.run\s*\(/);
  const roles = JSON.parse(args.at(-3)!) as {name: string; pid: number; ticks: number;
    ns: string; nspid: number[]}[];
  assert.deepEqual(roles.map(r => r.name), ['outer','wrapper','parent']);
  for (const role of roles) {
    const historical = fact.observation.candidate.probe.processes[role.name as
      'outer'|'wrapper'|'parent'];
    assert.equal(role.pid, historical.pid);
    assert.equal(role.ticks, historical.startTicks);
    assert.equal(role.ns, historical.namespaces.pid);
  }
});

test('invalid historical identity never starts a fixed Linux probe', async () => {
  const fact = fixture(); const journal = closed(fact);
  fact.observation.candidate.probe.processes.wrapper.startTicks++;
  let invoked = false;
  const result = await observeClaudeModelTreeTerminal(fact, journal,
    async () => { invoked = true; throw new Error('unexpected'); },
    async () => { invoked = true; throw new Error('unexpected'); });
  assert.deepEqual(result, {kind:'unconfirmed'});
  assert.equal(invoked, false);
});

test('one original deadline bounds hanging outer and unit operations', async () => {
  const fact = fixture();
  const sleep = new Promise<void>(resolve => setTimeout(resolve, 250));
  const start = Date.now();
  const first = await observeClaudeModelTreeTerminal(fact, closed(fact),
    async () => new Promise(() => {}), async () => unit(fact), { deadlineMs: 30 });
  assert.deepEqual(first, { kind: 'unconfirmed' });
  assert.ok(Date.now() - start < 200);
  let outerCalls = 0;
  const second = await observeClaudeModelTreeTerminal(fact, closed(fact), async () => {
    outerCalls++;
    return { exitCode: 0, stdout: JSON.stringify(absence(fact)) + '\n', stderr: '' };
  }, async () => new Promise(() => {}), { deadlineMs: 30 });
  assert.deepEqual(second, { kind: 'unconfirmed' });
  assert.equal(outerCalls, 1);
  await sleep;
});

test('entry-time deadline expiration consumes late runner rejection', async () => {
  const fact = fixture();
  let rejectLater!: (error: Error) => void;
  const result = await observeClaudeModelTreeTerminal(fact, closed(fact),
    async () => {
      const pending = new Promise<never>((_, reject) => { rejectLater = reject; });
      const end = Date.now() + 20;
      while (Date.now() < end) { /* force original deadline to expire at call entry */ }
      return pending;
    }, async () => unit(fact), { deadlineMs: 1 });
  assert.deepEqual(result, {kind:'unconfirmed'});
  rejectLater(new Error('late bridge failure'));
  await new Promise<void>(resolve => setTimeout(resolve, 10));
});

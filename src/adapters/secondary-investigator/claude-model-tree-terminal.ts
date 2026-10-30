import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import { validateClaudeModelOuterFact, type ModelOuterConfinedFact } from
  './claude-model-outer-fact.js';
import { observeClaudeModelTerminal, type ClaudeModelTerminalObservation } from
  './claude-model-terminal-observer.js';
import type { ClaudeModelSupervisorState } from './claude-model-supervisor.js';

type UnitTerminal = Extract<ClaudeModelTerminalObservation, { kind: 'model_unit_terminal' }>;
export interface ClaudeModelTreeOuterAbsence {
  kind: 'outer_absent_v1'; bootId: string; uid: number; observerPidNamespace: string;
  outerPid: number; outerStartTicks: number; outerPidNamespace: string;
  processState: 'absent'; signal: 'none' | 'pidfd_sigkill';
}
export type ClaudeModelTreeTerminalObservation =
  | { kind: 'model_tree_terminal_v1'; outerBefore: ClaudeModelTreeOuterAbsence;
      unitTerminal: UnitTerminal; outerAfter: ClaudeModelTreeOuterAbsence }
  | { kind: 'unconfirmed' };
export interface ClaudeModelTreeSpec {
  executable: typeof WSL_EXECUTABLE; args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
}
export interface ClaudeModelTreeOutput { exitCode: number | null; stdout: string; stderr: string }
export type ClaudeModelTreeRunner = (spec: ClaudeModelTreeSpec) => Promise<ClaudeModelTreeOutput>;

const LINUX_OUTER_TERMINAL = String.raw`
import json, os, signal, stat, sys, time
boot, uid_text, observer_ns, roles_text, group, mode = sys.argv[1:7]
uid, roles = int(uid_text), json.loads(roles_text)
if (uid <= 0 or mode not in ('terminate','observe') or not isinstance(roles,list) or
    len(roles)!=3 or [r.get('name') for r in roles]!=['outer','wrapper','parent']):
    raise ValueError('arguments')
for role in roles:
    if (set(role)!={'name','pid','ticks','ns','nspid'} or
        type(role['pid']) is not int or role['pid']<=1 or
        type(role['ticks']) is not int or role['ticks']<=0 or
        type(role['ns']) is not str or role['nspid'] not in
        ([role['pid'],1] if role['name']=='outer' else [role['pid']],)):
        raise ValueError('role identity')
    if role['name']=='outer':
        if role['ns']==observer_ns: raise ValueError('outer namespace')
    elif role['ns']!=observer_ns: raise ValueError('host namespace')
if len({r['pid'] for r in roles})!=3: raise ValueError('duplicate pid')
deadline = time.monotonic() + 3
def read(path, limit):
    with open(path,'rb',buffering=0) as stream:
        data=bytearray()
        while len(data) <= limit:
            part=stream.read(limit+1-len(data))
            if not part: break
            data.extend(part)
    if len(data)>limit: raise ValueError('oversize')
    return bytes(data).decode('ascii','strict')
def host():
    if (read('/proc/sys/kernel/random/boot_id',128).strip()!=boot or os.getuid()!=uid or
        os.readlink('/proc/self/ns/pid')!=observer_ns): raise ValueError('observer identity')
def identity(role):
    pid,ticks=role['pid'],role['ticks']
    try: directory=os.open('/proc/%d'%pid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except FileNotFoundError: return 'absent'
    try:
        def item(name,limit):
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('proc type')
                data=bytearray()
                while len(data) <= limit:
                    part=os.read(fd,limit+1-len(data))
                    if not part: break
                    data.extend(part)
                if len(data)>limit: raise ValueError('proc oversize')
                return bytes(data).decode('ascii','strict')
            finally: os.close(fd)
        raw=item('stat',4096)
        if not raw.startswith(str(pid)+' (') or raw.count(')')<1: raise ValueError('stat')
        fields=raw[raw.rfind(')')+2:].split()
        if len(fields)<20 or not fields[19].isdigit(): raise ValueError('stat fields')
        if int(fields[19])!=ticks: raise ValueError('pid reused')
        if fields[0]=='Z': return 'pending'
        if fields[0] not in ('R','S','D','T','t','W','I'): raise ValueError('process state')
        lines=item('status',8192).splitlines()
        wanted={}
        for line in lines:
            key,sep,value=line.partition(':')
            if sep and key in ('Uid','NSpid'):
                if key in wanted: raise ValueError('duplicate status')
                wanted[key]=value.split()
        if wanted!={'Uid':[str(uid)]*4,'NSpid':[str(n) for n in role['nspid']]}:
            raise ValueError('outer status')
        if os.readlink('ns/pid',dir_fd=directory)!=role['ns']:
            raise ValueError('pid namespace')
        if item('cgroup',1024)!='0::'+group+'\n': raise ValueError('cgroup')
        return 'live'
    finally: os.close(directory)
host()
signal_state='none'
for role in roles:
    if mode=='terminate':
        try: pidfd=os.pidfd_open(role['pid'],0)
        except ProcessLookupError: pidfd=None
        if pidfd is not None:
            try:
                if identity(role)=='live':
                    signal.pidfd_send_signal(pidfd,signal.SIGKILL,None,0)
                    signal_state='pidfd_sigkill'
            finally: os.close(pidfd)
    while True:
        host()
        state=identity(role)
        if state=='absent': break
        if (mode=='observe' and state!='pending') or time.monotonic()>=deadline:
            raise ValueError('process present')
        time.sleep(.02)
host()
outer=roles[0]
sys.stdout.write(json.dumps({'kind':'outer_absent_v1','bootId':boot,'uid':uid,
    'observerPidNamespace':observer_ns,'outerPid':outer['pid'],
    'outerStartTicks':outer['ticks'],'outerPidNamespace':outer['ns'],
    'processState':'absent','signal':signal_state},
    separators=(',',':'))+'\n')
`;

const absent = { kind: 'unconfirmed' } as const;
const exact = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

function validClosed(fact: ModelOuterConfinedFact, journal: ClaudeModelSupervisorState): boolean {
  return journal?.phase === 'consumed' && journal.closed === true &&
    isDeepStrictEqual(journal, { ...fact.observation.journalAfter, closed: true });
}

function validOuter(fact: ModelOuterConfinedFact, value: ClaudeModelTreeOuterAbsence,
  allowSignal: boolean): boolean {
  const probe = fact.observation.candidate.probe;
  const outer = probe.processes.outer;
  return !!value && exact(value, ['kind','bootId','uid','observerPidNamespace','outerPid',
    'outerStartTicks','outerPidNamespace','processState','signal']) &&
    value.kind === 'outer_absent_v1' && value.bootId === probe.bootId &&
    value.uid === probe.uid && value.observerPidNamespace === probe.observerNamespaces.pid &&
    value.outerPid === outer.pid && value.outerStartTicks === outer.startTicks &&
    value.outerPidNamespace === outer.namespaces.pid &&
    value.outerPidNamespace !== value.observerPidNamespace &&
    value.processState === 'absent' &&
    (value.signal === 'none' || allowSignal && value.signal === 'pidfd_sigkill');
}

function validUnit(fact: ModelOuterConfinedFact, unit: UnitTerminal): boolean {
  const running = fact.observation.candidate.running;
  if (!unit || !exact(unit, ['kind','resource','journal','runningFact','native']) ||
      unit.kind !== 'model_unit_terminal' ||
      !isDeepStrictEqual(unit.resource, running.resource) ||
      !isDeepStrictEqual(unit.runningFact, running) || !validClosed(fact, unit.journal)) return false;
  const n = unit.native; const resource = running.resource;
  if (!n || !exact(n, ['bootId','uid','unitName','invocationId','controlGroup','loadState',
    'activeState','subState','mainPid','originalPid','originalStartTicks','processState',
    'cgroupState']) || n.bootId !== resource.bootId || n.uid !== resource.uid ||
    n.unitName !== resource.unitName || n.mainPid !== 0 ||
    n.originalPid !== running.journal.enterPid ||
    n.originalStartTicks !== running.journal.enterStartTicks ||
    n.processState !== 'absent' || !['empty','absent'].includes(n.cgroupState)) return false;
  return n.loadState === 'loaded' && n.invocationId === resource.invocationId &&
    (n.controlGroup === resource.controlGroup || n.controlGroup === '') &&
    (n.activeState === 'inactive' && n.subState === 'dead' ||
      n.activeState === 'failed' && n.subState === 'failed') ||
    n.loadState === 'not-found' && n.invocationId === '' && n.controlGroup === '' &&
    n.activeState === 'inactive' && n.subState === 'dead';
}

/** Historical terminal sample only. Current owner, slot release and outcome remain separate. */
export function validateClaudeModelTreeTerminal(fact: ModelOuterConfinedFact,
  observation: ClaudeModelTreeTerminalObservation): boolean {
  try {
    const saved = structuredClone({ fact, observation });
    const o = saved.observation;
    return validateClaudeModelOuterFact(saved.fact) && o.kind === 'model_tree_terminal_v1' &&
      exact(o, ['kind','outerBefore','unitTerminal','outerAfter']) &&
      validOuter(saved.fact, o.outerBefore, true) && validUnit(saved.fact, o.unitTerminal) &&
      validOuter(saved.fact, o.outerAfter, false);
  } catch { return false; }
}

export function claudeModelTreeSpec(fact: ModelOuterConfinedFact,
  mode: 'terminate' | 'observe'): ClaudeModelTreeSpec {
  if (!validateClaudeModelOuterFact(fact) || !['terminate','observe'].includes(mode))
    throw new Error('INVALID_ARGUMENT');
  const p = fact.observation.candidate.probe;
  const outer = p.processes.outer;
  const running = fact.observation.candidate.running;
  return { executable: WSL_EXECUTABLE,
    args: ['-d', running.resource.distro, '--user', running.resource.gate!.linuxUser,
      '--cd', '/', '--exec', '/usr/bin/python3', '-I', '-S', '-c', LINUX_OUTER_TERMINAL,
      p.bootId, String(p.uid), p.observerNamespaces.pid!, JSON.stringify([
        { name: 'outer', pid: outer.pid, ticks: outer.startTicks,
          ns: outer.namespaces.pid, nspid: [outer.pid, 1] },
        { name: 'wrapper', pid: p.processes.wrapper.pid,
          ticks: p.processes.wrapper.startTicks, ns: p.processes.wrapper.namespaces.pid,
          nspid: [p.processes.wrapper.pid] },
        { name: 'parent', pid: p.processes.parent.pid,
          ticks: p.processes.parent.startTicks, ns: p.processes.parent.namespaces.pid,
          nspid: [p.processes.parent.pid] }]), running.resource.controlGroup!, mode],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } };
}

type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean; unref(): void };
function readChild(child: BoundedChild): Promise<ClaudeModelTreeOutput> {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let bytes = 0; let finished = false; let failed = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); if (grace) clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy(); if (code === null) child.unref();
      resolve({ exitCode: failed ? null : code, stdout, stderr });
    };
    const fail = () => {
      if (finished || failed) return;
      failed = true;
      try { child.kill(); } catch { /* Windows bridge death is not Linux terminal proof. */ }
      grace = setTimeout(() => finish(null), 500);
    };
    const timer = setTimeout(fail, 3500);
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length; if (bytes > 2048) { fail(); return; }
      stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => {
      bytes += part.length; if (bytes > 2048) { fail(); return; }
      stderr += part.toString('utf8');
    });
    child.stdout.on('error', fail); child.stderr.on('error', fail); child.on('error', fail);
    child.on('close', finish);
  });
}
export function runClaudeModelTreeProbe(spec: ClaudeModelTreeSpec): Promise<ClaudeModelTreeOutput> {
  const child = spawn(spec.executable, [...spec.args],
    { env: spec.env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  return readChild(child);
}

async function withinDeadline<T>(pending: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    // The caller has already started the bridge; consume a late rejection.
    void pending.catch(() => undefined);
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), remaining);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function sample(fact: ModelOuterConfinedFact, mode: 'terminate' | 'observe',
  runner: ClaudeModelTreeRunner, deadline: number): Promise<ClaudeModelTreeOuterAbsence | null> {
  let result: ClaudeModelTreeOutput | undefined;
  try {
    const pending = runner(claudeModelTreeSpec(fact, mode));
    result = await withinDeadline(pending, deadline);
  } catch { return null; }
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
      result.stderr !== '' || Buffer.byteLength(result.stdout) > 2048 ||
      !result.stdout.endsWith('\n') || result.stdout.indexOf('\n') !== result.stdout.length - 1)
    return null;
  try {
    const parsed = JSON.parse(result.stdout) as ClaudeModelTreeOuterAbsence;
    return validOuter(fact, parsed, mode === 'terminate') ? parsed : null;
  } catch { return null; }
}

/** Only a validated historical outer fact and exact closed journal can trigger a pidfd signal. */
export async function observeClaudeModelTreeTerminal(fact: ModelOuterConfinedFact,
  closedJournal: ClaudeModelSupervisorState,
  runner: ClaudeModelTreeRunner = runClaudeModelTreeProbe,
  terminalObserver: typeof observeClaudeModelTerminal = observeClaudeModelTerminal,
  options: { deadlineMs?: number } = {}):
  Promise<ClaudeModelTreeTerminalObservation> {
  let savedFact: ModelOuterConfinedFact; let savedJournal: ClaudeModelSupervisorState;
  try { savedFact = structuredClone(fact); savedJournal = structuredClone(closedJournal); }
  catch { return absent; }
  if (!validateClaudeModelOuterFact(savedFact) || !validClosed(savedFact, savedJournal)) return absent;
  const maxMs = options.deadlineMs ?? 15000;
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 15000) return absent;
  const deadline = performance.now() + maxMs;
  const before = await sample(savedFact, 'terminate', runner, deadline);
  if (!before || performance.now() >= deadline) return absent;
  const running = savedFact.observation.candidate.running;
  let unit: ClaudeModelTerminalObservation | undefined;
  try { unit = structuredClone(await withinDeadline(terminalObserver(running.resource, savedJournal,
    savedFact.expectation.descriptor, running), deadline)); }
  catch { return absent; }
  if (!unit || unit.kind !== 'model_unit_terminal' || !validUnit(savedFact, unit) ||
      performance.now() >= deadline) return absent;
  const after = await sample(savedFact, 'observe', runner, deadline);
  if (!after || performance.now() >= deadline) return absent;
  const observation: ClaudeModelTreeTerminalObservation =
    { kind: 'model_tree_terminal_v1', outerBefore: before, unitTerminal: unit, outerAfter: after };
  return validateClaudeModelTreeTerminal(savedFact, observation) ? observation : absent;
}

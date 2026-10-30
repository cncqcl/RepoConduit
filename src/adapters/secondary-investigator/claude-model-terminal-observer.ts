import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import type { WslResource } from '../storage/investigation-sqlite.js';
import { claudeModelSupervisorSpec, parseClaudeModelSupervisorOutput,
  type ClaudeModelSupervisorDescriptor, type ClaudeModelSupervisorState } from './claude-model-supervisor.js';
import { claudeModelRunningSpec, type ClaudeModelRunningObservation } from './claude-model-running-observer.js';

export type ClaudeModelTerminalNativeState = {
  bootId: string; uid: number; unitName: string; invocationId: string; controlGroup: string;
  loadState: 'loaded' | 'not-found'; activeState: 'inactive' | 'failed';
  subState: 'dead' | 'failed'; mainPid: 0; originalPid: number;
  originalStartTicks: number; processState: 'absent'; cgroupState: 'empty' | 'absent';
};
export type ClaudeModelTerminalObservation =
  | { kind: 'model_unit_terminal'; resource: WslResource; journal: ClaudeModelSupervisorState;
    runningFact?: Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }>;
    native: ClaudeModelTerminalNativeState }
  | { kind: 'unconfirmed' };
export interface ClaudeModelTerminalSpec {
  executable: typeof WSL_EXECUTABLE; args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
}
export interface ClaudeModelTerminalOutput { exitCode: number | null; stdout: string; stderr: string }
export type ClaudeModelTerminalRunner = (spec: ClaudeModelTerminalSpec) => Promise<ClaudeModelTerminalOutput>;

// Fixed unit-only observation. PID absence and the saved cgroup are checked
// independently even when systemd has cleared ControlGroup or unloaded the unit.
const LINUX_TERMINAL_OBSERVER = String.raw`
import json, os, stat, subprocess, sys
unit, saved_group, expected_inv, pid_text, ticks_text = sys.argv[1:6]
pid, ticks = int(pid_text), int(ticks_text)
if pid <= 0 or ticks <= 0: raise ValueError('original process identity')
def show():
    p = subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup',unit],
        capture_output=True,timeout=2,check=True)
    if p.stderr or len(p.stdout)>2048: raise ValueError('show output')
    fields={}
    for line in p.stdout.decode('ascii').splitlines():
        key,sep,value=line.partition('=')
        if not sep or key in fields: raise ValueError('show field')
        fields[key]=value
    if fields.keys()!={'Id','LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup'} or fields['Id']!=unit:
        raise ValueError('show fields')
    loaded=(fields['LoadState']=='loaded' and fields['ActiveState'] in ('inactive','failed') and
            (fields['ActiveState'],fields['SubState']) in (('inactive','dead'),('failed','failed')) and
            fields['MainPID']=='0' and fields['InvocationID']==expected_inv and
            fields['ControlGroup'] in (saved_group,''))
    unloaded=(fields=={'Id':unit,'LoadState':'not-found','ActiveState':'inactive',
        'SubState':'dead','MainPID':'0','InvocationID':'','ControlGroup':''})
    if not loaded and not unloaded: raise ValueError('unit not terminal')
    return fields
def process_absent():
    try: directory=os.open('/proc/%d'%pid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except FileNotFoundError: return
    try:
        fd=os.open('stat',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('proc stat type')
            raw=os.read(fd,4096).decode('ascii')
            if len(raw)>=4096 or not raw.startswith(str(pid)+' ('): raise ValueError('proc stat format')
            fields=raw[raw.rfind(')')+2:].split()
            if len(fields)<20: raise ValueError('proc stat fields')
            if int(fields[19])==ticks: raise ValueError('original process alive')
            raise ValueError('pid reused')
        finally: os.close(fd)
    finally: os.close(directory)
def group_state():
    fd=os.open('/sys/fs/cgroup',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        device=os.fstat(fd).st_dev
        with open('/proc/self/mountinfo',encoding='ascii') as source:
            rows=[line.strip().split(' - ',1) for line in source]
        matches=[]
        for row in rows:
            if len(row)!=2: raise ValueError('mountinfo format')
            left,right=row; fields,fs=left.split(),right.split()
            if len(fields)<5 or len(fs)<1: raise ValueError('mountinfo fields')
            if fields[4]=='/sys/fs/cgroup': matches.append((fields,fs))
        if len(matches)!=1: raise ValueError('cgroup mount count')
        fields,fs=matches[0]
        if fields[3]!='/' or fs[0]!='cgroup2' or fields[2]!='%s:%s'%(os.major(device),os.minor(device)):
            raise ValueError('not cgroup v2 root')
        for component in saved_group.split('/')[1:]:
            try: next_fd=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            except FileNotFoundError: return 'absent'
            os.close(fd); fd=next_fd
        def read(name):
            item=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            try: return os.read(item,1024)
            finally: os.close(item)
        events=read('cgroup.events').decode('ascii').splitlines()
        values=dict(line.split(' ',1) for line in events)
        procs=read('cgroup.procs')
        if values.get('populated') not in ('0','1') or len(procs)>=1024: raise ValueError('cgroup fields')
        if values['populated']!='0' or procs.strip(): raise ValueError('populated group')
        return 'empty'
    finally: os.close(fd)
boot=open('/proc/sys/kernel/random/boot_id',encoding='ascii').read().strip(); uid=os.getuid()
first=show(); process_absent(); group=group_state(); process_absent(); second=show()
if first!=second or boot!=open('/proc/sys/kernel/random/boot_id',encoding='ascii').read().strip() or uid!=os.getuid():
    raise ValueError('host identity changed')
sys.stdout.write(json.dumps({'bootId':boot,'uid':uid,'unitName':unit,
    'invocationId':second['InvocationID'],'controlGroup':second['ControlGroup'],
    'loadState':second['LoadState'],'activeState':second['ActiveState'],'subState':second['SubState'],
    'mainPid':0,'originalPid':pid,'originalStartTicks':ticks,'processState':'absent',
    'cgroupState':group},separators=(',',':'))+'\n')
`;

function baseMatches(resource: WslResource, journal: ClaudeModelSupervisorState,
  descriptor: ClaudeModelSupervisorDescriptor): boolean {
  const gate = resource?.gate; const launch = gate?.launch;
  if (!gate || Object.keys(gate).sort().join(',') !== 'launch,linuxUser,payloadKind,protocol,root' ||
    gate.protocol !== 'attempt_gate_v1' || gate.payloadKind !== 'claude_model_v1' ||
    !launch || Object.keys(launch).sort().join(',') !==
      'action,commandDigest,profileDigest,sourceDigest,workerEpoch' ||
    launch.action !== 'claude_model_v1' || !journal || !descriptor ||
    journal.protocol !== 'claude_model_v1' || journal.action !== 'claude_model_v1' ||
    !journal.closed || !['entered','released','consumed'].includes(journal.phase) ||
    resource.distro !== descriptor.distro || resource.uid !== descriptor.uid ||
    resource.bootId !== descriptor.bootId || resource.unitName !== descriptor.unitName ||
    gate.linuxUser !== descriptor.linuxUser ||
    launch.workerEpoch !== descriptor.launchWorkerEpoch ||
    launch.sourceDigest !== descriptor.sourceDigest ||
    launch.profileDigest !== descriptor.profileDigest ||
    launch.commandDigest !== descriptor.commandDigest ||
    journal.attemptId !== descriptor.attemptId || journal.workspaceId !== descriptor.workspaceId ||
    journal.bootId !== descriptor.bootId || journal.uid !== descriptor.uid ||
    journal.unitName !== descriptor.unitName ||
    journal.launchWorkerEpoch !== descriptor.launchWorkerEpoch ||
    journal.sourceDigest !== descriptor.sourceDigest ||
    journal.profileDigest !== descriptor.profileDigest ||
    journal.commandDigest !== descriptor.commandDigest ||
    journal.invocationId !== resource.invocationId ||
    journal.controlGroup !== resource.controlGroup ||
    !Number.isSafeInteger(journal.enterPid) || (journal.enterPid ?? 0) <= 0 ||
    !Number.isSafeInteger(journal.enterStartTicks) || (journal.enterStartTicks ?? 0) <= 0) return false;
  try { claudeModelSupervisorSpec('status', descriptor, gate.root); }
  catch { return false; }
  return parseClaudeModelSupervisorOutput(JSON.stringify(journal) + '\n', descriptor) !== null;
}

function historicalMatches(resource: WslResource, journal: ClaudeModelSupervisorState,
  descriptor: ClaudeModelSupervisorDescriptor,
  fact: ClaudeModelRunningObservation | null | undefined): fact is Extract<ClaudeModelRunningObservation,
  { kind: 'claude_model_running' }> {
  if (fact?.kind !== 'claude_model_running') return false;
  const saved = fact.resource; const entered = fact.journal; const native = fact.native;
  try { claudeModelRunningSpec(saved, entered, descriptor); }
  catch { return false; }
  const launch = resource.gate!.launch!;
  const savedLaunch = saved.gate!.launch!;
  const nativeKeys = ['bootId','uid','unitName','invocationId','controlGroup',
    'loadState','activeState','subState','mainPid','startTicks','procControlGroup'];
  return Object.keys(native).length === nativeKeys.length &&
    nativeKeys.every(key => key in native) &&
    saved.unitName === resource.unitName && saved.distro === resource.distro &&
    saved.uid === resource.uid && saved.bootId === resource.bootId &&
    saved.invocationId === resource.invocationId && saved.controlGroup === resource.controlGroup &&
    saved.gate!.linuxUser === resource.gate!.linuxUser && saved.gate!.root === resource.gate!.root &&
    savedLaunch.workerEpoch === launch.workerEpoch &&
    savedLaunch.sourceDigest === launch.sourceDigest &&
    savedLaunch.profileDigest === launch.profileDigest &&
    savedLaunch.commandDigest === launch.commandDigest &&
    entered.attemptId === journal.attemptId && entered.workspaceId === journal.workspaceId &&
    entered.bootId === journal.bootId && entered.uid === journal.uid &&
    entered.unitName === journal.unitName &&
    entered.launchWorkerEpoch === journal.launchWorkerEpoch &&
    entered.sourceDigest === journal.sourceDigest &&
    entered.profileDigest === journal.profileDigest &&
    entered.commandDigest === journal.commandDigest &&
    entered.invocationId === journal.invocationId && entered.controlGroup === journal.controlGroup &&
    entered.enterPid === journal.enterPid && entered.enterStartTicks === journal.enterStartTicks &&
    native.bootId === resource.bootId && native.uid === resource.uid &&
    native.unitName === resource.unitName && native.invocationId === resource.invocationId &&
    native.controlGroup === resource.controlGroup && native.loadState === 'loaded' &&
    native.activeState === 'active' && native.subState === 'running' &&
    native.mainPid === journal.enterPid && native.startTicks === journal.enterStartTicks &&
    native.procControlGroup === resource.controlGroup;
}

export function claudeModelTerminalSpec(resource: WslResource, journal: ClaudeModelSupervisorState,
  descriptor: ClaudeModelSupervisorDescriptor): ClaudeModelTerminalSpec {
  if (!baseMatches(resource, journal, descriptor)) throw new Error('INVALID_ARGUMENT');
  return { executable: WSL_EXECUTABLE,
    args: ['-d', resource.distro, '--user', resource.gate!.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', LINUX_TERMINAL_OBSERVER, resource.unitName,
      resource.controlGroup!, resource.invocationId!, String(journal.enterPid),
      String(journal.enterStartTicks)],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } };
}

type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean; unref(): void };
export function readClaudeModelTerminalChild(child: BoundedChild,
  timeoutMs = 7000): Promise<ClaudeModelTerminalOutput> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7000)
    throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let bytes = 0; let failed = false; let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); if (grace) clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy(); if (code === null) child.unref();
      resolve({ exitCode: failed ? null : code, stdout, stderr });
    };
    const fail = () => {
      if (failed || finished) return;
      failed = true;
      try { child.kill(); } catch { /* No Linux terminal inference. */ }
      grace = setTimeout(() => finish(null), 1000);
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length; if (bytes > 4096) { fail(); return; }
      stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => {
      bytes += part.length; if (bytes > 4096) { fail(); return; }
      stderr += part.toString('utf8');
    });
    child.stdout.on('error', fail); child.stderr.on('error', fail); child.on('error', fail);
    child.on('close', finish);
  });
}

export function runClaudeModelTerminalProbe(spec: ClaudeModelTerminalSpec): Promise<ClaudeModelTerminalOutput> {
  const child = spawn(spec.executable, [...spec.args],
    { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return readClaudeModelTerminalChild(child);
}

export async function observeClaudeModelTerminal(resource: WslResource,
  journal: ClaudeModelSupervisorState, descriptor: ClaudeModelSupervisorDescriptor,
  runningFact?: ClaudeModelRunningObservation | null,
  runner: ClaudeModelTerminalRunner = runClaudeModelTerminalProbe): Promise<ClaudeModelTerminalObservation> {
  let savedResource: WslResource; let savedJournal: ClaudeModelSupervisorState;
  let savedDescriptor: ClaudeModelSupervisorDescriptor;
  let savedFact: ClaudeModelRunningObservation | null | undefined;
  try {
    savedResource = structuredClone(resource); savedJournal = structuredClone(journal);
    savedDescriptor = structuredClone(descriptor); savedFact = structuredClone(runningFact);
  } catch { return { kind: 'unconfirmed' }; }
  if (!baseMatches(savedResource, savedJournal, savedDescriptor) ||
    (savedJournal.phase === 'consumed' && !savedFact) ||
    (savedFact && !historicalMatches(savedResource, savedJournal, savedDescriptor, savedFact)))
    return { kind: 'unconfirmed' };
  let result: ClaudeModelTerminalOutput;
  try { result = await runner(claudeModelTerminalSpec(savedResource, savedJournal, savedDescriptor)); }
  catch { return { kind: 'unconfirmed' }; }
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096 ||
    !result.stdout.endsWith('\n')) return { kind: 'unconfirmed' };
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { return { kind: 'unconfirmed' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unconfirmed' };
  const value = parsed as Record<string, unknown>;
  const keys = ['bootId','uid','unitName','invocationId','controlGroup','loadState',
    'activeState','subState','mainPid','originalPid','originalStartTicks','processState','cgroupState'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value)) ||
    value.bootId !== savedResource.bootId || value.uid !== savedResource.uid ||
    value.unitName !== savedResource.unitName || value.mainPid !== 0 ||
    value.originalPid !== savedJournal.enterPid ||
    value.originalStartTicks !== savedJournal.enterStartTicks ||
    value.processState !== 'absent' ||
    (value.cgroupState !== 'absent' && value.cgroupState !== 'empty'))
    return { kind: 'unconfirmed' };
  const loaded = value.loadState === 'loaded' &&
    value.invocationId === savedResource.invocationId &&
    (value.controlGroup === savedResource.controlGroup || value.controlGroup === '') &&
    (value.activeState === 'inactive' && value.subState === 'dead' ||
      value.activeState === 'failed' && value.subState === 'failed');
  const unloaded = value.loadState === 'not-found' && value.activeState === 'inactive' &&
    value.subState === 'dead' && value.invocationId === '' && value.controlGroup === '';
  if (!loaded && !unloaded) return { kind: 'unconfirmed' };
  return { kind: 'model_unit_terminal', resource: savedResource, journal: savedJournal,
    ...(savedFact?.kind === 'claude_model_running' ? { runningFact: savedFact } : {}),
    native: value as unknown as ClaudeModelTerminalNativeState };
}

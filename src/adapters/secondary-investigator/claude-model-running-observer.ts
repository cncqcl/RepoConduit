import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { WSL_EXECUTABLE } from '../codex/investigator/preflight.js';
import type { WslResource } from '../storage/investigation-sqlite.js';
import { claudeModelSupervisorSpec, parseClaudeModelSupervisorOutput,
  type ClaudeModelSupervisorDescriptor,
  type ClaudeModelSupervisorState } from './claude-model-supervisor.js';

export interface ClaudeModelRunningNativeState {
  bootId: string; uid: number; unitName: string; invocationId: string; controlGroup: string;
  loadState: 'loaded'; activeState: 'active'; subState: 'running';
  mainPid: number; startTicks: number; procControlGroup: string;
}
export type ClaudeModelRunningObservation =
  | { kind: 'claude_model_running'; resource: WslResource;
    journal: ClaudeModelSupervisorState; native: ClaudeModelRunningNativeState }
  | { kind: 'unconfirmed' };
export interface ClaudeModelRunningSpec {
  executable: typeof WSL_EXECUTABLE;
  args: readonly string[];
  env: Readonly<Record<'SystemRoot' | 'PATH', string>>;
}
export interface ClaudeModelRunningOutput { exitCode: number | null; stdout: string; stderr: string }
export type ClaudeModelRunningRunner =
  (spec: ClaudeModelRunningSpec) => Promise<ClaudeModelRunningOutput>;

// Two fixed systemctl reads bracket the original PID/cgroup checks. This is
// a bounded observation, not a terminal or release receipt.
const LINUX_RUNNING_OBSERVER = String.raw`
import json, os, subprocess, sys
unit, expected_group, expected_inv, expected_pid, expected_ticks = sys.argv[1:6]
expected_pid, expected_ticks = int(expected_pid), int(expected_ticks)
def show():
    p = subprocess.run(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup', unit],
        capture_output=True, timeout=2, check=True)
    if p.stderr or len(p.stdout) > 2048: raise ValueError('show output')
    fields = {}
    for line in p.stdout.decode('ascii').splitlines():
        key, sep, value = line.partition('=')
        if not sep or key in fields: raise ValueError('show field')
        fields[key] = value
    if fields.keys() != {'Id','LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup'}:
        raise ValueError('show fields')
    if fields['Id'] != unit or fields['LoadState'] != 'loaded' or fields['ActiveState'] != 'active' or fields['SubState'] != 'running' or fields['InvocationID'] != expected_inv or fields['ControlGroup'] != expected_group or int(fields['MainPID']) != expected_pid:
        raise ValueError('systemd identity')
    return fields
def process():
    with open('/proc/%d/stat' % expected_pid, encoding='ascii') as stream: raw = stream.read()
    fields = raw[raw.rfind(')') + 2:].split()
    if len(fields) < 20 or fields[0] in ('Z','X','x') or int(fields[19]) != expected_ticks:
        raise ValueError('process start')
    with open('/proc/%d/cgroup' % expected_pid, encoding='ascii') as stream: rows = stream.read().splitlines()
    if rows != ['0::' + expected_group]: raise ValueError('process cgroup')
    return int(fields[19]), rows[0][3:]
boot = open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip()
uid = os.getuid()
first = show()
ticks, group = process()
second = show()
if first != second or boot != open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip() or uid != os.getuid():
    raise ValueError('identity changed')
sys.stdout.write(json.dumps({'bootId':boot,'uid':uid,'unitName':second['Id'],
    'invocationId':second['InvocationID'],'controlGroup':second['ControlGroup'],
    'loadState':second['LoadState'],'activeState':second['ActiveState'],
    'subState':second['SubState'],'mainPid':int(second['MainPID']),
    'startTicks':ticks,'procControlGroup':group}, separators=(',',':')) + '\n')
`;

function descriptorMatches(resource: WslResource, journal: ClaudeModelSupervisorState,
  d: ClaudeModelSupervisorDescriptor): boolean {
  const gate = resource?.gate;
  const launch = gate?.launch;
  if (!gate || Object.keys(gate).sort().join(',') !== 'launch,linuxUser,payloadKind,protocol,root' ||
    gate.protocol !== 'attempt_gate_v1' || gate.payloadKind !== 'claude_model_v1' ||
    !launch || Object.keys(launch).sort().join(',') !==
      'action,commandDigest,profileDigest,sourceDigest,workerEpoch' ||
    launch.action !== 'claude_model_v1' ||
    !journal || !d || journal.protocol !== 'claude_model_v1' ||
    journal.action !== 'claude_model_v1' || journal.phase !== 'entered' || journal.closed ||
    resource.unitName !== d.unitName || resource.distro !== d.distro ||
    resource.uid !== d.uid || resource.bootId !== d.bootId ||
    gate.linuxUser !== d.linuxUser ||
    launch.workerEpoch !== d.launchWorkerEpoch ||
    launch.sourceDigest !== d.sourceDigest || launch.profileDigest !== d.profileDigest ||
    launch.commandDigest !== d.commandDigest ||
    journal.attemptId !== d.attemptId || journal.workspaceId !== d.workspaceId ||
    journal.bootId !== d.bootId || journal.uid !== d.uid ||
    journal.unitName !== d.unitName || journal.launchWorkerEpoch !== d.launchWorkerEpoch ||
    journal.sourceDigest !== d.sourceDigest || journal.profileDigest !== d.profileDigest ||
    journal.commandDigest !== d.commandDigest ||
    journal.invocationId !== resource.invocationId ||
    journal.controlGroup !== resource.controlGroup ||
    !Number.isSafeInteger(journal.enterPid) || (journal.enterPid ?? 0) <= 0 ||
    !Number.isSafeInteger(journal.enterStartTicks) || (journal.enterStartTicks ?? 0) <= 0) return false;
  try { claudeModelSupervisorSpec('status', d, gate.root); }
  catch { return false; }
  return parseClaudeModelSupervisorOutput(JSON.stringify(journal) + '\n', d) !== null;
}

export function claudeModelRunningSpec(resource: WslResource, journal: ClaudeModelSupervisorState,
  expectedDescriptor: ClaudeModelSupervisorDescriptor): ClaudeModelRunningSpec {
  if (!descriptorMatches(resource, journal, expectedDescriptor)) throw new Error('INVALID_ARGUMENT');
  return { executable: WSL_EXECUTABLE,
    args: ['-d', resource.distro, '--user', resource.gate!.linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c', LINUX_RUNNING_OBSERVER, resource.unitName,
      resource.controlGroup!, resource.invocationId!, String(journal.enterPid),
      String(journal.enterStartTicks)],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } };
}

type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean; unref(): void };
export function readClaudeModelRunningChild(child: BoundedChild,
  timeoutMs = 7000): Promise<ClaudeModelRunningOutput> {
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

export function runClaudeModelRunningProbe(spec: ClaudeModelRunningSpec): Promise<ClaudeModelRunningOutput> {
  const child = spawn(spec.executable, [...spec.args],
    { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return readClaudeModelRunningChild(child);
}

export async function observeClaudeModelRunning(resource: WslResource,
  journal: ClaudeModelSupervisorState, expectedDescriptor: ClaudeModelSupervisorDescriptor,
  runner: ClaudeModelRunningRunner = runClaudeModelRunningProbe): Promise<ClaudeModelRunningObservation> {
  let savedResource: WslResource;
  let savedJournal: ClaudeModelSupervisorState;
  let savedDescriptor: ClaudeModelSupervisorDescriptor;
  try {
    savedResource = structuredClone(resource);
    savedJournal = structuredClone(journal);
    savedDescriptor = structuredClone(expectedDescriptor);
  } catch { return { kind: 'unconfirmed' }; }
  if (!descriptorMatches(savedResource, savedJournal, savedDescriptor)) return { kind: 'unconfirmed' };
  let result: ClaudeModelRunningOutput;
  try { result = await runner(claudeModelRunningSpec(savedResource, savedJournal, savedDescriptor)); }
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
    'activeState','subState','mainPid','startTicks','procControlGroup'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value)) ||
    value.bootId !== savedResource.bootId || value.uid !== savedResource.uid ||
    value.unitName !== savedResource.unitName || value.invocationId !== savedResource.invocationId ||
    value.controlGroup !== savedResource.controlGroup || value.loadState !== 'loaded' ||
    value.activeState !== 'active' || value.subState !== 'running' ||
    value.mainPid !== savedJournal.enterPid || value.startTicks !== savedJournal.enterStartTicks ||
    value.procControlGroup !== savedResource.controlGroup) return { kind: 'unconfirmed' };
  return { kind: 'claude_model_running', resource: savedResource, journal: savedJournal,
    native: value as unknown as ClaudeModelRunningNativeState };
}

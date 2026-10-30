import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export type WindowsJobScenario = 'single' | 'tree' | 'parent_exits';
export interface WindowsJobBinding {
  scenario: WindowsJobScenario; hostScopeId: string; executionInstanceId: string;
}
export interface WindowsJobRoot { pid: number; creationFiletime: string }
export interface WindowsJobObservation extends WindowsJobBinding {
  protocol: 'windows_job_canary_observation_v1'; helperVersion: '2'; sequence: number;
  phase: 'running' | 'closed'; root: WindowsJobRoot;
  createdSuspended: true; jobMemberBeforeResume: true; resumed: true; rootExited: boolean;
  members: { complete: true; assigned: number; listed: number; pids: number[]; fixturePids: number[] };
  stopRequested: boolean; stopCallSucceeded: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join(',') === expected;
const uint = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= 0xffff_ffff;
const validBinding = (b: WindowsJobBinding) => record(b) &&
  keys(b, 'executionInstanceId,hostScopeId,scenario') &&
  ['single', 'tree', 'parent_exits'].includes(b.scenario) && typeof b.hostScopeId === 'string' &&
  typeof b.executionInstanceId === 'string' && uuid.test(b.hostScopeId) && uuid.test(b.executionInstanceId);

/** Closed observations from an owned helper channel; not app-server or isolation qualification. */
export function parseWindowsJobObservation(line: string, binding: WindowsJobBinding,
  sequence: number, expectedRoot?: WindowsJobRoot): WindowsJobObservation | null {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 32_768 || !validBinding(binding)) return null;
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (!record(v) || !keys(v,
    'createdSuspended,executionInstanceId,helperVersion,hostScopeId,jobMemberBeforeResume,members,phase,protocol,resumed,root,rootExited,scenario,sequence,stopCallSucceeded,stopRequested') ||
    v.protocol !== 'windows_job_canary_observation_v1' || v.helperVersion !== '2' ||
    v.scenario !== binding.scenario || v.hostScopeId !== binding.hostScopeId ||
    v.executionInstanceId !== binding.executionInstanceId || !Number.isSafeInteger(sequence) || sequence < 1 ||
    v.sequence !== sequence || !['running', 'closed'].includes(v.phase as string) ||
    v.createdSuspended !== true || v.jobMemberBeforeResume !== true || v.resumed !== true ||
    typeof v.rootExited !== 'boolean' || typeof v.stopRequested !== 'boolean' ||
    typeof v.stopCallSucceeded !== 'boolean' || !record(v.root) ||
    !keys(v.root, 'creationFiletime,pid') || !uint(v.root.pid, 1) ||
    typeof v.root.creationFiletime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.root.creationFiletime) ||
    BigInt(v.root.creationFiletime) > 0xffff_ffff_ffff_ffffn ||
    (expectedRoot && (v.root.pid !== expectedRoot.pid || v.root.creationFiletime !== expectedRoot.creationFiletime)) ||
    !record(v.members) || !keys(v.members, 'assigned,complete,fixturePids,listed,pids') || v.members.complete !== true ||
    !uint(v.members.assigned) || !uint(v.members.listed) || v.members.listed > 1024 ||
    v.members.assigned !== v.members.listed || !Array.isArray(v.members.pids) ||
    v.members.pids.length !== v.members.listed || v.members.pids.some(p => !uint(p, 1)) ||
    new Set(v.members.pids).size !== v.members.listed || !Array.isArray(v.members.fixturePids) ||
    v.members.fixturePids.some(p => !uint(p, 1) || !(v.members as { pids: unknown[] }).pids.includes(p)) ||
    new Set(v.members.fixturePids).size !== v.members.fixturePids.length ||
    (!v.rootExited && !v.members.fixturePids.includes(v.root.pid)) ||
    (sequence === 1 && (v.rootExited || v.members.fixturePids.length < (binding.scenario === 'single' ? 1 : 3)))) return null;
  if (v.phase === 'closed') {
    if (!v.rootExited || v.members.listed !== 0 || !v.stopRequested || !v.stopCallSucceeded) return null;
  } else if (v.stopRequested || v.stopCallSucceeded) return null;
  Object.freeze(v.root); Object.freeze(v.members.pids); Object.freeze(v.members.fixturePids); Object.freeze(v.members);
  return Object.freeze(v) as unknown as WindowsJobObservation;
}

/** No executable selection. Reviewed helper lives alongside installed adapter output. */
export function windowsJobHelperPath(): string {
  const binary = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ?
    '../../../../dist/src/adapters/codex/investigator/windows-job-helper.exe' : './windows-job-helper.exe', import.meta.url));
  const base = new URL('./', pathToFileURL(binary));
  const read = (path: string, cap: number) => {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > cap) throw new Error('WINDOWS_JOB_HELPER_UNAVAILABLE');
    return readFileSync(path);
  };
  const manifest = JSON.parse(read(fileURLToPath(new URL('windows-job-helper.manifest.json', base)), 4096).toString('utf8')) as unknown;
  if (!record(manifest) || !keys(manifest, 'architecture,compiler,helperVersion,outputSha256,schemaVersion,sourceSha256') ||
    manifest.schemaVersion !== 1 || manifest.helperVersion !== '3' || manifest.architecture !== 'x64' ||
    !record(manifest.compiler) || !keys(manifest.compiler, 'path,version') ||
    manifest.compiler.path !== 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe' ||
    typeof manifest.compiler.version !== 'string' || !manifest.compiler.version ||
    manifest.outputSha256 !== createHash('sha256').update(read(binary, 2 * 1024 * 1024)).digest('hex') ||
    manifest.sourceSha256 !== createHash('sha256').update(read(fileURLToPath(new URL('windows-job-helper.cs', base)), 512 * 1024)).digest('hex'))
    throw new Error('WINDOWS_JOB_HELPER_UNAVAILABLE');
  return binary;
}

type Pending = { resolve: (o: WindowsJobObservation) => void; reject: (e: Error) => void; command: 'initial' | 'observe' | 'stop' };
export type WindowsJobHelperChannel = EventEmitter & { stdin: Writable; stdout: Readable;
  stderr: Readable; kill(): boolean };
/** Owns only this helper channel. Abort/EOF is unknown, even when kill-on-close later works. */
export class WindowsJobCanarySession {
  readonly initial: WindowsJobObservation;
  private constructor(private readonly control: { request: (c: 'observe' | 'stop') => Promise<WindowsJobObservation>;
    abort: () => Promise<void> }, initial: WindowsJobObservation) { this.initial = initial; }
  observe() { return this.control.request('observe'); }
  stop() { return this.control.request('stop'); }
  abort() { return this.control.abort(); }

  static async open(scenario: WindowsJobScenario, options: { signal?: AbortSignal } = {}): Promise<WindowsJobCanarySession> {
    if (process.platform !== 'win32' || !['single', 'tree', 'parent_exits'].includes(scenario) ||
      !record(options) || Object.keys(options).some(k => k !== 'signal')) throw new Error('WINDOWS_JOB_UNAVAILABLE');
    if (options.signal?.aborted) throw new Error('WINDOWS_JOB_UNKNOWN');
    const binary = windowsJobHelperPath();
    const binding: WindowsJobBinding = { scenario, hostScopeId: randomUUID(), executionInstanceId: randomUUID() };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, [scenario, binding.hostScopeId, binding.executionInstanceId], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' },
      });
    } catch { throw new Error('WINDOWS_JOB_UNKNOWN'); }
    return WindowsJobCanarySession.attachHelperChannel(child, binding, options);
  }

  /** Adapter protocol test seam; its observations grant no native or investigator authority. */
  static async attachHelperChannel(child: WindowsJobHelperChannel, binding: WindowsJobBinding,
    options: { signal?: AbortSignal } = {}): Promise<WindowsJobCanarySession> {
    if (!validBinding(binding)) throw new Error('WINDOWS_JOB_UNKNOWN');
    let pending: Pending | null = null;
    let current: WindowsJobObservation | undefined;
    let sequence = 1;
    let failed = false;
    let stopped = false;
    let closing = false;
    let buffer = Buffer.alloc(0);
    let total = 0;
    let closeResolve: (code: number | null) => void;
    const closed = new Promise<number | null>(r => { closeResolve = r; });
    const unknown = () => new Error('WINDOWS_JOB_UNKNOWN');
    const fail = () => {
      if (failed || stopped) return;
      failed = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', fail);
      const active = pending; pending = null; active?.reject(unknown());
      try { child.kill(); } catch { /* No terminal proof. */ }
      child.stdin.destroy();
    };
    const deadline = setTimeout(fail, 55_000);
    const next = (command: Pending['command']) => new Promise<WindowsJobObservation>((resolve, reject) => {
      if (failed || stopped || pending) { reject(unknown()); return; }
      pending = { resolve, reject, command };
    });
    const first = next('initial');
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', (code) => { closeResolve(code); if (!current || current.phase !== 'closed') fail(); });
    child.stderr.on('data', fail); // Public result never retains native details.
    child.stdout.on('data', (part: Buffer) => {
      if (failed || stopped) return;
      total += part.length;
      if (total > 512 * 1024 || buffer.length + part.length > 32_768) { fail(); return; }
      buffer = Buffer.concat([buffer, part]);
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 1);
        const observation = parseWindowsJobObservation(line, binding, sequence, current?.root);
        const active = pending;
        if (!observation || !active || (active.command === 'stop') !== (observation.phase === 'closed')) { fail(); return; }
        pending = null; sequence += 1; current = observation;
        active.resolve(observation);
      }
    });
    options.signal?.addEventListener('abort', fail, { once: true });
    if (options.signal?.aborted) fail();
    const waitClose = async () => {
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([closed, new Promise<null>(r => { timer = setTimeout(() => r(null), 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    try {
      const initial = await first;
      if (failed) throw unknown();
      return new WindowsJobCanarySession({
        request: async command => {
          if (failed || stopped || closing || pending) throw unknown();
          if (command === 'stop') closing = true;
          const response = next(command);
          if (!failed && !stopped && pending) child.stdin.write(`${command}\n`);
          const observation = await response;
          if (failed) throw unknown();
          if (command === 'stop') {
            if (await waitClose() !== 0 || failed || buffer.length !== 0) { fail(); throw unknown(); }
            stopped = true; clearTimeout(deadline); options.signal?.removeEventListener('abort', fail);
          }
          return observation;
        },
        abort: async () => { fail(); await waitClose(); },
      }, initial);
    } catch { fail(); await waitClose(); throw unknown(); }
  }
}
export const openWindowsJobCanary = WindowsJobCanarySession.open;

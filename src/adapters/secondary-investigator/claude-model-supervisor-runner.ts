import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { encodeClaudeModelBootstrapFrame } from './claude-model-bootstrap.js';
import { parseClaudeModelStartup, type ClaudeModelStartupRecord } from './claude-model-startup.js';
import type { ClaudeMcpSandboxPaths } from './claude-mcp-sandbox-spec.js';
import type { ClaudeModelLaunchProfile } from './claude-model-launch-config.js';
import { claudeModelSupervisorSpec, parseClaudeModelSupervisorOutput, validClaudeModelLaunchLimits,
  type ClaudeModelSupervisorDescriptor, type ClaudeModelSupervisorOperation,
  type ClaudeModelSupervisorState, type ClaudeModelUnitIdentity,
  type ClaudeModelLaunchLimits } from './claude-model-supervisor.js';

const CONTROL_MAX = 4096;
const MODEL_MAX = 256 * 1024;

export { boundedInvestigationPrompt as boundedClaudeModelPrompt } from '../../runtime/investigation-prompt.js';

type ControlChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean; unref(): void };
export interface ClaudeModelControlOutput {
  exitCode: number | null; stdout: string; stderrBytes: number; uncertain: boolean;
}

/** Bounded bridge read; failed Windows-child closure is an uncertain result. */
export function readClaudeModelSupervisorControl(child: ControlChild,
  timeoutMs = 6000, signal?: AbortSignal): Promise<ClaudeModelControlOutput> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000)
    throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let stdout = ''; let bytes = 0; let stderrBytes = 0; let failed = false; let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); if (grace) clearTimeout(grace);
      signal?.removeEventListener('abort', fail);
      child.stdout.destroy(); child.stderr.destroy();
      if (code === null) child.unref();
      resolve({ exitCode: failed ? null : code, stdout, stderrBytes, uncertain: failed });
    };
    const fail = () => {
      if (failed || finished) return;
      failed = true;
      try { child.kill(); } catch { /* WSL bridge close does not prove Linux termination. */ }
      grace = setTimeout(() => finish(null), 1000);
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length; if (bytes > CONTROL_MAX) { fail(); return; }
      stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => {
      bytes += part.length; stderrBytes += part.length; if (bytes > CONTROL_MAX) fail();
    });
    child.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
    child.on('close', finish);
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) fail();
  });
}

export async function runClaudeModelSupervisorOperation(operation: Exclude<ClaudeModelSupervisorOperation,
  'enter_wait_exec'>, descriptor: ClaudeModelSupervisorDescriptor, root: string,
observed?: ClaudeModelUnitIdentity, signal?: AbortSignal): Promise<ClaudeModelSupervisorState | null> {
  const spec = claudeModelSupervisorSpec(operation, descriptor, root, undefined, observed);
  if (signal?.aborted) return null;
  const child = spawn(spec.executable, [...spec.args],
    { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = await readClaudeModelSupervisorControl(child, 6000, signal);
  const state = !output.uncertain && output.exitCode === 0 ?
    parseClaudeModelSupervisorOutput(output.stdout, descriptor) : null;
  return state && (operation === 'status' ||
    operation === 'close' && state.closed ||
    operation === 'prepare' && state.phase === 'prepared' && !state.closed ||
    operation === 'release' && ['released', 'consumed'].includes(state.phase) && !state.closed) ? state : null;
}

export interface ClaudeModelUnitResult {
  /** This only observes the Windows WSL bridge, never proves all Linux descendants ended. */
  bridgeExitCode: number | null;
  stdout: Buffer | null;
  stderrBytes: number;
  uncertain: boolean;
}

export interface ClaudeModelUnitHandle {
  /** Candidate startup identity only; never confinement or prompt authorization. */
  ready: Promise<ClaudeModelStartupRecord | null>;
  closed: Promise<ClaudeModelUnitResult>;
  /** One bounded write after trusted durable running fact and prompt intent. */
  writePrompt(bytes: Buffer, expectedSha256: string): Promise<void>;
  closeBridge(): Promise<ClaudeModelUnitResult>;
}

/** Starts only the fixed original unit. Its gate waits for a separate, authorized host release. */
export function startClaudeModelUnit(descriptor: ClaudeModelSupervisorDescriptor, root: string,
  paths: ClaudeMcpSandboxPaths, limits: ClaudeModelLaunchLimits,
  profile: ClaudeModelLaunchProfile,
  signal?: AbortSignal): ClaudeModelUnitHandle {
  const spec = claudeModelSupervisorSpec('enter_wait_exec', descriptor, root, paths, undefined, limits, profile);
  if (signal?.aborted || !spec.startupInput) throw new Error('MODEL_UNIT_UNAVAILABLE');
  const child = spawn(spec.executable, [...spec.args],
    { env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return attachClaudeModelUnit(child, descriptor, limits, signal, spec.startupInput);
}

type UnitChild = ControlChild & { stdin: Writable };
/** Byte protocol shared by the native spawn path and focused transport tests. */
export function attachClaudeModelUnit(child: UnitChild, descriptor: ClaudeModelSupervisorDescriptor,
  limits: ClaudeModelLaunchLimits, signal?: AbortSignal, startupInput?: Buffer): ClaudeModelUnitHandle {
  if (!validClaudeModelLaunchLimits(limits)) throw new Error('INVALID_ARGUMENT');
  const expectedDescriptor = { ...descriptor };
  if (startupInput !== undefined && (!Buffer.isBuffer(startupInput) ||
    startupInput.length < 1 || startupInput.length > 128 * 1024 + 2048)) throw new Error('INVALID_ARGUMENT');
  const configuration = startupInput === undefined ? undefined : Buffer.from(startupInput);
  let configWritten = configuration === undefined;
  let stdout: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0;
  let uncertain = false; let promptWritten = false; let bridgeClosed = false; let settled = false;
  let startupBytes = Buffer.alloc(0); let startup: ClaudeModelStartupRecord | null = null;
  let readyFinished = false;
  let finishReady!: (value: ClaudeModelStartupRecord | null) => void;
  const ready = new Promise<ClaudeModelStartupRecord | null>(resolve => { finishReady = resolve; });
  const settleReady = (value: ClaudeModelStartupRecord | null) => {
    if (readyFinished) return;
    readyFinished = true; clearTimeout(startupDeadline); finishReady(value);
  };
  let grace: NodeJS.Timeout | undefined;
  let configDeadline: NodeJS.Timeout | undefined;
  let finish!: (value: ClaudeModelUnitResult) => void;
  const closed = new Promise<ClaudeModelUnitResult>(resolve => { finish = resolve; });
  const wall = setTimeout(() => fail(), (limits.maxWallSeconds + 5) * 1000);
  const startupDeadline = setTimeout(() => fail(), Math.min(15, limits.maxWallSeconds) * 1000);
  const settle = (result: ClaudeModelUnitResult) => {
    if (settled) return;
    settled = true;
    settleReady(null);
    clearTimeout(wall); if (grace) clearTimeout(grace); if (configDeadline) clearTimeout(configDeadline);
    signal?.removeEventListener('abort', fail);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (!bridgeClosed) child.unref();
    finish(result);
  };
  const fail = () => {
    if (uncertain || bridgeClosed || settled) return;
    uncertain = true;
    settleReady(null);
    child.stdin.destroy();
    try { child.kill(); } catch { /* No broad Linux termination inference. */ }
    grace ??= setTimeout(() => settle({ bridgeExitCode: null, stdout: null,
      stderrBytes, uncertain: true }), 1000);
  };
  child.stdout.on('data', (part: Buffer) => {
    if (uncertain || settled) return;
    if (!startup) {
      const newline = part.indexOf(10);
      const prefix = newline < 0 ? part : part.subarray(0, newline + 1);
      if (startupBytes.length + prefix.length > CONTROL_MAX ||
        newline < 0 && startupBytes.length + prefix.length >= CONTROL_MAX) { fail(); return; }
      startupBytes = Buffer.concat([startupBytes, prefix]);
      if (newline < 0) return;
      const candidate = parseClaudeModelStartup(startupBytes.toString('utf8'), expectedDescriptor);
      if (!candidate || part.length !== prefix.length) { fail(); return; }
      startup = candidate; startupBytes = Buffer.alloc(0);
      if (configWritten) settleReady(candidate);
      return;
    }
    if (!promptWritten) { fail(); return; }
    stdoutBytes += part.length;
    if (stdoutBytes > MODEL_MAX) { stdout = []; fail(); return; }
    if (!uncertain) stdout.push(part);
  });
  child.stderr.on('data', (part: Buffer) => {
    stderrBytes += part.length; if (stderrBytes > CONTROL_MAX) fail();
  });
  child.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => {
    bridgeClosed = true;
    if (code === null || promptWritten && code !== 0) uncertain = true;
    settle({ bridgeExitCode: uncertain ? null : code,
      stdout: uncertain ? null : Buffer.concat(stdout), stderrBytes, uncertain });
  });
  signal?.addEventListener('abort', fail, { once: true });
  if (signal?.aborted) fail();
  const writePrompt = async (bytes: Buffer, expectedSha256: string) => {
    const prompt = encodeClaudeModelBootstrapFrame(bytes, expectedSha256);
    if (!startup || !configWritten || promptWritten || bridgeClosed || uncertain || settled) throw new Error('MODEL_PROMPT_UNAVAILABLE');
    promptWritten = true;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finishWrite = (ok: boolean) => {
        if (done) return;
        done = true; clearTimeout(timer);
        child.stdin.removeListener('error', onError);
        child.removeListener('close', onClose);
        if (ok && !uncertain && !bridgeClosed && !settled) resolve();
        else { fail(); reject(new Error('MODEL_PROMPT_UNAVAILABLE')); }
      };
      const onError = () => finishWrite(false);
      const onClose = () => finishWrite(false);
      const timer = setTimeout(() => finishWrite(false), 5000);
      child.stdin.once('error', onError);
      child.once('close', onClose);
      child.stdin.write(prompt, (error?: Error | null) => {
        if (error) { finishWrite(false); return; }
        child.stdin.end(() => setImmediate(() => finishWrite(true)));
      });
    });
  };
  if (configuration && !uncertain && !settled) {
    configDeadline = setTimeout(fail, Math.min(5000, limits.maxWallSeconds * 1000));
    try {
      child.stdin.write(configuration, (error?: Error | null) => {
        if (configDeadline) clearTimeout(configDeadline);
        if (error) { fail(); return; }
        if (uncertain || bridgeClosed || settled) return;
        configWritten = true;
        if (startup) settleReady(startup);
      });
    } catch { fail(); }
  }
  return { ready, closed, writePrompt, closeBridge: async () => { fail(); return closed; } };
}

import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { nativeSupervisorGateSpec, parseNativeSupervisorGateOutput,
  type LegacyNativeSupervisorGateState, type NativeSupervisorGateDescriptor,
  type NativeSupervisorGateOperation, type NativeSupervisorGateState,
  type NativeSupervisorUnitIdentity } from './claude-native-supervisor.js';

export interface NativeSupervisorGateChildOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean };
type GateState = NativeSupervisorGateState | LegacyNativeSupervisorGateState;

/** The cap includes the six second in-unit wait plus bridge overhead; failed children get one second to close. */
export function readNativeSupervisorGateChild(child: BoundedChild, timeoutMs = 9000,
  signal?: AbortSignal): Promise<NativeSupervisorGateChildOutput> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 9000)
    throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let failed = false;
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: failed ? null : exitCode, stdout, stderr });
    };
    const fail = () => {
      if (failed || finished) return;
      failed = true;
      try { child.kill(); }
      catch { /* A failed kill still leaves the journal result unconfirmed. */ }
      grace = setTimeout(() => finish(null), 1000);
    };
    const onAbort = () => fail();
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4096) { fail(); return; }
      stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4096) { fail(); return; }
      stderr += part.toString('utf8');
    });
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', finish);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) fail();
  });
}

export function validateNativeSupervisorGateResult(operation: NativeSupervisorGateOperation,
  descriptor: NativeSupervisorGateDescriptor,
  output: NativeSupervisorGateChildOutput): GateState | null {
  if (!['prepare', 'enter', 'release', 'close', 'status'].includes(operation) || !output ||
    output.exitCode !== 0 || typeof output.stdout !== 'string' ||
    typeof output.stderr !== 'string' ||
    Buffer.byteLength(output.stdout, 'utf8') + Buffer.byteLength(output.stderr, 'utf8') > 4096)
    return null;
  const state = parseNativeSupervisorGateOutput(output.stdout, descriptor);
  if (!state) return null;
  if (operation === 'status') return state;
  if (state.protocol === 'native_supervisor_v1')
    return operation === 'close' && state.kind.startsWith('closed_') ? state : null;
  if (operation === 'close') return state.closed ? state : null;
  if (state.closed) return null;
  if (operation === 'prepare') return state.phase === 'prepared' ? state : null;
  if (operation === 'enter') return state.phase === 'consumed' ? state : null;
  return state.phase === 'released' || state.phase === 'consumed' ? state : null;
}

/** Fixed zero-model journal runner. Its result is observation, never launch or cleanup authorization. */
export async function runNativeSupervisorGate(operation: NativeSupervisorGateOperation,
  descriptor: NativeSupervisorGateDescriptor, root: string,
  observed?: NativeSupervisorUnitIdentity, signal?: AbortSignal): Promise<GateState | null> {
  const spec = nativeSupervisorGateSpec(operation, descriptor, root, observed);
  if (signal?.aborted) return null;
  try {
    const child = spawn(spec.executable, spec.args,
      { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return validateNativeSupervisorGateResult(operation, descriptor,
      await readNativeSupervisorGateChild(child, operation === 'enter' ? 9000 : 6000, signal));
  } catch { return null; }
}

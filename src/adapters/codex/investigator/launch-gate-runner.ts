import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  parseWslLaunchGateOutput, wslLaunchGateSpec,
  type WslLaunchGateDescriptor, type WslLaunchGateState,
} from './launch-gate.js';

export type WslLaunchGateControlOperation = 'prepare' | 'close' | 'status';
export interface WslLaunchGateChildOutput { exitCode: number | null; stdout: string; stderr: string }
type BoundedChild = EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean };

/** The timeout includes a one second bridge-close grace and is at most seven seconds. */
export function readWslLaunchGateChild(child: BoundedChild,
  timeoutMs = 6000, signal?: AbortSignal): Promise<WslLaunchGateChildOutput> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000) throw new Error('INVALID_ARGUMENT');
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
      catch { /* A failed kill still leaves the gate result unconfirmed. */ }
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

export function validateWslLaunchGateResult(operation: WslLaunchGateControlOperation,
  descriptor: WslLaunchGateDescriptor, output: WslLaunchGateChildOutput): WslLaunchGateState | null {
  if ((operation !== 'prepare' && operation !== 'close' && operation !== 'status') || !output || output.exitCode !== 0 ||
    typeof output.stdout !== 'string' || typeof output.stderr !== 'string' ||
    Buffer.byteLength(output.stdout, 'utf8') + Buffer.byteLength(output.stderr, 'utf8') > 4096) return null;
  const state = parseWslLaunchGateOutput(output.stdout, descriptor);
  if (operation === 'status') return state;
  if (operation === 'prepare') return state?.kind === 'open' ? state : null;
  return state?.kind === 'closed_unconsumed' || state?.kind === 'closed_consumed' ? state : null;
}

/** Runs only the fixed WSL gate helper. A null result cannot authorize launch or cleanup. */
export async function runWslLaunchGate(operation: WslLaunchGateControlOperation,
  descriptor: WslLaunchGateDescriptor, root: string,
  signal?: AbortSignal): Promise<WslLaunchGateState | null> {
  if (operation !== 'prepare' && operation !== 'close' && operation !== 'status') throw new Error('INVALID_ARGUMENT');
  if (signal?.aborted) return null;
  const spec = wslLaunchGateSpec(operation, descriptor, root);
  if (signal?.aborted) return null;
  try {
    const child = spawn(spec.executable, spec.args,
      { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return validateWslLaunchGateResult(operation, descriptor, await readWslLaunchGateChild(child, 6000, signal));
  } catch { return null; }
}

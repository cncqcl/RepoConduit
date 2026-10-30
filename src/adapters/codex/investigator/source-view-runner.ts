import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { InvestigationSourcePlan } from '../../../application/investigation-source-plan.js';
import {
  parseWslSourceViewOutput, wslSourceViewSpec,
  type SourceViewDescriptor, type SourceViewOperation, type SourceViewState,
} from './source-view.js';

export interface SourceViewChildOutput {
  exitCode: number | null;
  stdout: string;
  stderrPresent: boolean;
}
type BoundedChild = EventEmitter & {
  stdin: Writable; stdout: Readable; stderr: Readable; kill(): boolean;
};

/** A bridge failure leaves WSL state unconfirmed; this reader never exposes stderr. */
export function readWslSourceViewChild(child: BoundedChild, input: string,
  timeoutMs = 120_000, signal?: AbortSignal): Promise<SourceViewChildOutput> {
  if (typeof input !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 180_000) throw new Error('INVALID_ARGUMENT');
  return new Promise(resolve => {
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let inputFinished = false;
    let failed = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      resolve(failed || !inputFinished || code !== 0
        ? { exitCode: null, stdout: '', stderrPresent: stderrBytes > 0 }
        : { exitCode: code, stdout, stderrPresent: stderrBytes > 0 });
    };
    const fail = () => {
      if (settled || failed) return;
      failed = true;
      try { child.kill(); } catch { /* Linux operation remains unconfirmed. */ }
      grace = setTimeout(() => finish(null), 1000);
    };
    const onAbort = () => fail();
    const timer = setTimeout(fail, timeoutMs);
    child.stdin.on('finish', () => { inputFinished = true; });
    child.stdin.on('error', fail);
    child.stdout.on('data', (part: Buffer) => {
      stdoutBytes += part.length;
      if (stdoutBytes + stderrBytes > 4096) { fail(); return; }
      stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => {
      stderrBytes += part.length;
      if (stdoutBytes + stderrBytes > 4096) fail();
    });
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', finish);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) fail();
    else try { child.stdin.end(input); } catch { fail(); }
  });
}

/** A null result is never evidence that close or materialization completed. */
export function validateWslSourceViewResult(operation: SourceViewOperation,
  descriptor: SourceViewDescriptor, output: SourceViewChildOutput): SourceViewState | null {
  if (!['materialize', 'close', 'status'].includes(operation) || !output ||
      output.exitCode !== 0 || typeof output.stderrPresent !== 'boolean' ||
      typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > 2048) return null;
  try {
    const state = parseWslSourceViewOutput(output.stdout, descriptor);
    if (operation === 'materialize') return state?.kind === 'ready' ? state : null;
    if (operation === 'close') return state?.kind === 'closed' ? state : null;
    return state;
  } catch { return null; }
}

/** Runs only the fixed source-view helper. The caller must supply trusted local identity. */
export async function runWslSourceView(operation: SourceViewOperation,
  descriptor: SourceViewDescriptor, root: string,
  plan?: InvestigationSourcePlan, signal?: AbortSignal): Promise<SourceViewState | null> {
  if (signal?.aborted) return null;
  const spec = wslSourceViewSpec(operation, descriptor, root, plan);
  if (signal?.aborted) return null;
  try {
    const child = spawn(spec.executable, spec.args,
      { env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = await readWslSourceViewChild(child, spec.input, 120_000, signal);
    return validateWslSourceViewResult(operation, descriptor, output);
  } catch { return null; }
}

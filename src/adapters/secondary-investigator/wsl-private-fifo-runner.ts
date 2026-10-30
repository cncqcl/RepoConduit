import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { privateFifoSpec, type PrivateFifoBinding } from './wsl-private-fifo.js';

export interface PrivateFifoRelay {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  closeTransport(): Promise<void>;
}

const MAX_CONTROL = 1024;

function validateControl(line: string, status: 'ready' | 'prepared', binding: PrivateFifoBinding): void {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error('PRIVATE_FIFO_CONTROL'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'attemptId,status,workerEpoch') throw new Error('PRIVATE_FIFO_CONTROL');
  const value = parsed as Record<string, unknown>;
  if (value.status !== status || value.attemptId !== binding.attemptId ||
    value.workerEpoch !== binding.workerEpoch) throw new Error('PRIVATE_FIFO_CONTROL');
}

/** The prepare child may write only one small structured response. */
export async function runPrivateFifoPrepare(binding: PrivateFifoBinding, signal?: AbortSignal): Promise<void> {
  const spec = privateFifoSpec('prepare', binding);
  if (signal?.aborted) throw new Error('NOT_AVAILABLE');
  const child = spawn(spec.executable, spec.args,
    { env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderrBytes = 0; let finished = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const fail = () => { child.kill(); finish(new Error('PRIVATE_FIFO_PREPARE')); };
      const timer = setTimeout(fail, 6000);
      const onAbort = () => fail();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8'); if (Buffer.byteLength(stdout) > MAX_CONTROL) fail();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length; if (stderrBytes > MAX_CONTROL) fail();
      });
      child.on('error', fail);
      child.on('close', code => {
        if (code !== 0) { finish(new Error('PRIVATE_FIFO_PREPARE')); return; }
        try { validateControl(stdout.trim(), 'prepared', binding); finish(); }
        catch { finish(new Error('PRIVATE_FIFO_PREPARE')); }
      });
    });
  } finally { child.stdout.destroy(); child.stderr.destroy(); }
}

/** Stderr carries a bounded readiness record; stdout/stdin are exclusively MCP bytes. */
export async function runPrivateFifoRelay(binding: PrivateFifoBinding, signal?: AbortSignal): Promise<PrivateFifoRelay> {
  const spec = privateFifoSpec('relay', binding);
  if (signal?.aborted) throw new Error('NOT_AVAILABLE');
  const child = spawn(spec.executable, spec.args,
    { env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
  child.once('close', () => { closed = true; resolveClosed(); });
  const closeTransport = async () => {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (!closed) child.kill();
    await Promise.race([closedPromise, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
    if (!closed) throw new Error('PRIVATE_FIFO_CLOSE_UNCONFIRMED');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let control = '';
      let done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true; clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const fail = () => { void closeTransport().catch(() => undefined); finish(new Error('PRIVATE_FIFO_RELAY')); };
      const onAbort = () => fail();
      const timer = setTimeout(fail, 6000);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr.on('data', (chunk: Buffer) => {
        if (done) { fail(); return; }
        control += chunk.toString('utf8');
        if (Buffer.byteLength(control) > MAX_CONTROL) { fail(); return; }
        const start = control.lastIndexOf('{');
        if (start < 0) return;
        const prefix = control.slice(0, start);
        if (prefix && !prefix.startsWith('w\u0000s\u0000l\u0000:\u0000') &&
          !prefix.startsWith('wsl:')) { fail(); return; }
        const newline = control.indexOf('\n', start);
        if (newline < 0) return;
        if (newline !== control.length - 1) { fail(); return; }
        try { validateControl(control.slice(start, -1), 'ready', binding); finish(); }
        catch { fail(); }
      });
      child.on('error', fail);
      child.once('close', fail);
    });
    // Further stderr is a protocol violation and never surfaced as a secret-bearing error.
    if (signal?.aborted) throw new Error('NOT_AVAILABLE');
    const onLifetimeAbort = () => { void closeTransport().catch(() => undefined); };
    child.stderr.on('data', () => { void closeTransport().catch(() => undefined); });
    signal?.addEventListener('abort', onLifetimeAbort, { once: true });
    void closedPromise.then(() => signal?.removeEventListener('abort', onLifetimeAbort));
    return { child, closed: closedPromise, closeTransport };
  } catch (error) { await closeTransport(); throw error; }
}

import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export type WindowsReadiness = 'ready' | 'notConfigured' | 'updateRequired';
export interface WindowsReadinessResult {
  readiness: WindowsReadiness;
  isolationVerified: false;
  modelTurn: 'not_run';
}

export interface ReadinessConnection {
  input: Writable;
  output: Readable;
  errors: Readable;
  exited: EventEmitter;
  terminate(): void;
}

/** One-purpose, zero-model App Server exchange. Every other native message fails closed. */
export function runWindowsReadinessProtocol(connection: ReadinessConnection, timeoutMs = 5_000): Promise<WindowsReadinessResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('INVALID_ARGUMENT');
  return new Promise((resolve, reject) => {
    let phase: 'initialize' | 'readiness' = 'initialize';
    let partial = Buffer.alloc(0);
    let totalBytes = 0;
    let settled = false;
    let candidate: WindowsReadiness | undefined;
    const stop = () => { try { connection.terminate(); } catch { /* A failed kill never upgrades readiness. */ } };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error('WINDOWS_READINESS_FAILED'));
    };
    const timer = setTimeout(fail, timeoutMs);
    const send = (value: object) => {
      try { connection.input.write(`${JSON.stringify(value)}\n`); }
      catch { fail(); }
    };
    connection.input.on('error', fail);
    connection.output.on('error', fail);
    connection.errors.on('error', fail);
    connection.exited.on('error', fail);
    connection.exited.on('close', () => {
      if (settled) return;
      if (candidate === undefined || partial.length !== 0) return fail();
      settled = true;
      clearTimeout(timer);
      resolve({ readiness: candidate, isolationVerified: false, modelTurn: 'not_run' });
    });
    connection.errors.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > 8192) fail();
    });
    connection.output.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (candidate !== undefined) return fail();
      totalBytes += chunk.length;
      if (totalBytes > 8192) return fail();
      partial = Buffer.concat([partial, chunk]);
      while (!settled) {
        const newline = partial.indexOf(10);
        if (newline < 0) break;
        if (newline > 4096) return fail();
        const bytes = partial.subarray(0, newline);
        partial = partial.subarray(newline + 1);
        let message: unknown;
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { return fail(); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return fail();
        const entry = message as Record<string, unknown>;
        // This schema-defined status notification can arrive during initialize.
        // It grants no capability and its identity fields are deliberately discarded.
        if (entry.method === 'remoteControl/status/changed' && !('id' in entry) &&
            entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params)) continue;
        if (phase === 'initialize') {
          if (entry.id !== 1 || !entry.result || typeof entry.result !== 'object' || Array.isArray(entry.result) ||
              'error' in entry || 'method' in entry) return fail();
          phase = 'readiness';
          send({ method: 'initialized' });
          send({ id: 2, method: 'windowsSandbox/readiness', params: null });
        } else {
          if (entry.id !== 2 || 'error' in entry || 'method' in entry || !entry.result ||
              typeof entry.result !== 'object' || Array.isArray(entry.result)) return fail();
          const result = entry.result as Record<string, unknown>;
          if (Object.keys(result).length !== 1 ||
              !['ready', 'notConfigured', 'updateRequired'].includes(result.status as string) ||
              partial.length !== 0) return fail();
          candidate = result.status as WindowsReadiness;
          stop();
        }
      }
      if (partial.length > 4096) fail();
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'repo-conduit-readiness', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } });
  });
}

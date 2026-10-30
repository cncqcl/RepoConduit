import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { HostAction, HostActionTransport } from '../adapters/chatgpt/host-conversation.js';

const MAX_FRAME = 1_048_576;
const unavailable = () => new Error('HOST_BRIDGE_UNAVAILABLE');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) throw unavailable();
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

/** Foreground owner-controlled transport. EOF drains the product command before its stores close. */
export class HostConversationBridge implements HostActionTransport {
  private pending: { id: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private commandTask: Promise<void> | undefined;
  private seen = new Set<string>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private failure: Error | undefined;
  private started = false;
  private finishInput: (() => void) | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly input: Readable, private readonly output: Writable, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) throw unavailable();
  }

  close(failure?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = failure;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(unavailable());
      this.pending = undefined;
    }
    this.finishInput?.();
  }

  private emit(value: unknown): void {
    if (this.closed || this.output.destroyed || this.output.writableEnded) throw unavailable();
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_FRAME) throw unavailable();
    // No asynchronous gap between the application checkpoint and releasing a commit action.
    this.output.write(`${body}\n`, error => { if (error) this.close(unavailable()); });
  }

  request(action: HostAction): Promise<unknown> {
    if (this.closed || !this.commandTask || this.pending) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => this.close(unavailable()), this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      try { this.emit({ type: 'action', actionId: id, ...action }); }
      catch { this.close(unavailable()); }
    });
  }

  async run(dispatch: (command: unknown) => Promise<unknown>): Promise<void> {
    if (this.started) throw unavailable();
    this.started = true;
    const onError = () => this.close(unavailable());
    const onClose = () => this.close(unavailable());
    const onEnd = () => {
      if (this.buffer.length) this.close(unavailable());
      else this.close();
    };
    const onData = (chunk: Buffer | string) => {
      if (this.closed) return;
      try {
        const bytesIn = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytesIn.length > MAX_FRAME * 2) throw unavailable();
        this.buffer = Buffer.concat([this.buffer, bytesIn]);
        for (;;) {
          const end = this.buffer.indexOf(10);
          if (end < 0) { if (this.buffer.length > MAX_FRAME) throw unavailable(); break; }
          if (end > MAX_FRAME || end === 0) throw unavailable();
          const bytes = this.buffer.subarray(0, end);
          this.buffer = this.buffer.subarray(end + 1);
          const frame = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
          if (frame.type === 'action_result') {
            keys(frame, ['type', 'actionId', 'raw']);
            if (!this.pending || frame.actionId !== this.pending.id) throw unavailable();
            const pending = this.pending;
            this.pending = undefined;
            clearTimeout(pending.timer);
            pending.resolve(frame.raw);
          } else if (frame.type === 'command') {
            keys(frame, ['type', 'requestId', 'command']);
            if (!identifier(frame.requestId) || this.commandTask || this.seen.has(frame.requestId) || this.seen.size >= 256) throw unavailable();
            const requestId = frame.requestId;
            this.seen.add(requestId);
            // Defer dispatch so the active command promise exists before it asks for an action.
            this.commandTask = Promise.resolve().then(() => dispatch(frame.command)).then(result => {
              if (!this.closed) this.emit({ type: 'result', requestId, result });
            }, () => {
              if (!this.closed) this.emit({ type: 'result', requestId,
                error: { code: 'ERROR', message: 'Request failed or resource unavailable' } });
            }).catch(() => this.close(unavailable())).finally(() => { this.commandTask = undefined; });
          } else throw unavailable();
          if (this.closed) break;
        }
      } catch { this.close(unavailable()); }
    };
    const inputDone = new Promise<void>(resolve => { this.finishInput = resolve; });
    this.input.on('data', onData);
    this.input.once('end', onEnd);
    this.input.once('error', onError);
    this.input.once('close', onClose);
    this.output.on('error', onError);
    this.output.once('close', onClose);
    try {
      if (this.closed) this.finishInput?.();
      else if (this.input.readableEnded || this.input.destroyed) onEnd();
      await inputDone;
      await this.commandTask;
      if (this.failure) throw this.failure;
    } finally {
      this.input.off('data', onData);
      // A still-open parent stdin stays in flowing mode after removing our data handler.
      // Release only this bridge's read side after the active command has drained.
      this.input.pause();
      this.input.off('end', onEnd);
      this.input.off('error', onError);
      this.input.off('close', onClose);
      this.output.off('error', onError);
      this.output.off('close', onClose);
      this.finishInput = undefined;
      this.buffer = Buffer.alloc(0);
    }
  }
}

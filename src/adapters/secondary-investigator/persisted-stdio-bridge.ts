import type { Readable, Writable } from 'node:stream';
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createPersistedInvestigatorMcpServer, type PersistedInvestigatorMcpOptions } from './persisted-mcp.js';

export interface PersistedInvestigatorStdioBridgeOptions extends PersistedInvestigatorMcpOptions {
  /** Trusted host's read end of one worker's client-to-host pipe. */
  input: Readable;
  /** Trusted host's write end of the same worker's host-to-client pipe. */
  output: Writable;
}

/** Attach one already selected, durable worker attempt to its private stdio pipes. */
export function startPersistedInvestigatorStdioBridge(
  options: PersistedInvestigatorStdioBridgeOptions,
): StdioServerHandle & { closed: Promise<void> } {
  const { input, output, ...suppliedBinding } = options;
  const binding: PersistedInvestigatorMcpOptions = {
    ...suppliedBinding, claim: structuredClone(suppliedBinding.claim),
  };
  // Refuse an unstarted, stale, or ungranted binding before accepting wire input.
  const firstServer = createPersistedInvestigatorMcpServer(binding);
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  class BoundedTransport extends StdioServerTransport {
    private closing = false;
    private pendingSends = 0;

    override send(message: Parameters<StdioServerTransport['send']>[0]): Promise<void> {
      this.pendingSends++;
      return super.send(message).finally(() => { this.pendingSends--; });
    }

    override async close(): Promise<void> {
      if (this.closing) return;
      this.closing = true;
      output.off('finish', onOutputClosed);
      output.off('close', onOutputClosed);
      // The SDK waits for drain after a blocked write. A closed output will never drain.
      // Signal its pending writer so the connection can settle without retaining listeners.
      if (this.pendingSends > 0) output.emit('error', new Error('MCP_OUTPUT_CLOSED'));
      try { await super.close(); }
      finally { resolveClosed(); }
    }
  }
  const transport = new BoundedTransport(input, output, { maxBufferSize: 256 * 1024 });
  const onOutputClosed = () => { void transport.close(); };
  output.on('finish', onOutputClosed);
  output.on('close', onOutputClosed);
  let first = true;
  const handle = serveStdio(() => {
    if (first) { first = false; return firstServer; }
    return createPersistedInvestigatorMcpServer(binding);
  }, { transport, onerror: () => { void transport.close(); } });
  if (output.destroyed || output.writableEnded) queueMicrotask(onOutputClosed);
  return { close: () => handle.close(), closed };
}

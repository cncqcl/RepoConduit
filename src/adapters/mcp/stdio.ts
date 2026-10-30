import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createExternalMcpServer, type ExternalMcpServerOptions } from './server.js';

/** Attach a trusted, connection-bound external MCP server to this process's stdio. */
export function startExternalStdio(options: ExternalMcpServerOptions): StdioServerHandle & { closed: Promise<void> } {
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  class ObservedTransport extends StdioServerTransport {
    override async close(): Promise<void> {
      try { await super.close(); }
      finally { resolveClosed(); }
    }
  }
  const handle = serveStdio(() => createExternalMcpServer(options), { transport: new ObservedTransport() });
  return { close: () => handle.close(), closed };
}

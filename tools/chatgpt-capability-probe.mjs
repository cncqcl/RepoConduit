import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createPlatformFileDownloadResolver, PlatformFileDownloadError } from '../dist/src/adapters/mcp/platform-file-download.js';
import { syntheticFileObservation } from './synthetic-file-observation.mjs';

// Account-capability probe: no repository data access or intentional filesystem writes.
const runId = randomUUID();
const writes = new Map();
// These exact origins were observed in synthetic ChatGPT file-reference receipts.
// This probe never accepts an origin supplied by the model or a caller.
const downloadFile = createPlatformFileDownloadResolver({ allowedOrigins: [
  'https://sdmntprcentralus.oaiusercontent.com',
  'https://sdmntprwestus3.oaiusercontent.com',
  'https://oaisdmntprwestus.blob.core.windows.net',
] });
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'repo-conduit-capability-probe', version: '0.1.0' });
  server.registerTool('probe.read', {
    description: 'Read a synthetic capability marker. No repository data is exposed.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ runId, kind: 'read', writes: writes.size }) }] }));
  server.registerTool('probe.write', {
    description: 'Record one synthetic marker in volatile memory to test write-tool availability.',
    inputSchema: z.object({ marker: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ marker }) => {
    const first = !writes.has(marker);
    if (first && writes.size >= 16) {
      return { isError: true, content: [{ type: 'text', text: 'Synthetic probe limit reached' }] };
    }
    if (first) writes.set(marker, writes.size + 1);
    process.stderr.write(`probe_write_invoked run=${runId} ordinal=${writes.get(marker)} first=${first}\n`);
    return { content: [{ type: 'text', text: JSON.stringify({ runId, kind: 'write', marker,
      ordinal: writes.get(marker), first }) }] };
  });
  server.registerTool('probe.file_reference', {
    description: 'Inspect one non-sensitive synthetic ChatGPT file. Download at most 64 KiB, then return only its byte count and SHA-256; do not store or expose the bytes or signed URL.',
    inputSchema: z.object({ file: z.object({
      download_url: z.string().url().max(4096), file_id: z.string().min(1).max(512),
      mime_type: z.string().max(256).optional(), file_name: z.string().max(512).optional(),
    }).strict() }).strict(),
    _meta: { 'openai/fileParams': ['file'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ file }) => {
    const url = new URL(file.download_url);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return { isError: true, content: [{ type: 'text', text: 'Synthetic file reference unavailable' }] };
    }
    let bytes;
    try { bytes = await downloadFile(file).acquireBytes(64 * 1024); }
    catch (error) {
      const stage = error instanceof PlatformFileDownloadError ? error.stage : 'unknown';
      process.stderr.write(`probe_file_download_failed run=${runId} stage=${stage} origin=${url.origin}\n`);
      return { isError: true, content: [{ type: 'text', text: 'Synthetic file bytes unavailable' }] };
    }
    const observation = syntheticFileObservation(runId, file, bytes);
    process.stderr.write(`probe_file_reference_invoked run=${runId} origin=${url.origin}\n`);
    return { content: [{ type: 'text', text: JSON.stringify(observation) }] };
  });
  return server;
});

const http = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url !== '/mcp') { outgoing.writeHead(404).end(); return; }
    const headersOnly = new Request('http://127.0.0.1/mcp', {
      method: incoming.method ?? 'GET', headers: incoming.headers,
    });
    const rejected = hostHeaderValidationResponse(headersOnly, ['127.0.0.1']) ??
      originValidationResponse(headersOnly, ['127.0.0.1']);
    if (rejected) { outgoing.writeHead(rejected.status).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 64 * 1024) { outgoing.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const request = new Request('http://127.0.0.1/mcp', {
      method: incoming.method ?? 'GET', headers: incoming.headers,
      ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const answer = await handler.fetch(request);
    const body = Buffer.from(await answer.arrayBuffer());
    if (body.length > 64 * 1024) { outgoing.writeHead(500).end(); return; }
    outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
    outgoing.end(body);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500).end();
    else outgoing.destroy();
  }
});
http.requestTimeout = 10_000;
const portText = process.env.RCAC_CAPABILITY_PROBE_PORT;
const port = portText === undefined ? 0 : Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65535 || (portText !== undefined && port === 0)) {
  throw new Error('Invalid synthetic probe port');
}
http.listen(port, '127.0.0.1', () => {
  const address = http.address();
  process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, runId }) + '\n');
});
process.on('SIGINT', async () => { http.close(); await handler.close(); });

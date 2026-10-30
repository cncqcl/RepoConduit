import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';
import type { DispatchService } from '../../application/dispatch.js';
import type { RequestContext } from '../../core/policy/authorize.js';
import { createExternalMcpServer, type ExternalMcpServerOptions } from './server.js';

/** A trusted verifier must validate issuer, signature/introspection, revocation and token audience. */
export interface VerifiedHttpIdentity {
  principal: string;
  audience: string;
  recipient: string;
  /** Absolute expiry, in Unix milliseconds. */
  expiresAt: number;
  delegatedPermissions: readonly string[];
  visibleOperations: readonly string[];
  allowedWorkspaceId: string;
  allowedCollaborationId?: string;
}

export interface ExternalHttpOptions {
  dispatcher: Pick<DispatchService, 'dispatch'>;
  /** Exact resource audience configured by the operator, never taken from an HTTP request. */
  expectedAudience: string;
  /** Public HTTPS identifiers supplied by the operator after an issuer is configured. */
  resourceMetadata?: { resource: string; authorizationServer: string; scopes: readonly string[] };
  verifyBearer(token: string): Promise<VerifiedHttpIdentity | undefined>;
  resolveFileTransfer?: ExternalMcpServerOptions['resolveFileTransfer'];
  port?: number;
}

export interface ExternalHttpHandle {
  url: string;
  close(): Promise<void>;
}

const maxBodyBytes = 4 * 1024 * 1024;

function publicHttpsUrl(value: string, canonicalResource: boolean): URL {
  if (canonicalResource && /[?#]|%(?![0-9A-Fa-f]{2})/u.test(value)) {
    throw new TypeError('Canonical public HTTPS URL required');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (canonicalResource && !(value === url.origin ||
        (url.pathname !== '/' && !url.pathname.endsWith('/') && value === url.href)))) {
    throw new TypeError('Canonical public HTTPS URL required');
  }
  return url;
}

function validIdentity(identity: VerifiedHttpIdentity | undefined, audience: string): identity is VerifiedHttpIdentity {
  return !!identity && !!identity.principal && !!identity.recipient && identity.audience === audience &&
    Number.isFinite(identity.expiresAt) && identity.expiresAt > Date.now() &&
    Array.isArray(identity.delegatedPermissions) && identity.delegatedPermissions.every((item) => typeof item === 'string') &&
    Array.isArray(identity.visibleOperations) && identity.visibleOperations.every((item) => typeof item === 'string') &&
    typeof identity.allowedWorkspaceId === 'string' && identity.allowedWorkspaceId.length > 0 &&
    (identity.allowedCollaborationId === undefined ||
      (typeof identity.allowedCollaborationId === 'string' && identity.allowedCollaborationId.length > 0));
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxBodyBytes) throw new Error('body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function addToolSecuritySchemes(bytes: Buffer, scopes: readonly string[]): Buffer {
  const annotate = (value: unknown): string => {
    const response = value as { result?: { tools?: Record<string, unknown>[] } };
    if (Array.isArray(response?.result?.tools)) {
      response.result.tools = response.result.tools.map(tool => ({ ...tool,
        securitySchemes: [{ type: 'oauth2', scopes: [...scopes] }] }));
    }
    return JSON.stringify(value);
  };
  const source = bytes.toString('utf8');
  try {
    if (source.startsWith('event:') || source.startsWith('data:')) {
      return Buffer.from(source.replace(/^data: (.+)$/gm, (_line, payload: string) => {
        try { return `data: ${annotate(JSON.parse(payload) as unknown)}`; }
        catch { return `data: ${payload}`; }
      }));
    }
    return Buffer.from(annotate(JSON.parse(source) as unknown));
  } catch { return bytes; }
}

export async function sendResponse(response: Response, output: ServerResponse,
  stillAuthorized: () => Promise<boolean>, challenge: string, toolScopes?: readonly string[],
  signal?: AbortSignal): Promise<void> {
  const assertOpen = () => { if (signal?.aborted) throw new Error('MCP_HTTP_RESPONSE_ABORTED'); };
  if (!response.body) {
    assertOpen();
    if (!await stillAuthorized()) { output.writeHead(401, { 'www-authenticate': challenge }).end(); return; }
    assertOpen();
    output.writeHead(response.status, Object.fromEntries(response.headers)).end(); return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel();
    void cancellation.catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    while (true) {
      assertOpen();
      const { done, value } = await reader.read();
      assertOpen();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { if (cancellation) await cancellation; }
    finally { reader.releaseLock(); }
  }
  assertOpen();
  if (!await stillAuthorized()) { output.writeHead(401, { 'www-authenticate': challenge }).end(); return; }
  assertOpen();
  const headers = new Headers(response.headers);
  const raw = Buffer.concat(chunks);
  const result = toolScopes ? addToolSecuritySchemes(raw, toolScopes) : raw;
  if (toolScopes) headers.delete('content-length');
  output.writeHead(response.status, Object.fromEntries(headers));
  output.end(result);
}

function sameAuthority(before: VerifiedHttpIdentity, after: VerifiedHttpIdentity | undefined,
  audience: string): boolean {
  return validIdentity(after, audience) && before.principal === after.principal &&
    before.audience === after.audience && before.recipient === after.recipient &&
    before.allowedWorkspaceId === after.allowedWorkspaceId &&
    before.allowedCollaborationId === after.allowedCollaborationId &&
    before.delegatedPermissions.every(permission => after.delegatedPermissions.includes(permission)) &&
    before.visibleOperations.every(operation => after.visibleOperations.includes(operation));
}

/** Launches a local-only HTTP endpoint. A reverse proxy must supply its own trusted TLS/auth boundary. */
export async function startExternalHttp(options: ExternalHttpOptions): Promise<ExternalHttpHandle> {
  if (!options.expectedAudience || typeof options.verifyBearer !== 'function') {
    throw new Error('Explicit audience and verifier required');
  }
  const metadata = options.resourceMetadata;
  const resource = metadata ? publicHttpsUrl(metadata.resource, true) : undefined;
  if (metadata) {
    publicHttpsUrl(metadata.authorizationServer, false);
    if (metadata.resource !== options.expectedAudience || !Array.isArray(metadata.scopes) ||
        metadata.scopes.some(scope => typeof scope !== 'string' || !scope || /[\s"\\]/.test(scope))) {
      throw new TypeError('Invalid OAuth resource metadata');
    }
  }
  const metadataPath = resource ? `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}` : undefined;
  const metadataUrl = resource ? `${resource.origin}${metadataPath}` : undefined;
  const challenge = metadataUrl ? `Bearer resource_metadata="${metadataUrl}"` : 'Bearer';
  const allowedHosts = resource ? ['127.0.0.1', resource.hostname] : ['127.0.0.1'];
  let stopping = false;
  let active = 0;
  let resolveHandlers: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const requests = new Set<AbortController>();
  const releaseActive = () => {
    active--;
    if (active === 0) { resolveHandlers?.(); resolveHandlers = undefined; }
  };
  const server = createServer(async (incoming, outgoing) => {
    if (stopping) { outgoing.writeHead(503).end(); return; }
    active++;
    const controller = new AbortController();
    requests.add(controller);
    const abort = () => controller.abort();
    const disconnected = () => { if (!outgoing.writableEnded) abort(); };
    incoming.once('aborted', abort);
    outgoing.once('close', disconnected);
    try {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const isMetadataPath = metadataPath !== undefined && url.pathname === metadataPath;
      if (!(url.pathname === '/mcp' || isMetadataPath) || url.search || url.hash) {
        outgoing.writeHead(404).end(); return;
      }
      incoming.setTimeout(10_000, () => incoming.destroy());
      const headerRequest = new Request(`http://127.0.0.1${url.pathname}`, {
        method: incoming.method ?? 'GET', headers: incoming.headers as HeadersInit,
      });
      const rejected = hostHeaderValidationResponse(headerRequest, allowedHosts) ??
        originValidationResponse(headerRequest, ['127.0.0.1']);
      if (rejected) { outgoing.writeHead(rejected.status, Object.fromEntries(rejected.headers)).end(); return; }
      if (isMetadataPath) {
        if (!metadata || incoming.method !== 'GET') { outgoing.writeHead(404).end(); return; }
        outgoing.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          .end(JSON.stringify({ resource: metadata.resource,
            authorization_servers: [metadata.authorizationServer], scopes_supported: [...metadata.scopes] }));
        return;
      }
      const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(headerRequest.headers.get('authorization') ?? '');
      if (!match) { outgoing.writeHead(401, { 'www-authenticate': challenge }).end(); return; }
      let identity: VerifiedHttpIdentity | undefined;
      try { identity = await options.verifyBearer(match[1]!); } catch { /* opaque authentication failure */ }
      if (!validIdentity(identity, options.expectedAudience)) {
        outgoing.writeHead(401, { 'www-authenticate': challenge }).end(); return;
      }
      const boundIdentity = identity;
      const stillAuthorized = async () => {
        if (stopping || controller.signal.aborted) return false;
        try {
          const next = await options.verifyBearer(match[1]!);
          return !stopping && !controller.signal.aborted && sameAuthority(boundIdentity, next, options.expectedAudience);
        }
        catch { return false; }
      };
      let body: Buffer | undefined;
      if (incoming.method === 'POST') {
        if (Number(incoming.headers['content-length']) > maxBodyBytes) {
          outgoing.writeHead(413).end(); return;
        }
        try { body = await requestBody(incoming); }
        catch { outgoing.writeHead(413).end(); return; }
      }
      if (!await stillAuthorized()) {
        outgoing.writeHead(401, { 'www-authenticate': challenge }).end(); return;
      }
      const request = new Request(`http://127.0.0.1${url.pathname}`, {
        method: incoming.method ?? 'GET', headers: incoming.headers as HeadersInit,
        signal: controller.signal,
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      const context: RequestContext = {
        principal: boundIdentity.principal, audience: boundIdentity.audience, recipient: boundIdentity.recipient,
        surface: 'external_mcp', now: new Date(), delegatedPermissions: [...boundIdentity.delegatedPermissions],
        assertFreshAuthority: async () => {
          if (!await stillAuthorized()) throw new Error('Remote authority is no longer valid');
        },
      };
      const handler = createMcpHandler(() => createExternalMcpServer({
        dispatcher: { async dispatch(...args: Parameters<DispatchService['dispatch']>) {
          if (stopping || controller.signal.aborted) throw new Error('MCP_HTTP_RESPONSE_ABORTED');
          // SDK transport close aborts callbacks but does not await business work.
          // Keep the existing drain occupied until the actual dispatcher returns.
          active++;
          try { return await options.dispatcher.dispatch(...args); }
          finally { releaseActive(); }
        } }, context, visibleOperations: boundIdentity.visibleOperations,
        ...(options.resolveFileTransfer ? { resolveFileTransfer: options.resolveFileTransfer } : {}),
        allowedWorkspaceId: boundIdentity.allowedWorkspaceId,
        ...(boundIdentity.allowedCollaborationId ? { allowedCollaborationId: boundIdentity.allowedCollaborationId } : {}),
      }), { maxRequestBodySize: maxBodyBytes });
      try {
        let toolScopes: readonly string[] | undefined;
        if (metadata && body) {
          try {
            const envelope = JSON.parse(body.toString('utf8')) as { method?: unknown };
            if (envelope.method === 'tools/list') toolScopes = metadata.scopes;
          } catch { /* The SDK handles malformed request bodies. */ }
        }
        await sendResponse(await handler.fetch(request), outgoing, stillAuthorized, challenge, toolScopes,
          controller.signal);
      } finally { await handler.close(); }
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500).end();
      else outgoing.destroy();
    } finally {
      incoming.off('aborted', abort);
      outgoing.off('close', disconnected);
      requests.delete(controller);
      releaseActive();
    }
  });
  server.requestTimeout = 10_000;
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected HTTP listener address');
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => {
    if (closing) return closing;
    stopping = true;
    for (const request of requests) request.abort();
    const drained = active === 0 ? Promise.resolve() : new Promise<void>(resolve => { resolveHandlers = resolve; });
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve(); });
    });
    const deadline = setTimeout(() => server.closeAllConnections(), 2_000);
    closing = Promise.allSettled([closed, drained]).then(([outcome]) => {
      if (outcome?.status === 'rejected') throw outcome.reason;
    }).finally(() => clearTimeout(deadline));
    return closing;
  } };
}

#!/usr/bin/env node
/** Synthetic-only loopback ingress for a single HTTPS tunnel origin. Not product authorization. */
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';

const issuerPaths = new Set([
  '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration',
  '/auth', '/token', '/jwks', '/token/revocation', '/token/introspection',
]);
const resourcePath = '/.well-known/oauth-protected-resource/mcp';
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function loopbackUrl(value, expectedPath) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== expectedPath ||
      value !== url.origin + (expectedPath === '/' ? '' : expectedPath)) {
    // URL normalization is not used to authorize an upstream supplied by callers.
    throw new Error('Exact loopback upstream URL required');
  }
  return url;
}

function route(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//') ||
      rawUrl.includes('#') || rawUrl.includes('\\')) return undefined;
  const path = rawUrl.split('?', 1)[0];
  if (path.includes('%')) return undefined;
  if (path === '/mcp' || path === resourcePath) return 'mcp';
  if (issuerPaths.has(path) || /^\/(?:interaction|auth)\/[A-Za-z0-9_-]+$/.test(path)) return 'issuer';
  return undefined;
}

function upstreamHeaders(headers, publicHost) {
  const forwarded = { ...headers };
  const connectionTokens = String(headers.connection ?? '').split(',').map(token => token.trim().toLowerCase());
  for (const key of Object.keys(forwarded)) {
    if (hopHeaders.has(key) || connectionTokens.includes(key) || key === 'forwarded' ||
        key.startsWith('x-forwarded-') || key === 'x-real-ip' || key === 'proxy-connection') {
      delete forwarded[key];
    }
  }
  forwarded.host = publicHost;
  return forwarded;
}

export async function startSingleOriginOAuthProxy({ publicOrigin, issuerUrl, mcpUrl, port = 0 }) {
  const publicUrl = new URL(publicOrigin);
  if (publicUrl.protocol !== 'https:' || publicOrigin !== publicUrl.origin ||
      publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('Exact public HTTPS origin required');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port');
  const issuer = loopbackUrl(issuerUrl, '/');
  const mcp = loopbackUrl(mcpUrl, '/mcp');
  const server = createServer((incoming, outgoing) => {
    if (incoming.headers.host !== publicUrl.host) {
      outgoing.writeHead(400, { 'cache-control': 'no-store' }).end(); return;
    }
    const destination = route(incoming.url);
    if (!destination) {
      outgoing.writeHead(404, { 'cache-control': 'no-store' }).end(); return;
    }
    const upstream = destination === 'issuer' ? issuer : mcp;
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: upstream.port,
      path: incoming.url, method: incoming.method,
      headers: upstreamHeaders(incoming.headers, publicUrl.host) }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    forwarded.setTimeout(10_000, () => forwarded.destroy(new Error('Upstream timeout')));
    forwarded.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'cache-control': 'no-store' }).end();
      else outgoing.destroy();
    });
    incoming.on('aborted', () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  server.requestTimeout = 10_000;
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected loopback socket');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.close();
    const deadline = setTimeout(() => server.closeAllConnections(), 2_000);
    try { await once(server, 'close'); } finally { clearTimeout(deadline); }
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--public-origin', '--issuer-url', '--mcp-url', '--port'].includes(key) ||
        !args[index + 1]) throw new Error('Usage: --public-origin HTTPS --issuer-url LOOPBACK --mcp-url LOOPBACK/mcp --port N');
    options[key.slice(2)] = args[index + 1];
  }
  const handle = await startSingleOriginOAuthProxy({ publicOrigin: options['public-origin'],
    issuerUrl: options['issuer-url'], mcpUrl: options['mcp-url'],
    port: Number(options.port) });
  process.stdout.write(`${handle.url}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void handle.close().then(() => process.exit(0));
  });
}

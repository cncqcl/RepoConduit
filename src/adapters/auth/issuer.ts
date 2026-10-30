import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import Provider, { errors, type JWKS } from 'oidc-provider';
import { createSqliteOidcAdapter } from './sqlite-adapter.js';

export interface LocalIssuerOptions {
  issuer: string;
  resource: string;
  clientId: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  operator: { subject: string; saltHex: string; hashHex: string };
  cookieKeys: readonly string[];
  jwks: JWKS;
  db: DatabaseSync;
  port?: number;
}

function publicUrl(value: string, allowPath = false): URL {
  if (typeof value !== 'string' || /[?#]|%(?![0-9A-Fa-f]{2})/u.test(value)) {
    throw new Error('Public HTTPS issuer and resource required');
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Public HTTPS issuer and resource required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      value !== (allowPath && url.pathname !== '/' && !url.pathname.endsWith('/') ? url.href : url.origin)) {
    throw new Error('Public HTTPS issuer and resource required');
  }
  return url;
}

function validConfig(options: LocalIssuerOptions): void {
  const issuer = publicUrl(options.issuer);
  publicUrl(options.resource, true);
  const validRedirect = (uri: string): boolean => {
    try {
      const url = new URL(uri);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch { return false; }
  };
  if (!issuer.hostname || !/^[A-Za-z0-9._:-]{3,128}$/.test(options.clientId ?? '') ||
      !options.operator?.subject?.trim() ||
      !Array.isArray(options.redirectUris) || options.redirectUris.length === 0 ||
      options.redirectUris.some(uri => !validRedirect(uri)) ||
      new Set(options.redirectUris).size !== options.redirectUris.length ||
      !Array.isArray(options.scopes) || options.scopes.length === 0 ||
      options.scopes.some(scope => !/^[a-z][a-z0-9.:-]{1,63}$/.test(scope) || scope === 'openid' || scope === 'offline_access') ||
      new Set(options.scopes).size !== options.scopes.length ||
      !Array.isArray(options.cookieKeys) || options.cookieKeys.length === 0 ||
      options.cookieKeys.some(key => !/^[a-f0-9]{64,}$/.test(key)) ||
      !/^[a-f0-9]{32}$/.test(options.operator.saltHex) ||
      !/^[a-f0-9]{128}$/.test(options.operator.hashHex) ||
      !Array.isArray(options.jwks?.keys) || options.jwks.keys.length === 0 ||
      options.jwks.keys.some(key => !key.kid || !key.d || key.alg !== 'RS256' || key.kty !== 'RSA') ||
      new Set(options.jwks.keys.map(key => key.kid)).size !== options.jwks.keys.length ||
      !(options.db instanceof DatabaseSync)) throw new Error('Incomplete local issuer configuration');
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') throw new Error('Invalid form type');
  let body = '';
  for await (const part of request) {
    body += part.toString();
    if (body.length > 4096) throw new Error('Form too large');
  }
  return new URLSearchParams(body);
}

function page(outgoing: ServerResponse, title: string, action: string, csrf: string,
  content: string): void {
  outgoing.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff' });
  outgoing.end(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title></head><body>
    <h1>${htmlEscape(title)}</h1><form method="post" action="${htmlEscape(action)}">
    <input type="hidden" name="csrf" value="${csrf}">${content}<button type="submit">Continue</button>
    </form></body></html>`);
}

/** Loopback origin for an operator-controlled HTTPS reverse proxy or tunnel. */
export async function startLocalIssuer(options: LocalIssuerOptions): Promise<{
  url: string; provider: Provider; close(): Promise<void>;
}> {
  validConfig(options);
  const issuer = new URL(options.issuer);
  const cookieKey = Buffer.from(options.cookieKeys[0]!, 'hex');
  const provider = new Provider(options.issuer, {
    adapter: createSqliteOidcAdapter(options.db), jwks: options.jwks,
    cookies: { keys: [...options.cookieKeys], short: { secure: true, sameSite: 'lax' },
      long: { secure: true, sameSite: 'lax' } },
    clients: [{ client_id: options.clientId, redirect_uris: [...options.redirectUris],
      response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }],
    clientAuthMethods: ['none'], responseTypes: ['code'],
    scopes: [...options.scopes], pkce: { required: () => true },
    features: { devInteractions: { enabled: false }, introspection: { enabled: true,
      allowedPolicy: (_ctx, client, token) => client.clientId === options.clientId &&
        token.clientId === options.clientId },
      revocation: { enabled: true }, resourceIndicators: { enabled: true,
        getResourceServerInfo(_ctx, resource, client) {
          if (resource !== options.resource || client.clientId !== options.clientId) throw new errors.InvalidTarget();
          return { scope: options.scopes.join(' '), audience: options.resource, accessTokenTTL: 3600,
            accessTokenFormat: 'opaque' };
        },
        defaultResource(_ctx, client) {
          if (client.clientId !== options.clientId) throw new errors.InvalidTarget();
          return options.resource;
        },
        useGrantedResource: () => true,
      } },
    ttl: { AccessToken: 3600, AuthorizationCode: 600, Interaction: 600,
      Session: 3600, Grant: 3600 },
    renderError(ctx) {
      ctx.type = 'text/plain';
      ctx.set('Cache-Control', 'no-store');
      ctx.body = 'Authorization request rejected';
    },
    findAccount: async (_ctx, accountId) => accountId === options.operator.subject ? {
      accountId, claims: async () => ({ sub: accountId }),
    } : undefined,
  });
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.method === 'GET' && ctx.status === 200 &&
        /^\/\.well-known\/(?:oauth-authorization-server|openid-configuration)\/?$/i.test(ctx.path) &&
        ctx.body && typeof ctx.body === 'object' && !Buffer.isBuffer(ctx.body)) {
      (ctx.body as Record<string, unknown>).scopes_supported = [...options.scopes];
    }
  });
  const oidcHandler = provider.callback();
  provider.proxy = true;
  options.db.exec(`CREATE TABLE IF NOT EXISTS oidc_login_guard (
    subject TEXT PRIMARY KEY, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL
  )`);
  let stopping = false;
  let active = 0;
  let resolveHandlers: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer(async (incoming, outgoing) => {
    if (stopping) { outgoing.writeHead(503).end(); return; }
    active++;
    try {
      incoming.setTimeout(10_000, () => incoming.destroy());
      const path = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const host = incoming.headers.host?.split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== issuer.hostname) {
        outgoing.writeHead(400).end(); return;
      }
      // This listener binds loopback only. Never trust forwarded headers from a caller.
      incoming.headers['x-forwarded-proto'] = 'https';
      incoming.headers['x-forwarded-host'] = issuer.host;
      const match = /^\/interaction\/([A-Za-z0-9_-]+)$/.exec(path.pathname);
      if (!match) { await oidcHandler(incoming, outgoing); return; }
      const details = await provider.interactionDetails(incoming, outgoing);
      const requestedScopes = typeof details.params.scope === 'string' ? details.params.scope.split(' ') : [];
      const approvedScopes = new Set(options.scopes);
      if (match[1] !== details.uid || details.params.client_id !== options.clientId ||
          details.params.resource !== options.resource ||
          requestedScopes.length === 0 || new Set(requestedScopes).size !== requestedScopes.length ||
          requestedScopes.some(scope => !approvedScopes.has(scope))) {
        outgoing.writeHead(403).end(); return;
      }
      const prompt = details.prompt.name;
      if (prompt !== 'login' && prompt !== 'consent') { outgoing.writeHead(403).end(); return; }
      const csrf = createHmac('sha256', cookieKey).update(`${details.uid}:${prompt}`).digest('base64url');
      if (incoming.method === 'GET') {
        if (prompt === 'login') {
          page(outgoing, 'Operator login', path.pathname, csrf,
            `<p>Approve access for ${htmlEscape(options.clientId)} to ${htmlEscape(options.resource)}.</p>
            <label>Password <input name="password" type="password" required autocomplete="current-password"></label>`);
        } else {
          page(outgoing, 'Authorize client', path.pathname, csrf,
            `<p>${htmlEscape(options.clientId)} requests ${htmlEscape(String(details.params.scope))}
            for ${htmlEscape(options.resource)}.</p><label><input type="checkbox" name="approve" value="yes" required>Approve</label>`);
        }
        return;
      }
      if (incoming.method !== 'POST' || incoming.headers.origin !== options.issuer) {
        outgoing.writeHead(403).end(); return;
      }
      const body = await formBody(incoming);
      const supplied = body.get('csrf') ?? '';
      if (supplied.length !== csrf.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))) {
        outgoing.writeHead(403).end(); return;
      }
      if (prompt === 'login') {
        const now = Math.floor(Date.now() / 1000);
        const guard = options.db.prepare('SELECT failures, blocked_until FROM oidc_login_guard WHERE subject=?')
          .get(options.operator.subject) as { failures: number; blocked_until: number } | undefined;
        if (guard && guard.blocked_until > now) { outgoing.writeHead(429).end(); return; }
        const password = body.get('password') ?? '';
        if (password.length > 1024 || password.length === 0) { outgoing.writeHead(403).end(); return; }
        const hash = scryptSync(password, Buffer.from(options.operator.saltHex, 'hex'), 64);
        if (!timingSafeEqual(hash, Buffer.from(options.operator.hashHex, 'hex'))) {
          const failures = (guard && guard.failures < 5 && guard.blocked_until + 900 > now ?
            guard.failures : 0) + 1;
          options.db.prepare(`INSERT INTO oidc_login_guard(subject,failures,blocked_until) VALUES(?,?,?)
            ON CONFLICT(subject) DO UPDATE SET failures=excluded.failures,
            blocked_until=excluded.blocked_until`).run(options.operator.subject, failures,
              failures >= 5 ? now + 900 : now);
          outgoing.writeHead(403).end(); return;
        }
        options.db.prepare('DELETE FROM oidc_login_guard WHERE subject=?').run(options.operator.subject);
        await provider.interactionFinished(incoming, outgoing, { login: {
          accountId: options.operator.subject, remember: false,
        } });
      } else {
        if (body.get('approve') !== 'yes' || details.session?.accountId !== options.operator.subject) {
          outgoing.writeHead(403).end(); return;
        }
        const grant = new provider.Grant({ accountId: options.operator.subject, clientId: options.clientId });
        grant.addOIDCScope(String(details.params.scope));
        grant.addResourceScope(options.resource, String(details.params.scope));
        await provider.interactionFinished(incoming, outgoing, { consent: { grantId: await grant.save() } });
      }
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400, { 'cache-control': 'no-store' }).end();
      else outgoing.destroy();
    } finally {
      active--;
      if (active === 0) { resolveHandlers?.(); resolveHandlers = undefined; }
    }
  });
  server.requestTimeout = 10_000;
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected issuer socket');
  return { url: `http://127.0.0.1:${address.port}`, provider, close: () => {
    if (closing) return closing;
    stopping = true;
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

import type { VerifiedHttpIdentity } from '../mcp/http.js';

export interface IssuerScopeBinding {
  delegatedPermissions: readonly string[];
  visibleOperations: readonly string[];
}

export interface IssuerOperatorBinding {
  issuer: string;
  clientId: string;
  subject: string;
  principal: string;
  recipient: string;
  workspaceId: string;
  collaborationId?: string;
  scopes: Readonly<Record<string, IssuerScopeBinding>>;
}

export interface LocalIntrospectionOptions {
  /** Trusted local listener returned by startLocalIssuer, never chosen from a bearer or HTTP request. */
  loopbackUrl: string;
  expectedIssuer: string;
  expectedResource: string;
  expectedClientId: string;
  bindings: readonly IssuerOperatorBinding[];
  timeoutMs?: number;
}

const maxJsonBytes = 8 * 1024;
const maxTokenBytes = 4096;

function canonicalPublicOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/' && value === url.origin;
  } catch { return false; }
}

function canonicalPublicResource(value: string): boolean {
  try {
    if (/[?#]|%(?![0-9A-Fa-f]{2})/u.test(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      (value === url.origin || (url.pathname !== '/' && !url.pathname.endsWith('/') && value === url.href));
  } catch { return false; }
}

function configuredEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      value !== url.origin) throw new TypeError('Fixed 127.0.0.1 loopback issuer endpoint required');
  return url;
}

function validBinding(binding: IssuerOperatorBinding, options: LocalIntrospectionOptions): boolean {
  return binding.issuer === options.expectedIssuer && binding.clientId === options.expectedClientId &&
    !!binding.subject && !!binding.principal && !!binding.recipient && !!binding.workspaceId &&
    (binding.collaborationId === undefined || !!binding.collaborationId) &&
    !!binding.scopes && typeof binding.scopes === 'object' &&
    Object.keys(binding.scopes).length > 0 && Object.entries(binding.scopes).every(([scope, mapped]) =>
      /^[a-z][a-z0-9.:-]{1,63}$/.test(scope) && !!mapped &&
      Array.isArray(mapped.delegatedPermissions) && mapped.delegatedPermissions.every(value => typeof value === 'string' && !!value) &&
      Array.isArray(mapped.visibleOperations) && mapped.visibleOperations.every(value => typeof value === 'string' && !!value));
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
      Number(response.headers.get('content-length')) > maxJsonBytes || !response.body) {
    throw new Error('Issuer response rejected');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxJsonBytes) throw new Error('Issuer response too large');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid issuer response');
  return value as Record<string, unknown>;
}

/** Builds a same-host verifier after checking the configured issuer's discovery document. */
export async function createLocalIntrospectionVerifier(options: LocalIntrospectionOptions): Promise<
  (token: string) => Promise<VerifiedHttpIdentity | undefined>> {
  const endpoint = configuredEndpoint(options.loopbackUrl);
  if (!canonicalPublicOrigin(options.expectedIssuer) || !canonicalPublicResource(options.expectedResource) ||
      !options.expectedClientId || !Array.isArray(options.bindings) ||
      options.bindings.some(binding => !validBinding(binding, options)) ||
      new Set(options.bindings.map(binding => `${binding.issuer}\0${binding.clientId}\0${binding.subject}`)).size !== options.bindings.length) {
    throw new TypeError('Invalid trusted issuer or operator binding');
  }
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new TypeError('Invalid issuer timeout');
  const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> =>
    jsonResponse(await fetch(new URL(path, endpoint), { ...init, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs) }));
  const metadata = await request('/.well-known/oauth-authorization-server');
  if (metadata.issuer !== options.expectedIssuer ||
      metadata.introspection_endpoint !== `${options.expectedIssuer}/token/introspection`) {
    throw new Error('Issuer discovery mismatch');
  }
  return async (token: string): Promise<VerifiedHttpIdentity | undefined> => {
    if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > maxTokenBytes ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) return undefined;
    try {
      const data = await request('/token/introspection', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: options.expectedClientId }) });
      if (data.active !== true || data.aud !== options.expectedResource ||
          data.client_id !== options.expectedClientId ||
          (data.iss !== undefined && data.iss !== options.expectedIssuer) ||
          typeof data.sub !== 'string' || !data.sub ||
          typeof data.exp !== 'number' || !Number.isSafeInteger(data.exp) ||
          data.exp * 1000 <= Date.now() || typeof data.scope !== 'string') return undefined;
      const scopes = data.scope.split(' ');
      if (!scopes.length || scopes.some(scope => !scope) || new Set(scopes).size !== scopes.length) return undefined;
      const binding = options.bindings.find(entry => entry.issuer === options.expectedIssuer &&
        entry.clientId === data.client_id && entry.subject === data.sub);
      if (!binding || scopes.some(scope => !Object.hasOwn(binding.scopes, scope))) return undefined;
      const delegatedPermissions = [...new Set(scopes.flatMap(scope => binding.scopes[scope]!.delegatedPermissions))].sort();
      const visibleOperations = [...new Set(scopes.flatMap(scope => binding.scopes[scope]!.visibleOperations))].sort();
      return { principal: binding.principal, audience: options.expectedResource, recipient: binding.recipient,
        expiresAt: data.exp * 1000, delegatedPermissions, visibleOperations,
        allowedWorkspaceId: binding.workspaceId,
        ...(binding.collaborationId ? { allowedCollaborationId: binding.collaborationId } : {}) };
    } catch { return undefined; }
  };
}

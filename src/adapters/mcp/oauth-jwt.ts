import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWSAlgorithm } from 'jose';
import type { VerifiedHttpIdentity } from './http.js';

const supportedAlgorithms = new Set(['RS256', 'PS256', 'ES256']);
const privateFields = ['d', 'dp', 'dq', 'p', 'q', 'qi', 'oth', 'k', 'priv'];

export interface JwtScopeGrant {
  delegatedPermissions: readonly string[];
  visibleOperations: readonly string[];
}

/** Stored by the local operator. No value in this binding is read from token claims. */
export interface JwtAccountBinding {
  issuer: string;
  subject: string;
  /** OAuth client that the local operator approved as this recipient. */
  clientId: string;
  principal: string;
  recipient: string;
  allowedWorkspaceId: string;
  allowedCollaborationId?: string;
  scopes: Readonly<Record<string, JwtScopeGrant>>;
}

export interface LocalJwksVerifierOptions {
  issuer: string;
  audience: string;
  /** Pinned public keys. Reconstruct the verifier after an operator-approved rotation. */
  jwks: JSONWebKeySet;
  algorithms: readonly JWSAlgorithm[];
  bindings: readonly JwtAccountBinding[];
  /** Trusted issuer/account revocation check. Called on every verification; failure denies access. */
  isActive(token: string): Promise<boolean>;
  /** Maximum accepted access-token lifetime; defaults to one hour. */
  maxTokenLifetimeSeconds?: number;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validNames(values: readonly string[]): boolean {
  return Array.isArray(values) && values.every(nonempty) && new Set(values).size === values.length;
}

/** Verifies a compact JWT offline; authentication failures return no identity. */
export function createLocalJwksBearerVerifier(options: LocalJwksVerifierOptions):
  (token: string) => Promise<VerifiedHttpIdentity | undefined> {
  if (!nonempty(options.issuer) || !nonempty(options.audience) ||
      !Array.isArray(options.algorithms) || options.algorithms.length === 0 ||
      options.algorithms.some((alg) => !supportedAlgorithms.has(alg)) ||
      new Set(options.algorithms).size !== options.algorithms.length ||
      !Array.isArray(options.jwks?.keys) || options.jwks.keys.length === 0 ||
      !Array.isArray(options.bindings) || options.bindings.length === 0 ||
      typeof options.isActive !== 'function') {
    throw new Error('Invalid local JWT verifier configuration');
  }
  const maxLifetime = options.maxTokenLifetimeSeconds ?? 3600;
  if (!Number.isSafeInteger(maxLifetime) || maxLifetime <= 0) throw new Error('Invalid token lifetime');
  const seenKids = new Set<string>();
  const pinnedKeys = options.jwks.keys.map((key) => {
    if (!nonempty(key.kid) || seenKids.has(key.kid) || !options.algorithms.includes(key.alg as JWSAlgorithm) ||
        (key.kty !== 'RSA' && key.kty !== 'EC') ||
        (key.kty === 'EC' && (key.crv !== 'P-256' || key.alg !== 'ES256')) ||
        (key.kty === 'RSA' && key.alg !== 'RS256' && key.alg !== 'PS256') ||
        (key.use !== undefined && key.use !== 'sig') ||
        (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))) ||
        privateFields.some((field) => Object.hasOwn(key, field)) ||
        Object.hasOwn(key, 'jku') || Object.hasOwn(key, 'x5u')) {
      throw new Error('Invalid pinned public JWKS');
    }
    seenKids.add(key.kid);
    return structuredClone(key);
  });
  const bindings = new Map<string, JwtAccountBinding>();
  for (const binding of options.bindings) {
    const id = JSON.stringify([binding.issuer, binding.subject, binding.clientId]);
    if (binding.issuer !== options.issuer || !nonempty(binding.subject) || !nonempty(binding.clientId) || !nonempty(binding.principal) ||
        !nonempty(binding.recipient) || !nonempty(binding.allowedWorkspaceId) ||
        (binding.allowedCollaborationId !== undefined && !nonempty(binding.allowedCollaborationId)) ||
        !binding.scopes || typeof binding.scopes !== 'object' ||
        Object.keys(binding.scopes).length === 0 || bindings.has(id)) {
      throw new Error('Invalid local account binding');
    }
    const scopeGrants: Record<string, JwtScopeGrant> = Object.create(null) as Record<string, JwtScopeGrant>;
    for (const [scope, grant] of Object.entries(binding.scopes as Record<string, JwtScopeGrant>)) {
      if (!nonempty(scope) || /\s/.test(scope) || !grant ||
          !validNames(grant.delegatedPermissions) || !validNames(grant.visibleOperations)) {
        throw new Error('Invalid local scope grant');
      }
      scopeGrants[scope] = {
        delegatedPermissions: [...grant.delegatedPermissions],
        visibleOperations: [...grant.visibleOperations],
      };
    }
    bindings.set(id, { ...binding, scopes: scopeGrants });
  }
  const jwks = createLocalJWKSet({ keys: pinnedKeys });
  const algorithms = [...options.algorithms];
  return async (token) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) return undefined;
    try {
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        issuer: options.issuer, audience: options.audience, typ: 'at+jwt', algorithms,
        requiredClaims: ['exp', 'nbf', 'iat', 'sub'], clockTolerance: 0,
      });
      if (!nonempty(protectedHeader.kid) || !seenKids.has(protectedHeader.kid) ||
          payload.iss !== options.issuer || payload.aud !== options.audience ||
          !nonempty(payload.sub) || !nonempty(payload.client_id) || !Number.isSafeInteger(payload.exp) ||
          !Number.isSafeInteger(payload.nbf) || !Number.isSafeInteger(payload.iat)) return undefined;
      const now = Math.floor(Date.now() / 1000);
      if (payload.iat! > now || payload.nbf! > now || payload.exp! <= now ||
          payload.exp! <= payload.iat! || payload.exp! <= payload.nbf! ||
          payload.exp! - payload.iat! > maxLifetime) return undefined;
      const binding = bindings.get(JSON.stringify([payload.iss, payload.sub, payload.client_id]));
      if (!binding || typeof payload.scope !== 'string' || !payload.scope.trim()) return undefined;
      if (!await options.isActive(token)) return undefined;
      const scopes = payload.scope.split(' ');
      if (scopes.some((scope) => !scope || !Object.hasOwn(binding.scopes, scope)) ||
          new Set(scopes).size !== scopes.length) return undefined;
      const delegatedPermissions = [...new Set(scopes.flatMap((scope) => binding.scopes[scope]!.delegatedPermissions))];
      const visibleOperations = [...new Set(scopes.flatMap((scope) => binding.scopes[scope]!.visibleOperations))];
      return {
        principal: binding.principal, recipient: binding.recipient,
        audience: options.audience, expiresAt: payload.exp! * 1000,
        delegatedPermissions, visibleOperations,
        allowedWorkspaceId: binding.allowedWorkspaceId,
        ...(binding.allowedCollaborationId ? { allowedCollaborationId: binding.allowedCollaborationId } : {}),
      };
    } catch { return undefined; }
  };
}

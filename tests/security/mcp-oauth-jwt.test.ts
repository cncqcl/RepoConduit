import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createLocalJwksBearerVerifier } from '../../src/adapters/mcp/oauth-jwt.js';

const issuer = 'https://issuer.example/';
const audience = 'https://resource.example/mcp';

async function fixture() {
  const first = await generateKeyPair('RS256', { extractable: true });
  const second = await generateKeyPair('RS256', { extractable: true });
  const key = async (publicKey: CryptoKey, kid: string): Promise<JWK> =>
    ({ ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' });
  const key1 = await key(first.publicKey, 'one');
  const key2 = await key(second.publicKey, 'two');
  const revoked = new Set<string>();
  const config = (keys: JWK[]) => ({
    issuer, audience, jwks: { keys }, algorithms: ['RS256'] as const,
    isActive: async (token: string) => !revoked.has(token),
    bindings: [{ issuer, subject: 'external-123', clientId: 'approved-chatgpt', principal: 'alice', recipient: 'chatgpt-alice',
      allowedWorkspaceId: 'ws-a', allowedCollaborationId: 'col-a',
      scopes: {
        'repo.read': { delegatedPermissions: ['data.read', 'collab.read'], visibleOperations: ['repo.read', 'collab.get'] },
        'bundle.submit': { delegatedPermissions: ['bundle.write'], visibleOperations: ['bundle.stage'] },
      } }],
  });
  const sign = async (changes: { issuer?: string; audience?: string | string[]; subject?: string;
    scope?: string; exp?: number; nbf?: number; iat?: number; key?: CryptoKey; kid?: string; alg?: string;
    clientId?: string | null } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: changes.scope ?? 'repo.read',
      ...(changes.clientId === null ? {} : { client_id: changes.clientId ?? 'approved-chatgpt' }) })
      .setProtectedHeader({ alg: changes.alg ?? 'RS256', typ: 'at+jwt', kid: changes.kid ?? 'one' })
      .setIssuer(changes.issuer ?? issuer).setAudience(changes.audience ?? audience)
      .setSubject(changes.subject ?? 'external-123').setIssuedAt(changes.iat ?? now)
      .setNotBefore(changes.nbf ?? now).setExpirationTime(changes.exp ?? now + 300)
      .sign(changes.key ?? first.privateKey);
  };
  return { first, second, key1, key2, config, sign, revoked };
}

test('accepts only a signed access token bound to a local account and requested scopes', async () => {
  const f = await fixture();
  const verify = createLocalJwksBearerVerifier(f.config([f.key1]));
  const identity = await verify(await f.sign());
  assert.deepEqual(identity?.delegatedPermissions, ['data.read', 'collab.read']);
  assert.deepEqual(identity?.visibleOperations, ['repo.read', 'collab.get']);
  assert.equal(identity?.principal, 'alice');
  assert.equal(identity?.recipient, 'chatgpt-alice');
  assert.equal(identity?.allowedWorkspaceId, 'ws-a');
  assert.equal(identity?.allowedCollaborationId, 'col-a');
  assert.equal(identity?.audience, audience);
  const revocable = await f.sign();
  assert.ok(await verify(revocable));
  f.revoked.add(revocable);
  assert.equal(await verify(revocable), undefined);
  assert.equal(await verify(await f.sign({ scope: 'bundle.submit' })).then((item) => item?.visibleOperations[0]), 'bundle.stage');
  assert.equal((await verify(await f.sign({ scope: 'repo.read bundle.submit' })))?.visibleOperations.length, 3);
});

test('rejects tampering, wrong key, issuer, audience, time, subject, scopes and algorithm confusion', async () => {
  const f = await fixture();
  const verify = createLocalJwksBearerVerifier(f.config([f.key1]));
  const valid = await f.sign();
  const parts = valid.split('.');
  const changedSignature = Buffer.from(parts[2]!, 'base64url');
  changedSignature[0] = changedSignature[0]! ^ 1;
  assert.notDeepEqual(changedSignature, Buffer.from(parts[2]!, 'base64url'));
  assert.equal(await verify(`${parts[0]}.${parts[1]}.${changedSignature.toString('base64url')}`), undefined);
  const now = Math.floor(Date.now() / 1000);
  const symmetric = await new SignJWT({ scope: 'repo.read' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'one' })
    .setIssuer(issuer).setAudience(audience).setSubject('external-123')
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300)
    .sign(new TextEncoder().encode('a very long synthetic secret for a test'));
  const idToken = await new SignJWT({ scope: 'repo.read' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'one' })
    .setIssuer(issuer).setAudience(audience).setSubject('external-123')
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300)
    .sign(f.first.privateKey);
  for (const token of [
    symmetric,
    idToken,
    await f.sign({ kid: 'not-pinned' }),
    await f.sign({ key: f.second.privateKey }),
    await f.sign({ issuer: 'https://other.example/' }),
    await f.sign({ audience: 'https://other.example/mcp' }),
    await f.sign({ audience: [audience, 'https://other.example/mcp'] }),
    await f.sign({ exp: now - 1 }),
    await f.sign({ nbf: now + 60 }),
    await f.sign({ iat: now + 60 }),
    await f.sign({ iat: now - 4000 }),
    await f.sign({ subject: 'unknown' }),
    await f.sign({ clientId: 'unapproved-other-client' }),
    await f.sign({ clientId: null }),
    await f.sign({ scope: 'admin' }),
    await f.sign({ scope: 'repo.read admin' }),
    await f.sign({ scope: '' }),
  ]) assert.equal(await verify(token), undefined);
  assert.equal(await verify('not.a.jwt'), undefined);
});

test('key rotation uses only currently pinned public keys and rejects private/symmetric material', async () => {
  const f = await fixture();
  const both = createLocalJwksBearerVerifier(f.config([f.key1, f.key2]));
  assert.ok(await both(await f.sign({ key: f.second.privateKey, kid: 'two' })));
  const rotated = createLocalJwksBearerVerifier(f.config([f.key2]));
  assert.equal(await rotated(await f.sign()), undefined);
  assert.ok(await rotated(await f.sign({ key: f.second.privateKey, kid: 'two' })));
  assert.throws(() => createLocalJwksBearerVerifier(f.config([{ ...f.key1, d: 'secret' }])));
  assert.throws(() => createLocalJwksBearerVerifier(f.config([{ kty: 'oct', k: 'c2VjcmV0', kid: 'one', alg: 'HS256' }])));
  assert.throws(() => createLocalJwksBearerVerifier(f.config([f.key1, f.key1])));
});

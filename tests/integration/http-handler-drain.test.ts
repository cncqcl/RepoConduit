import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { exportJWK, generateKeyPair } from 'jose';
import { startExternalHttp } from '../../src/adapters/mcp/http.js';
import { startLocalIssuer } from '../../src/adapters/auth/issuer.js';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForEntry(promise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('HTTP handler did not enter')), 3_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function requestUntilClosed(url: string, headers: Record<string,string> = {}): Promise<{
  closed: Promise<void>; destroy(): void;
}> {
  const req = httpRequest(url, { headers });
  req.on('error', () => undefined);
  const closed = new Promise<void>(resolve => { req.once('close', resolve); });
  req.end();
  return { closed, destroy() { req.destroy(); } };
}

test('MCP close waits for a verifier after its HTTP client disconnects', { timeout: 10_000 }, async () => {
  const entered = deferred(), release = deferred();
  let verifies = 0;
  const server = await startExternalHttp({ expectedAudience: 'https://mcp.example.test',
    dispatcher: { async dispatch() { return null; } },
    async verifyBearer() { verifies++; entered.resolve(); await release.promise; return undefined; },
  });
  let client: Awaited<ReturnType<typeof requestUntilClosed>> | undefined;
  try {
    client = await requestUntilClosed(server.url, { authorization: 'Bearer fixture' });
    await waitForEntry(entered.promise);
    client.destroy();
    await client.closed;
    let settled = false;
    const closing = server.close().then(() => { settled = true; });
    assert.strictEqual(server.close(), server.close());
    await Promise.resolve();
    assert.equal(settled, false);
    let afterStop: Response | undefined;
    try { afterStop = await fetch(server.url, { headers: { authorization: 'Bearer other' },
      signal: AbortSignal.timeout(2_000) }); }
    catch (error) { assert.ok(error instanceof TypeError); }
    if (afterStop) assert.equal(afterStop.status, 503);
    assert.equal(verifies, 1);
    release.resolve();
    await closing;
    assert.equal(settled, true);
  } finally {
    release.resolve();
    client?.destroy();
    await server.close();
  }
});

test('MCP shutdown drains actual business dispatch after cancelling its response', { timeout:10_000 },async()=>{
 const entered=deferred(),release=deferred();let calls=0,closed=false;
 const server=await startExternalHttp({expectedAudience:'fixture',
  async verifyBearer(){return {principal:'external',audience:'fixture',recipient:'remote',
   expiresAt:Date.now()+60_000,delegatedPermissions:['collab.read'],visibleOperations:['collab.get'],
   allowedWorkspaceId:'ws',allowedCollaborationId:'col'};},
  dispatcher:{async dispatch(){calls++;entered.resolve();await release.promise;return {id:'col'};}},
 });
 const client=new Client({name:'drain-fixture',version:'1'});
 let pending:Promise<unknown>|undefined,closing:Promise<void>|undefined;
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url),
   {requestInit:{headers:{authorization:'Bearer synthetic'}}}));
  pending=client.callTool({name:'collab.get',arguments:{scope:{workspaceId:'ws',collaborationId:'col'},payload:{}}})
   .catch(()=>undefined);
  await waitForEntry(entered.promise);
  closing=server.close().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(closed,false,'SDK response cancellation must not erase an active dispatcher');
  assert.equal(calls,1);
  release.resolve();await closing;
  assert.equal(closed,true);assert.equal(calls,1);
 }finally{
  release.resolve();await client.close();await pending;await(closing??server.close());
 }
});

test('issuer close waits for a real OIDC callback after its HTTP client disconnects',
  { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-issuer-drain-'));
    const db = new DatabaseSync(join(dir, 'issuer.sqlite'));
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const salt = randomBytes(16);
    const server = await startLocalIssuer({ issuer: 'https://issuer.example.test',
      resource: 'https://mcp.example.test', clientId: 'approved-chatgpt',
      redirectUris: ['https://chatgpt.example.test/callback'], scopes: ['repo.read'],
      operator: { subject: 'operator', saltHex: salt.toString('hex'),
        hashHex: scryptSync('fixture-password', salt, 64).toString('hex') },
      cookieKeys: [randomBytes(32).toString('hex')],
      jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] }, db });
    const entered = deferred(), release = deferred();
    let providerStarts = 0;
    server.provider.use(async (ctx, next) => {
      providerStarts++;
      if (ctx.path === '/.well-known/oauth-authorization-server') {
        entered.resolve();
        await release.promise;
      }
      await next();
    });
    let client: Awaited<ReturnType<typeof requestUntilClosed>> | undefined;
    try {
      client = await requestUntilClosed(new URL('/.well-known/oauth-authorization-server', server.url).href);
      await waitForEntry(entered.promise);
      client.destroy();
      await client.closed;
      let settled = false;
      const closing = server.close().then(() => { settled = true; });
      assert.strictEqual(server.close(), server.close());
      await Promise.resolve();
      assert.equal(settled, false);
      let afterStop: Response | undefined;
      try { afterStop = await fetch(new URL('/.well-known/oauth-authorization-server', server.url),
        { signal: AbortSignal.timeout(2_000) }); }
      catch (error) { assert.ok(error instanceof TypeError); }
      if (afterStop) assert.equal(afterStop.status, 503);
      assert.equal(providerStarts, 1);
      release.resolve();
      await closing;
      assert.equal(settled, true);
      assert.ok(db.prepare('SELECT name FROM sqlite_master LIMIT 1').get());
    } finally {
      release.resolve();
      client?.destroy();
      await server.close();
      db.close();
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      assert.match(basename(dir), /^rcac-issuer-drain-[A-Za-z0-9_-]{6}$/);
      rmSync(dir, { recursive: true, force: true });
    }
  });

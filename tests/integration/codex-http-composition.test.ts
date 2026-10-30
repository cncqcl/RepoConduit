import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { startSelfHostedOAuthHttp } from '../../src/runtime/self-hosted-oauth-http.js';

test('self-hosted OAuth refuses a Codex workspace outside its fixed operator binding', async () => {
  const root = mkdtempSync(join(homedir(), 'rcac-codex-http-'));
  protectNewDataDirectory(root);
  const store = new SqliteStore(join(root, 'state.sqlite'));
  store.insertWorkspace({ id: 'ws-a', name: 'A', canonicalRoot: root, registeredBy: 'owner' });
  store.close();
  const issuer = 'https://issuer.example.test';
  const clientId = 'approved-chatgpt';
  const subject = 'operator-1';
  const options = {
    issuer: { issuer, resource: 'https://mcp.example.test', clientId, redirectUris: [],
      scopes: ['investigation.request'], operator: { subject, saltHex: '', hashHex: '' },
      cookieKeys: [], jwks: { keys: [] } },
    bindings: [{ issuer, clientId, subject, principal: 'external', recipient: clientId,
      workspaceId: 'ws-a', scopes: { 'investigation.request': {
        delegatedPermissions: ['investigation.request'], visibleOperations: ['investigate.submit'] } } }],
    codexInvestigator: { workspaceId: 'ws-b', profileRevision: 'profile-a' },
  };
  try {
    await assert.rejects(startSelfHostedOAuthHttp(root, options), /binding mismatch/);
    assert.equal(existsSync(join(root, 'issuer.sqlite')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

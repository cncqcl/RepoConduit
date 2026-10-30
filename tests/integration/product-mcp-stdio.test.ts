import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('production CLI and MCP stdio share one issue and revoke immediately', async () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-product-mcp-'));
  const data = join(dir, 'data');
  const workspaceRoot = join(dir, 'workspace');
  mkdirSync(workspaceRoot);
  const script = resolve('src/cli/main.ts');
  const run = (action: 'init' | 'request' | 'configure-mcp', input?: unknown) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--data-dir', data, action],
      { cwd: resolve('.'), input: input === undefined ? undefined : JSON.stringify(input),
        encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  let client: Client | undefined;
  try {
    run('init');
    const workspace = run('request', { operation: 'admin.register_workspace', scope: { workspaceId: 'management' },
      idempotencyKey: 'register', payload: { name: 'Fixture', root: workspaceRoot } });
    const workspaceId = workspace.id as string;
    const grant = run('request', { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'grant', payload: { principal: 'external-fixture', audience: 'stdio-fixture',
        recipient: 'external-fixture', workspaceId, permissions: ['collab.create', 'collab.read'],
        expiresAt: null } });
    run('configure-mcp', { principal: 'external-fixture', audience: 'stdio-fixture', recipient: 'external-fixture',
      workspaceId, visibleOperations: ['collab.open', 'collab.get'] });
    writeFileSync(join(data, 'oauth-config.json'), '{invalid-json');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', script, '--data-dir', data, 'mcp'], cwd: resolve('.'), stderr: 'pipe' });
    client = new Client({ name: 'product-mcp-fixture', version: '1.0.0' });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['collab.get', 'collab.open']);
    const opened = await client.callTool({ name: 'collab.open', arguments: {
      scope: { workspaceId }, payload: { purpose: 'External entry' }, idempotencyKey: 'issue-1',
    } });
    assert.equal(opened.isError, undefined);
    const collaborationId = (JSON.parse((opened.content[0] as { text: string }).text) as { id: string }).id;
    const args = { scope: { workspaceId, collaborationId }, payload: {} };
    const fetched = await client.callTool({ name: 'collab.get', arguments: args });
    assert.equal(fetched.isError, undefined);
    assert.equal((JSON.parse((fetched.content[0] as { text: string }).text) as { id: string }).id, collaborationId);
    run('request', { operation: 'admin.revoke', scope: { workspaceId: 'management' },
      idempotencyKey: 'revoke', payload: { grantId: grant.id } });
    const rejected = await client.callTool({ name: 'collab.get', arguments: args });
    assert.equal(rejected.isError, true);
  } finally {
    await client?.close();
    const child = relative(resolve(fixtureRoot), resolve(dir));
    assert.ok(child.startsWith('rcac-product-mcp-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdio file discovery uses private configured origins and current grant', async () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-stdio-file-'));
  const data = join(dir, 'data');
  const workspaceRoot = join(dir, 'workspace');
  mkdirSync(workspaceRoot);
  const script = resolve('src/cli/main.ts');
  const run = (action: string, input?: unknown) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--data-dir', data, action],
      { cwd: resolve('.'), input: input === undefined ? undefined : JSON.stringify(input),
        encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', script, '--data-dir', data, 'mcp'], cwd: resolve('.'), stderr: 'pipe' });
    const client = new Client({ name: 'stdio-file-fixture', version: '1.0.0' });
    await client.connect(transport);
    return client;
  };
  let client: Client | undefined;
  try {
    run('init');
    const workspaceId = run('request', { operation: 'admin.register_workspace',
      scope: { workspaceId: 'management' }, idempotencyKey: 'register-file',
      payload: { name: 'Fixture', root: workspaceRoot } }).id as string;
    const grant = run('request', { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'grant-file', payload: { principal: 'external-file', audience: 'stdio-file',
        recipient: 'external-file', workspaceId, permissions: ['artifact.submit'], expiresAt: null } });
    run('configure-mcp', { principal: 'external-file', audience: 'stdio-file', recipient: 'external-file',
      workspaceId, visibleOperations: ['artifact.import_reference'] });
    client = await connect();
    assert.deepEqual((await client.listTools()).tools, [], 'missing OAuth file disables transfer');
    await client.close(); client = undefined;
    const issuer = 'https://issuer.example.test';
    const resource = 'https://mcp.example.test/api/mcp';
    const clientId = 'fixture-client';
    run('request', { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'grant-oauth-file', payload: { principal: 'external-file', audience: resource,
        recipient: clientId, workspaceId, permissions: ['artifact.submit'], expiresAt: null } });
    run('configure-oauth', { issuer, resource, clientId,
      redirectUris: ['https://chatgpt.example.test/callback'], scopes: ['artifact.submit'],
      operator: { subject: 'operator-1', password: 'fixture-password-12345' },
      binding: { issuer, clientId, subject: 'operator-1', principal: 'external-file',
        recipient: clientId, workspaceId, scopes: { 'artifact.submit': {
          delegatedPermissions: ['artifact.submit'], visibleOperations: ['artifact.import_reference'] } } } });
    client = await connect();
    assert.deepEqual((await client.listTools()).tools, [], 'empty origins disable transfer');
    await client.close(); client = undefined;
    run('configure-file-origins', { allowedFileOrigins: ['https://files.example.test'],
      expectedAllowedFileOrigins: [] });
    client = await connect();
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), ['artifact.import_reference']);
    assert.deepEqual(tools[0]?._meta?.['openai/fileParams'], ['file']);
    const schema = tools[0]?.inputSchema.properties?.file as { required?: string[] };
    assert.deepEqual(schema.required, ['download_url', 'file_id']);
    assert.equal(tools[0]?.annotations?.readOnlyHint, false);
    const wrongScope = await client.callTool({ name: 'artifact.import_reference', arguments: {
      scope: { workspaceId: 'other-workspace' }, payload: { bundleId: 'bundle-1', path: 'file.bin' },
      idempotencyKey: 'wrong-scope', file: { download_url: 'https://files.example.test/file', file_id: 'file-1' },
    } });
    assert.equal(wrongScope.isError, true);
    const rejected = await client.callTool({ name: 'artifact.import_reference', arguments: {
      scope: { workspaceId }, payload: { bundleId: 'bundle-1', path: 'file.bin' },
      idempotencyKey: 'wrong-origin', file: { download_url: 'https://denied.example.test/file', file_id: 'file-1' },
    } });
    assert.equal(rejected.isError, true);
    await client.close(); client = undefined;
    const configPath = join(data, 'oauth-config.json');
    const saved = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(saved) as object, allowedFileOrigins: null }));
    const failed = spawnSync(process.execPath, ['--import', 'tsx', script, '--data-dir', data, 'mcp'],
      { cwd: resolve('.'), encoding: 'utf8', input: '', timeout: 20_000 });
    assert.equal(failed.status, 1, 'malformed private config refuses startup');
    writeFileSync(configPath, saved);
    client = await connect();
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['artifact.import_reference'],
      'failed startup released installation');
    run('request', { operation: 'admin.revoke', scope: { workspaceId: 'management' },
      idempotencyKey: 'revoke-file', payload: { grantId: grant.id } });
    const revoked = await client.callTool({ name: 'artifact.import_reference', arguments: {
      scope: { workspaceId }, payload: { bundleId: 'bundle-1', path: 'file.bin' },
      idempotencyKey: 'revoked-file', file: { download_url: 'https://files.example.test/file', file_id: 'file-1' },
    } });
    assert.equal(revoked.isError, true);
    await client.close(); client = undefined;
    client = await connect();
    assert.deepEqual((await client.listTools()).tools, [], 'revoked grant hides transfer on reconnect');
    await client.close(); client = undefined;
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(saved) as object, allowedFileOrigins: null }));
    client = await connect();
    assert.deepEqual((await client.listTools()).tools, [], 'no grant skips irrelevant OAuth configuration');
  } finally {
    await client?.close();
    const child = relative(resolve(fixtureRoot), resolve(dir));
    assert.ok(child.startsWith('rcac-stdio-file-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('stdio child negotiates MCP, lists bounded tools, and calls with trusted identity', async () => {
  const childScript = `
    import { startExternalStdio } from './src/adapters/mcp/stdio.ts';
    const trustedContext = {
      principal: 'transport-verified', audience: 'local-stdio-binding', recipient: 'approved-recipient',
      surface: 'external_mcp', now: new Date(),
    };
    startExternalStdio({
      context: trustedContext,
      visibleOperations: ['collab.get', 'admin.grant'],
      dispatcher: { async dispatch(context, command) {
        return { principal: context.principal, audience: context.audience, operation: command.operation,
          scope: command.scope, payload: command.payload };
      } },
    });
  `;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', '--input-type=module', '--eval', childScript],
    cwd: process.cwd(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'mcp-stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'repo-conduit');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['collab.get']);
    const good = await client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-approved', collaborationId: 'col-approved' }, payload: {},
    } });
    assert.equal(good.isError, undefined);
    const receipt = JSON.parse((good.content[0] as { text: string }).text) as Record<string, unknown>;
    assert.equal(receipt.principal, 'transport-verified');
    assert.equal(receipt.audience, 'local-stdio-binding');
    assert.equal(receipt.operation, 'collab.get');
    const forged = await client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-approved' }, payload: {}, principal: 'forged-owner',
    } });
    assert.equal(forged.isError, true);
    assert.doesNotMatch(stderr, /transport-verified|approved-recipient/);
  } finally {
    await client.close();
  }
});

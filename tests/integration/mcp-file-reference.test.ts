import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createExternalMcpServer } from '../../src/adapters/mcp/server.js';
import type { Command, TrustedFileTransfer } from '../../src/application/dispatch.js';

test('platform file input is advertised and forwarded through the application command', async () => {
  const calls: { command: Command; transfer: TrustedFileTransfer | undefined }[] = [];
  const server = createExternalMcpServer({
    dispatcher: { async dispatch(_context, command, transfer) {
      calls.push({ command, transfer }); return { imported: true };
    } },
    context: { principal: 'external', audience: 'oauth-resource', recipient: 'chatgpt',
      surface: 'external_mcp', now: new Date() },
    visibleOperations: ['artifact.import_reference'], allowedWorkspaceId: 'ws-1',
    allowedCollaborationId: 'col-1',
    resolveFileTransfer: (file) => ({ referenceIdentity: file.file_id,
      mediaType: file.mime_type ?? 'application/octet-stream',
      async acquireBytes() { return Buffer.from('test'); } }),
  });
  const client = new Client({ name: 'file-reference-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['artifact.import_reference']);
    const tool = tools[0]!;
    assert.deepEqual(tool._meta?.['openai/fileParams'], ['file']);
    const fileSchema = tool.inputSchema.properties?.file as { required?: string[] };
    assert.deepEqual(fileSchema.required, ['download_url', 'file_id']);
    assert.deepEqual(Object.keys((fileSchema as { properties: Record<string, unknown> }).properties).sort(),
      ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.equal(tool.annotations?.readOnlyHint, false);
    const file = { download_url: 'https://files.example.test/signed', file_id: 'file-1',
      mime_type: 'application/zip', file_name: 'bundle.zip' };
    const result = await client.callTool({ name: 'artifact.import_reference', arguments: {
      scope: { workspaceId: 'ws-1', collaborationId: 'col-1' },
      payload: { bundleId: 'bundle-1', path: 'bundle.zip' }, idempotencyKey: 'upload-1', file,
    } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls.map((call) => call.command), [{ operation: 'artifact.import_reference',
      scope: { workspaceId: 'ws-1', collaborationId: 'col-1' },
      payload: { bundleId: 'bundle-1', path: 'bundle.zip' }, idempotencyKey: 'upload-1' }]);
    assert.equal(calls[0]?.transfer?.referenceIdentity, 'file-1');
    assert.equal(calls[0]?.transfer?.mediaType, 'application/zip');
    const forged = await client.callTool({ name: 'artifact.import_reference', arguments: {
      scope: { workspaceId: 'ws-1', collaborationId: 'col-1' },
      payload: { bundleId: 'bundle-1', path: 'bundle.zip' }, idempotencyKey: 'upload-2',
      file: { ...file, principal: 'admin' },
    } });
    assert.equal(forged.isError, true);
    assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});

test('file import is absent when no trusted transfer resolver is installed', async () => {
  const server = createExternalMcpServer({
    dispatcher: { async dispatch() { throw new Error('must not dispatch'); } },
    context: { principal: 'external', audience: 'oauth-resource', recipient: 'chatgpt',
      surface: 'external_mcp', now: new Date() },
    visibleOperations: ['artifact.import_reference'], allowedWorkspaceId: 'ws-1',
  });
  const client = new Client({ name: 'file-reference-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools, []);
  } finally { await client.close(); await server.close(); }
});

test('artifact tools advertise required payload fields and reject omissions before dispatch', async () => {
  const calls: Command[] = [];
  const server = createExternalMcpServer({
    dispatcher: { async dispatch(_context, command) { calls.push(command); return { ok: true }; } },
    context: { principal: 'external', audience: 'oauth-resource', recipient: 'chatgpt',
      surface: 'external_mcp', now: new Date() },
    visibleOperations: ['artifact.begin', 'artifact.put_text', 'artifact.import_reference',
      'artifact.status', 'artifact.finalize', 'artifact.abort'],
    allowedWorkspaceId: 'ws-1', allowedCollaborationId: 'col-1',
    resolveFileTransfer: (file) => ({ referenceIdentity: file.file_id,
      mediaType: file.mime_type ?? 'application/octet-stream',
      async acquireBytes() { return Buffer.from('test'); } }),
  });
  const client = new Client({ name: 'artifact-schema-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const requirements = [
      ['artifact.begin', ['bundleId', 'contextRevision', 'snapshotRefs'],
        ['bundleId', 'contextRevision', 'snapshotRefs', 'parentBundleId', 'expectedPaths']],
      ['artifact.put_text', ['bundleId', 'path', 'text', 'mediaType'],
        ['bundleId', 'path', 'text', 'mediaType']],
      ['artifact.import_reference', ['bundleId', 'path'], ['bundleId', 'path']],
      ['artifact.status', ['bundleId'], ['bundleId']],
      ['artifact.finalize', ['bundleId'], ['bundleId']],
      ['artifact.abort', ['bundleId'], ['bundleId']],
    ] as const;
    for (const [name, required, fields] of requirements) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} must be listed`);
      const payload = tool.inputSchema.properties?.payload as {
        required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean;
      };
      assert.deepEqual(payload.required, required, `${name} required payload fields`);
      assert.deepEqual(Object.keys(payload.properties ?? {}).sort(), [...fields].sort(), `${name} payload fields`);
      assert.equal(payload.additionalProperties, false, `${name} rejects unknown payload fields`);
    }
    const file = { download_url: 'https://files.example.test/signed', file_id: 'file-1' };
    const validPayloads: Record<string, Record<string, unknown>> = {
      'artifact.begin': { bundleId: 'bundle-1', contextRevision: 'ctx', snapshotRefs: [] },
      'artifact.put_text': { bundleId: 'bundle-1', path: 'plan.md', text: 'plan', mediaType: 'text/markdown' },
      'artifact.import_reference': { bundleId: 'bundle-1', path: 'bundle.zip' },
      'artifact.status': { bundleId: 'bundle-1' },
      'artifact.finalize': { bundleId: 'bundle-1' },
      'artifact.abort': { bundleId: 'bundle-1' },
    };
    for (const [name, required] of requirements) {
      for (const field of required) {
        const payload = { ...validPayloads[name] };
        delete payload[field];
        const result = await client.callTool({ name, arguments: {
          scope: { workspaceId: 'ws-1', collaborationId: 'col-1' },
          ...(name === 'artifact.status' ? {} : { idempotencyKey: `missing-${name}-${field}` }),
          payload,
          ...(name === 'artifact.import_reference' ? { file } : {}),
        } });
        assert.equal(result.isError, true, `${name} missing ${field} must be rejected`);
      }
    }
    assert.equal(calls.length, 0);
    for (const [name] of requirements) {
      const payload = validPayloads[name]!;
      const idempotencyKey = `valid-${name}`;
      const result = await client.callTool({ name, arguments: {
        scope: { workspaceId: 'ws-1', collaborationId: 'col-1' }, payload,
        ...(name === 'artifact.status' ? {} : { idempotencyKey }),
        ...(name === 'artifact.import_reference' ? { file } : {}),
      } });
      assert.equal(result.isError, undefined, `${name} valid payload`);
      assert.equal(calls.at(-1)?.operation, name);
      assert.deepEqual(calls.at(-1)?.payload, payload);
      assert.equal(calls.at(-1)?.idempotencyKey,
        name === 'artifact.status' ? undefined : idempotencyKey);
    }
    const dispatched = calls.length;
    for (const [name] of requirements) {
      for (const payload of [{ ...validPayloads[name], unexpected: true },
        { ...validPayloads[name], bundleId: 42 }]) {
        const result = await client.callTool({ name, arguments: {
          scope: { workspaceId: 'ws-1', collaborationId: 'col-1' }, payload,
          ...(name === 'artifact.status' ? {} : { idempotencyKey: `invalid-${name}` }),
          ...(name === 'artifact.import_reference' ? { file } : {}),
        } });
        assert.equal(result.isError, true, `${name} malformed payload`);
      }
    }
    assert.equal(calls.length, dispatched, 'malformed payloads must not dispatch');
  } finally { await client.close(); await server.close(); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createExternalMcpServer } from '../../src/adapters/mcp/server.js';
import { DispatchService, type Command } from '../../src/application/dispatch.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { readSnapshot } from '../../src/adapters/repository/queries.js';
import type { RequestContext } from '../../src/core/policy/authorize.js';

const boundContext: RequestContext = {
  principal: 'verified-external', audience: 'bound-local-transport', surface: 'external_mcp',
  recipient: 'approved-recipient', now: new Date('2026-09-26T00:00:00Z'),
};

test('repo.read advertises exact output and preserves complete, paged UTF-8 results in both MCP channels', async () => {
  const snapshot = createSnapshotFromFiles('copy', 'synthetic', {
    'README.md': Buffer.from('A界B\n', 'utf8'), 'EMPTY.md': Buffer.alloc(0),
  });
  const context = { principal: boundContext.principal, scopePaths: ['README.md', 'EMPTY.md'] };
  const calls: Command[] = [];
  const server = createExternalMcpServer({
    dispatcher: { async dispatch(_context, command) {
      calls.push(command);
      const payload = command.payload as { path: string; maxBytes?: number; cursor?: string };
      return readSnapshot(snapshot, context, { path: payload.path,
        ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes }),
        ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }) });
    } },
    context: boundContext, visibleOperations: ['repo.read'], allowedWorkspaceId: 'ws-approved',
  });
  const client = new Client({ name: 'repo-read-output-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['repo.read']);
    const schema = tools[0]?.outputSchema;
    assert.ok(schema);
    assert.deepEqual(schema.required, ['snapshotId', 'path', 'content', 'contentHash',
      'lineRange', 'byteRange', 'decoding', 'completeness']);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['snapshotId', 'path', 'content',
      'contentHash', 'lineRange', 'byteRange', 'decoding', 'completeness', 'continuation', 'toolReceipt'].sort());
    const invoke = async (path: string, maxBytes?: number, cursor?: string) => {
      const result = await client.callTool({ name: 'repo.read', arguments: {
        scope: { workspaceId: 'ws-approved' }, payload: { workingCopyId: 'copy', snapshotId: snapshot.id,
          path, ...(maxBytes === undefined ? {} : { maxBytes }), ...(cursor === undefined ? {} : { cursor }) },
      } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, JSON.parse((result.content[0] as { text: string }).text));
      return result.structuredContent as Record<string, unknown>;
    };
    const complete = await invoke('README.md');
    assert.equal(complete.content, 'A界B\n');
    assert.equal(complete.contentHash, createHash('sha256').update('A界B\n').digest('hex'));
    assert.equal(complete.completeness, 'complete');
    const first = await invoke('README.md', 4);
    assert.equal(first.content, 'A界'); assert.equal(first.completeness, 'partial');
    assert.equal(typeof first.continuation, 'string');
    const second = await invoke('README.md', 4, first.continuation as string);
    assert.equal(second.content, 'B\n'); assert.equal(second.completeness, 'complete');
    assert.equal(second.contentHash, first.contentHash);
    assert.deepEqual(second.byteRange, { start: 4, end: 6 });
    const empty = await invoke('EMPTY.md');
    assert.equal(empty.content, '');
    assert.deepEqual(empty.byteRange, { start: 0, end: 0 });
    assert.equal(calls.length, 4);
    assert.equal((calls[2]?.payload as Record<string, unknown>).cursor, first.continuation);
  } finally { await client.close(); await server.close(); }
});

test('repo.read bound-scope and dispatch errors do not disclose structured content', async () => {
  let dispatched = 0;
  const server = createExternalMcpServer({
    dispatcher: { async dispatch() { dispatched++; throw new Error('sensitive-local-path'); } },
    context: boundContext, visibleOperations: ['repo.read'], allowedWorkspaceId: 'ws-approved',
  });
  const client = new Client({ name: 'repo-read-errors-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const payload = { workingCopyId: 'copy', snapshotId: 'snap', path: 'README.md' };
    for (const workspaceId of ['ws-other', 'ws-approved']) {
      const result = await client.callTool({ name: 'repo.read', arguments: {
        scope: { workspaceId }, payload,
      } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal((result.content[0] as { text: string }).text, 'Request failed or resource unavailable');
    }
    assert.equal(dispatched, 1);
  } finally { await client.close(); await server.close(); }
});

test('configured external decision.propose is discoverable as a write tool', async () => {
  const server = createExternalMcpServer({
    dispatcher: { async dispatch() { return { kind: 'decision_proposal' }; } },
    context: boundContext, visibleOperations: ['decision.propose'],
    allowedWorkspaceId: 'ws-approved', allowedCollaborationId: 'col-approved',
  });
  const client = new Client({ name: 'decision-discovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['decision.propose']);
    assert.equal(tools[0]?.annotations?.readOnlyHint, false);
  } finally { await client.close(); await server.close(); }
});

test('real MCP initialization, discovery, and calls preserve trusted context and narrow catalog', async () => {
  const calls: { context: RequestContext; command: Command }[] = [];
  const dispatcher = { async dispatch(context: RequestContext, command: Command): Promise<unknown> {
    calls.push({ context, command });
    return { accepted: true, operation: command.operation };
  } };
  const server = createExternalMcpServer({ dispatcher, context: boundContext,
    visibleOperations: ['collab.get', 'collab.open', 'repo.read', 'admin.grant', 'context.read', 'artifact.abort'],
    allowedWorkspaceId: 'ws-approved' });
  const client = new Client({ name: 'mcp-adapter-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(client.getServerVersion()?.name, 'repo-conduit');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['artifact.abort', 'collab.get', 'collab.open', 'context.read', 'repo.read']);
    assert.equal(tools.find((tool) => tool.name === 'collab.get')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'collab.open')?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === 'artifact.abort')?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === 'artifact.abort')?.annotations?.destructiveHint, true);
    const ok = await client.callTool({ name: 'collab.open', arguments: {
      scope: { workspaceId: 'ws-approved' }, payload: { purpose: 'review' }, idempotencyKey: 'open-1',
    } });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(JSON.parse((ok.content[0] as { text: string }).text), { accepted: true, operation: 'collab.open' });
    assert.equal(calls.length, 1);
    const wrongWorkspace = await client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-other' }, payload: {},
    } });
    assert.equal(wrongWorkspace.isError, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.context.principal, 'verified-external');
    assert.equal(calls[0]?.context.audience, 'bound-local-transport');
    assert.equal(calls[0]?.command.operation, 'collab.open');
    assert.deepEqual(calls[0]?.command.scope, { workspaceId: 'ws-approved' });
    assert.deepEqual(calls[0]?.command.payload, { purpose: 'review' });

    const badIdentity = await client.callTool({ name: 'collab.open', arguments: {
      scope: { workspaceId: 'ws-approved' }, payload: { purpose: 'review' }, idempotencyKey: 'open-2',
      principal: 'forged-owner',
    } });
    assert.equal(badIdentity.isError, true);
    const badScope = await client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-approved', principal: 'forged-owner' }, payload: {},
    } });
    assert.equal(badScope.isError, true);
    const missingIdempotency = await client.callTool({ name: 'collab.open', arguments: {
      scope: { workspaceId: 'ws-approved' }, payload: { purpose: 'review' },
    } });
    assert.equal(missingIdempotency.isError, true);
    assert.equal(calls.length, 1);
    await assert.rejects(client.callTool({ name: 'admin.grant', arguments: {
      scope: { workspaceId: 'management' }, payload: {}, idempotencyKey: 'x',
    } }));
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('direct MCP call remains subject to application grant revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-mcp-'));
  const store = new SqliteStore(join(dir, 'state.sqlite'));
  const workspaceId = 'ws_01234567-89ab-4cde-8f01-234567890abc';
  const collaborationId = 'col_01234567-89ab-4cde-8f01-234567890abc';
  store.insertWorkspace({ id: workspaceId, name: 'fixture', canonicalRoot: dir, registeredBy: 'owner' });
  store.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner', purpose: 'private', hostThreadId: null, state: 'open' });
  store.insertGrant({ id: 'gr_mcp', principal: boundContext.principal, audience: boundContext.audience,
    workspaceId, collaborationId, recipient: boundContext.recipient, permissions: ['collab.read'],
    expiresAt: null, revokedAt: null });
  const server = createExternalMcpServer({ dispatcher: new DispatchService(store), context: boundContext,
    visibleOperations: ['collab.get'] });
  const client = new Client({ name: 'mcp-adapter-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const args = { scope: { workspaceId, collaborationId }, payload: {} };
    const first = await client.callTool({ name: 'collab.get', arguments: args });
    assert.equal(first.isError, undefined);
    store.revokeGrant('gr_mcp', new Date().toISOString());
    const afterRevocation = await client.callTool({ name: 'collab.get', arguments: args });
    assert.equal(afterRevocation.isError, true);
    assert.doesNotMatch((afterRevocation.content[0] as { text: string }).text, /private/);
  } finally {
    await client.close();
    await server.close();
    store.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-mcp-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collaboration-bound MCP connection rejects another collaboration and broad operations', async () => {
  const calls: Command[] = [];
  const server = createExternalMcpServer({
    dispatcher: { async dispatch(_context, command) { calls.push(command); return { ok: true }; } },
    context: boundContext, visibleOperations: ['collab.get', 'collab.list', 'collab.open'],
    allowedWorkspaceId: 'ws-approved', allowedCollaborationId: 'col-approved',
  });
  const client = new Client({ name: 'mcp-binding-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const other = await client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-approved', collaborationId: 'col-other' }, payload: {},
    } });
    const list = await client.callTool({ name: 'collab.list', arguments: {
      scope: { workspaceId: 'ws-approved' }, payload: {},
    } });
    const open = await client.callTool({ name: 'collab.open', arguments: {
      scope: { workspaceId: 'ws-approved' }, payload: { purpose: 'other' }, idempotencyKey: 'open-other',
    } });
    assert.equal(other.isError, true);
    assert.equal(list.isError, true);
    assert.equal(open.isError, true);
    assert.equal(calls.length, 0);
    const same = await client.callTool({ name: 'collab.get', arguments: {
      scope: { workspaceId: 'ws-approved', collaborationId: 'col-approved' }, payload: {},
    } });
    assert.equal(same.isError, undefined);
    assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});

test('external tool discovery exposes closed operation payloads and rejects missing fields before dispatch', async () => {
  const calls: Command[] = [];
  const expected: Record<string, { required: string[]; fields: string[] }> = {
    'collab.open': { required: ['purpose'], fields: ['purpose'] },
    'collab.get': { required: [], fields: [] },
    'collab.list': { required: [], fields: [] },
    'context.read': { required: [], fields: ['proposalId', 'revisionId'] },
    'context.propose': { required: ['proposalId', 'parentRevisionId', 'snapshotId', 'sourceRefs', 'content'],
      fields: ['proposalId', 'parentRevisionId', 'snapshotId', 'sourceRefs', 'content'] },
    'repo.inspect': { required: ['workingCopyId', 'snapshotId'], fields: ['workingCopyId', 'snapshotId'] },
    'repo.status': { required: ['workingCopyId', 'snapshotId'], fields: ['workingCopyId', 'snapshotId'] },
    'repo.list': { required: ['workingCopyId', 'snapshotId'], fields: ['workingCopyId', 'snapshotId', 'maxEntries', 'cursor'] },
    'repo.read': { required: ['workingCopyId', 'snapshotId', 'path'], fields: ['workingCopyId', 'snapshotId', 'path', 'maxBytes', 'maxLines', 'cursor'] },
    'repo.search': { required: ['workingCopyId', 'snapshotId', 'term'], fields: ['workingCopyId', 'snapshotId', 'term', 'maxBytes', 'maxMatches', 'cursor'] },
    'repo.diff': { required: ['workingCopyId', 'snapshotId', 'beforeSnapshotId'], fields: ['workingCopyId', 'snapshotId', 'beforeSnapshotId', 'maxEntries', 'cursor'] },
    'investigate.get': { required: ['workingCopyId', 'requestId'], fields: ['workingCopyId', 'requestId'] },
    'investigate.result': { required: ['workingCopyId', 'requestId'], fields: ['workingCopyId', 'requestId'] },
    'investigate.cancel': { required: ['workingCopyId', 'requestId'], fields: ['workingCopyId', 'requestId'] },
    'investigate.submit': { required: ['workingCopyId', 'input'], fields: ['workingCopyId', 'input'] },
  };
  const validPayloads: Record<string, Record<string, unknown>> = {
    'collab.open': { purpose: 'review' }, 'collab.get': {}, 'collab.list': {}, 'context.read': {},
    'context.propose': { proposalId: 'proposal', parentRevisionId: null, snapshotId: 'snap', sourceRefs: [],
      content: { goal: 'review', constraints: [], acceptedDecisions: [], rejectedDecisions: [],
        currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] } },
    'repo.inspect': { workingCopyId: 'copy', snapshotId: 'snap' },
    'repo.status': { workingCopyId: 'copy', snapshotId: 'snap' },
    'repo.list': { workingCopyId: 'copy', snapshotId: 'snap' },
    'repo.read': { workingCopyId: 'copy', snapshotId: 'snap', path: 'README.md' },
    'repo.search': { workingCopyId: 'copy', snapshotId: 'snap', term: 'needle' },
    'repo.diff': { workingCopyId: 'copy', snapshotId: 'snap', beforeSnapshotId: 'previous' },
    'investigate.get': { workingCopyId: 'copy', requestId: 'request' },
    'investigate.result': { workingCopyId: 'copy', requestId: 'request' },
    'investigate.cancel': { workingCopyId: 'copy', requestId: 'request' },
    'investigate.submit': { workingCopyId: 'copy', input: { contextRevisionId: 'ctx', snapshotRef: 'snap',
      question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'] } },
  };
  const server = createExternalMcpServer({
    dispatcher: { async dispatch(_context, command) {
      calls.push(command);
      if (command.operation === 'repo.read') return {
        snapshotId: 'snap', path: 'README.md', content: 'fixture', contentHash: 'a'.repeat(64),
        lineRange: { start: 1, end: 1 }, byteRange: { start: 0, end: 7 },
        decoding: 'utf-8', completeness: 'complete',
      };
      return { ok: true };
    } },
    context: boundContext, visibleOperations: Object.keys(expected), allowedWorkspaceId: 'ws-approved',
  });
  const client = new Client({ name: 'mcp-schema-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), Object.keys(expected).sort());
    for (const [name, spec] of Object.entries(expected)) {
      const payload = tools.get(name)?.inputSchema.properties?.payload as {
        required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean;
      };
      assert.ok(payload, `${name} payload`);
      assert.deepEqual(payload.required ?? [], spec.required, `${name} required`);
      assert.deepEqual(Object.keys(payload.properties ?? {}).sort(), spec.fields.sort(), `${name} fields`);
      assert.equal(payload.additionalProperties, false, `${name} closed`);
      for (const missing of spec.required) {
        const valid = { ...validPayloads[name] };
        delete valid[missing];
        const rejected = await client.callTool({ name, arguments: {
          scope: { workspaceId: 'ws-approved', collaborationId: 'col-approved' },
          payload: valid, ...(['collab.open', 'context.propose', 'investigate.submit', 'investigate.cancel'].includes(name) ?
            { idempotencyKey: 'missing' } : {}),
        } });
        assert.equal(rejected.isError, true, `${name} missing ${missing}`);
      }
    }
    const proposePayload = tools.get('context.propose')?.inputSchema.properties?.payload as {
      properties?: Record<string, unknown>;
    };
    const proposedContent = proposePayload.properties?.content as {
      required?: string[]; additionalProperties?: boolean;
    };
    assert.deepEqual(proposedContent.required, ['goal', 'constraints', 'acceptedDecisions', 'rejectedDecisions',
      'currentQuestions', 'evidenceRefs', 'expectedDeliverables', 'unknowns', 'recentChanges']);
    assert.equal(proposedContent.additionalProperties, false);
    const submitPayload = tools.get('investigate.submit')?.inputSchema.properties?.payload as {
      properties?: Record<string, unknown>;
    };
    const investigationInput = submitPayload.properties?.input as {
      required?: string[]; additionalProperties?: boolean;
    };
    assert.deepEqual(investigationInput.required, ['contextRevisionId', 'snapshotRef', 'question', 'scope', 'requestedOutputs']);
    assert.equal(investigationInput.additionalProperties, false);
    for (const [name, payload] of [
      ['context.propose', { ...validPayloads['context.propose'], content: {
        ...(validPayloads['context.propose']!.content as Record<string, unknown>), adminGrant: true } }],
      ['context.propose', { ...validPayloads['context.propose'], content: {
        ...(validPayloads['context.propose']!.content as Record<string, unknown>), goal: undefined } }],
      ['investigate.submit', { ...validPayloads['investigate.submit'], input: {
        ...(validPayloads['investigate.submit']!.input as Record<string, unknown>), shell: 'echo unsafe' } }],
    ] as const) {
      const rejected = await client.callTool({ name, arguments: {
        scope: { workspaceId: 'ws-approved', collaborationId: 'col-approved' }, payload,
        idempotencyKey: `nested-invalid-${name}`,
      } });
      assert.equal(rejected.isError, true, `${name} rejects invalid nested shape`);
    }
    assert.equal(calls.length, 0);
    for (const [name, payload] of [
      ['repo.read', { workingCopyId: 'copy', snapshotId: 'snap', path: 'README.md', maxLines: 3 }],
      ['repo.search', { workingCopyId: 'copy', snapshotId: 'snap', term: 'needle', maxMatches: 2 }],
      ['context.propose', { proposalId: 'proposal', parentRevisionId: null, snapshotId: 'snap',
        sourceRefs: [], content: { goal: 'review', constraints: [], acceptedDecisions: [],
          rejectedDecisions: [], currentQuestions: [], evidenceRefs: [], expectedDeliverables: [],
          unknowns: [], recentChanges: [] } }],
      ['investigate.submit', { workingCopyId: 'copy', input: { contextRevisionId: 'ctx',
        snapshotRef: 'snap', question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'] } }],
    ] as const) {
      const response = await client.callTool({ name, arguments: {
        scope: { workspaceId: 'ws-approved', collaborationId: 'col-approved' }, payload,
        ...(['context.propose', 'investigate.submit'].includes(name) ? { idempotencyKey: `valid-${name}` } : {}),
      } });
      assert.equal(response.isError, undefined);
    }
    assert.deepEqual(calls.map((call) => call.operation),
      ['repo.read', 'repo.search', 'context.propose', 'investigate.submit']);
    assert.deepEqual(calls[0]?.payload, { workingCopyId: 'copy', snapshotId: 'snap', path: 'README.md', maxLines: 3 });
  } finally { await client.close(); await server.close(); }
});

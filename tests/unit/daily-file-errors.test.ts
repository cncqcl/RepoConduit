import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createDailyMcpServer, type DailyMcpOptions } from '../../src/adapters/mcp/daily-server.js';
import { createPlatformFileDownloadResolver, PlatformFileDownloadError } from '../../src/adapters/mcp/platform-file-download.js';
import type { DailyUseApplication } from '../../src/application/daily-use.js';

const secret = 'PRIVATE_FILE_REFERENCE_SECRET';
const file = { download_url: `https://files.example.test/original?token=${secret}`,
  file_id: `file-${secret}`, file_name: 'payload(1).bin', mime_type: 'application/octet-stream' };
const binding = { topicHandle: 'col_topic', title: 'Topic', projectId: 'ws_project', question: 'Read',
  workspaceId: 'ws_project', collaborationId: 'col_topic', workingCopyId: 'wc_copy', snapshotId: 'snp_frozen', contextRevisionId: 'ctx_frozen' };
type Resolver = NonNullable<DailyMcpOptions['resolveFileTransfer']>;

// Adapter/SDK fault tests. The fake application does not establish real authorization or storage.
async function withClient(resolver: Resolver, action: (client: Client, operations: string[]) => Promise<void>,
  dispatch?: DailyMcpOptions['dispatcher']['dispatch']) {
  const operations: string[] = [];
  const server = createDailyMcpServer({
    daily: { resolveTopic: async () => binding } as unknown as DailyUseApplication,
    context: { principal: 'external', audience: 'external', recipient: 'external', surface: 'external_mcp', now: new Date() },
    dispatcher: { dispatch: async (...args) => {
      operations.push(args[1].operation);
      return dispatch ? dispatch(...args) : {};
    } }, resolveFileTransfer: resolver,
  });
  const client = new Client({ name: 'file-failure-regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); await action(client, operations); }
  finally { await client.close(); await server.close(); }
}

async function deliver(client: Client, selected: object) {
  const result = await client.callTool({ name: 'deliver_files', arguments: { topic: 'col_topic', version: 'v1', files: [selected] } });
  assert.equal(result.isError, true);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('https://'));
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
}

test('daily file diagnostics preserve the official optional file metadata schema', async () => {
  await withClient(() => { throw new Error(secret); }, async client => {
    const tool = (await client.listTools()).tools.find(t => t.name === 'deliver_files')!;
    const items = (tool.inputSchema.properties as Record<string, { items: { required: string[]; properties: object } }>).files!.items;
    assert.deepEqual([...items.required].sort(), ['download_url', 'file_id']);
    assert.deepEqual(Object.keys(items.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  });
});

test('daily file missing target name is a preflight rejection with no resolver or delivery', async () => {
  let resolutions = 0;
  await withClient(() => { resolutions++; throw new Error(secret); }, async (client, operations) => {
    const unnamed = { download_url: file.download_url, file_id: file.file_id, mime_type: file.mime_type };
    for (const selected of [unnamed, { ...file, file_name: '' }]) {
      const result = await deliver(client, selected);
      assert.equal(result.failurePhase, 'file_reference_preflight');
      assert.equal(result.failureReason, 'target_name_missing');
      assert.equal(result.manualImportAvailable, true);
    }
    assert.equal(resolutions, 0); assert.deepEqual(operations, []);
  });
});

test('daily file rejected references expose fixed input reasons without DNS, bytes or secrets', async () => {
  let dns = 0; let requests = 0;
  const resolver = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'] }, {
    async resolveAddresses() { dns++; throw new Error(secret); }, request() { requests++; throw new Error(secret); },
  });
  await withClient(resolver, async (client, operations) => {
    for (const [selected, reason] of [
      [{ ...file, download_url: `http://files.example.test/${secret}` }, 'invalid_url'],
      [{ ...file, download_url: `https://unapproved.example.test/${secret}` }, 'origin_not_allowed'],
      [{ ...file, file_id: '' }, 'invalid_file_id'],
      [{ ...file, mime_type: `bad-${secret}` }, 'invalid_mime'],
    ] as const) {
      const result = await deliver(client, selected);
      assert.equal(result.failurePhase, 'file_reference_preflight');
      assert.equal(result.downloadStage, 'input'); assert.equal(result.failureReason, reason);
      assert.equal(result.automaticAttemptsExhausted, false);
    }
    assert.deepEqual(operations, []); assert.equal(dns, 0); assert.equal(requests, 0);
  });
});

test('daily file unknown resolver errors disclose no original error', async () => {
  await withClient(() => { throw new Error(secret, { cause: new Error(file.download_url) }); }, async (client, operations) => {
    const result = await deliver(client, file);
    assert.equal(result.failurePhase, 'file_reference_preflight'); assert.equal(result.failureReason, 'unclassified');
    assert.equal(result.downloadStage, undefined); assert.deepEqual(operations, []);
  });
});

const transfer: ReturnType<Resolver> = { referenceIdentity: 'fixed-reference', mediaType: 'application/octet-stream',
  async acquireBytes() { return Buffer.from([0, 255, 1]); } };

test('daily file delivery rejection is distinguished from reference preflight', async () => {
  await withClient(() => transfer, async (client, operations) => {
    const result = await deliver(client, file);
    assert.equal(result.failurePhase, 'delivery'); assert.equal(result.failureReason, 'unclassified');
    assert.deepEqual(operations, ['artifact.begin']);
  }, async () => { throw new Error(secret); });
});

test('daily file import failure preserves download stage and the already-started call sequence', async () => {
  await withClient(() => transfer, async (client, operations) => {
    const result = await deliver(client, file);
    assert.equal(result.failurePhase, 'delivery'); assert.equal(result.downloadStage, 'http_status');
    assert.equal(result.automaticAttemptsExhausted, true);
    assert.deepEqual(operations, ['artifact.begin', 'artifact.import_reference']);
  }, async (_ctx, command) => {
    if (command.operation === 'artifact.import_reference') throw new PlatformFileDownloadError('http_status', true);
    return {};
  });
});

test('daily file ordinary original bytes and platform duplicate filename reach finalize unchanged', async () => {
  let acquired: Buffer | undefined;
  await withClient(() => transfer, async (client, operations) => {
    const result = await client.callTool({ name: 'deliver_files', arguments: { topic: 'col_topic', version: 'v1', files: [file] } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(acquired, Buffer.from([0, 255, 1]));
    assert.deepEqual(operations, ['artifact.begin', 'artifact.import_reference', 'artifact.finalize']);
  }, async (_ctx, command, source) => {
    if (command.operation === 'artifact.import_reference') {
      assert.equal((command.payload as { path: string }).path, 'payload(1).bin');
      acquired = await source!.acquireBytes(1024);
    }
    return { state: 'published' };
  });
});

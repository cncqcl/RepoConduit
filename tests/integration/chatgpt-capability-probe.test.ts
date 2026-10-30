import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { syntheticFileObservation } from '../../tools/synthetic-file-observation.mjs';

test('synthetic byte observation keeps exact byte identity without signed metadata or contents', () => {
  const bytes = Buffer.from('RepoConduit synthetic bytes 2026-09-28\n', 'utf8');
  const file = { download_url: 'https://sdmntprcentralus.oaiusercontent.com/object?signature=synthetic-secret',
    file_id: 'synthetic-file-id-secret', mime_type: 'text/plain', file_name: 'rcac-byte-probe.txt' };
  const observation = syntheticFileObservation('run-1', file, bytes);
  assert.equal(observation.byteCount, bytes.length);
  assert.equal(observation.byteSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(observation.fileIdSha256, createHash('sha256').update(file.file_id).digest('hex'));
  assert.equal(observation.downloadOrigin, 'https://sdmntprcentralus.oaiusercontent.com');
  const serialized = JSON.stringify(observation);
  for (const secret of [file.download_url, file.file_id, bytes.toString('utf8')]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('synthetic file probe advertises file params and refuses unlisted origins without leaking signed metadata', async () => {
  const child = spawn(process.execPath, [resolve('tools/chatgpt-capability-probe.mjs')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const client = new Client({ name: 'synthetic-file-probe-test', version: '1.0.0' });
  let connected = false;
  let stderr = '';
  const rawId = 'synthetic-file-id-secret';
  const rawUrl = 'https://files.example.test/object?signature=synthetic-secret';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Probe did not start')), 5000);
      child.once('error', reject);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const line = output.split('\n')[0];
        if (line && output.includes('\n')) {
          clearTimeout(timer);
          resolveUrl((JSON.parse(line) as { url: string }).url);
        }
      });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    connected = true;
    const { tools } = await client.listTools();
    const tool = tools.find(entry => entry.name === 'probe.file_reference');
    assert.ok(tool);
    assert.deepEqual(tool._meta?.['openai/fileParams'], ['file']);
    const fileSchema = tool.inputSchema.properties?.file as {
      required: string[]; properties: Record<string, unknown>;
    };
    assert.deepEqual(fileSchema.required, ['download_url', 'file_id']);
    assert.deepEqual(Object.keys(fileSchema.properties).sort(),
      ['download_url', 'file_id', 'file_name', 'mime_type']);
    const response = await client.callTool({ name: 'probe.file_reference', arguments: {
      file: { download_url: rawUrl, file_id: rawId, mime_type: 'application/octet-stream', file_name: 'dummy.bin' },
    } });
    assert.equal(response.isError, true);
    const body = JSON.stringify(response);
    assert.equal(body.includes(rawId), false);
    assert.equal(body.includes(rawUrl), false);
    assert.equal((response.content[0] as { text: string }).text, 'Synthetic file bytes unavailable');
    const rejected = await client.callTool({ name: 'probe.file_reference', arguments: {
      file: { download_url: 'http://files.example.test/object?signature=reject-secret', file_id: rawId },
    } });
    assert.equal(rejected.isError, true);
    assert.equal(JSON.stringify(rejected).includes(rawId), false);
  } finally {
    try { if (connected) await client.close(); }
    finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolveClose, rejectClose) => {
          const timeout = setTimeout(() => rejectClose(new Error('Probe did not exit')), 3000);
          child.once('close', () => { clearTimeout(timeout); resolveClose(); });
        });
        child.kill('SIGINT');
        try { await closed; }
        finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
      }
    }
  }
  assert.match(stderr, /probe_file_download_failed run=[0-9a-f-]+ stage=input origin=https:\/\/files\.example\.test/);
  assert.equal(stderr.includes(rawId), false);
  assert.equal(stderr.includes(rawUrl), false);
  assert.equal(stderr.includes('reject-secret'), false);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseCodexStartupArguments } from '../../src/cli/codex-investigation.js';

const moduleUrl = pathToFileURL(resolve('tools/stdio-observation.mjs')).href;
const source = 'export const fixture = true;\n';
const sourceBytes = Buffer.byteLength(source);
const sourceHash = createHash('sha256').update(source).digest('hex');
const scope = { root: 'C:/fixed-case', profileRevision: 'profile_fixed',
  workspaceId: 'd239_ws', collaborationId: 'd239_web_col',
  workingCopyId: 'd239_copy', snapshotId: 'snp_fixed',
  files: [{ path: 'web-live-src/state.ts', sha256: sourceHash, bytes: sourceBytes },
    { path: 'web-live-src/cancel.ts', sha256: 'b'.repeat(64) },
    { path: 'web-live-src/publish.ts', sha256: 'c'.repeat(64) }] };
const request = (id: string, workspaceId = scope.workspaceId, path = scope.files[0]!.path) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'repo.read',
    arguments: { scope: { workspaceId, collaborationId: scope.collaborationId },
      payload: { workingCopyId: scope.workingCopyId, snapshotId: scope.snapshotId, path,
        secret: 'REQUEST_SECRET' } } } });
const response = (id: string, path = scope.files[0]!.path, content = source,
  contentHash = sourceHash) => ({ jsonrpc: '2.0', id,
  result: { content: [{ type: 'text', text: JSON.stringify({ snapshotId: scope.snapshotId, path,
    content, contentHash, byteRange: { start: 0, end: sourceBytes },
    lineRange: { start: 1, end: 1 }, completeness: 'complete', secret: 'CURSOR_SECRET' }) }] } });

test('matched fixed repo.read response records only bounded evidence fields', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${JSON.stringify(request('ID_SECRET'))}\n`);
  observation.observeOutput(`${JSON.stringify(response('ID_SECRET'))}\n`);
  const encoded = JSON.stringify(events);
  assert.match(encoded, /"kind":"repo_read"/);
  assert.match(encoded, new RegExp(`"contentHash":"${sourceHash}"`));
  assert.match(encoded, /"evidenceKind":"transport_observed"/);
  for (const secret of ['ID_SECRET', 'REQUEST_SECRET', source, 'CURSOR_SECRET']) {
    assert.equal(encoded.includes(secret), false);
  }
});

test('wrong scope, path, and response id cannot produce read evidence', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${JSON.stringify(request('wrong-workspace', 'other'))}\n`);
  observation.observeOutput(`${JSON.stringify(response('wrong-workspace'))}\n`);
  observation.observeInput(`${JSON.stringify(request('wrong-path', scope.workspaceId, 'private.txt'))}\n`);
  observation.observeOutput(`${JSON.stringify(response('wrong-path', 'private.txt'))}\n`);
  observation.observeInput(`${JSON.stringify(request('right'))}\n`);
  observation.observeOutput(`${JSON.stringify(response('unmatched'))}\n`);
  assert.equal(events.some(event => !!event && typeof event === 'object' && 'kind' in event && event.kind === 'repo_read'), false);
});

test('tool error and malformed result never become successful read evidence', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${JSON.stringify(request('error'))}\n`);
  observation.observeOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 'error', result: {
    isError: true, content: [{ type: 'text', text: 'TOKEN_SECRET' }] } })}\n`);
  observation.observeInput(`${JSON.stringify(request('malformed'))}\n`);
  observation.observeOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 'malformed', result: {
    content: [{ type: 'text', text: '{bad-json' }] } })}\n`);
  assert.equal(events.some(event => !!event && typeof event === 'object' && 'kind' in event && event.kind === 'repo_read'), false);
  assert.equal(JSON.stringify(events).includes('TOKEN_SECRET'), false);
});

test('forged declared hash with different content cannot count as a read', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${JSON.stringify(request('forged'))}\n`);
  observation.observeOutput(`${JSON.stringify(response('forged', scope.files[0]!.path,
    'x'.repeat(sourceBytes), sourceHash))}\n`);
  assert.equal(events.some(event => !!event && typeof event === 'object' && 'kind' in event && event.kind === 'repo_read'), false);
});

test('duplicate RPC ids invalidate read correlation', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${JSON.stringify(request('duplicate'))}\n${JSON.stringify(request('duplicate'))}\n`);
  observation.observeOutput(`${JSON.stringify(response('duplicate'))}\n`);
  assert.equal(events.some(event => !!event && typeof event === 'object' && 'kind' in event && event.kind === 'repo_read'), false);
});

test('unknown tool name and repeated invalid frames have bounded static logs', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${JSON.stringify({ ...request('unknown'), params: {
    name: 'SECRET_TOOL_NAME', arguments: request('unknown').params.arguments } })}\n`);
  for (let i = 0; i < 500; i++) observation.observeInput('{bad-json\n');
  observation.finish();
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes('SECRET_TOOL_NAME'), false);
  assert.ok(events.length <= 260);
  assert.equal((events.at(-1) as { complete?: boolean }).complete, false);
});

test('oversized frames cannot expose payload or claim a complete observation', async () => {
  const { createStdioObservation } = await import(moduleUrl);
  const events: unknown[] = [];
  const observation = createStdioObservation(scope, (event: unknown) => events.push(event));
  observation.observeInput(`${'FRAME_SECRET'.repeat(100_000)}\n`);
  observation.finish();
  assert.equal(JSON.stringify(events).includes('FRAME_SECRET'), false);
  assert.equal((events.at(-1) as { complete?: boolean }).complete, false);
});

test('installed serveMcp receives the data directory flag before the action', async () => {
  const { installedServeMcpArguments } = await import(moduleUrl);
  assert.deepEqual(installedServeMcpArguments(scope), ['--data-dir', scope.root, 'mcp',
    '--codex-workspace', scope.workspaceId, '--codex-profile', scope.profileRevision]);
});

test('installed serveMcp forwards the complete local runtime source selection', async () => {
  const { installedServeMcpArguments } = await import(moduleUrl);
  const runtimeSource = { dataDirectory: resolve('existing-runtime'), workspaceId: 'source_ws',
    profileRevision: 'profile_source' };
  const argv = installedServeMcpArguments({ ...scope, runtimeSource });
  assert.deepEqual(parseCodexStartupArguments(argv), { argv: ['--data-dir', scope.root, 'mcp'],
    selection: { workspaceId: scope.workspaceId, profileRevision: scope.profileRevision,
      runtimeSource } });
});

test('installed serveMcp rejects incomplete, malformed, and extra runtime source fields', async () => {
  const { installedServeMcpArguments } = await import(moduleUrl);
  const valid = { dataDirectory: resolve('existing-runtime'), workspaceId: 'source_ws',
    profileRevision: 'profile_source' };
  for (const runtimeSource of [null, {}, { ...valid, profileRevision: undefined },
    { ...valid, dataDirectory: 'relative' }, { ...valid, workspaceId: '../escape' },
    { ...valid, extra: 'unknown' }, ['invalid']]) {
    assert.throws(() => installedServeMcpArguments({ ...scope, runtimeSource }),
      /Invalid runtime source/);
  }
});

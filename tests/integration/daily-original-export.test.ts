import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { exportDailyOriginals } from '../../src/application/daily-original-export.js';
import type { DailyUseApplication } from '../../src/application/daily-use.js';
import type { Grant } from '../../src/core/policy/authorize.js';

const context = { principal: 'owner', audience: 'local-os', recipient: 'owner', surface: 'local_cli' as const, now: new Date() };
const grant: Grant = { id: 'export', ...context, workspaceId: 'A', permissions: ['artifact.export', 'data.read'],
  dataPaths: ['a/', 'b/', 'a.bin', 'b.bin'], expiresAt: null, revokedAt: null };
const daily = { async resolveTopic() { return { workspaceId: 'A', collaborationId: 'topic', snapshotId: 'frozen', workingCopyId: 'copy' }; } } as unknown as DailyUseApplication;

test('original export keeps nested filenames and exact binary bytes with a completion manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-original-export-'));
  const bytes = Buffer.from([0, 255, 13, 10]);
  try {
    const result = await exportDailyOriginals(daily, { async dispatch(_ctx, command) {
      const path = (command.payload as { path: string }).path;
      return { snapshotId: 'frozen', path, data: bytes.toString('base64'), byteLength: bytes.length,
        contentHash: createHash('sha256').update(bytes).digest('hex') };
    } }, () => [grant], context, root, { topicHandle: 'topic', paths: ['a/raw.bin', 'b/raw.bin'] });
    assert.ok(readFileSync(join(result.path, 'files', 'a', 'raw.bin')).equals(bytes));
    assert.ok(readFileSync(join(result.path, 'files', 'b', 'raw.bin')).equals(bytes));
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8')) as { snapshotId: string; files: unknown[] };
    assert.equal(manifest.snapshotId, 'frozen'); assert.equal(manifest.files.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('original export rejects external actors and revocation before any completed export is published', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-original-export-')); let revoked = false;
  try {
    const dispatch = { async dispatch() { revoked = true; return {}; } };
    await assert.rejects(exportDailyOriginals(daily, dispatch, () => [grant], { ...context, surface: 'external_mcp' }, root,
      { topicHandle: 'topic', paths: ['a.bin'] }));
    await assert.rejects(exportDailyOriginals(daily, dispatch, () => revoked ? [] : [grant], context, root,
      { topicHandle: 'topic', paths: ['a.bin'] }));
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['narrow', 'revoke'] as const) test(`original export rechecks all selected paths when read permission changes: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-original-export-')); let current = grant;
  const bytes = Buffer.from([0, 255]);
  try {
    await assert.rejects(exportDailyOriginals(daily, { async dispatch(_ctx, command) {
      const path = (command.payload as { path: string }).path;
      if (path === 'b.bin') current = mode === 'narrow' ? { ...grant, dataPaths: ['b.bin'] }
        : { ...grant, permissions: ['artifact.export'] };
      return { snapshotId: 'frozen', path, data: bytes.toString('base64'), byteLength: bytes.length,
        contentHash: createHash('sha256').update(bytes).digest('hex') };
    } }, () => [current], context, root, { topicHandle: 'topic', paths: ['a.bin', 'b.bin'] }));
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

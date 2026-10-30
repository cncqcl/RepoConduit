import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDailyBinding } from '../../src/cli/daily-binding.js';

const base = { principal: 'personal-synthetic', audience: 'repo-conduit-daily',
  recipient: 'chatgpt-personal', allowedFileOrigins: ['https://files.example.test'] };
const sourceRoot = process.platform === 'win32' ? 'C:/private/synthetic-data' : '/private/synthetic-data';

test('optional trusted Codex source parses without replacing recipient or source policy', () => {
  const codexRuntimeSource = { dataDirectory: sourceRoot,
    workspaceId: 'ws_source', profileRevision: 'pr_source' };
  assert.deepEqual(parseDailyBinding({ ...base, fileSourcePolicy: 'chatgpt-official-v1',
    codexRuntimeSource }), { ...base, fileSourcePolicy: 'chatgpt-official-v1', codexRuntimeSource });
  assert.deepEqual(parseDailyBinding(base), base);
});

test('trusted source binding rejects relative, partial and executable input', () => {
  for (const codexRuntimeSource of [
    { dataDirectory: 'relative', workspaceId: 'ws', profileRevision: 'pr' },
    { dataDirectory: sourceRoot, workspaceId: 'ws' },
    { dataDirectory: sourceRoot, workspaceId: 'ws', profileRevision: 'pr', executable: 'cmd.exe' },
    { dataDirectory: sourceRoot, workspaceId: '../other', profileRevision: 'pr' },
  ]) assert.throws(() => parseDailyBinding({ ...base, codexRuntimeSource }));
  assert.throws(() => parseDailyBinding({ ...base, unknownRuntime: true }));
});

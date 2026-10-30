import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDailyInbox } from '../../src/application/daily-delivery.js';

test('daily inbox follows internal cursors so an eleventh version remains discoverable', async () => {
  const seen: unknown[] = [];
  const result = await readDailyInbox({ async dispatch(_ctx, command) {
    seen.push(command.payload);
    return (command.payload as { cursor?: string }).cursor === undefined
      ? { bundles: Array.from({ length: 10 }, (_, n) => ({ bundleId: `v${n + 1}` })), nextCursor: 'private-page-2' }
      : { bundles: [{ bundleId: 'v11' }], nextCursor: null };
  } }, { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli', now: new Date() },
  { workspaceId: 'A', collaborationId: 'topic-A' });
  assert.equal(result.bundles.length, 11);
  assert.equal(result.truncated, false);
  assert.deepEqual(seen, [{}, { cursor: 'private-page-2' }]);
});

test('daily inbox refuses repeated cursors and does not disguise a failed page as complete', async () => {
  await assert.rejects(readDailyInbox({ async dispatch() { return { bundles: [], nextCursor: 'same' }; } },
    { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli', now: new Date() },
    { workspaceId: 'A', collaborationId: 'topic-A' }), /cursor/i);
});

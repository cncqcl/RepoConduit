import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const helper = await import(pathToFileURL(resolve('tools/package-smoke-lifecycle.mjs')).href);

test('smoke closure confirmation requires the owned transport close event', async () => {
  let priorCalls = 0;
  const transport = { onclose: () => { priorCalls++; } };
  const wait = helper.observeSmokeTransportClosure(transport) as (timeout: number) => Promise<void>;
  await assert.rejects(wait(10), /Installed MCP child exit unconfirmed/);
  transport.onclose();
  await wait(10);
  assert.equal(priorCalls, 1);
});

test('smoke waits for a late native close event and clears its timer', async () => {
  const transport: { onclose?: () => void } = {};
  const wait = helper.observeSmokeTransportClosure(transport) as (timeout: number) => Promise<void>;
  const closing = wait(100);
  transport.onclose?.();
  await closing;
});

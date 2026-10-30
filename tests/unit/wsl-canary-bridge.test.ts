import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { readWslCanaryBridge } from '../../src/runtime/investigation-canary-supervisor.js';

test('canary bridge waits asynchronously so heartbeat and cancellation can run', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    assert.equal(await readWslCanaryBridge(child, undefined, 1000), 'exited');
    assert.ok(ticks >= 3);
  } finally { clearInterval(timer); }
});

test('abort of a running bridge is unknown, not proof that the WSL unit stopped', async () => {
  const controller = new AbortController();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const read = readWslCanaryBridge(child, controller.signal, 1000);
  setTimeout(() => controller.abort(), 20);
  assert.equal(await read, 'unknown');
});

test('bridge output or elapsed-time limit yields unknown', async () => {
  const noisy = spawn(process.execPath, ['-e', 'process.stdout.write("a".repeat(5000))'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(await readWslCanaryBridge(noisy, undefined, 1000), 'unknown');
  const slow = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(await readWslCanaryBridge(slow, undefined, 30), 'unknown');
});

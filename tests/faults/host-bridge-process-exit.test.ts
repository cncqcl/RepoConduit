import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const childSource = `
import { HostConversationBridge } from './src/cli/host-conversation.ts';
const bridge = new HostConversationBridge(process.stdin, process.stdout, { timeoutMs: 25 });
let settled = false;
try {
  await bridge.run(async () => {
    try {
      await bridge.request({ kind: 'observe', target: { workspaceId: 'a', collaborationId: 'c' } });
      throw new Error('unexpected response');
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'HOST_BRIDGE_UNAVAILABLE') throw error;
      settled = true;
      return { status: 'unknown' };
    }
  });
  throw new Error('bridge unexpectedly succeeded');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'HOST_BRIDGE_UNAVAILABLE' || !settled) throw error;
  process.stderr.write('DRAINED_UNKNOWN\\n');
}
`;

test('timed-out bridge drains dispatch and exits with parent stdin still open', { timeout: 8_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    child.stdin.write(`${JSON.stringify({ type: 'command', requestId: 'synthetic', command: { operation: 'synthetic' } })}\n`);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, null, `child did not exit naturally: ${stderr}`);
    assert.equal(result.code, 0, stderr);
    assert.match(stdout, /"type":"action"/);
    assert.match(stderr, /DRAINED_UNKNOWN/);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});

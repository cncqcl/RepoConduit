import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('MCP stdio transport exposes EOF closure for application shutdown', async () => {
  const script = `import { startExternalStdio } from './src/adapters/mcp/stdio.ts';
    const handle = startExternalStdio({ dispatcher: { dispatch: async () => ({}) },
      context: { principal: 'p', audience: 'a', recipient: 'r', surface: 'external_mcp', now: new Date() },
      visibleOperations: [], allowedWorkspaceId: 'a' });
    handle.closed.then(() => process.stderr.write('TRANSPORT_CLOSED\\n'));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const exit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP EOF shutdown timed out')); }, 10_000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0, stderr);
  assert.match(stderr, /TRANSPORT_CLOSED/);
});

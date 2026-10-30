import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const client = new Client({ name: 'pipe-fixture', version: '1.0.0' });
process.send?.({ stage: 'connecting' });
try {
  await client.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 }));
  process.send?.({ ready: true });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : 'ERROR' });
  process.exit(1);
}
process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const command = message as { id: number; args: Record<string, unknown>; action?: string };
  if (command.action === 'half-close') { process.stdout.end(); return; }
  if (command.action === 'oversized') { process.stdout.write('x'.repeat(256 * 1024 + 1)); return; }
  try {
    const result = await client.callTool({ name: 'repo.read', arguments: command.args });
    process.send?.({ id: command.id, result });
  } catch (error) {
    process.send?.({ id: command.id, error: error instanceof Error ? error.message : 'ERROR' });
  }
});

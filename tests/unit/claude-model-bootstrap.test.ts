import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, CLAUDE_MODEL_BOOTSTRAP_SHA256,
  encodeClaudeModelBootstrapFrame } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import { buildClaudeMcpSandboxSpec } from
  '../../src/adapters/secondary-investigator/claude-mcp-sandbox-spec.js';

test('bootstrap frame snapshots raw bytes behind exact closed header', () => {
  const bytes = Buffer.from([0, 10, 13, 255, 1]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const frame = encodeClaudeModelBootstrapFrame(bytes, hash);
  const split = frame.indexOf(10);
  assert.deepEqual(JSON.parse(frame.subarray(0, split).toString('utf8')),
    { protocol: 'claude_model_bootstrap_v1', byteLength: 5, sha256: hash });
  assert.deepEqual(frame.subarray(split + 1), bytes);
  bytes[0] = 99;
  assert.equal(frame[split + 1], 0);
  assert.equal(CLAUDE_MODEL_BOOTSTRAP_SHA256,
    createHash('sha256').update(CLAUDE_MODEL_BOOTSTRAP_PYTHON).digest('hex'));
  assert.ok(split < 512);
});

test('bootstrap encoder rejects empty, oversized, mutable hash and nonbuffer input', () => {
  const one = Buffer.from('x');
  const hash = createHash('sha256').update(one).digest('hex');
  for (const bad of [Buffer.alloc(0), Buffer.alloc(16385)])
    assert.throws(() => encodeClaudeModelBootstrapFrame(bad, hash));
  assert.throws(() => encodeClaudeModelBootstrapFrame(one, 'a'.repeat(64)));
  assert.throws(() => encodeClaudeModelBootstrapFrame(one, hash.toUpperCase()));
  assert.throws(() => encodeClaudeModelBootstrapFrame('x' as never, hash));
});

test('fixed Python exec argv and environment equal the MCP sandbox builder tail', () => {
  const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
    srtSettingsFile: '/home/fixture/settings/srt.json', mcpConfigFile: '/home/fixture/settings/mcp.json',
    helperFile: '/home/fixture/settings/mcp-fifo.py',
    privateFifoDirectory: '/home/fixture/private/attempt_11111111-1111-4111-8111-111111111111-1.mcp',
    privateAuthHome: '/home/fixture/auth' };
  const spec = buildClaudeMcpSandboxSpec(paths);
  const tail = spec.argv.slice(spec.argv.indexOf('--') + 1);
  const exec = CLAUDE_MODEL_BOOTSTRAP_PYTHON.match(/^os\.execve\(('[^']+'), (\[[^\n]+\]), (\{[^\n]+\})\)$/m);
  assert.ok(exec, 'exactly one fixed final execve line');
  const parseLiteral = (value: string) => JSON.parse(value.replaceAll("'", '"')) as unknown;
  assert.equal(parseLiteral(exec[1]!), tail[0]);
  assert.deepEqual(parseLiteral(exec[2]!.replace('sys.argv[1]', "'3'")),
    [...tail, '--max-turns', '3']);
  assert.match(CLAUDE_MODEL_BOOTSTRAP_PYTHON,
    /len\(sys\.argv\) != 2 or sys\.argv\[1\] not in \('1','2','3','4','5','6','7','8'\)/);
  assert.deepEqual(parseLiteral(exec[3]!), spec.env);
});

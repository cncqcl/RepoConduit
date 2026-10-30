import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CLAUDE_MCP_FIFO_PYTHON } from
  '../../src/adapters/secondary-investigator/claude-mcp-fifo-helper.js';
import { fixedClaudeMcpConfig } from
  '../../src/adapters/secondary-investigator/claude-mcp-sandbox-spec.js';
import { buildClaudeModelLaunchConfig, cloneValidateClaudeModelLaunchConfig } from
  '../../src/adapters/secondary-investigator/claude-model-launch-config.js';

test('fixed config contains only three mounted bodies and strict synthetic SRT policy', () => {
  const profile = { allowedDomains: [] as string[] };
  const config = buildClaudeModelLaunchConfig(profile);
  assert.equal(config.version, 'claude_model_launch_config_v1');
  assert.deepEqual(config.files.map(file => file.target),
    ['/opt/srt.json', '/opt/mcp.json', '/opt/mcp-fifo.py']);
  for (const file of config.files) {
    assert.ok(Buffer.isBuffer(file.bytes));
    assert.equal(file.byteLength, file.bytes.length);
    assert.equal(file.sha256, createHash('sha256').update(file.bytes).digest('hex'));
    assert.ok(file.byteLength <= 64 * 1024);
  }
  assert.ok(config.files.reduce((sum, file) => sum + file.byteLength, 0) <= 128 * 1024);
  assert.deepEqual(JSON.parse(config.files[0].bytes.toString('utf8')), {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true,
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: { disabled: false, denyRead: ['/mnt'], allowRead: [],
      allowWrite: ['/relay/out', '/relay/helper.lock'], denyWrite: [] },
    enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
  });
  assert.deepEqual(JSON.parse(config.files[1].bytes.toString('utf8')), fixedClaudeMcpConfig());
  assert.equal(config.files[2].bytes.toString('utf8'), CLAUDE_MCP_FIFO_PYTHON);
  assert.deepEqual(cloneValidateClaudeModelLaunchConfig(config, profile), config);
});

test('domain policy is narrow, explicit and copied before building', () => {
  const profile = { allowedDomains: ['api.anthropic.com', 'example.org:443'] };
  const config = buildClaudeModelLaunchConfig(profile);
  profile.allowedDomains[0] = 'other.example.org';
  const srt = JSON.parse(config.files[0].bytes.toString('utf8'));
  assert.deepEqual(srt.network.allowedDomains, ['api.anthropic.com', 'example.org:443']);
  for (const value of ['*', '*.example.com', 'EXAMPLE.com', 'example.com:80',
    'localhost', 'foo.localhost', 'foo.local', 'foo.internal', '127.0.0.1',
    '192.168.1.1:443', '[::1]:443', 'example..com', '-bad.example.com',
    'bad-.example.com', 'singlelabel', 'example.com.', 'example.com/path',
    'home.arpa', 'child.home.arpa',
    'a'.repeat(64) + '.com', 'example.123', 'a'.repeat(254) + '.com']) {
    assert.throws(() => buildClaudeModelLaunchConfig({ allowedDomains: [value] }), value);
  }
  assert.throws(() => buildClaudeModelLaunchConfig({ allowedDomains:
    ['api.example.com', 'api.example.com'] }));
  assert.throws(() => buildClaudeModelLaunchConfig({ allowedDomains:
    Array.from({ length: 33 }, (_, i) => `api${i}.example.com`) }));
  const oversizedDomains = new Proxy(Array<string>(33), {
    get(target, property, receiver) {
      if (property === '0') throw new Error('domain array copied before length check');
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => buildClaudeModelLaunchConfig({ allowedDomains: oversizedDomains }),
    /too many allowed domains/);
  assert.throws(() => buildClaudeModelLaunchConfig({} as never));
  assert.throws(() => buildClaudeModelLaunchConfig({ allowedDomains: [], extra: true } as never));
});

test('clone validation rejects mutated bytes, hashes, metadata, and extra authority', () => {
  const profile = { allowedDomains: [] };
  const config = buildClaudeModelLaunchConfig(profile);
  const copy = cloneValidateClaudeModelLaunchConfig(config, profile);
  copy.files[0].bytes[0] = 88;
  assert.notEqual(config.files[0].bytes[0], 88);
  for (const index of [0, 1, 2] as const) {
    const broken = buildClaudeModelLaunchConfig(profile);
    broken.files[index]!.bytes[0]! ^= 1;
    assert.throws(() => cloneValidateClaudeModelLaunchConfig(broken, profile));
  }
  const hash = buildClaudeModelLaunchConfig(profile);
  hash.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => cloneValidateClaudeModelLaunchConfig(hash, profile));
  const length = buildClaudeModelLaunchConfig(profile);
  length.files[0].byteLength++;
  assert.throws(() => cloneValidateClaudeModelLaunchConfig(length, profile));
  const target = buildClaudeModelLaunchConfig(profile);
  target.files[0].target = '/opt/mcp.json';
  assert.throws(() => cloneValidateClaudeModelLaunchConfig(target, profile));
  const widened = buildClaudeModelLaunchConfig(profile);
  (widened.files[0] as object as Record<string, unknown>).extra = true;
  assert.throws(() => cloneValidateClaudeModelLaunchConfig(widened, profile));
  const widenedRoot = buildClaudeModelLaunchConfig(profile);
  (widenedRoot as object as Record<string, unknown>).extra = true;
  assert.throws(() => cloneValidateClaudeModelLaunchConfig(widenedRoot, profile));
  const wrongProfile = buildClaudeModelLaunchConfig({ allowedDomains: ['api.example.com'] });
  assert.throws(() => cloneValidateClaudeModelLaunchConfig(wrongProfile, profile));
  const oversized = buildClaudeModelLaunchConfig(profile);
  const oversizedBody = Buffer.alloc(64 * 1024 + 1);
  oversized.files[0].bytes = oversizedBody;
  oversized.files[0].byteLength = oversizedBody.length;
  const bufferClass = Buffer as unknown as { from: (...args: unknown[]) => Buffer };
  const originalFrom = bufferClass.from;
  let copiedOversizedBody = false;
  try {
    bufferClass.from = (...args: unknown[]) => {
      if (args[0] === oversizedBody) copiedOversizedBody = true;
      return Reflect.apply(originalFrom, Buffer, args) as Buffer;
    };
    assert.throws(() => cloneValidateClaudeModelLaunchConfig(oversized, profile));
    assert.equal(copiedOversizedBody, false, 'oversized caller bytes must be rejected before copy');
  } finally {
    bufferClass.from = originalFrom;
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildClaudeModelSealedLaunch } from '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { buildClaudeMcpSandboxSpec } from '../../src/adapters/secondary-investigator/claude-mcp-sandbox-spec.js';

const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
  srtSettingsFile: '/home/fixture/config/srt.json', mcpConfigFile: '/home/fixture/config/mcp.json',
  helperFile: '/home/fixture/config/helper.py', privateAuthHome: '/home/fixture/auth',
  privateFifoDirectory: '/home/fixture/relay/attempt_11111111-1111-4111-8111-111111111111-1.mcp' };

test('sealed recipe replaces every host config bind with exact fixed data descriptors', () => {
  const launch = buildClaudeModelSealedLaunch(paths, { allowedDomains: [] }, 3);
  assert.equal(launch.recipe.recipe, 'claude_model_bootstrap_config_v3');
  assert.deepEqual(launch.recipe.argv.slice(-11), ['--ro-bind-data', '10', '/opt/rcac-bootstrap.py',
    '--info-fd', '11', '--', '/usr/bin/python3', '-I', '-S', '/opt/rcac-bootstrap.py', '3']);
  assert.deepEqual(launch.recipe.configFiles, launch.config.files.map(({ target, byteLength, sha256 }) =>
    ({ target, byteLength, sha256 })));
  for (const path of [paths.srtSettingsFile, paths.mcpConfigFile, paths.helperFile])
    assert.equal(launch.recipe.argv.includes(path), false);
  for (const [index, target] of ['/opt/srt.json', '/opt/mcp.json', '/opt/mcp-fifo.py'].entries()) {
    const position = launch.recipe.argv.indexOf(target);
    assert.deepEqual(launch.recipe.argv.slice(position - 2, position + 1),
      ['--ro-bind-data', String(12 + index), target]);
    assert.equal(launch.recipe.argv.filter(value => value === target).length, 1);
  }
  assert.equal(launch.commandDigest, createHash('sha256').update(JSON.stringify(launch.recipe)).digest('hex'));
  assert.notEqual(launch.commandDigest,
    createHash('sha256').update(JSON.stringify(buildClaudeMcpSandboxSpec(paths))).digest('hex'));
});

test('recipe metadata and startup bytes share the same copied configuration', () => {
  const profile = { allowedDomains: ['example.invalid'] };
  const launch = buildClaudeModelSealedLaunch(paths, profile, 3);
  profile.allowedDomains[0] = 'other.invalid';
  const boundary = launch.startupInput.indexOf(10);
  assert.deepEqual(JSON.parse(launch.startupInput.subarray(0, boundary).toString('ascii')),
    { protocol: 'claude_model_config_input_v1', files: launch.recipe.configFiles });
  assert.deepEqual(launch.startupInput.subarray(boundary + 1),
    Buffer.concat(launch.config.files.map(file => file.bytes)));
  assert.notEqual(launch.commandDigest, buildClaudeModelSealedLaunch(paths, profile, 3).commandDigest);
  const digest = launch.commandDigest;
  launch.config.files[0].bytes.fill(0);
  assert.equal(launch.commandDigest, digest);
  assert.equal(createHash('sha256').update(launch.startupInput.subarray(boundary + 1,
    boundary + 1 + launch.recipe.configFiles[0]!.byteLength)).digest('hex'),
  launch.recipe.configFiles[0]!.sha256);
});

test('turn limit is mandatory, bounded and committed in digest', () => {
  const profile = {allowedDomains: []};
  for (const invalid of [undefined, 0, 9, 1.5, NaN, Infinity])
    assert.throws(() => buildClaudeModelSealedLaunch(paths, profile, invalid as number));
  const digests = [1, 2, 8].map(cap => buildClaudeModelSealedLaunch(paths, profile, cap).commandDigest);
  assert.equal(new Set(digests).size, 3);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaudeInvestigationRuntimeConfiguration,
  deriveClaudeInvestigationRuntimePaths } from '../../src/runtime/claude-investigation-runtime-config.js';

const config = () => ({ recipe: 'claude_model_bootstrap_config_v3', distro: 'Ubuntu',
  linuxUser: 'investigator',
  relayRoot: '/home/investigator/relays',
  paths: { installRoot: '/home/investigator/runtime', nodeRoot: '/home/investigator/node',
    srtSettingsFile: '/home/investigator/srt.json', mcpConfigFile: '/home/investigator/mcp.json',
    helperFile: '/home/investigator/helper.py', privateAuthHome: '/home/investigator/auth' },
  profile: { allowedDomains: ['api.anthropic.com'] } });
const attemptId = 'attempt_00000000-0000-0000-0000-000000000001';

test('fixed runtime configuration derives one attempt path without asserting availability', () => {
  const original = config();
  const parsed = parseClaudeInvestigationRuntimeConfiguration(original);
  original.profile.allowedDomains.push('example.com');
  assert.deepEqual(parsed.profile.allowedDomains, ['api.anthropic.com']);
  assert.equal(Object.hasOwn(parsed, 'verified'), false);
  assert.equal(deriveClaudeInvestigationRuntimePaths(parsed, attemptId, 2).privateFifoDirectory,
    `/home/investigator/relays/${attemptId}-2.mcp`);
});

test('runtime configuration rejects claimed verification and executable/identity overrides', () => {
  for (const key of ['verified', 'enabled', 'executable', 'argv', 'env', 'uid', 'bootId', 'model']) {
    assert.throws(() => parseClaudeInvestigationRuntimeConfiguration({ ...config(), [key]: true }));
  }
  assert.throws(() => parseClaudeInvestigationRuntimeConfiguration({ ...config(),
    paths: { ...config().paths, privateFifoDirectory: '/home/investigator/other' } }));
});

test('runtime configuration rejects unsafe roots, recipe and domain widening', () => {
  for (const relayRoot of ['/tmp/gate', '/home/other/gate', '/home/investigator/../gates',
    '/home/investigator/gates/', '/home/investigator/auth']) {
    assert.throws(() => parseClaudeInvestigationRuntimeConfiguration({ ...config(), relayRoot }));
  }
  assert.throws(() => parseClaudeInvestigationRuntimeConfiguration({ ...config(),
    relayRoot: '/home/investigator/runtime/relay' }));
  assert.throws(() => parseClaudeInvestigationRuntimeConfiguration({ ...config(), recipe: 'old_recipe' }));
  for (const allowedDomains of [['*'], ['localhost'], ['127.0.0.1'], ['api.anthropic.com', 'api.anthropic.com']]) {
    assert.throws(() => parseClaudeInvestigationRuntimeConfiguration({ ...config(), profile: { allowedDomains } }));
  }
});

test('attempt identity and fencing epoch cannot be supplied as arbitrary paths', () => {
  const parsed = parseClaudeInvestigationRuntimeConfiguration(config());
  for (const id of ['../escape', 'attempt_old', attemptId + '/other']) {
    assert.throws(() => deriveClaudeInvestigationRuntimePaths(parsed, id, 1));
  }
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveClaudeInvestigationRuntimePaths(parsed, attemptId, epoch));
  }
});

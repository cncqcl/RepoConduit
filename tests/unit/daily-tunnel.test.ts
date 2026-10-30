import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDailyTunnelArguments, validateDailyTunnelProfile } from '../../src/cli/daily-tunnel.js';

test('one saved tunnel command selects the installation, never a project, and refers to an environment key', () => {
  const profile = validateDailyTunnelProfile({ executable: 'C:/tools/tunnel-client.exe', tunnelId: 'tunnel_example123', proxy: 'http://127.0.0.1:33210' });
  const args = buildDailyTunnelArguments(profile, { node: 'C:/Program Files/nodejs/node.exe', cli: 'D:/installed/repo-conduit/main.js',
    installationDirectory: 'C:/Users/owner/.repo-conduit', healthFile: 'C:/Users/owner/.repo-conduit/health.url' });
  assert.equal(args[0], 'run');
  assert.ok(args.includes('env:CONTROL_PLANE_API_KEY'));
  assert.ok(args.includes('127.0.0.1:0'));
  assert.ok(args.some(arg => arg.includes('mcp-daily') && arg.includes('--data-dir')));
  assert.doesNotMatch(JSON.stringify(args), /workspace|collaboration|profileRevision|actual-secret/);
});

test('tunnel configuration rejects remote proxies, arbitrary origins, executable commands and ambiguous command paths', () => {
  for (const value of [
    { executable: 'relative.exe', tunnelId: 'tunnel_example123' },
    { executable: 'C:/tools/cmd.exe', tunnelId: 'tunnel_example123' },
    { executable: 'C:/tools/tunnel-client.exe', tunnelId: 'tunnel_example123', proxy: 'https://remote.example.test' },
    { executable: 'C:/tools/tunnel-client.exe', tunnelId: 'tunnel_example123', apiKey: 'actual-secret' },
  ]) assert.throws(() => validateDailyTunnelProfile(value));
  const profile = validateDailyTunnelProfile({ executable: 'C:/tools/tunnel-client.exe', tunnelId: 'tunnel_example123' });
  assert.throws(() => buildDailyTunnelArguments(profile, { node: 'C:/node.exe', cli: 'D:/bad,entry.js',
    installationDirectory: 'C:/data', healthFile: 'C:/data/health' }));
});

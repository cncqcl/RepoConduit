import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaudeMcpSandboxSpec, fixedClaudeMcpConfig } from '../../src/adapters/secondary-investigator/claude-mcp-sandbox-spec.js';

const paths = {
  installRoot: '/home/fixture/.local/share/rcac-second-runtime-20260929',
  nodeRoot: '/home/fixture/.hermes/node',
  srtSettingsFile: '/home/fixture/.local/rcac-config/srt.json',
  mcpConfigFile: '/home/fixture/.local/rcac-config/mcp.json',
  helperFile: '/home/fixture/.local/rcac-config/mcp-fifo.py',
  privateFifoDirectory: '/home/fixture/.local/share/rcac-private/attempt_11111111-1111-4111-8111-111111111111-1.mcp',
  privateAuthHome: '/home/fixture/.local/rcac-auth',
};

test('MCP-only Claude spec mounts no source or host authority and starts in empty work', () => {
  const spec = buildClaudeMcpSandboxSpec(paths);
  assert.equal(spec.file, '/usr/bin/bwrap');
  assert.deepEqual(spec.env, {
    HOME: '/home/claude', PATH: '/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/runtime/deps/usr/lib/x86_64-linux-gnu',
  });
  assert.deepEqual(pairs(spec.argv, '--bind'), [[paths.privateFifoDirectory, '/relay']]);
  assert.deepEqual(pairs(spec.argv, '--ro-bind').slice(-7), [
    [`${paths.installRoot}/node_modules`, '/runtime/node_modules'],
    [`${paths.installRoot}/deps`, '/runtime/deps'], [paths.nodeRoot, '/node'],
    [paths.srtSettingsFile, '/opt/srt.json'], [paths.mcpConfigFile, '/opt/mcp.json'],
    [paths.helperFile, '/opt/mcp-fifo.py'], [paths.privateAuthHome, '/home/claude'],
  ]);
  assert.deepEqual(pairs(spec.argv, '--ro-bind').map(pair => pair[1]!).filter(path =>
    ['/snapshot', '/source', '/gate', '/run', '/sys'].includes(path)), []);
  assert.ok(!spec.argv.includes('/mnt'));
  assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--chdir'), spec.argv.indexOf('--chdir') + 2),
    ['--chdir', '/work']);
  assert.ok(spec.argv.some((value, i) => value === '--tmpfs' && spec.argv[i + 1] === '/work'));
  assert.deepEqual(spec.argv.slice(-16), [
    '/runtime/node_modules/.bin/claude', '--print', '--no-session-persistence',
    '--restricted', '--permission-mode', 'dontAsk', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '/opt/mcp.json', '--tools', '',
    '--disable-slash-commands', '--output-format', 'json',
  ]);
  assert.ok(!spec.argv.includes('--max-turns'));
});

test('fixed MCP config invokes only the mounted FIFO helper', () => {
  assert.deepEqual(fixedClaudeMcpConfig(), { mcpServers: { 'repo-conduit': {
    command: '/usr/bin/python3', args: ['-I', '-S', '/opt/mcp-fifo.py'], env: {},
  } } });
});

test('rejects extra sources, overlap, traversal and authority mounts', () => {
  for (const bad of [
    { privateFifoDirectory: '/mnt/d/relay' },
    { privateFifoDirectory: '/home/fixture/.local/share/rcac-private/../relay' },
    { privateFifoDirectory: '/home/fixture/.local/share/rcac-private//relay' },
    { privateFifoDirectory: paths.privateAuthHome + '/relay' },
    { helperFile: paths.installRoot + '/helper.py' },
    { privateAuthHome: '/run/auth' }, { nodeRoot: '/sys/node' },
  ]) assert.throws(() => buildClaudeMcpSandboxSpec({ ...paths, ...bad }), TypeError);
  assert.throws(() => buildClaudeMcpSandboxSpec({ ...paths, snapshotDirectory: '/safe/snapshot' } as never), TypeError);
  assert.throws(() => buildClaudeMcpSandboxSpec({ ...paths, mcpConfigFile: '' }), TypeError);
});

function pairs(argv: readonly string[], flag: string): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag) result.push([argv[i + 1]!, argv[i + 2]!]);
  return result;
}

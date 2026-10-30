import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildClaudeSandboxSpec } from '../../src/adapters/secondary-investigator/claude-sandbox-spec.js';

const paths = {
  installRoot: '/opt/rcac/runtime',
  nodeRoot: '/opt/rcac/node',
  srtSettingsFile: '/opt/rcac/config/srt.json',
  mcpConfigFile: '/opt/rcac/config/mcp.json',
  snapshotDirectory: '/opt/rcac/snapshot',
  privateAuthHome: '/opt/rcac/auth',
};

test('builds the fixed nested bwrap and SRT command with an allow-only environment', () => {
  const spec = buildClaudeSandboxSpec(paths);
  assert.equal(spec.file, '/usr/bin/bwrap');
  assert.deepEqual(spec.env, {
    HOME: '/home/claude',
    PATH: '/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/runtime/deps/usr/lib/x86_64-linux-gnu',
  });
  assert.deepEqual(spec.argv.slice(0, 14), [
    '--clearenv', '--setenv', 'HOME', '/home/claude',
    '--setenv', 'PATH', '/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin',
    '--setenv', 'LD_LIBRARY_PATH', '/runtime/deps/usr/lib/x86_64-linux-gnu',
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
  ]);
  assert.deepEqual(spec.argv.slice(-20), [
    '/runtime/node_modules/.bin/srt', '--settings', '/opt/srt.json', '--',
    '/runtime/node_modules/.bin/claude', '--print', '--no-session-persistence',
    '--restricted', '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '/opt/mcp.json', '--tools', '', '--disable-slash-commands',
    '--output-format', 'json',
  ]);
  assert.deepEqual(mountPairs(spec.argv), [
    ['/usr', '/usr'], ['/bin', '/bin'], ['/lib', '/lib'], ['/lib64', '/lib64'],
    ['/usr/bin/which.debianutils', '/etc/alternatives/which'],
    [paths.installRoot + '/node_modules', '/runtime/node_modules'],
    [paths.installRoot + '/deps', '/runtime/deps'], [paths.nodeRoot, '/node'],
    [paths.srtSettingsFile, '/opt/srt.json'], [paths.mcpConfigFile, '/opt/mcp.json'],
    [paths.snapshotDirectory, '/snapshot'], [paths.privateAuthHome, '/home/claude'],
  ]);
  assert.ok(spec.argv.includes('--tmpfs'));
  assert.ok(spec.argv.includes('/tmp'));
  assert.ok(!spec.argv.includes('/mnt'));
  assert.ok(!spec.argv.includes('/home/fixture'));
  assert.ok(!mountPairs(spec.argv).some(([source]) => source === '/etc'));
  assert.ok(spec.argv.includes('/etc'));
  assert.deepEqual(dirPaths(spec.argv).filter(path => path.startsWith('/etc')),
    ['/etc', '/etc/alternatives']);
  assert.ok(!JSON.stringify(spec).includes('HTTP_PROXY'));
});

test('rejects unsafe or overlapping trusted source paths', () => {
  for (const bad of [
    { snapshotDirectory: 'relative' }, { snapshotDirectory: '/snapshot/../escape' },
    { snapshotDirectory: '/snapshot//sub' }, { snapshotDirectory: '/snapshot/' },
    { snapshotDirectory: '/mnt/c/work' }, { snapshotDirectory: '/tmp' },
    { privateAuthHome: '/opt/rcac/snapshot/auth' },
    { mcpConfigFile: '/opt/rcac/snapshot/config.json' },
    { nodeRoot: '/opt/rcac/runtime/node' },
  ]) {
    assert.throws(() => buildClaudeSandboxSpec({ ...paths, ...bad }), TypeError);
  }
});

test('rejects a missing named mount source even when an extra valid path hides it', () => {
  const malformed: Record<string, string> = { ...paths, extraPath: '/opt/rcac/extra' };
  delete malformed.installRoot;
  assert.throws(() => buildClaudeSandboxSpec(malformed as unknown as typeof paths), TypeError);
});

test('synthetic SRT fixture does not claim the mounted auth HOME is denied', () => {
  const file = new URL('../fixtures/legacy-runtime/claude-srt-settings.json', import.meta.url);
  const settings = JSON.parse(readFileSync(file, 'utf8')) as {
    filesystem: { denyRead: string[] };
  };
  assert.deepEqual(settings.filesystem.denyRead, ['/mnt']);
  assert.ok(!settings.filesystem.denyRead.includes('/home/claude'));
});

function mountPairs(argv: readonly string[]): string[][] {
  const pairs: string[][] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ro-bind') pairs.push([argv[i + 1]!, argv[i + 2]!]);
  }
  return pairs;
}

function dirPaths(argv: readonly string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') paths.push(argv[i + 1]!);
  }
  return paths;
}

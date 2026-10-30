/** MCP-only Claude launch preview. The trusted supervisor validates mount objects and starts the process. */
export interface ClaudeMcpSandboxPaths {
  installRoot: string;
  nodeRoot: string;
  srtSettingsFile: string;
  mcpConfigFile: string;
  helperFile: string;
  /** One pre-created private FIFO directory for the exact durable attempt. */
  privateFifoDirectory: string;
  /** Dedicated auth HOME; credentials are never included in the spec or response. */
  privateAuthHome: string;
}

export interface ClaudeMcpSandboxSpec {
  file: '/usr/bin/bwrap';
  argv: readonly string[];
  env: Readonly<Record<'HOME' | 'PATH' | 'LD_LIBRARY_PATH', string>>;
}

const sourceKeys = [
  'installRoot', 'nodeRoot', 'srtSettingsFile', 'mcpConfigFile',
  'helperFile', 'privateFifoDirectory', 'privateAuthHome',
] as const;
const env = Object.freeze({
  HOME: '/home/claude',
  PATH: '/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin',
  LD_LIBRARY_PATH: '/runtime/deps/usr/lib/x86_64-linux-gnu',
});

function canonicalPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..');
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Only this single, mounted helper can join the private MCP FIFOs. */
export function fixedClaudeMcpConfig(): Readonly<{ mcpServers: Readonly<{
  'repo-conduit': Readonly<{ command: '/usr/bin/python3'; args: readonly ['-I', '-S', '/opt/mcp-fifo.py'];
    env: Readonly<Record<string, never>> }> }> }> {
  return Object.freeze({ mcpServers: Object.freeze({ 'repo-conduit': Object.freeze({
    command: '/usr/bin/python3' as const,
    args: Object.freeze(['-I', '-S', '/opt/mcp-fifo.py'] as const),
    env: Object.freeze({}),
  }) }) });
}

/** No source tree is mounted. Working directory is a new empty tmpfs. */
export function buildClaudeMcpSandboxSpec(paths: ClaudeMcpSandboxPaths): ClaudeMcpSandboxSpec {
  if (!paths || typeof paths !== 'object' || Reflect.ownKeys(paths).length !== sourceKeys.length ||
    !sourceKeys.every(key => Object.hasOwn(paths, key))) throw new TypeError('MCP sandbox needs exact paths');
  const sources = sourceKeys.map(key => paths[key]);
  const ambient = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/proc', '/dev', '/tmp',
    '/mnt', '/run', '/sys'];
  if (!sources.every(canonicalPath) ||
    sources.some(path => ambient.some(root => contains(root, path))) ||
    sources.some((path, index) => sources.some((other, otherIndex) =>
      index !== otherIndex && (contains(path, other) || contains(other, path)))) ||
    !/\/attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]*\.mcp$/.test(
      paths.privateFifoDirectory)) throw new TypeError('Unsafe MCP sandbox source path');

  const argv = [
    '--clearenv', '--setenv', 'HOME', env.HOME,
    '--setenv', 'PATH', env.PATH,
    '--setenv', 'LD_LIBRARY_PATH', env.LD_LIBRARY_PATH,
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--dir', '/etc', '--dir', '/etc/alternatives',
    '--ro-bind', '/usr/bin/which.debianutils', '/etc/alternatives/which',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/work',
    '--dir', '/runtime', '--dir', '/opt', '--dir', '/home', '--dir', '/relay',
    '--ro-bind', `${paths.installRoot}/node_modules`, '/runtime/node_modules',
    '--ro-bind', `${paths.installRoot}/deps`, '/runtime/deps',
    '--ro-bind', paths.nodeRoot, '/node',
    '--ro-bind', paths.srtSettingsFile, '/opt/srt.json',
    '--ro-bind', paths.mcpConfigFile, '/opt/mcp.json',
    '--ro-bind', paths.helperFile, '/opt/mcp-fifo.py',
    '--ro-bind', paths.privateAuthHome, '/home/claude',
    '--bind', paths.privateFifoDirectory, '/relay',
    '--chdir', '/work', '--',
    '/runtime/node_modules/.bin/srt', '--settings', '/opt/srt.json', '--',
    '/runtime/node_modules/.bin/claude', '--print', '--no-session-persistence',
    '--restricted', '--permission-mode', 'dontAsk', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '/opt/mcp.json', '--tools', '',
    '--disable-slash-commands', '--output-format', 'json',
  ];
  return Object.freeze({ file: '/usr/bin/bwrap', argv: Object.freeze(argv), env });
}

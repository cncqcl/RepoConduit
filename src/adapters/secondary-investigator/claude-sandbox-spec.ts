/** Pure preview of a nested Linux bwrap → SRT → Claude command. No process is started here. */
export interface ClaudeSandboxPaths {
  /** Trusted, private installed Claude/SRT root; node_modules and deps are exact children. */
  installRoot: string;
  /** Trusted Node distribution root with bin/node. */
  nodeRoot: string;
  /** Caller must verify the contents before launch; this builder does not inspect files. */
  srtSettingsFile: string;
  mcpConfigFile: string;
  snapshotDirectory: string;
  /** Dedicated per-attempt auth HOME; mounted read-only. OAuth refresh compatibility is unverified. */
  privateAuthHome: string;
}

export interface ClaudeSandboxSpec {
  file: '/usr/bin/bwrap';
  argv: readonly string[];
  /** Pass as the complete spawn environment; do not merge inherited variables. */
  env: Readonly<Record<'HOME' | 'PATH' | 'LD_LIBRARY_PATH', string>>;
}

const env = Object.freeze({
  HOME: '/home/claude',
  PATH: '/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin',
  LD_LIBRARY_PATH: '/runtime/deps/usr/lib/x86_64-linux-gnu',
});
const sourceKeys = [
  'installRoot', 'nodeRoot', 'srtSettingsFile', 'mcpConfigFile',
  'snapshotDirectory', 'privateAuthHome',
] as const;

function canonicalPath(value: string): boolean {
  return typeof value === 'string' && value.startsWith('/') && value !== '/' &&
    !value.endsWith('/') && !value.includes('//') && !value.includes('\\') &&
    ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    value.split('/').every(part => part !== '.' && part !== '..');
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Build only a command specification. The future supervisor owns trusted path resolution,
 * settings/MCP verification, authorized stdin, inherited-FD closure, execution and receipts. */
export function buildClaudeSandboxSpec(paths: ClaudeSandboxPaths): ClaudeSandboxSpec {
  if (paths === null || typeof paths !== 'object' ||
      Reflect.ownKeys(paths).length !== sourceKeys.length ||
      !sourceKeys.every(key => Object.hasOwn(paths, key))) {
    throw new TypeError('Sandbox source paths require exactly six named fields');
  }
  const inputs = sourceKeys.map(key => paths[key]);
  if (!inputs.every(canonicalPath)) {
    throw new TypeError('Sandbox source paths must be canonical absolute POSIX paths');
  }
  const reserved = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/proc', '/dev', '/tmp', '/mnt'];
  if (inputs.some(path => reserved.some(root => contains(root, path))) ||
      inputs.some((path, index) => inputs.some((other, otherIndex) =>
        index !== otherIndex && (contains(path, other) || contains(other, path))))) {
    throw new TypeError('Sandbox source paths overlap or use ambient system mounts');
  }

  const argv = [
    '--clearenv', '--setenv', 'HOME', env.HOME,
    '--setenv', 'PATH', env.PATH,
    '--setenv', 'LD_LIBRARY_PATH', env.LD_LIBRARY_PATH,
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--dir', '/etc', '--dir', '/etc/alternatives',
    '--ro-bind', '/usr/bin/which.debianutils', '/etc/alternatives/which',
    '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--dir', '/runtime', '--dir', '/opt', '--dir', '/home',
    '--ro-bind', `${paths.installRoot}/node_modules`, '/runtime/node_modules',
    '--ro-bind', `${paths.installRoot}/deps`, '/runtime/deps',
    '--ro-bind', paths.nodeRoot, '/node',
    '--ro-bind', paths.srtSettingsFile, '/opt/srt.json',
    '--ro-bind', paths.mcpConfigFile, '/opt/mcp.json',
    '--ro-bind', paths.snapshotDirectory, '/snapshot',
    '--ro-bind', paths.privateAuthHome, '/home/claude',
    '--chdir', '/snapshot', '--',
    '/runtime/node_modules/.bin/srt', '--settings', '/opt/srt.json', '--',
    '/runtime/node_modules/.bin/claude', '--print', '--no-session-persistence',
    '--restricted', '--permission-mode', 'dontAsk', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '/opt/mcp.json', '--tools', '',
    '--disable-slash-commands', '--output-format', 'json',
  ];
  return Object.freeze({ file: '/usr/bin/bwrap', argv: Object.freeze(argv), env });
}

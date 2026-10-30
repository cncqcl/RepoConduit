import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPrivateDataDirectory } from '../runtime/local-security.js';

export interface DailyTunnelProfile { executable: string; tunnelId: string; proxy?: string }
const absolute = (value: string) => isAbsolute(value) || win32.isAbsolute(value);
export function validateDailyTunnelProfile(value: unknown): DailyTunnelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved Tunnel connection');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['executable', 'tunnelId', 'proxy'].includes(key)) ||
      typeof p.executable !== 'string' || !absolute(p.executable) || /["\r\n\0,]/.test(p.executable) ||
      !/^tunnel-client(?:\.exe)?$/i.test(basename(p.executable.replaceAll('\\', '/'))) ||
      typeof p.tunnelId !== 'string' || !/^tunnel_[A-Za-z0-9]{8,128}$/.test(p.tunnelId)) throw new Error('Invalid saved Tunnel connection');
  if (p.proxy !== undefined && (typeof p.proxy !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(p.proxy) ||
      Number(new URL(p.proxy).port) > 65535)) throw new Error('Tunnel proxy must be an explicit local HTTP endpoint');
  return { executable: p.executable, tunnelId: p.tunnelId, ...(p.proxy === undefined ? {} : { proxy: p.proxy as string }) };
}

export function buildDailyTunnelArguments(profile: DailyTunnelProfile, input: {
  node: string; cli: string; installationDirectory: string; healthFile: string;
}): string[] {
  const p = validateDailyTunnelProfile(profile);
  const quoted = (path: string) => {
    if (!absolute(path) || /["\r\n\0,]/.test(path)) throw new Error('Unsupported Tunnel command path');
    return `"${path.replaceAll('\\', '/')}"`;
  };
  return ['run', '--control-plane.base-url', 'https://api.openai.com', '--control-plane.tunnel-id', p.tunnelId,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp.command',
    `command=${quoted(input.node)} ${quoted(input.cli)} mcp-daily --data-dir ${quoted(input.installationDirectory)},channel=main`,
    '--mcp.stdio-send-initialized-notification', '--health.listen-addr', '127.0.0.1:0', '--health.url-file', input.healthFile,
    '--log.level', 'warn', '--log.file', 'stdout', ...(p.proxy ? ['--control-plane.http-proxy', p.proxy] : [])];
}

export function saveDailyTunnelProfile(root: string, profile: DailyTunnelProfile): void {
  const input = validateDailyTunnelProfile(profile);
  assertPrivateDataDirectory(root);
  const info = lstatSync(input.executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Tunnel executable unavailable');
  const file = join(root, 'daily-tunnel.json');
  if (existsSync(file)) {
    const previous = readDailyTunnelProfile(root);
    if (JSON.stringify(previous) !== JSON.stringify(input)) throw new Error('Existing Tunnel connection preserved');
    return;
  }
  writeFileSync(file, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
  assertPrivateDataDirectory(root, file);
}

export function readDailyTunnelProfile(root: string): DailyTunnelProfile {
  const file = join(root, 'daily-tunnel.json'); const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Invalid saved Tunnel connection');
  assertPrivateDataDirectory(root, file);
  return validateDailyTunnelProfile(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

/** Foreground use of the owner's existing official Tunnel. No new endpoint, key file or per-project script. */
export async function connectDailyTunnel(root: string, installationDirectory: string, cli: string, dryRun = false): Promise<unknown> {
  const profile = readDailyTunnelProfile(root);
  const healthFile = join(root, `tunnel-health-${randomUUID()}.url`);
  const args = buildDailyTunnelArguments(profile, { node: process.execPath, cli, installationDirectory, healthFile });
  if (dryRun) return { executable: profile.executable, args, runtimeKeySource: 'CONTROL_PLANE_API_KEY', connectsNetwork: false };
  if (!cli.endsWith('.js')) throw new Error('Build or install RepoConduit before connecting Tunnel');
  if (!process.env.CONTROL_PLANE_API_KEY?.trim()) throw new Error('Existing restricted Tunnel key required in CONTROL_PLANE_API_KEY; never paste it into chat');
  const env: Record<string, string> = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  const help = spawnSync(profile.executable, ['help', 'run'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env, windowsHide: true });
  if (help.status !== 0 || !/^run version 0\.0\.15(?:\+|\s)/.test(help.stdout) ||
      !help.stdout.includes('--mcp.stdio-send-initialized-notification')) throw new Error('Installed Tunnel interface is unverified');
  env.CONTROL_PLANE_API_KEY = process.env.CONTROL_PLANE_API_KEY;
  const child = spawn(profile.executable, args, { env, stdio: 'inherit', windowsHide: true, shell: false });
  env.CONTROL_PLANE_API_KEY = '';
  const stop = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Tunnel transport could not start')));
      child.once('close', code => code === 0 ? resolve({ transportExited: true, exitCode: code })
        : reject(new Error('Tunnel transport stopped; preserve pending deliveries before reconnecting')));
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

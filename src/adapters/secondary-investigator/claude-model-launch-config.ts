import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { CLAUDE_MCP_FIFO_PYTHON } from './claude-mcp-fifo-helper.js';
import { fixedClaudeMcpConfig } from './claude-mcp-sandbox-spec.js';

export interface ClaudeModelLaunchProfile {
  allowedDomains: readonly string[];
}

export type ClaudeModelLaunchTarget = '/opt/srt.json' | '/opt/mcp.json' | '/opt/mcp-fifo.py';

export interface ClaudeModelLaunchFile {
  target: ClaudeModelLaunchTarget;
  bytes: Buffer;
  sha256: string;
  byteLength: number;
}

export interface ClaudeModelLaunchConfig {
  version: 'claude_model_launch_config_v1';
  files: [ClaudeModelLaunchFile, ClaudeModelLaunchFile, ClaudeModelLaunchFile];
}

const TARGETS: readonly ClaudeModelLaunchTarget[] =
  ['/opt/srt.json', '/opt/mcp.json', '/opt/mcp-fifo.py'];
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

function copyDomains(profile: ClaudeModelLaunchProfile): string[] {
  if (!hasExactKeys(profile, ['allowedDomains']) || !Array.isArray(profile.allowedDomains)) {
    throw new TypeError('invalid Claude model launch profile');
  }
  const domainCount = profile.allowedDomains.length;
  if (domainCount > 32) throw new TypeError('too many allowed domains');
  const domains: unknown[] = [];
  for (let i = 0; i < domainCount; i++) domains.push(profile.allowedDomains[i]);
  const seen = new Set<string>();
  for (const domain of domains) {
    if (typeof domain !== 'string' || domain.length > 257) throw new TypeError('invalid allowed domain');
    const host = domain.endsWith(':443') ? domain.slice(0, -4) : domain;
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2 || isIP(host) !== 0 ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/^[a-z]{2,63}$/.test(labels.at(-1) ?? '') ||
      /(?:^|\.)(?:localhost|local|internal|lan|localdomain|home\.arpa)$/.test(host) ||
      domain !== host && domain !== `${host}:443` || seen.has(domain)) {
      throw new TypeError('invalid or duplicate allowed domain');
    }
    seen.add(domain);
  }
  return domains as string[];
}

function makeFile(target: ClaudeModelLaunchTarget, body: Buffer): ClaudeModelLaunchFile {
  const bytes = Buffer.from(body);
  if (bytes.length > MAX_FILE_BYTES) throw new TypeError('Claude model launch file too large');
  return {
    target, bytes, byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function buildClaudeModelLaunchConfig(profile: ClaudeModelLaunchProfile): ClaudeModelLaunchConfig {
  const allowedDomains = copyDomains(profile);
  const srt = {
    network: {
      allowedDomains, deniedDomains: [], strictAllowlist: true,
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
    },
    filesystem: {
      disabled: false, denyRead: ['/mnt'], allowRead: [],
      allowWrite: ['/relay/out', '/relay/helper.lock'], denyWrite: [],
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  };
  const files: ClaudeModelLaunchConfig['files'] = [
    makeFile(TARGETS[0]!, Buffer.from(JSON.stringify(srt), 'utf8')),
    makeFile(TARGETS[1]!, Buffer.from(JSON.stringify(fixedClaudeMcpConfig()), 'utf8')),
    makeFile(TARGETS[2]!, Buffer.from(CLAUDE_MCP_FIFO_PYTHON, 'utf8')),
  ];
  if (files.reduce((total, file) => total + file.byteLength, 0) > MAX_TOTAL_BYTES) {
    throw new TypeError('Claude model launch config too large');
  }
  return { version: 'claude_model_launch_config_v1', files };
}

export function cloneValidateClaudeModelLaunchConfig(
  config: ClaudeModelLaunchConfig, profile: ClaudeModelLaunchProfile,
): ClaudeModelLaunchConfig {
  const expected = buildClaudeModelLaunchConfig(profile);
  if (!hasExactKeys(config, ['version', 'files']) ||
      config.version !== expected.version || !Array.isArray(config.files) ||
      config.files.length !== expected.files.length) {
    throw new TypeError('invalid Claude model launch config');
  }
  for (let i = 0; i < expected.files.length; i++) {
    const actual = config.files[i];
    const fixed = expected.files[i]!;
    if (!hasExactKeys(actual, ['target', 'bytes', 'sha256', 'byteLength']) ||
        !Buffer.isBuffer(actual.bytes)) {
      throw new TypeError('invalid Claude model launch file');
    }
    if (actual.bytes.length > MAX_FILE_BYTES || actual.bytes.length !== fixed.byteLength ||
        actual.byteLength !== fixed.byteLength || actual.target !== fixed.target ||
        actual.sha256 !== fixed.sha256) {
      throw new TypeError('Claude model launch file differs from fixed body');
    }
    const bytes = Buffer.from(actual.bytes);
    if (bytes.length !== fixed.byteLength ||
        !bytes.equals(fixed.bytes)) {
      throw new TypeError('Claude model launch file differs from fixed body');
    }
  }
  return expected;
}

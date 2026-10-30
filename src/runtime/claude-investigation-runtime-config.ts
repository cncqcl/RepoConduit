import { buildClaudeMcpSandboxSpec, type ClaudeMcpSandboxPaths } from
  '../adapters/secondary-investigator/claude-mcp-sandbox-spec.js';
import { buildClaudeModelLaunchConfig, type ClaudeModelLaunchProfile } from
  '../adapters/secondary-investigator/claude-model-launch-config.js';

/** Trusted local configuration only. Parsing neither proves isolation nor authorizes launch. */
export interface ClaudeInvestigationRuntimeConfiguration {
  recipe: 'claude_model_bootstrap_config_v3';
  distro: string;
  linuxUser: string;
  relayRoot: string;
  paths: Omit<ClaudeMcpSandboxPaths, 'privateFifoDirectory'>;
  profile: ClaudeModelLaunchProfile;
}

const ATTEMPT = /^attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMPLATE_ATTEMPT = 'attempt_00000000-0000-0000-0000-000000000001';
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root + '/');
}
function privateRoot(value: unknown, user: string): value is string {
  return typeof value === 'string' && value.length <= 200 &&
    value.startsWith(`/home/${user}/`) &&
    /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..');
}

export function parseClaudeInvestigationRuntimeConfiguration(value: unknown):
  ClaudeInvestigationRuntimeConfiguration {
  if (!exact(value, ['recipe', 'distro', 'linuxUser', 'relayRoot', 'paths', 'profile']) ||
    value.recipe !== 'claude_model_bootstrap_config_v3' ||
    typeof value.distro !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.distro) ||
    typeof value.linuxUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.linuxUser) ||
    !privateRoot(value.relayRoot, value.linuxUser) ||
    !exact(value.paths, ['installRoot', 'nodeRoot', 'srtSettingsFile', 'mcpConfigFile', 'helperFile', 'privateAuthHome'])) {
    throw new TypeError('INVALID_RUNTIME_CONFIGURATION');
  }
  const roots = [value.relayRoot];
  const paths = Object.values(value.paths);
  if (paths.some(path => typeof path !== 'string') ||
    roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && contains(root, other))) ||
    roots.some(root => paths.some(path => contains(root, path as string) || contains(path as string, root)))) {
    throw new TypeError('INVALID_RUNTIME_CONFIGURATION');
  }
  const candidate = structuredClone(value) as unknown as ClaudeInvestigationRuntimeConfiguration;
  buildClaudeModelLaunchConfig(candidate.profile);
  deriveClaudeInvestigationRuntimePaths(candidate, TEMPLATE_ATTEMPT, 1);
  return candidate;
}

export function deriveClaudeInvestigationRuntimePaths(config: ClaudeInvestigationRuntimeConfiguration,
  attemptId: string, workerEpoch: number): ClaudeMcpSandboxPaths {
  if (!ATTEMPT.test(attemptId) || !Number.isSafeInteger(workerEpoch) || workerEpoch < 1) {
    throw new TypeError('INVALID_RUNTIME_ATTEMPT');
  }
  const paths = { ...config.paths,
    privateFifoDirectory: `${config.relayRoot}/${attemptId}-${workerEpoch}.mcp` };
  buildClaudeMcpSandboxSpec(paths);
  return paths;
}

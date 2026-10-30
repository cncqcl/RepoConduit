import { createHash } from 'node:crypto';
import { buildClaudeMcpSandboxSpec, type ClaudeMcpSandboxPaths } from './claude-mcp-sandbox-spec.js';
import { CLAUDE_MODEL_BOOTSTRAP_SHA256 } from './claude-model-bootstrap.js';
import { buildClaudeModelLaunchConfig, type ClaudeModelLaunchProfile } from './claude-model-launch-config.js';
import { encodeClaudeModelConfigInput } from './claude-model-config-wire.js';

/** A private snapshot, used together for the command commitment and initial input. */
export function buildClaudeModelSealedLaunch(paths: ClaudeMcpSandboxPaths,
  profile: ClaudeModelLaunchProfile, maxTurns: number) {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 8)
    throw new Error('INVALID_ARGUMENT');
  const config = buildClaudeModelLaunchConfig(profile);
  const spec = buildClaudeMcpSandboxSpec(paths);
  const separator = spec.argv.indexOf('--');
  if (separator < 0) throw new Error('INVALID_ARGUMENT');
  const configFiles = config.files.map(({ target, byteLength, sha256 }) =>
    Object.freeze({ target, byteLength, sha256 }));
  const prefix: string[] = [];
  const replaced = new Set<string>();
  for (let i = 0; i < separator; i++) {
    const target = spec.argv[i + 2];
    const index = configFiles.findIndex(file => file.target === target);
    if (spec.argv[i] === '--ro-bind' && index >= 0) {
      if (replaced.has(target!)) throw new Error('INVALID_ARGUMENT');
      replaced.add(target!);
      prefix.push('--ro-bind-data', String(12 + index), target!);
      i += 2;
    } else prefix.push(spec.argv[i]!);
  }
  if (replaced.size !== 3) throw new Error('INVALID_ARGUMENT');
  const recipe = Object.freeze({
    recipe: 'claude_model_bootstrap_config_v3' as const,
    bootstrapSha256: CLAUDE_MODEL_BOOTSTRAP_SHA256,
    configFiles: Object.freeze(configFiles), file: spec.file,
    argv: Object.freeze([...prefix, '--ro-bind-data', '10', '/opt/rcac-bootstrap.py',
      '--info-fd', '11', '--', '/usr/bin/python3', '-I', '-S', '/opt/rcac-bootstrap.py', String(maxTurns)]),
    env: spec.env,
  });
  // Revalidation reads a private profile derived from the copied canonical body;
  // it never samples a caller's mutable profile again.
  const privateProfile: ClaudeModelLaunchProfile = {
    allowedDomains: JSON.parse(config.files[0].bytes.toString('utf8')).network.allowedDomains,
  };
  const startupInput = encodeClaudeModelConfigInput(config, privateProfile);
  const commandDigest = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  return { recipe, config, startupInput, commandDigest };
}

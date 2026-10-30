import { createHash } from 'node:crypto';
import { buildClaudeMcpSandboxSpec, type ClaudeMcpSandboxPaths } from './claude-mcp-sandbox-spec.js';
import { buildClaudeModelLaunchConfig, type ClaudeModelLaunchProfile } from './claude-model-launch-config.js';
import type { ClaudeModelSupervisorDescriptor } from './claude-model-supervisor.js';

/** Frozen v2 metadata is for captured evidence only. No launcher imports this module. */
export const HISTORICAL_BOOTSTRAP_SHA256 =
  '64f7fd88cbeef270f5bc25d2c26774f22928a19a26a78d859a37d3fa6f84ba9f';
export const HISTORICAL_BOOTSTRAP_BYTE_LENGTH = 4295;
export const HISTORICAL_PARENT_PROGRAMS = [
  {byteLength: 23576, sha256: 'a2f40340140f5d15935dfc2e21434e1e24eaa0c0ea620b0716c7af509dd122b7'},
  {byteLength: 23477, sha256: '4f2f7e73c69cf4d950b597862e6696093ce1da86dd80101c1c42284c639be7ec'},
] as const;

export function historicalClaudeModelRecipe(paths: ClaudeMcpSandboxPaths,
  profile: ClaudeModelLaunchProfile) {
  const config=buildClaudeModelLaunchConfig(profile);
  const spec=buildClaudeMcpSandboxSpec(paths);
  const separator=spec.argv.indexOf('--');
  if (separator<0) throw new Error('INVALID_ARGUMENT');
  const configFiles=config.files.map(({target,byteLength,sha256})=>({target,byteLength,sha256}));
  const prefix:string[]=[];
  const replaced=new Set<string>();
  for(let i=0;i<separator;i++) {
    const target=spec.argv[i+2];
    const index=configFiles.findIndex(file=>file.target===target);
    if(spec.argv[i]==='--ro-bind'&&index>=0) {
      if(replaced.has(target!)) throw new Error('INVALID_ARGUMENT');
      replaced.add(target!);
      prefix.push('--ro-bind-data',String(12+index),target!);i+=2;
    } else prefix.push(spec.argv[i]!);
  }
  if(replaced.size!==3) throw new Error('INVALID_ARGUMENT');
  const recipe={recipe:'claude_model_bootstrap_config_v2',
    bootstrapSha256:HISTORICAL_BOOTSTRAP_SHA256,configFiles,file:spec.file,
    argv:[...prefix,'--ro-bind-data','10','/opt/rcac-bootstrap.py','--info-fd','11','--',
      '/usr/bin/python3','-I','-S','/opt/rcac-bootstrap.py'],env:spec.env};
  return {recipe, commandDigest: createHash('sha256').update(JSON.stringify(recipe)).digest('hex')};
}

export function historicalClaudeModelParentArgv(descriptor: ClaudeModelSupervisorDescriptor,
  root: string, paths: ClaudeMcpSandboxPaths, profile: ClaudeModelLaunchProfile,
  maxWallSeconds: number, capturedProgram: string, capturedBootstrap: string): readonly string[] | null {
  if (!Number.isSafeInteger(maxWallSeconds) || maxWallSeconds < 1 || maxWallSeconds > 600 ||
    !HISTORICAL_PARENT_PROGRAMS.some(entry => entry.byteLength === Buffer.byteLength(capturedProgram, 'utf8') &&
      entry.sha256 === createHash('sha256').update(capturedProgram).digest('hex')) ||
    Buffer.byteLength(capturedBootstrap, 'utf8') !== HISTORICAL_BOOTSTRAP_BYTE_LENGTH ||
    createHash('sha256').update(capturedBootstrap).digest('hex') !== HISTORICAL_BOOTSTRAP_SHA256)
    return null;
  const {recipe, commandDigest} = historicalClaudeModelRecipe(paths, profile);
  if (descriptor.commandDigest !== commandDigest) return null;
  return ['/usr/bin/python3', '-I', '-S', '-c', capturedProgram, 'enter_wait_exec', root,
    descriptor.attemptId, descriptor.workspaceId, descriptor.bootId, String(descriptor.uid),
    descriptor.unitName, String(descriptor.launchWorkerEpoch), descriptor.sourceDigest,
    descriptor.profileDigest, descriptor.commandDigest, '', '', JSON.stringify(recipe),
    String(maxWallSeconds), capturedBootstrap];
}

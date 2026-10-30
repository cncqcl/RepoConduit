import { claudeModelSupervisorSpec } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { buildClaudeModelSealedLaunch } from
  '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, CLAUDE_MODEL_BOOTSTRAP_SHA256 } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import type { ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';

/** Offline counterfactual only: updates every committed recipe/startup/process field together. */
export function syntheticCurrentOuterFact(historical: ModelOuterConfinedFact,
  maxTurns: number): ModelOuterConfinedFact {
  const fact = structuredClone(historical);
  const { descriptor, paths, profile } = fact.expectation;
  const limits = {maxWallSeconds: fact.expectation.limits.maxWallSeconds, maxTurns};
  fact.expectation.limits = limits;
  const launch = buildClaudeModelSealedLaunch(paths, profile, maxTurns);
  descriptor.commandDigest = launch.commandDigest;
  const {candidate} = fact.observation;
  const {running,startup,probe} = candidate;
  running.resource.gate!.launch!.commandDigest = launch.commandDigest;
  running.journal.commandDigest = launch.commandDigest;
  startup.journal.commandDigest = launch.commandDigest;
  fact.observation.journalAfter.commandDigest = launch.commandDigest;
  startup.bootstrapSha256 = CLAUDE_MODEL_BOOTSTRAP_SHA256;
  const fixed = probe.mountedFixedFiles.find(file => file.target === '/opt/rcac-bootstrap.py');
  if (!fixed) throw new Error('INVALID_ARGUMENT');
  fixed.byteLength = Buffer.byteLength(CLAUDE_MODEL_BOOTSTRAP_PYTHON, 'utf8');
  fixed.stat.size = fixed.byteLength;
  fixed.sha256 = CLAUDE_MODEL_BOOTSTRAP_SHA256;
  probe.processes.wrapper.cmdline = [launch.recipe.file,...launch.recipe.argv].join('\0')+'\0';
  probe.processes.outer.cmdline = probe.processes.wrapper.cmdline;
  probe.processes.bootstrap.cmdline = ['/usr/bin/python3','-I','-S',
    '/opt/rcac-bootstrap.py',String(maxTurns)].join('\0')+'\0';
  const args = claudeModelSupervisorSpec('enter_wait_exec', descriptor,
    running.resource.gate!.root, paths, undefined, limits, profile).args;
  probe.processes.parent.cmdline =
    args.slice(args.indexOf('/usr/bin/python3')).join('\0') + '\0';
  return fact;
}

import { isDeepStrictEqual } from 'node:util';
import type { ClaudeModelOuterProbeInput } from './claude-model-outer-probe.js';
import type { ClaudeModelOuterObservation } from './claude-model-outer-observer.js';
import type { ClaudeModelLaunchLimits } from './claude-model-supervisor.js';
import { validateClaudeModelOuterMounts } from './claude-model-outer-mounts.js';
import { validateClaudeModelOuterProcesses } from './claude-model-outer-processes.js';

const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Validates captured samples only. Current owner, lease and dispatch authority remain separate. */
export function validateClaudeModelOuterObservation(input: ClaudeModelOuterProbeInput,
  observation: ClaudeModelOuterObservation,
  limits: ClaudeModelLaunchLimits | {maxWallSeconds:number}): boolean {
  try {
    const saved = structuredClone({ input, observation, limits });
    const result = saved.observation;
    if (result.kind !== 'outer_journal_candidate' ||
      !exact(result, ['kind', 'candidate', 'journalAfter']) ||
      !exact(result.candidate, ['kind', 'running', 'startup', 'probe']) ||
      result.candidate.kind !== 'outer_probe_candidate' ||
      !isDeepStrictEqual(result.candidate.running, saved.input.running) ||
      !isDeepStrictEqual(result.candidate.startup, saved.input.startup) ||
      result.journalAfter.closed || result.journalAfter.phase !== 'consumed' ||
      !isDeepStrictEqual(result.journalAfter, saved.input.startup.journal)) return false;
    return validateClaudeModelOuterMounts(saved.input, result.candidate.probe, saved.limits) &&
      validateClaudeModelOuterProcesses(saved.input, result.candidate.probe, saved.limits);
  } catch {
    return false;
  }
}

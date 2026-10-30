import type { ClaudeModelOuterProbeInput } from './claude-model-outer-probe.js';
import type { ClaudeModelOuterObservation } from './claude-model-outer-observer.js';
import type { ClaudeModelLaunchLimits } from './claude-model-supervisor.js';
import { validateClaudeModelOuterObservation } from './claude-model-outer-validation.js';
import { currentClaudeModelParentCmdline } from './claude-model-outer-processes.js';

export interface ModelOuterConfinedFact {
  kind: 'model_outer_confined_v1';
  networkMode: 'host_shared_pre_srt';
  srtState: 'not_started';
  expectation: Pick<ClaudeModelOuterProbeInput, 'descriptor' | 'paths' | 'profile'> & {
    profileRevision: string;
    limits: ClaudeModelLaunchLimits;
  };
  observation: Extract<ClaudeModelOuterObservation, {kind: 'outer_journal_candidate'}>;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Captured sample validity only; current claim, grant, lease and send authority are separate. */
export function validateClaudeModelOuterFact(fact: ModelOuterConfinedFact |
  (Omit<ModelOuterConfinedFact,'expectation'> & {expectation: Omit<ModelOuterConfinedFact['expectation'],'limits'> &
    {limits:{maxWallSeconds:number}}})): boolean {
  try {
    const saved = structuredClone(fact);
    if (!exactKeys(saved, ['kind', 'networkMode', 'srtState', 'expectation', 'observation']) ||
        saved.kind !== 'model_outer_confined_v1' ||
        saved.networkMode !== 'host_shared_pre_srt' || saved.srtState !== 'not_started' ||
        !exactKeys(saved.expectation,
          ['descriptor', 'paths', 'profile', 'profileRevision', 'limits']) ||
        typeof saved.expectation.profileRevision !== 'string' ||
        saved.expectation.profileRevision.trim().length === 0 ||
        saved.expectation.profileRevision.length > 256 ||
        !(exactKeys(saved.expectation.limits, ['maxWallSeconds']) ||
          exactKeys(saved.expectation.limits, ['maxWallSeconds','maxTurns']))) return false;
    const serialized = JSON.stringify(saved);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 512 * 1024)
      return false;
    const {descriptor, paths, profile, limits} = saved.expectation;
    const {running, startup} = saved.observation.candidate;
    return validateClaudeModelOuterObservation(
      {descriptor, paths, profile, running, startup}, saved.observation, limits);
  } catch {
    return false;
  }
}

/** Fresh owner facts must contain the exact current parent Python program. */
export function validateCurrentClaudeModelOuterFact(fact: ModelOuterConfinedFact): boolean {
  try {
    const saved=structuredClone(fact);
    if (!validateClaudeModelOuterFact(saved) ||
      Object.keys(saved.expectation.limits).sort().join(',') !== 'maxTurns,maxWallSeconds') return false;
    const {descriptor,paths,profile,limits}=saved.expectation;
    const {running,startup,probe}=saved.observation.candidate;
    return probe.processes.parent.cmdline===currentClaudeModelParentCmdline(
      {descriptor,paths,profile,running,startup,limits},limits);
  } catch {return false;}
}

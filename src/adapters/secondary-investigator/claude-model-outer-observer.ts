import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { observeClaudeModelOuterCandidate, type ClaudeModelOuterProbeInput,
  type ClaudeModelOuterProbeObservation } from './claude-model-outer-probe.js';
import { runClaudeModelSupervisorOperation } from './claude-model-supervisor-runner.js';
import type { ClaudeModelSupervisorDescriptor, ClaudeModelSupervisorState } from
  './claude-model-supervisor.js';

type Candidate = Extract<ClaudeModelOuterProbeObservation, { kind: 'outer_probe_candidate' }>;
export type ClaudeModelOuterObservation =
  | { kind: 'outer_journal_candidate'; candidate: Candidate; journalAfter: ClaudeModelSupervisorState }
  | { kind: 'unconfirmed' };

/** Original owner only: deadline starts BEFORE its first release, never at READY or on recovery. */
export interface ClaudeModelOuterOwnerWindow {
  deadline: number;
  closed: Promise<unknown>;
  signal?: AbortSignal;
}
export interface ClaudeModelOuterObserverPorts {
  collect: typeof observeClaudeModelOuterCandidate;
  status: (descriptor: ClaudeModelSupervisorDescriptor, root: string,
    signal: AbortSignal) => Promise<ClaudeModelSupervisorState | null>;
}
const ports: ClaudeModelOuterObserverPorts = {
  collect: observeClaudeModelOuterCandidate,
  status: (descriptor, root, signal) =>
    runClaudeModelSupervisorOperation('status', descriptor, root, undefined, signal),
};

/** Sampled prerequisites only. No confinement receipt, persistence or prompt permission. */
export async function observeClaudeModelOuter(input: ClaudeModelOuterProbeInput,
  owner: ClaudeModelOuterOwnerWindow,
  dependencies: ClaudeModelOuterObserverPorts = ports): Promise<ClaudeModelOuterObservation> {
  const unavailable = { kind: 'unconfirmed' } as const;
  let saved: ClaudeModelOuterProbeInput;
  try { saved = structuredClone(input); } catch { return unavailable; }
  const deadline = owner?.deadline;
  const signal = owner?.signal;
  const remaining = deadline - performance.now();
  if (!Number.isFinite(deadline) || remaining <= 0 || remaining > 5000 ||
      !(owner.closed instanceof Promise) || signal?.aborted) return unavailable;
  const controller = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<ClaudeModelOuterObservation>(resolve => {
    cancel = () => { controller.abort(); resolve(unavailable); };
  });
  const expired = () => controller.signal.aborted || performance.now() >= deadline;
  const timer = setTimeout(cancel, remaining);
  signal?.addEventListener('abort', cancel, { once: true });
  // A late bounded bridge may still finish. Its result is discarded, never retried.
  void owner.closed.then(cancel, cancel);
  try {
    await Promise.resolve();
    if (expired()) return unavailable;
    const observation = (async (): Promise<ClaudeModelOuterObservation> => {
      const candidate = structuredClone(await dependencies.collect(saved));
      if (expired() || candidate.kind !== 'outer_probe_candidate' ||
          !isDeepStrictEqual(candidate.running, saved.running) ||
          !isDeepStrictEqual(candidate.startup, saved.startup)) return unavailable;
      const root = saved.running.resource.gate?.root;
      if (typeof root !== 'string') return unavailable;
      const journal = await dependencies.status(saved.descriptor, root, controller.signal);
      if (expired() || !journal || journal.closed || journal.phase !== 'consumed' ||
          !isDeepStrictEqual(journal, saved.startup.journal)) return unavailable;
      const result: ClaudeModelOuterObservation = { kind: 'outer_journal_candidate',
        candidate: structuredClone(candidate), journalAfter: structuredClone(journal) };
      return expired() ? unavailable : result;
    })().catch(() => unavailable);
    return await Promise.race([observation, cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

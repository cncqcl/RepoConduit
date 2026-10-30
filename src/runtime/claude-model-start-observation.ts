import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';
import { observeClaudeModelRunning } from '../adapters/secondary-investigator/claude-model-running-observer.js';
import type { ClaudeModelSupervisorDescriptor, ClaudeModelSupervisorState } from
  '../adapters/secondary-investigator/claude-model-supervisor.js';
import type { createClaudeModelRunningTickets } from './claude-model-running-tickets.js';

type Store = Pick<SqliteInvestigationStore, 'get' | 'preflightClaudeModelLaunch' | 'observeWslResource' |
  'recordNativeStart' | 'recordModelRunningObservation' | 'markRecoveryRequired'>;
export interface ClaudeModelStartObservationInput {
  claim: InvestigationClaim;
  journal: ClaudeModelSupervisorState;
  descriptor: ClaudeModelSupervisorDescriptor;
  store: Store;
  /** The same receipt instance must back both store authority callbacks. */
  tickets: ReturnType<typeof createClaudeModelRunningTickets>;
  nativeRef: string;
  profileRevision: string;
  now?: () => Date;
}

/** Observes a waiting original unit and persists identity/fact. It never releases or sends a prompt. */
export async function persistClaudeModelRunning(input: ClaudeModelStartObservationInput,
  observe: typeof observeClaudeModelRunning = observeClaudeModelRunning): Promise<InvestigationClaim> {
  const { store, tickets, nativeRef, profileRevision } = input;
  const now = input.now ?? (() => new Date());
  let current = structuredClone(input.claim);
  const journal = structuredClone(input.journal);
  const descriptor = structuredClone(input.descriptor);
  let startReceipt: string | undefined;
  let runningReceipt: string | undefined;
  try {
    const record = store.get(current.requestId);
    const resource = current.wslResource;
    const launch = resource?.gate?.launch;
    if (!record || !resource || !launch || current.phase !== 'start_intent' || current.nativeRef !== null ||
      descriptor.attemptId !== current.attemptId || descriptor.workspaceId !== current.workspaceId ||
      !journal.invocationId || !journal.controlGroup) throw new Error('NOT_AVAILABLE');
    const selected = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
    store.preflightClaudeModelLaunch(current, selected, profileRevision, launch, now());
    const candidate = { ...resource, invocationId: journal.invocationId, controlGroup: journal.controlGroup };
    const observation = await observe(candidate, journal, descriptor);
    if (observation.kind !== 'claude_model_running' ||
      !isDeepStrictEqual(observation.resource, candidate) || !isDeepStrictEqual(observation.journal, journal)) {
      throw new Error('NOT_AVAILABLE');
    }
    // Save real identity even if authority changed during the native probe; recordNativeStart
    // keeps that identity for cleanup but returns reconcile instead of executable started.
    current = store.observeWslResource(current,
      { invocationId: candidate.invocationId, controlGroup: candidate.controlGroup }, now());
    startReceipt = tickets.issueNativeStart(current, nativeRef, observation);
    current = store.recordNativeStart(current, nativeRef, startReceipt, now());
    if (current.phase !== 'started') throw new Error('NOT_AVAILABLE');
    runningReceipt = tickets.issueRunning(current, observation);
    store.recordModelRunningObservation(current, observation, runningReceipt, now());
    return current;
  } catch {
    try { store.markRecoveryRequired(current, now()); } catch {
      // Expired/stale owner cannot overwrite the new owner. Existing slot stays occupied.
    }
    throw new Error('MODEL_RUNNING_UNAVAILABLE');
  } finally {
    if (startReceipt) tickets.revoke(startReceipt);
    if (runningReceipt) tickets.revoke(runningReceipt);
  }
}

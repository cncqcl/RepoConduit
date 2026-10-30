import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, SqliteInvestigationStore, WslResource } from
  '../adapters/storage/investigation-sqlite.js';
import { observeClaudeModelTerminal, type ClaudeModelTerminalObservation } from
  '../adapters/secondary-investigator/claude-model-terminal-observer.js';
import type { ClaudeModelRunningObservation } from
  '../adapters/secondary-investigator/claude-model-running-observer.js';
import { validateClaudeModelOuterFact, type ModelOuterConfinedFact } from
  '../adapters/secondary-investigator/claude-model-outer-fact.js';
import { observeClaudeModelTreeTerminal, validateClaudeModelTreeTerminal,
  type ClaudeModelTreeTerminalObservation } from
  '../adapters/secondary-investigator/claude-model-tree-terminal.js';
import { claudeModelSupervisorSpec, parseClaudeModelSupervisorOutput,
  type ClaudeModelSupervisorDescriptor, type ClaudeModelSupervisorState } from
  '../adapters/secondary-investigator/claude-model-supervisor.js';
import { runClaudeModelSupervisorOperation } from
  '../adapters/secondary-investigator/claude-model-supervisor-runner.js';
import type { createClaudeModelPreventionTickets } from './claude-model-prevention-tickets.js';
import type { createClaudeModelTreeTickets } from './claude-model-tree-tickets.js';

type Store = Pick<SqliteInvestigationStore, 'acquireWslCleanupLease' | 'observeWslResource' |
  'preflightClaudeModelCleanup' | 'getModelRunningObservation' |
  'settleClaudeModelExecutionPrevented'> &
  Partial<Pick<SqliteInvestigationStore, 'getModelOuterFact' | 'settleClaudeModelTreeTerminated'>>;
type Running = Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }>;

export interface ClaudeModelRecoveryOperations {
  close(descriptor: ClaudeModelSupervisorDescriptor, root: string): Promise<ClaudeModelSupervisorState | null>;
  observeTerminal(resource: WslResource, journal: ClaudeModelSupervisorState,
    descriptor: ClaudeModelSupervisorDescriptor, runningFact: Running | null):
    Promise<ClaudeModelTerminalObservation>;
  observeTreeTerminal(fact: ModelOuterConfinedFact, closedJournal: ClaudeModelSupervisorState):
    Promise<ClaudeModelTreeTerminalObservation>;
}

const defaultOperations: ClaudeModelRecoveryOperations = {
  close: (descriptor, root) => runClaudeModelSupervisorOperation('close', descriptor, root),
  observeTerminal: (resource, journal, descriptor, runningFact) =>
    observeClaudeModelTerminal(resource, journal, descriptor, runningFact),
  observeTreeTerminal: (fact, closedJournal) => observeClaudeModelTreeTerminal(fact, closedJournal),
};

function descriptorFor(claim: InvestigationClaim): ClaudeModelSupervisorDescriptor | null {
  const resource = claim.wslResource; const gate = resource?.gate; const launch = gate?.launch;
  if (claim.phase !== 'reconcile' || claim.launchProtocol !== 'resource_reservation_v1' ||
    claim.sourceView || claim.windowsSource || claim.containerId || claim.containerName ||
    claim.scratchRoot || claim.dockerVolume ||
    !resource || !gate || gate.protocol !== 'attempt_gate_v1' ||
    gate.payloadKind !== 'claude_model_v1' || !launch ||
    launch.action !== 'claude_model_v1' || !launch.commandDigest ||
    !Number.isSafeInteger(claim.workerEpoch) || claim.workerEpoch <= launch.workerEpoch)
    return null;
  const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    distro: resource.distro, linuxUser: gate.linuxUser, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest, commandDigest: launch.commandDigest };
  try { claudeModelSupervisorSpec('close', descriptor, gate.root); }
  catch { return null; }
  return descriptor;
}

/** Closes one original gate; consumed and unconsumed phases require distinct proofs. */
export async function recoverClaudeModelAttempt(store: Store, unsettled: InvestigationClaim,
  workerId: string, tickets: ReturnType<typeof createClaudeModelPreventionTickets>,
  ops: Partial<ClaudeModelRecoveryOperations> & { now?: () => Date } = {},
  treeTickets?: ReturnType<typeof createClaudeModelTreeTickets>): Promise<boolean> {
  let preventionReceipt: string | undefined;
  let treeReceipt: string | undefined;
  const now = ops.now ?? (() => new Date());
  try {
    const input = structuredClone(unsettled);
    const acquired = store.acquireWslCleanupLease(input, workerId, now());
    if (!acquired) return false;
    let current = structuredClone(acquired);
    const descriptor = descriptorFor(current);
    const resource = current.wslResource;
    const root = resource?.gate?.root;
    if (!descriptor || !resource || !root) return false;
    store.preflightClaudeModelCleanup(current, now());
    const closed = structuredClone(await (ops.close ?? defaultOperations.close)(
      structuredClone(descriptor), root));
    if (!closed || !closed.closed || !['entered', 'released', 'consumed'].includes(closed.phase) ||
      !parseClaudeModelSupervisorOutput(JSON.stringify(closed) + '\n', descriptor) ||
      !closed.invocationId || !closed.controlGroup ||
      resource.invocationId !== null && resource.invocationId !== closed.invocationId ||
      resource.controlGroup !== null && resource.controlGroup !== closed.controlGroup) return false;
    current = structuredClone(store.observeWslResource(current,
      { invocationId: closed.invocationId, controlGroup: closed.controlGroup }, now()));
    const observedResource = current.wslResource;
    if (!observedResource || observedResource.invocationId !== closed.invocationId ||
      observedResource.controlGroup !== closed.controlGroup ||
      !isDeepStrictEqual(observedResource.gate, resource.gate)) return false;
    if (closed.phase === 'consumed') {
      if (!treeTickets || !store.getModelOuterFact || !store.settleClaudeModelTreeTerminated)
        return false;
      const running = structuredClone(store.getModelRunningObservation(current));
      const fact = structuredClone(store.getModelOuterFact(current));
      if (!running || !fact || !validateClaudeModelOuterFact(fact) ||
          !isDeepStrictEqual(fact.observation.candidate.running, running) ||
          !isDeepStrictEqual(fact.observation.candidate.running.resource, observedResource) ||
          !isDeepStrictEqual(fact.expectation.descriptor, descriptor) ||
          !isDeepStrictEqual(closed, {...fact.observation.journalAfter, closed: true}))
        return false;
      // Recheck the live cleanup lease immediately before a pidfd signal is possible.
      store.preflightClaudeModelCleanup(current, now());
      const observed = structuredClone(await (ops.observeTreeTerminal ??
        defaultOperations.observeTreeTerminal)(structuredClone(fact), structuredClone(closed)));
      if (observed.kind !== 'model_tree_terminal_v1' ||
          !validateClaudeModelTreeTerminal(fact, observed)) return false;
      store.preflightClaudeModelCleanup(current, now());
      treeReceipt = treeTickets.issue(current, fact, observed);
      store.settleClaudeModelTreeTerminated(current, observed, treeReceipt, now());
      return true;
    }
    const runningFact = structuredClone(store.getModelRunningObservation(current));
    const deadline = Date.now() + 7000;
    do {
      const terminal = await (ops.observeTerminal ?? defaultOperations.observeTerminal)(structuredClone(observedResource),
        structuredClone(closed), structuredClone(descriptor), structuredClone(runningFact));
      if (terminal.kind === 'model_unit_terminal' &&
        isDeepStrictEqual(terminal.resource, observedResource) &&
        isDeepStrictEqual(terminal.journal, closed)) {
        preventionReceipt = tickets.issue(current, terminal);
        store.settleClaudeModelExecutionPrevented(current, terminal, preventionReceipt, now());
        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    } while (Date.now() < deadline);
    return false;
  } catch { return false; }
  finally {
    if (preventionReceipt) tickets.revoke(preventionReceipt);
    if (treeReceipt) treeTickets?.revoke(treeReceipt);
  }
}

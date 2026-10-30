import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, WslResource } from '../adapters/storage/investigation-sqlite.js';
import type { ModelOuterConfinedFact } from '../adapters/secondary-investigator/claude-model-outer-fact.js';
import { validateCurrentClaudeModelOuterFact } from '../adapters/secondary-investigator/claude-model-outer-fact.js';
import type { ModelPromptIntent } from '../adapters/storage/investigation-sqlite.js';
import type { VerifiedClaudeModelOriginalOutcome } from './claude-model-investigation.js';
import { parseInvestigationResult } from '../core/investigation/result.js';
import { validateClaudeModelTreeTerminal, type ClaudeModelTreeTerminalObservation } from
  '../adapters/secondary-investigator/claude-model-tree-terminal.js';

type Ticket = {purpose: 'model_tree_terminal'; claim: InvestigationClaim;
  fact: ModelOuterConfinedFact; observation: ClaudeModelTreeTerminalObservation};

function exact(claim: InvestigationClaim, fact: ModelOuterConfinedFact,
  observation: ClaudeModelTreeTerminalObservation): boolean {
  try {
    const resource = claim.wslResource;
    const gate = resource?.gate; const launch = gate?.launch;
    if (claim.phase !== 'reconcile' || claim.launchProtocol !== 'resource_reservation_v1' ||
      claim.sourceView || claim.windowsSource || claim.containerId || claim.containerName ||
      claim.scratchRoot || claim.dockerVolume || !resource || !gate || !launch ||
      gate.protocol !== 'attempt_gate_v1' || gate.payloadKind !== 'claude_model_v1' ||
      launch.action !== 'claude_model_v1' || !launch.commandDigest ||
      !Number.isSafeInteger(claim.workerEpoch) || claim.workerEpoch <= launch.workerEpoch ||
      !claim.requestId || !claim.workerId || !claim.nativeRef ||
      !isDeepStrictEqual(fact.observation.candidate.running.resource, resource)) return false;
    const descriptor = {attemptId: claim.attemptId, workspaceId: claim.workspaceId,
      distro: resource.distro, linuxUser: gate.linuxUser, uid: resource.uid,
      bootId: resource.bootId, unitName: resource.unitName,
      launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
      profileDigest: launch.profileDigest, commandDigest: launch.commandDigest};
    return isDeepStrictEqual(fact.expectation.descriptor, descriptor) &&
      validateClaudeModelTreeTerminal(fact, observation);
  } catch { return false; }
}

type OriginalTicket = {purpose: 'original_tree' | 'original_outcome'; claim: InvestigationClaim;
  fact: ModelOuterConfinedFact; observation?: ClaudeModelTreeTerminalObservation;
  outcome?: VerifiedClaudeModelOriginalOutcome; intent?: ModelPromptIntent};

function original(claim: InvestigationClaim, fact: ModelOuterConfinedFact): boolean {
  const launch = claim.wslResource?.gate?.launch;
  return claim.phase === 'started' && !!claim.nativeRef && !!launch &&
    launch.workerEpoch === claim.workerEpoch && !!launch.commandDigest &&
    validateCurrentClaudeModelOuterFact(fact) &&
    isDeepStrictEqual(fact.observation.candidate.running.resource, claim.wslResource) &&
    fact.expectation.descriptor.commandDigest === launch.commandDigest;
}

/** Separate one-use original-owner purposes; cleanup tickets above remain unchanged. */
export function createClaudeModelOriginalCompletionTickets() {
  const issued = new Map<string, OriginalTicket>();
  const put = (ticket: OriginalTicket) => {
    if (issued.size >= 128) throw new Error('NOT_AVAILABLE');
    const id = randomUUID(); issued.set(id, structuredClone(ticket)); return id;
  };
  const take = (id: string, expected: OriginalTicket): boolean => {
    const ticket = issued.get(id);
    if (!ticket || !isDeepStrictEqual(ticket, expected)) return false;
    issued.delete(id); return true;
  };
  return {
    issueOutcome(claim: InvestigationClaim, fact: ModelOuterConfinedFact,
      intent: ModelPromptIntent, outcome: VerifiedClaudeModelOriginalOutcome): string {
      let parsed;
      try { parsed = parseInvestigationResult(outcome.candidate.result); }
      catch { throw new Error('NOT_AVAILABLE'); }
      if (!original(claim, fact) || intent.launchEpoch !== claim.workerEpoch ||
        intent.nativeRef !== claim.nativeRef ||
        intent.commandDigest !== fact.expectation.descriptor.commandDigest ||
        outcome.candidate.requestId !== claim.requestId ||
        outcome.candidate.attemptId !== claim.attemptId ||
        outcome.candidate.workerEpoch !== claim.workerEpoch ||
        outcome.candidate.nativeRef !== claim.nativeRef ||
        outcome.candidate.promptHash !== intent.promptHash ||
        outcome.candidate.commandDigest !== intent.commandDigest ||
        outcome.result.requestId !== claim.requestId || outcome.result.attemptId !== claim.attemptId ||
        !isDeepStrictEqual(parsed, outcome.result) ||
        !Number.isSafeInteger(outcome.candidate.numTurns) || outcome.candidate.numTurns < 1 ||
        !/^[0-9a-f]{64}$/.test(outcome.candidate.rawBytesSha256) ||
        !isDeepStrictEqual(outcome.evidenceReceiptIds,
          outcome.result.evidence.map(item => item.toolReceipt)))
        throw new Error('NOT_AVAILABLE');
      return put({purpose: 'original_outcome', claim, fact, intent, outcome});
    },
    verifyOutcome(claim: InvestigationClaim, resource: WslResource,
      fact: ModelOuterConfinedFact, intent: ModelPromptIntent,
      outcome: VerifiedClaudeModelOriginalOutcome, receipt: string): boolean {
      return isDeepStrictEqual(claim.wslResource, resource) && original(claim, fact) &&
        take(receipt, {purpose: 'original_outcome', claim, fact, intent, outcome});
    },
    issueTree(claim: InvestigationClaim, fact: ModelOuterConfinedFact,
      observation: ClaudeModelTreeTerminalObservation): string {
      if (!original(claim, fact) || !validateClaudeModelTreeTerminal(fact, observation))
        throw new Error('NOT_AVAILABLE');
      return put({purpose: 'original_tree', claim, fact, observation});
    },
    verifyTree(claim: InvestigationClaim, resource: WslResource,
      fact: ModelOuterConfinedFact, observation: ClaudeModelTreeTerminalObservation,
      receipt: string): boolean {
      return isDeepStrictEqual(claim.wslResource, resource) && original(claim, fact) &&
        validateClaudeModelTreeTerminal(fact, observation) &&
        take(receipt, {purpose: 'original_tree', claim, fact, observation});
    },
    revoke(receipt: string): void { issued.delete(receipt); },
  };
}

/** Internal process-local proof bridge; current cleanup lease is checked by storage. */
export function createClaudeModelTreeTickets() {
  const issued = new Map<string, Ticket>();
  return {
    issue(claim: InvestigationClaim, fact: ModelOuterConfinedFact,
      observation: ClaudeModelTreeTerminalObservation): string {
      if (issued.size >= 128 || !exact(claim, fact, observation)) throw new Error('NOT_AVAILABLE');
      const receipt = randomUUID();
      issued.set(receipt, structuredClone({purpose: 'model_tree_terminal', claim, fact, observation}));
      return receipt;
    },
    verify(claim: InvestigationClaim, resource: WslResource, fact: ModelOuterConfinedFact,
      observation: ClaudeModelTreeTerminalObservation, receipt: string): boolean {
      const ticket = issued.get(receipt);
      if (!ticket || ticket.purpose !== 'model_tree_terminal' ||
        !isDeepStrictEqual(ticket.claim, claim) || !isDeepStrictEqual(claim.wslResource, resource) ||
        !isDeepStrictEqual(ticket.fact, fact) || !isDeepStrictEqual(ticket.observation, observation) ||
        !exact(claim, fact, observation)) return false;
      issued.delete(receipt);
      return true;
    },
    revoke(receipt: string): void { issued.delete(receipt); },
  };
}

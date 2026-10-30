import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, WslResource } from '../adapters/storage/investigation-sqlite.js';
import { claudeModelRunningSpec, type ClaudeModelRunningObservation } from
  '../adapters/secondary-investigator/claude-model-running-observer.js';
import type { ClaudeModelSupervisorState } from '../adapters/secondary-investigator/claude-model-supervisor.js';

type Running = Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }>;
type Ticket = { purpose: 'native_start' | 'running_fact'; claim: InvestigationClaim;
  nativeRef: string; observation: Running };

function exactObservation(claim: InvestigationClaim, observation: ClaudeModelRunningObservation): observation is Running {
  const resource = claim.wslResource;
  const gate = resource?.gate;
  const launch = gate?.launch;
  if (!resource || !gate || !launch?.commandDigest || observation.kind !== 'claude_model_running' ||
    claim.launchProtocol !== 'resource_reservation_v1' || claim.sourceView || claim.windowsSource ||
    claim.containerId || claim.containerName || claim.scratchRoot || claim.dockerVolume ||
    !isDeepStrictEqual(resource, observation.resource) ||
    !Number.isSafeInteger(claim.workerEpoch) || claim.workerEpoch !== launch.workerEpoch ||
    !claim.requestId || !claim.workerId) return false;
  try {
    claudeModelRunningSpec(resource, observation.journal, {
      attemptId: claim.attemptId, workspaceId: claim.workspaceId, distro: resource.distro,
      linuxUser: gate.linuxUser, uid: resource.uid, bootId: resource.bootId, unitName: resource.unitName,
      launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
      profileDigest: launch.profileDigest, commandDigest: launch.commandDigest,
    });
  } catch { return false; }
  const native = observation.native;
  const journal = observation.journal;
  return !!native && Object.keys(native).sort().join(',') ===
    'activeState,bootId,controlGroup,invocationId,loadState,mainPid,procControlGroup,startTicks,subState,uid,unitName' &&
    native.bootId === resource.bootId && native.uid === resource.uid && native.unitName === resource.unitName &&
    native.invocationId === resource.invocationId && native.controlGroup === resource.controlGroup &&
    native.loadState === 'loaded' && native.activeState === 'active' && native.subState === 'running' &&
    native.mainPid === journal.enterPid && native.startTicks === journal.enterStartTicks &&
    native.procControlGroup === resource.controlGroup;
}

/** Trusted process-local facts only. These receipts are not external inputs or user approvals. */
export function createClaudeModelRunningTickets() {
  const issued = new Map<string, Ticket>();
  const issue = (purpose: Ticket['purpose'], claim: InvestigationClaim, nativeRef: string,
    observation: ClaudeModelRunningObservation): string => {
    if (issued.size >= 128 || typeof nativeRef !== 'string' || !nativeRef || nativeRef.length > 256 ||
      !exactObservation(claim, observation) ||
      (purpose === 'native_start' ? claim.phase !== 'start_intent' || claim.nativeRef !== null :
        claim.phase !== 'started' || claim.nativeRef !== nativeRef)) throw new Error('NOT_AVAILABLE');
    const receipt = randomUUID();
    issued.set(receipt, structuredClone({ purpose, claim, nativeRef, observation }));
    return receipt;
  };
  const matching = (purpose: Ticket['purpose'], claim: InvestigationClaim, nativeRef: string,
    receipt: string): Ticket | undefined => {
    const ticket = issued.get(receipt);
    if (!ticket || ticket.purpose !== purpose || ticket.nativeRef !== nativeRef ||
      !isDeepStrictEqual(ticket.claim, claim) || !exactObservation(claim, ticket.observation)) return undefined;
    return ticket;
  };
  return {
    issueNativeStart(claim: InvestigationClaim, nativeRef: string, observation: ClaudeModelRunningObservation) {
      return issue('native_start', claim, nativeRef, observation);
    },
    verifyNativeStart(claim: InvestigationClaim, nativeRef: string, receipt: string): boolean {
      if (!matching('native_start', claim, nativeRef, receipt)) return false;
      issued.delete(receipt);
      return true;
    },
    issueRunning(claim: InvestigationClaim, observation: ClaudeModelRunningObservation) {
      return issue('running_fact', claim, claim.nativeRef ?? '', observation);
    },
    verifyRunning(claim: InvestigationClaim, resource: WslResource,
      fact: ClaudeModelSupervisorState, receipt: string): boolean {
      const ticket = matching('running_fact', claim, claim.nativeRef ?? '', receipt);
      if (!ticket || !isDeepStrictEqual(ticket.observation.resource, resource) ||
        !isDeepStrictEqual(ticket.observation.journal, fact)) return false;
      issued.delete(receipt);
      return true;
    },
    verifyRunningObservation(claim: InvestigationClaim, resource: WslResource,
      observation: ClaudeModelRunningObservation, receipt: string): boolean {
      const ticket = matching('running_fact', claim, claim.nativeRef ?? '', receipt);
      if (!ticket || !isDeepStrictEqual(ticket.observation.resource, resource) ||
        !isDeepStrictEqual(ticket.observation, observation)) return false;
      issued.delete(receipt);
      return true;
    },
    revoke(receipt: string) { issued.delete(receipt); },
  };
}

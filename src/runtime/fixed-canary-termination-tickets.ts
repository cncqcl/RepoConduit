import { randomUUID } from 'node:crypto';
import type { InvestigationClaim, WslResource } from '../adapters/storage/investigation-sqlite.js';
import type { FixedCanaryTerminalObservation } from
  '../adapters/codex/investigator/fixed-canary-terminal-observer.js';

type Binding = { requestId: string; attemptId: string; workspaceId: string;
  workerId: string; workerEpoch: number; resource: WslResource };

function sameResource(left: WslResource | undefined, right: WslResource | undefined): boolean {
  return !!left && !!right && left.unitName === right.unitName && left.distro === right.distro &&
    left.uid === right.uid && left.bootId === right.bootId &&
    left.invocationId === right.invocationId && left.controlGroup === right.controlGroup &&
    left.gate?.protocol === 'attempt_gate_v1' && right.gate?.protocol === 'attempt_gate_v1' &&
    left.gate.payloadKind === 'canary_v1' && right.gate.payloadKind === 'canary_v1' &&
    left.gate.linuxUser === right.gate.linuxUser && left.gate.root === right.gate.root;
}

/** Process-local one-use bridge from native observation to the SQLite termination fence. */
export function createFixedCanaryTerminationTickets(): {
  issue(claim: InvestigationClaim, observation: FixedCanaryTerminalObservation): string;
  verify(claim: InvestigationClaim, resource: WslResource, receipt: string): boolean;
  revoke(receipt: string): void;
} {
  const issued = new Map<string, Binding>();
  return {
    issue(claim, observation) {
      if (claim.phase !== 'reconcile' || claim.nativeRef !== null ||
        claim.launchProtocol !== 'resource_reservation_v1' ||
        observation.kind !== 'fixed_canary_terminal' ||
        !sameResource(claim.wslResource, observation.resource) || issued.size >= 128)
        throw new Error('NOT_AVAILABLE');
      const receipt = randomUUID();
      issued.set(receipt, { requestId: claim.requestId, attemptId: claim.attemptId,
        workspaceId: claim.workspaceId, workerId: claim.workerId,
        workerEpoch: claim.workerEpoch, resource: observation.resource });
      return receipt;
    },
    verify(claim, resource, receipt) {
      const binding = issued.get(receipt);
      if (!binding || binding.requestId !== claim.requestId ||
        binding.attemptId !== claim.attemptId || binding.workspaceId !== claim.workspaceId ||
        binding.workerId !== claim.workerId || binding.workerEpoch !== claim.workerEpoch ||
        claim.phase !== 'reconcile' || claim.nativeRef !== null ||
        claim.launchProtocol !== 'resource_reservation_v1' ||
        !sameResource(binding.resource, resource) || !sameResource(claim.wslResource, resource))
        return false;
      issued.delete(receipt);
      return true;
    },
    revoke(receipt) { issued.delete(receipt); },
  };
}

export type ReturnTypeFixedCanaryTickets = ReturnType<typeof createFixedCanaryTerminationTickets>;

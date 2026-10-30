import { randomUUID } from 'node:crypto';
import type { DockerCleanupResult } from '../adapters/investigator/docker-volume-cleanup.js';
import type { DockerVolumeResource, InvestigationClaim } from
  '../adapters/storage/investigation-sqlite.js';

type Cleaned = Extract<DockerCleanupResult, { kind: 'cleaned' }>;
type Binding = { requestId: string; attemptId: string; workspaceId: string;
  workerId: string; workerEpoch: number; resource: DockerVolumeResource };

function sameResource(left: DockerVolumeResource | undefined, right: DockerVolumeResource | undefined): boolean {
  return !!left && !!right && left.protocol === right.protocol && left.daemonId === right.daemonId &&
    left.ownerName === right.ownerName && left.ownerId === right.ownerId &&
    left.volumeName === right.volumeName && left.materializationIntent === right.materializationIntent &&
    left.materialized === right.materialized && left.readerName === right.readerName &&
    left.readerId === right.readerId;
}

/** Process-local one-use bridge between a complete Docker absence observation and store settlement. */
export function createDockerVolumeCleanupTickets(): {
  issue(claim: InvestigationClaim, observation: Cleaned): string;
  verify(claim: InvestigationClaim, resource: DockerVolumeResource, receipt: string): boolean;
  revoke(receipt: string): void;
} {
  const issued = new Map<string, Binding>();
  return {
    issue(claim, observation) {
      const resource = claim.dockerVolume;
      if (claim.phase !== 'reconcile' || claim.nativeRef !== null ||
        claim.launchProtocol !== 'resource_reservation_v1' || !resource?.ownerId ||
        !resource.volumeName || (resource.readerName !== null && !resource.readerId) ||
        observation.kind !== 'cleaned' || observation.evidence.daemonId !== resource.daemonId ||
        observation.evidence.ownerId !== resource.ownerId ||
        observation.evidence.readerId !== resource.readerId ||
        observation.evidence.volumeName !== resource.volumeName || issued.size >= 128) {
        throw new Error('NOT_AVAILABLE');
      }
      const receipt = randomUUID();
      issued.set(receipt, { requestId: claim.requestId, attemptId: claim.attemptId,
        workspaceId: claim.workspaceId, workerId: claim.workerId, workerEpoch: claim.workerEpoch,
        resource: { ...resource } });
      return receipt;
    },
    verify(claim, resource, receipt) {
      const binding = issued.get(receipt);
      if (!binding || binding.requestId !== claim.requestId || binding.attemptId !== claim.attemptId ||
        binding.workspaceId !== claim.workspaceId || binding.workerId !== claim.workerId ||
        binding.workerEpoch !== claim.workerEpoch || claim.phase !== 'reconcile' ||
        claim.nativeRef !== null || claim.launchProtocol !== 'resource_reservation_v1' ||
        !sameResource(binding.resource, resource) || !sameResource(claim.dockerVolume, resource)) return false;
      issued.delete(receipt);
      return true;
    },
    revoke(receipt) { issued.delete(receipt); },
  };
}

export type DockerVolumeCleanupTickets = ReturnType<typeof createDockerVolumeCleanupTickets>;

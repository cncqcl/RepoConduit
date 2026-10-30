import { randomUUID } from 'node:crypto';
import type { InvestigationClaim, NativeSupervisorLaunchBinding, WslResource } from
  '../adapters/storage/investigation-sqlite.js';
import { parseNativeSupervisorGateOutput, type NativeSupervisorGateState } from
  '../adapters/secondary-investigator/claude-native-supervisor.js';
import type { SupervisorV2TerminalObservation } from
  '../adapters/secondary-investigator/supervisor-v2-terminal-observer.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from '../core/investigation/fixed-zero-model-profile.js';

type Binding = { requestId: string; attemptId: string; workspaceId: string;
  workerId: string; workerEpoch: number; resource: WslResource;
  launch: NativeSupervisorLaunchBinding; journal: NativeSupervisorGateState };

function sameLaunch(a: NativeSupervisorLaunchBinding | undefined,
  b: NativeSupervisorLaunchBinding | undefined): boolean {
  return !!a && !!b && a.workerEpoch === b.workerEpoch &&
    a.sourceDigest === b.sourceDigest && a.profileDigest === b.profileDigest && a.action === b.action;
}

function sameResource(a: WslResource | undefined, b: WslResource | undefined): boolean {
  return !!a && !!b && a.unitName === b.unitName && a.distro === b.distro &&
    a.uid === b.uid && a.bootId === b.bootId &&
    a.invocationId === b.invocationId && a.controlGroup === b.controlGroup &&
    a.gate?.protocol === 'attempt_gate_v1' && b.gate?.protocol === 'attempt_gate_v1' &&
    a.gate.payloadKind === 'native_supervisor_v2' && b.gate.payloadKind === 'native_supervisor_v2' &&
    a.gate.linuxUser === b.gate.linuxUser && a.gate.root === b.gate.root &&
    sameLaunch(a.gate.launch, b.gate.launch);
}

function sameJournal(a: NativeSupervisorGateState, b: NativeSupervisorGateState): boolean {
  return a.protocol === b.protocol && a.phase === b.phase && a.closed === b.closed &&
    a.attemptId === b.attemptId && a.workspaceId === b.workspaceId &&
    a.bootId === b.bootId && a.uid === b.uid && a.unitName === b.unitName &&
    a.launchWorkerEpoch === b.launchWorkerEpoch && a.sourceDigest === b.sourceDigest &&
    a.profileDigest === b.profileDigest && a.invocationId === b.invocationId &&
    a.controlGroup === b.controlGroup && a.enterPid === b.enterPid &&
    a.enterStartTicks === b.enterStartTicks;
}

function validTerminalBinding(claim: InvestigationClaim, resource: WslResource,
  launch: NativeSupervisorLaunchBinding, journal: NativeSupervisorGateState): boolean {
  if (!claim || claim.phase !== 'reconcile' || claim.nativeRef !== null ||
    claim.launchProtocol !== 'resource_reservation_v1' ||
    !resource?.gate || resource.gate.payloadKind !== 'native_supervisor_v2' ||
    !sameLaunch(resource.gate.launch, launch) ||
    launch.action !== 'fixed_zero_model_v1' ||
    launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
    !Number.isSafeInteger(claim.workerEpoch) || claim.workerEpoch <= launch.workerEpoch ||
    !sameResource(claim.wslResource, resource) ||
    !resource.invocationId || !resource.controlGroup ||
    !journal || journal.protocol !== 'native_supervisor_v2' ||
    journal.phase !== 'consumed' || !journal.closed ||
    journal.attemptId !== claim.attemptId || journal.workspaceId !== claim.workspaceId ||
    journal.bootId !== resource.bootId || journal.uid !== resource.uid ||
    journal.unitName !== resource.unitName ||
    journal.invocationId !== resource.invocationId ||
    journal.controlGroup !== resource.controlGroup ||
    journal.launchWorkerEpoch !== launch.workerEpoch ||
    journal.sourceDigest !== launch.sourceDigest ||
    journal.profileDigest !== launch.profileDigest) return false;
  const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    distro: resource.distro, linuxUser: resource.gate.linuxUser,
    bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest };
  return parseNativeSupervisorGateOutput(JSON.stringify(journal) + '\n', descriptor)?.protocol ===
    'native_supervisor_v2';
}

/** One-use process-local bridge from a verified fixed-unit terminal observation to storage. */
export function createSupervisorV2TerminationTickets(): {
  issue(claim: InvestigationClaim, observation: SupervisorV2TerminalObservation): string;
  verify(claim: InvestigationClaim, resource: WslResource, launch: NativeSupervisorLaunchBinding,
    journal: NativeSupervisorGateState, receipt: string): boolean;
  revoke(receipt: string): void;
} {
  const issued = new Map<string, Binding>();
  return {
    issue(claim, observation) {
      if (observation.kind !== 'fixed_zero_model_terminal' ||
        !validTerminalBinding(claim, observation.resource,
          observation.resource.gate?.launch as NativeSupervisorLaunchBinding, observation.journal) ||
        issued.size >= 128) throw new Error('NOT_AVAILABLE');
      const resource: WslResource = { ...observation.resource,
        gate: { ...observation.resource.gate!, launch: { ...observation.resource.gate!.launch! } } };
      const receipt = randomUUID();
      issued.set(receipt, { requestId: claim.requestId, attemptId: claim.attemptId,
        workspaceId: claim.workspaceId, workerId: claim.workerId,
        workerEpoch: claim.workerEpoch, resource, launch: { ...resource.gate!.launch! },
        journal: { ...observation.journal } });
      return receipt;
    },
    verify(claim, resource, launch, journal, receipt) {
      const binding = issued.get(receipt);
      if (!binding || binding.requestId !== claim.requestId ||
        binding.attemptId !== claim.attemptId || binding.workspaceId !== claim.workspaceId ||
        binding.workerId !== claim.workerId || binding.workerEpoch !== claim.workerEpoch ||
        !sameResource(binding.resource, resource) || !sameLaunch(binding.launch, launch) ||
        !sameJournal(binding.journal, journal) ||
        !validTerminalBinding(claim, resource, launch, journal)) return false;
      issued.delete(receipt);
      return true;
    },
    revoke(receipt) { issued.delete(receipt); },
  };
}

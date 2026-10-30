import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, WslResource } from '../adapters/storage/investigation-sqlite.js';
import { claudeModelTerminalSpec, type ClaudeModelTerminalObservation } from
  '../adapters/secondary-investigator/claude-model-terminal-observer.js';
import { claudeModelRunningSpec } from
  '../adapters/secondary-investigator/claude-model-running-observer.js';
import { parseClaudeModelSupervisorOutput } from
  '../adapters/secondary-investigator/claude-model-supervisor.js';

type Terminal = Extract<ClaudeModelTerminalObservation, { kind: 'model_unit_terminal' }>;
type Ticket = { purpose: 'model_execution_prevented'; claim: InvestigationClaim;
  observation: Terminal };

function exactPrevention(claim: InvestigationClaim, resource: WslResource,
  observation: ClaudeModelTerminalObservation): observation is Terminal {
  const gate = resource?.gate; const launch = gate?.launch;
  if (!claim || claim.phase !== 'reconcile' ||
    claim.launchProtocol !== 'resource_reservation_v1' ||
    claim.sourceView || claim.windowsSource || claim.containerId || claim.containerName ||
    claim.scratchRoot || claim.dockerVolume ||
    !gate || gate.protocol !== 'attempt_gate_v1' || gate.payloadKind !== 'claude_model_v1' ||
    !launch || launch.action !== 'claude_model_v1' || !launch.commandDigest ||
    !Number.isSafeInteger(claim.workerEpoch) || claim.workerEpoch <= launch.workerEpoch ||
    !claim.requestId || !claim.workerId ||
    !isDeepStrictEqual(claim.wslResource, resource) ||
    observation.kind !== 'model_unit_terminal' ||
    !isDeepStrictEqual(observation.resource, resource)) return false;
  const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    distro: resource.distro, linuxUser: gate.linuxUser, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest, commandDigest: launch.commandDigest };
  const journal = observation.journal;
  if (!journal.closed || !['entered', 'released'].includes(journal.phase) ||
    journal.invocationId !== resource.invocationId ||
    journal.controlGroup !== resource.controlGroup) return false;
  try { claudeModelTerminalSpec(resource, journal, descriptor); }
  catch { return false; }
  if (!parseClaudeModelSupervisorOutput(JSON.stringify(journal) + '\n', descriptor)) return false;
  const native = observation.native;
  const keys = ['bootId','uid','unitName','invocationId','controlGroup','loadState',
    'activeState','subState','mainPid','originalPid','originalStartTicks',
    'processState','cgroupState'];
  if (!native || Object.keys(native).length !== keys.length || keys.some(key => !(key in native)) ||
    native.bootId !== resource.bootId || native.uid !== resource.uid ||
    native.unitName !== resource.unitName || native.mainPid !== 0 ||
    native.originalPid !== journal.enterPid ||
    native.originalStartTicks !== journal.enterStartTicks ||
    native.processState !== 'absent' ||
    !['empty','absent'].includes(native.cgroupState)) return false;
  const loaded = native.loadState === 'loaded' &&
    native.invocationId === resource.invocationId &&
    (native.controlGroup === resource.controlGroup || native.controlGroup === '') &&
    (native.activeState === 'inactive' && native.subState === 'dead' ||
      native.activeState === 'failed' && native.subState === 'failed');
  const unloaded = native.loadState === 'not-found' && native.activeState === 'inactive' &&
    native.subState === 'dead' && native.invocationId === '' && native.controlGroup === '';
  if (!loaded && !unloaded) return false;
  const historical = observation.runningFact;
  if (historical === undefined) return true;
  if (historical.kind !== 'claude_model_running' ||
    !isDeepStrictEqual(historical.resource, resource) ||
    !isDeepStrictEqual(historical.journal, { ...journal, phase: 'entered', closed: false }))
    return false;
  try { claudeModelRunningSpec(resource, historical.journal, descriptor); }
  catch { return false; }
  const live = historical.native;
  const liveKeys = ['bootId','uid','unitName','invocationId','controlGroup','loadState',
    'activeState','subState','mainPid','startTicks','procControlGroup'];
  return !!live && Object.keys(live).length === liveKeys.length &&
    liveKeys.every(key => key in live) &&
    live.bootId === resource.bootId && live.uid === resource.uid &&
    live.unitName === resource.unitName && live.invocationId === resource.invocationId &&
    live.controlGroup === resource.controlGroup && live.loadState === 'loaded' &&
    live.activeState === 'active' && live.subState === 'running' &&
    live.mainPid === journal.enterPid && live.startTicks === journal.enterStartTicks &&
    live.procControlGroup === resource.controlGroup;
}

/** One-use process-local bridge for closed unconsumed model execution prevention. */
export function createClaudeModelPreventionTickets() {
  const issued = new Map<string, Ticket>();
  return {
    issue(claim: InvestigationClaim, observation: ClaudeModelTerminalObservation): string {
      if (issued.size >= 128 || observation.kind !== 'model_unit_terminal' ||
        !exactPrevention(claim, observation.resource, observation)) throw new Error('NOT_AVAILABLE');
      const receipt = randomUUID();
      issued.set(receipt, structuredClone({ purpose: 'model_execution_prevented', claim, observation }));
      return receipt;
    },
    verify(claim: InvestigationClaim, resource: WslResource,
      observation: ClaudeModelTerminalObservation, receipt: string): boolean {
      const ticket = issued.get(receipt);
      if (!ticket || ticket.purpose !== 'model_execution_prevented' ||
        !isDeepStrictEqual(ticket.claim, claim) ||
        !isDeepStrictEqual(ticket.observation.resource, resource) ||
        !isDeepStrictEqual(ticket.observation, observation) ||
        !exactPrevention(claim, resource, observation)) return false;
      issued.delete(receipt);
      return true;
    },
    revoke(receipt: string): void { issued.delete(receipt); },
  };
}

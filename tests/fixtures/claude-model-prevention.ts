import { randomUUID } from 'node:crypto';
import type { InvestigationClaim, WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import type { ClaudeModelTerminalObservation } from
  '../../src/adapters/secondary-investigator/claude-model-terminal-observer.js';

export function preventionFixture() {
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const attemptId = `attempt_${randomUUID()}`;
  const workspaceId = `ws_${randomUUID()}`;
  const bootId = randomUUID();
  const uid = 1000;
  const invocationId = 'a'.repeat(32);
  const controlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unitName}`;
  const launch = { action: 'claude_model_v1' as const, workerEpoch: 1,
    sourceDigest: 'b'.repeat(64), profileDigest: 'c'.repeat(64), commandDigest: 'd'.repeat(64) };
  const resource: WslResource = { unitName, distro: 'Ubuntu-22.04', uid, bootId,
    invocationId, controlGroup, gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture',
      root: '/home/fixture/model-gates', payloadKind: 'claude_model_v1', launch } };
  const claim: InvestigationClaim = { requestId: randomUUID(), attemptId, workspaceId,
    workerId: 'cleanup', workerEpoch: 2, nativeRef: 'owned-native', phase: 'reconcile',
    launchProtocol: 'resource_reservation_v1', wslResource: resource };
  const journal = { protocol: 'claude_model_v1' as const, action: 'claude_model_v1' as const,
    phase: 'entered' as const, closed: true, attemptId, workspaceId, bootId, uid,
    unitName, launchWorkerEpoch: 1, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest, commandDigest: launch.commandDigest,
    invocationId, controlGroup, enterPid: 123, enterStartTicks: 456 };
  const observation: Extract<ClaudeModelTerminalObservation, { kind: 'model_unit_terminal' }> = {
    kind: 'model_unit_terminal', resource, journal,
    native: { bootId, uid, unitName, invocationId, controlGroup,
      loadState: 'loaded', activeState: 'inactive', subState: 'dead', mainPid: 0,
      originalPid: 123, originalStartTicks: 456, processState: 'absent', cgroupState: 'empty' } };
  return { claim, observation };
}

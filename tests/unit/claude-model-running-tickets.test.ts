import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { InvestigationClaim, WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import type { ClaudeModelRunningObservation } from '../../src/adapters/secondary-investigator/claude-model-running-observer.js';
import { createClaudeModelRunningTickets } from '../../src/runtime/claude-model-running-tickets.js';

function fixture() {
  const uid = 1000;
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const resource: WslResource = { unitName, distro: 'Ubuntu-22.04', uid, bootId: randomUUID(),
    invocationId: 'a'.repeat(32), controlGroup: `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unitName}`,
    gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture', root: '/home/fixture/model-gates', payloadKind: 'claude_model_v1',
      launch: { action: 'claude_model_v1', workerEpoch: 1, sourceDigest: 'b'.repeat(64),
        profileDigest: 'c'.repeat(64), commandDigest: 'd'.repeat(64) } } };
  const claim: InvestigationClaim = { requestId: randomUUID(), attemptId: `attempt_${randomUUID()}`,
    workspaceId: `ws_${randomUUID()}`, workerId: 'worker', workerEpoch: 1, nativeRef: null,
    phase: 'start_intent', launchProtocol: 'resource_reservation_v1', wslResource: resource };
  const journal = { protocol: 'claude_model_v1' as const, action: 'claude_model_v1' as const,
    phase: 'entered' as const, closed: false, attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    bootId: resource.bootId, uid, unitName, launchWorkerEpoch: 1, sourceDigest: 'b'.repeat(64),
    profileDigest: 'c'.repeat(64), commandDigest: 'd'.repeat(64), invocationId: resource.invocationId!,
    controlGroup: resource.controlGroup!, enterPid: 123, enterStartTicks: 456 };
  const observation: Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }> = {
    kind: 'claude_model_running', resource, journal,
    native: { bootId: resource.bootId, uid, unitName, invocationId: resource.invocationId!,
      controlGroup: resource.controlGroup!, loadState: 'loaded', activeState: 'active', subState: 'running',
      mainPid: 123, startTicks: 456, procControlGroup: resource.controlGroup! } };
  return { claim, observation };
}

test('native-start and running-fact receipts are distinct, exact and single-use', () => {
  const { claim, observation } = fixture();
  const tickets = createClaudeModelRunningTickets();
  const nativeRef = 'model-owned-native';
  const start = tickets.issueNativeStart(claim, nativeRef, observation);
  const running = { ...claim, phase: 'started' as const, nativeRef };
  assert.equal(tickets.verifyRunning(running, claim.wslResource!, observation.journal, start), false);
  assert.equal(tickets.verifyNativeStart({ ...claim, workerEpoch: 2 }, nativeRef, start), false);
  assert.equal(tickets.verifyNativeStart(claim, 'wrong-ref', start), false);
  assert.equal(tickets.verifyNativeStart(claim, nativeRef, start), true);
  assert.equal(tickets.verifyNativeStart(claim, nativeRef, start), false);
  const receipt = tickets.issueRunning(running, observation);
  assert.equal(tickets.verifyNativeStart(claim, nativeRef, receipt), false);
  assert.equal(tickets.verifyRunning({ ...running, attemptId: `attempt_${randomUUID()}` }, claim.wslResource!, observation.journal, receipt), false);
  assert.equal(tickets.verifyRunning(running, claim.wslResource!, { ...observation.journal, commandDigest: 'e'.repeat(64) }, receipt), false);
  assert.equal(tickets.verifyRunning(running, claim.wslResource!, observation.journal, receipt), true);
  assert.equal(tickets.verifyRunning(running, claim.wslResource!, observation.journal, receipt), false);
});

test('running receipt refuses wrong native observations and protects stored bindings from mutation', () => {
  const { claim, observation } = fixture();
  const tickets = createClaudeModelRunningTickets();
  for (const patch of [{ mainPid: 999 }, { startTicks: 999 }, { bootId: randomUUID() },
    { invocationId: 'f'.repeat(32) }, { procControlGroup: '/wrong' }]) {
    assert.throws(() => tickets.issueNativeStart(claim, 'owned-native',
      { ...observation, native: { ...observation.native, ...patch } }));
  }
  assert.throws(() => tickets.issueNativeStart(claim, 'owned-native', { kind: 'unconfirmed' }));
  assert.throws(() => tickets.issueRunning({ ...claim, phase: 'reconcile', nativeRef: 'owned-native' }, observation));
  const receipt = tickets.issueNativeStart(claim, 'owned-native', observation);
  const original = structuredClone(claim);
  claim.wslResource!.gate!.launch!.commandDigest = 'f'.repeat(64);
  assert.equal(tickets.verifyNativeStart(claim, 'owned-native', receipt), false);
  assert.equal(tickets.verifyNativeStart(original, 'owned-native', receipt), true);
});

test('full running observation receipt binds native evidence without consuming on mismatch', () => {
  const { claim, observation } = fixture();
  const tickets = createClaudeModelRunningTickets();
  const nativeRef = 'model-owned-native';
  const start = tickets.issueNativeStart(claim, nativeRef, observation);
  const running = { ...claim, phase: 'started' as const, nativeRef };
  const receipt = tickets.issueRunning(running, observation);
  assert.equal(tickets.verifyRunningObservation(running, claim.wslResource!, observation, start), false);
  assert.equal(tickets.verifyRunningObservation({ ...running, workerId: 'other' }, claim.wslResource!, observation, receipt), false);
  assert.equal(tickets.verifyRunningObservation(running, { ...claim.wslResource!, bootId: randomUUID() }, observation, receipt), false);
  assert.equal(tickets.verifyRunningObservation(running, claim.wslResource!,
    { ...observation, native: { ...observation.native, mainPid: 999 } }, receipt), false);
  assert.equal(tickets.verifyRunningObservation(running, claim.wslResource!, observation, receipt), true);
  assert.equal(tickets.verifyRunningObservation(running, claim.wslResource!, observation, receipt), false);
  assert.equal(tickets.verifyNativeStart(claim, nativeRef, start), true);
});

test('revoked receipts are unusable and issuance capacity is bounded', () => {
  const { claim, observation } = fixture();
  const tickets = createClaudeModelRunningTickets();
  const receipts = Array.from({ length: 128 }, () => tickets.issueNativeStart(claim, 'owned-native', observation));
  assert.throws(() => tickets.issueNativeStart(claim, 'owned-native', observation));
  tickets.revoke(receipts[0]!);
  assert.equal(tickets.verifyNativeStart(claim, 'owned-native', receipts[0]!), false);
  const next = tickets.issueNativeStart(claim, 'owned-native', observation);
  assert.equal(tickets.verifyNativeStart(claim, 'owned-native', next), true);
  assert.throws(() => tickets.issueNativeStart({ ...claim, sourceView: {} as never }, 'owned-native', observation));
  assert.throws(() => tickets.issueNativeStart(claim, '', observation));
});

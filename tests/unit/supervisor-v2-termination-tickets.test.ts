import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { InvestigationClaim, WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import type { NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import type { SupervisorV2TerminalObservation } from
  '../../src/adapters/secondary-investigator/supervisor-v2-terminal-observer.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../../src/core/investigation/fixed-zero-model-profile.js';
import { createSupervisorV2TerminationTickets } from
  '../../src/runtime/supervisor-v2-termination-tickets.js';

const attemptId = `attempt_${randomUUID()}`;
const workspaceId = `ws_${randomUUID()}`;
const unitName = `rcac-investigator-${randomUUID()}.service`;
const bootId = randomUUID();
const invocationId = 'f'.repeat(32);
const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`;
const sourceDigest = 'a'.repeat(64);
const resource: WslResource = { unitName, distro: 'Ubuntu', uid: 1000, bootId,
  invocationId, controlGroup, gate: { protocol: 'attempt_gate_v1', linuxUser: 'investigator',
    root: '/home/investigator/gates', payloadKind: 'native_supervisor_v2',
    launch: { workerEpoch: 1, sourceDigest, profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST,
      action: 'fixed_zero_model_v1' } } };
const journal: NativeSupervisorGateState = { protocol: 'native_supervisor_v2', phase: 'consumed',
  closed: true, attemptId, workspaceId, bootId, uid: 1000, unitName,
  launchWorkerEpoch: 1, sourceDigest, profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST,
  invocationId, controlGroup, enterPid: 123, enterStartTicks: 456 };
const claim: InvestigationClaim = { requestId: 'inv', attemptId, workspaceId,
  workerId: 'cleanup', workerEpoch: 2, phase: 'reconcile', nativeRef: null,
  launchProtocol: 'resource_reservation_v1', wslResource: resource };
const observation: SupervisorV2TerminalObservation =
  { kind: 'fixed_zero_model_terminal', resource, journal };

test('one-use v2 ticket binds exact cleanup epoch, resource and consumed closed journal', () => {
  const tickets = createSupervisorV2TerminationTickets();
  const receipt = tickets.issue(claim, observation);
  assert.equal(tickets.verify({ ...claim, workerEpoch: 3 }, resource, resource.gate!.launch!, journal,
    receipt), false);
  assert.equal(tickets.verify(claim, { ...resource, invocationId: 'e'.repeat(32) },
    resource.gate!.launch!, journal, receipt), false);
  assert.equal(tickets.verify(claim, resource, { ...resource.gate!.launch!, sourceDigest: 'b'.repeat(64) },
    journal, receipt), false);
  assert.equal(tickets.verify(claim, resource, resource.gate!.launch!,
    { ...journal, enterPid: 999 }, receipt), false);
  assert.equal(tickets.verify(claim, resource, resource.gate!.launch!, journal, receipt), true);
  assert.equal(tickets.verify(claim, resource, resource.gate!.launch!, journal, receipt), false);
});

test('ticket issuer rejects open, unconsumed, cross-attempt and cross-resource observations', () => {
  const tickets = createSupervisorV2TerminationTickets();
  const changed = [
    { ...journal, closed: false }, { ...journal, phase: 'entered' as const },
    { ...journal, phase: 'released' as const },
    { ...journal, attemptId: `attempt_${randomUUID()}` },
    { ...journal, workspaceId: `ws_${randomUUID()}` },
    { ...journal, launchWorkerEpoch: 2 },
    { ...journal, sourceDigest: 'b'.repeat(64) },
    { ...journal, profileDigest: 'c'.repeat(64) },
    { ...journal, invocationId: 'e'.repeat(32) },
    { ...journal, controlGroup: '/wrong' },
  ];
  for (const bad of changed)
    assert.throws(() => tickets.issue(claim, { ...observation,
      kind: 'fixed_zero_model_terminal', journal: bad }), /NOT_AVAILABLE/);
  assert.throws(() => tickets.issue(claim, { kind: 'fixed_zero_model_terminal',
    resource: { ...resource, bootId: randomUUID() }, journal }), /NOT_AVAILABLE/);
  assert.throws(() => tickets.issue(claim, { kind: 'unconfirmed' }), /NOT_AVAILABLE/);
});

test('ticket issuer refuses wrong claim phase, nativeRef, old epoch and missing fixed profile', () => {
  const tickets = createSupervisorV2TerminationTickets();
  for (const changed of [
    { ...claim, phase: 'started' as const }, { ...claim, nativeRef: 'native' },
    { ...claim, workerEpoch: 1 }, { ...claim, attemptId: `attempt_${randomUUID()}` },
    { ...claim, workspaceId: `ws_${randomUUID()}` },
  ]) assert.throws(() => tickets.issue(changed, observation), /NOT_AVAILABLE/);
  const wrong = { ...resource, gate: { ...resource.gate!,
    launch: { ...resource.gate!.launch!, profileDigest: 'b'.repeat(64) } } };
  assert.throws(() => tickets.issue({ ...claim, wslResource: wrong },
    { kind: 'fixed_zero_model_terminal', resource: wrong, journal }), /NOT_AVAILABLE/);
});

test('issued ticket snapshots nested observation and explicit revoke removes it', () => {
  const tickets = createSupervisorV2TerminationTickets();
  const mutable = { ...resource, gate: { ...resource.gate!, launch: { ...resource.gate!.launch! } } };
  const state = { ...journal };
  const receipt = tickets.issue({ ...claim, wslResource: mutable },
    { kind: 'fixed_zero_model_terminal', resource: mutable, journal: state });
  mutable.gate.launch.sourceDigest = 'b'.repeat(64);
  state.enterPid = 999;
  assert.equal(tickets.verify(claim, resource, resource.gate!.launch!, journal, receipt), true);
  const another = tickets.issue(claim, observation);
  tickets.revoke(another);
  assert.equal(tickets.verify(claim, resource, resource.gate!.launch!, journal, another), false);
});

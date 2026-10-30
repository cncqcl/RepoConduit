import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixedCanaryTerminationTickets } from '../../src/runtime/fixed-canary-termination-tickets.js';
import type { InvestigationClaim, WslResource } from '../../src/adapters/storage/investigation-sqlite.js';

const unitName = 'rcac-investigator-11111111-1111-4111-8111-111111111111.service';
const resource: WslResource = { distro: 'Ubuntu-22.04', uid: 1000,
  bootId: '489e4ff0-c995-44d1-829f-2f23c3c2daa8', unitName,
  invocationId: 'f3f4939908f042f9bfbd804103a376f6',
  controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`,
  gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture', root: '/home/fixture/.local/state/rcac/gate',
    payloadKind: 'canary_v1' } };
const claim: InvestigationClaim = { requestId: 'inv_11111111-1111-4111-8111-111111111111',
  attemptId: 'attempt_22222222-2222-4222-8222-222222222222', workerId: 'cleanup', workerEpoch: 2,
  workspaceId: 'ws_33333333-3333-4333-8333-333333333333', phase: 'reconcile',
  launchProtocol: 'resource_reservation_v1', nativeRef: null, wslResource: resource };

test('fixed canary ticket binds one native observation to exact claim and resource', () => {
  const tickets = createFixedCanaryTerminationTickets();
  const receipt = tickets.issue(claim, { kind: 'fixed_canary_terminal', resource });
  assert.equal(tickets.verify({ ...claim, workerEpoch: 3 }, resource, receipt), false);
  assert.equal(tickets.verify(claim, { ...resource, invocationId: 'a'.repeat(32) }, receipt), false);
  assert.equal(tickets.verify(claim, resource, receipt), true);
  assert.equal(tickets.verify(claim, resource, receipt), false);
  const abandoned = tickets.issue(claim, { kind: 'fixed_canary_terminal', resource });
  tickets.revoke(abandoned);
  assert.equal(tickets.verify(claim, resource, abandoned), false);
});

test('fixed canary ticket rejects AI, changed resource and absent native observation', () => {
  const tickets = createFixedCanaryTerminationTickets();
  assert.throws(() => tickets.issue({ ...claim, nativeRef: 'native-thread' },
    { kind: 'fixed_canary_terminal', resource }));
  assert.throws(() => tickets.issue(claim, { kind: 'unconfirmed' }));
  const withoutGate: WslResource = { distro: resource.distro, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    invocationId: resource.invocationId, controlGroup: resource.controlGroup };
  assert.throws(() => tickets.issue({ ...claim, wslResource: withoutGate },
    { kind: 'fixed_canary_terminal', resource }));
});

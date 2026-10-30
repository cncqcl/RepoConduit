import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createClaudeModelPreventionTickets } from '../../src/runtime/claude-model-prevention-tickets.js';
import { preventionFixture } from '../fixtures/claude-model-prevention.js';

test('prevention receipt binds full claim, resource, journal and native proof once', () => {
  const { claim, observation } = preventionFixture();
  const tickets = createClaudeModelPreventionTickets();
  const receipt = tickets.issue(claim, observation);
  assert.equal(tickets.verify({ ...claim, nativeRef: 'other' }, observation.resource, observation, receipt), false);
  assert.equal(tickets.verify(claim, { ...observation.resource, bootId: randomUUID() }, observation, receipt), false);
  assert.equal(tickets.verify(claim, observation.resource,
    { ...observation, native: { ...observation.native, cgroupState: 'absent' } }, receipt), false);
  assert.equal(tickets.verify(claim, observation.resource, observation, receipt), true);
  assert.equal(tickets.verify(claim, observation.resource, observation, receipt), false);
});

test('prevention issuance refuses consumed, prepared, forged native and stale epoch', () => {
  const { claim, observation } = preventionFixture();
  const tickets = createClaudeModelPreventionTickets();
  assert.throws(() => tickets.issue(claim, { kind: 'unconfirmed' }));
  for (const phase of ['prepared', 'consumed'] as const) {
    assert.throws(() => tickets.issue(claim, { ...observation,
      journal: { ...observation.journal, phase } }));
  }
  assert.throws(() => tickets.issue(claim, { ...observation,
    native: { ...observation.native, originalPid: 124 } }));
  assert.throws(() => tickets.issue({ ...claim, workerEpoch: 1 }, observation));
  const receipts = Array.from({ length: 128 }, () => tickets.issue(claim, observation));
  assert.throws(() => tickets.issue(claim, observation));
  tickets.revoke(receipts[0]!);
  assert.equal(tickets.verify(claim, observation.resource, observation, receipts[0]!), false);
});

test('prevention receipt accepts only an exact historical entered fact when present', () => {
  const { claim, observation } = preventionFixture();
  const entered = { ...observation.journal, phase: 'entered' as const, closed: false };
  const runningFact = { kind: 'claude_model_running' as const,
    resource: observation.resource, journal: entered,
    native: { bootId: observation.resource.bootId, uid: observation.resource.uid,
      unitName: observation.resource.unitName, invocationId: observation.resource.invocationId!,
      controlGroup: observation.resource.controlGroup!, loadState: 'loaded' as const,
      activeState: 'active' as const, subState: 'running' as const,
      mainPid: entered.enterPid!, startTicks: entered.enterStartTicks!,
      procControlGroup: observation.resource.controlGroup! } };
  const tickets = createClaudeModelPreventionTickets();
  const full = { ...observation, runningFact };
  const receipt = tickets.issue(claim, full);
  assert.equal(tickets.verify(claim, observation.resource, full, receipt), true);
  assert.throws(() => tickets.issue(claim, { ...observation,
    runningFact: { ...runningFact, native: { ...runningFact.native, startTicks: 457 } } }));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import type { ModelOuterConfinedFact } from '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import type { ClaudeModelTreeTerminalObservation } from '../../src/adapters/secondary-investigator/claude-model-tree-terminal.js';
import { createClaudeModelTreeTickets } from '../../src/runtime/claude-model-tree-tickets.js';

function fixture() {
  const fact = JSON.parse(readFileSync(new URL(
    '../fixtures/legacy-runtime/recovery.json',
    import.meta.url), 'utf8')).fact as ModelOuterConfinedFact;
  const resource = fact.observation.candidate.running.resource;
  const outer = fact.observation.candidate.startup.outerCandidate;
  const sample = {kind: 'outer_absent_v1' as const, bootId: resource.bootId,
    uid: resource.uid, observerPidNamespace: fact.observation.candidate.probe.observerNamespaces.pid!,
    outerPid: outer.hostPid, outerStartTicks: outer.startTicks,
    outerPidNamespace: outer.pidNamespace, processState: 'absent' as const, signal: 'none' as const};
  const observation: ClaudeModelTreeTerminalObservation = {
    kind: 'model_tree_terminal_v1', outerBefore: sample, outerAfter: structuredClone(sample),
    unitTerminal: {kind: 'model_unit_terminal', resource,
      journal: {...fact.observation.journalAfter, closed: true},
      runningFact: fact.observation.candidate.running,
      native: {bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
        invocationId: resource.invocationId!, controlGroup: '', loadState: 'loaded',
        activeState: 'failed', subState: 'failed', mainPid: 0,
        originalPid: fact.observation.journalAfter.enterPid!,
        originalStartTicks: fact.observation.journalAfter.enterStartTicks!,
        processState: 'absent', cgroupState: 'absent'}}};
  const claim: InvestigationClaim = {requestId: 'synthetic-request', attemptId: fact.expectation.descriptor.attemptId,
    workspaceId: fact.expectation.descriptor.workspaceId, workerId: 'cleanup', workerEpoch: 2,
    phase: 'reconcile', launchProtocol: 'resource_reservation_v1',
    nativeRef: 'synthetic-native-reference', wslResource: resource};
  return {fact, observation, claim, resource};
}

test('tree tickets bind original fact, cleanup claim and observation and consume once', () => {
  const {fact, observation, claim, resource} = fixture();
  const tickets = createClaudeModelTreeTickets();
  const receipt = tickets.issue(claim, fact, observation);
  assert.equal(tickets.verify({...claim, workerEpoch: 3}, resource, fact, observation, receipt), false);
  assert.equal(tickets.verify(claim, {...resource, bootId: 'other'}, fact, observation, receipt), false);
  assert.equal(tickets.verify(claim, resource, {...fact, expectation: {...fact.expectation,
    profileRevision: 'other'}}, observation, receipt), false);
  assert.equal(tickets.verify(claim, resource, fact, observation, receipt), true);
  assert.equal(tickets.verify(claim, resource, fact, observation, receipt), false);
});

test('tree issuance refuses incomplete proof, stale launch epoch and cross-attempt claim', () => {
  const {fact, observation, claim} = fixture();
  const tickets = createClaudeModelTreeTickets();
  assert.throws(() => tickets.issue(claim, fact, {kind: 'unconfirmed'}));
  assert.throws(() => tickets.issue({...claim, workerEpoch: 1}, fact, observation));
  assert.throws(() => tickets.issue({...claim, attemptId: 'other'}, fact, observation));
  assert.throws(() => tickets.issue({...claim, phase: 'started'}, fact, observation));
});

test('tree tickets snapshot mutable inputs, revoke and bound issued receipts', () => {
  const {fact, observation, claim, resource} = fixture();
  const tickets = createClaudeModelTreeTickets();
  const receipt = tickets.issue(claim, fact, observation);
  const saved = structuredClone({claim, fact, observation});
  claim.workerId = 'mutated'; fact.expectation.profileRevision = 'mutated';
  assert.equal(tickets.verify(saved.claim, resource, saved.fact, saved.observation, receipt), true);
  claim.workerId = saved.claim.workerId; fact.expectation.profileRevision = saved.fact.expectation.profileRevision;
  const revoked = tickets.issue(claim, fact, observation);
  const changed = structuredClone(claim); changed.workerId = 'other';
  assert.equal(tickets.verify(changed, resource, fact, observation, revoked), false);
  tickets.revoke(revoked);
  assert.equal(tickets.verify(claim, resource, fact, observation, revoked), false);
  for (let i = 0; i < 128; i++) tickets.issue(claim, fact, observation);
  assert.throws(() => tickets.issue(claim, fact, observation));
});

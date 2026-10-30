import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import type { ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import type { ClaudeModelTreeTerminalObservation } from
  '../../src/adapters/secondary-investigator/claude-model-tree-terminal.js';
import { recoverClaudeModelAttempt } from '../../src/runtime/claude-model-recovery.js';
import { createClaudeModelPreventionTickets } from '../../src/runtime/claude-model-prevention-tickets.js';
import { createClaudeModelTreeTickets } from '../../src/runtime/claude-model-tree-tickets.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';

function fixture() {
  const fact = JSON.parse(readFileSync(new URL(
    '../fixtures/legacy-runtime/recovery.json',
    import.meta.url), 'utf8')).fact as ModelOuterConfinedFact;
  const running = fact.observation.candidate.running;
  const resource = running.resource;
  const p = fact.observation.candidate.probe;
  const outer = p.processes.outer;
  const sample = {kind: 'outer_absent_v1' as const, bootId: p.bootId, uid: p.uid,
    observerPidNamespace: p.observerNamespaces.pid!, outerPid: outer.pid,
    outerStartTicks: outer.startTicks, outerPidNamespace: outer.namespaces.pid,
    processState: 'absent' as const, signal: 'pidfd_sigkill' as const};
  const observation: ClaudeModelTreeTerminalObservation = {
    kind: 'model_tree_terminal_v1', outerBefore: sample,
    outerAfter: {...sample, signal: 'none'},
    unitTerminal: {kind: 'model_unit_terminal', resource,
      journal: {...fact.observation.journalAfter, closed: true}, runningFact: running,
      native: {bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
        invocationId: resource.invocationId!, controlGroup: '', loadState: 'loaded',
        activeState: 'failed', subState: 'failed', mainPid: 0,
        originalPid: running.journal.enterPid!,
        originalStartTicks: running.journal.enterStartTicks!,
        processState: 'absent', cgroupState: 'absent'}}};
  const claim: InvestigationClaim = {requestId: 'synthetic-request',
    attemptId: fact.expectation.descriptor.attemptId,
    workspaceId: fact.expectation.descriptor.workspaceId,
    workerId: 'cleanup', workerEpoch: resource.gate!.launch!.workerEpoch + 1,
    phase: 'reconcile', launchProtocol: 'resource_reservation_v1',
    nativeRef: 'synthetic-native-reference', wslResource: resource};
  const old = {...claim, workerId: 'old', workerEpoch: resource.gate!.launch!.workerEpoch,
    phase: 'started' as const};
  return {fact, observation, claim, old, running, resource};
}

test('consumed recovery uses saved fact, current lease, tree receipt and settlement once', async () => {
  const f = fixture(); const events: string[] = [];
  const tickets = createClaudeModelTreeTickets();
  const store = {
    acquireWslCleanupLease: () => {events.push('acquire'); return f.claim;},
    preflightClaudeModelCleanup: () => {events.push('preflight');},
    observeWslResource: () => {events.push('identity'); return f.claim;},
    getModelRunningObservation: () => {events.push('running'); return f.running;},
    getModelOuterFact: () => {events.push('outer'); return f.fact;},
    settleClaudeModelExecutionPrevented: () => {throw new Error('wrong settlement');},
    settleClaudeModelTreeTerminated: (claim: InvestigationClaim,
      observation: ClaudeModelTreeTerminalObservation, receipt: string) => {
      events.push('settle');
      assert.deepEqual(claim, f.claim); assert.deepEqual(observation, f.observation);
      assert.equal(tickets.verify(claim, f.resource, f.fact, observation, receipt), true);
    },
  };
  const ops = {close: async () => {events.push('close'); return f.observation.unitTerminal.journal;},
    observeTreeTerminal: async (fact: ModelOuterConfinedFact) => {
      events.push('tree'); assert.deepEqual(fact, f.fact); return f.observation;
    }};
  assert.equal(await recoverClaudeModelAttempt(store as never, f.old, 'cleanup',
    createClaudeModelPreventionTickets(), ops, tickets), true);
  assert.deepEqual(events, ['acquire','preflight','close','identity','running','outer',
    'preflight','tree','preflight','settle']);
});

test('consumed recovery refuses missing or mismatched original fact before any tree signal', async () => {
  for (const damage of ['missing', 'mismatched-running', 'mismatched-journal', 'old-epoch']) {
    const f = fixture(); let tree = false; let settled = false;
    const fact = structuredClone(f.fact);
    if (damage === 'mismatched-running') fact.observation.candidate.running.native.startTicks++;
    const journal = {...f.observation.unitTerminal.journal};
    if (damage === 'mismatched-journal') journal.enterStartTicks!++;
    if (damage === 'old-epoch') f.claim.workerEpoch = f.resource.gate!.launch!.workerEpoch;
    const store = {acquireWslCleanupLease: () => f.claim,
      preflightClaudeModelCleanup: () => undefined,
      observeWslResource: () => f.claim,
      getModelRunningObservation: () => f.running,
      getModelOuterFact: () => damage === 'missing' ? null : fact,
      settleClaudeModelExecutionPrevented: () => {settled = true;},
      settleClaudeModelTreeTerminated: () => {settled = true;}};
    const result = await recoverClaudeModelAttempt(store as never, f.old, 'cleanup',
      createClaudeModelPreventionTickets(),
      {close: async () => journal,
        observeTreeTerminal: async () => {tree = true; return f.observation;}},
      createClaudeModelTreeTickets());
    assert.equal(result, false, damage);
    assert.equal(tree, false, damage); assert.equal(settled, false, damage);
  }
});

test('fenced lease and failed tree observer keep consumed slot occupied', async () => {
  for (const failAt of ['before-close','before-tree','after-tree','observer']) {
    const f = fixture(); let preflights = 0; let settled = false; let tree = false;
    let fenced = false;
    const store = {acquireWslCleanupLease: () => f.claim,
      preflightClaudeModelCleanup: () => {
        preflights++; if (failAt === 'before-close' && preflights === 1 ||
          failAt === 'before-tree' && preflights === 2 ||
          failAt === 'after-tree' && fenced) throw new Error('fenced');
      }, observeWslResource: () => f.claim,
      getModelRunningObservation: () => f.running,
      getModelOuterFact: () => f.fact,
      settleClaudeModelExecutionPrevented: () => {settled = true;},
      settleClaudeModelTreeTerminated: () => {settled = true;}};
    const result = await recoverClaudeModelAttempt(store as never, f.old, 'cleanup',
      createClaudeModelPreventionTickets(),
      {close: async () => f.observation.unitTerminal.journal,
        observeTreeTerminal: async () => {
          tree = true; await Promise.resolve();
          if (failAt === 'after-tree') fenced = true;
          return failAt === 'observer' ? {kind:'unconfirmed'} as const : f.observation;
        }},
      createClaudeModelTreeTickets());
    assert.equal(result, false, failAt);
    assert.equal(settled, false, failAt);
    assert.equal(tree, failAt === 'after-tree' || failAt === 'observer', failAt);
    assert.equal(preflights, failAt === 'before-close' ? 1 :
      failAt === 'before-tree' || failAt === 'observer' ? 2 : 3, failAt);
  }
});

test('failed consumed settlement revokes the private tree receipt', async () => {
  const f = fixture(); const underlying = createClaudeModelTreeTickets();
  let receipt: string | undefined; let settled = false;
  const tickets = {...underlying,
    issue: (...args: Parameters<typeof underlying.issue>) => {
      receipt = underlying.issue(...args); return receipt;
    }};
  const store = {acquireWslCleanupLease: () => f.claim,
    preflightClaudeModelCleanup: () => undefined,
    observeWslResource: () => f.claim,
    getModelRunningObservation: () => f.running,
    getModelOuterFact: () => f.fact,
    settleClaudeModelExecutionPrevented: () => {throw new Error('wrong path');},
    settleClaudeModelTreeTerminated: () => {settled = true; throw new Error('stale');}};
  assert.equal(await recoverClaudeModelAttempt(store as never, f.old, 'cleanup',
    createClaudeModelPreventionTickets(),
    {close: async () => f.observation.unitTerminal.journal,
      observeTreeTerminal: async () => f.observation}, tickets), false);
  assert.equal(settled, true); assert.ok(receipt);
  assert.equal(underlying.verify(f.claim, f.resource, f.fact, f.observation, receipt), false);
});

test('installed cleanup tick routes consumed attempts to the same tree ticket instance', async () => {
  const f = fixture(); const tickets = createClaudeModelTreeTickets();
  let settled = false; let tree = false;
  const store = {listUnsettled: () => [f.old],
    settleExpiredUnreservedAttempt: () => null,
    acquireWslCleanupLease: () => f.claim,
    preflightClaudeModelCleanup: () => undefined,
    observeWslResource: () => f.claim,
    getModelRunningObservation: () => f.running,
    getModelOuterFact: () => f.fact,
    settleClaudeModelExecutionPrevented: () => {throw new Error('wrong path');},
    settleClaudeModelTreeTerminated: (claim: InvestigationClaim,
      observation: ClaudeModelTreeTerminalObservation, receipt: string) => {
      settled = tickets.verify(claim, f.resource, f.fact, observation, receipt);
    }};
  await runInvestigationCleanupTick(store as never, 'cleanup', undefined, [f.old],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    createClaudeModelPreventionTickets(), tickets, {
      close: async () => f.observation.unitTerminal.journal,
      observeTreeTerminal: async () => {tree = true; return f.observation;},
    });
  assert.equal(tree, true);
  assert.equal(settled, true);
});

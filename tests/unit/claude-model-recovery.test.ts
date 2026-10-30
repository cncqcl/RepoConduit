import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverClaudeModelAttempt } from '../../src/runtime/claude-model-recovery.js';
import { createClaudeModelPreventionTickets } from '../../src/runtime/claude-model-prevention-tickets.js';
import { preventionFixture } from '../fixtures/claude-model-prevention.js';

test('synthetic recovery closes, observes terminal and settles with one-use receipt', async () => {
  const { claim, observation } = preventionFixture();
  const unsettled = { ...claim, workerId: 'old', workerEpoch: 1, phase: 'started' as const };
  const tickets = createClaudeModelPreventionTickets();
  const events: string[] = [];
  let probes = 0;
  const store = {
    acquireWslCleanupLease: () => { events.push('acquire'); return claim; },
    preflightClaudeModelCleanup: () => { events.push('preflight'); },
    observeWslResource: () => { events.push('identity'); return claim; },
    getModelRunningObservation: () => { events.push('historical'); return null; },
    settleClaudeModelExecutionPrevented: (_claim: unknown, terminal: typeof observation,
      receipt: string) => {
      events.push('settle');
      assert.deepEqual(terminal, observation);
      assert.equal(tickets.verify(claim, observation.resource, terminal, receipt), true);
    },
  };
  const ops = {
    close: async () => { events.push('close'); return observation.journal; },
    observeTerminal: async () => { events.push('probe'); probes++;
      return probes === 1 ? { kind: 'unconfirmed' as const } : observation; },
  };
  assert.equal(await recoverClaudeModelAttempt(store as never, unsettled, 'cleanup', tickets, ops), true);
  assert.deepEqual(events, ['acquire', 'preflight', 'close', 'identity', 'historical',
    'probe', 'probe', 'settle']);
});

test('synthetic recovery retains slot on prepared, consumed, or missing terminal proof', async () => {
  for (const phase of ['prepared', 'consumed', 'entered'] as const) {
    const { claim, observation } = preventionFixture();
    let settled = false; let probed = false; let savedIdentity = false;
    const store = {
      acquireWslCleanupLease: () => claim,
      preflightClaudeModelCleanup: () => undefined,
      observeWslResource: () => { savedIdentity = true; return claim; },
      getModelRunningObservation: () => null,
      settleClaudeModelExecutionPrevented: () => { settled = true; },
    };
    const ops = { close: async () => ({ ...observation.journal, phase }),
      observeTerminal: async () => { probed = true; return { kind: 'unconfirmed' as const }; } };
    const settledResult = await recoverClaudeModelAttempt(store as never, claim,
      'cleanup', createClaudeModelPreventionTickets(), ops);
    assert.equal(settledResult, false);
    assert.equal(settled, false);
    assert.equal(probed, phase === 'entered');
    assert.equal(savedIdentity, phase !== 'prepared');
  }
});

test('synthetic recovery refuses changed closed identity and failed cleanup preflight', async () => {
  const { claim, observation } = preventionFixture();
  let closeCalls = 0;
  const store = { acquireWslCleanupLease: () => claim,
    preflightClaudeModelCleanup: () => { throw new Error('stale'); },
    observeWslResource: () => claim, getModelRunningObservation: () => null,
    settleClaudeModelExecutionPrevented: () => { throw new Error('must not settle'); } };
  const ops = { close: async () => { closeCalls++; return observation.journal; },
    observeTerminal: async () => observation };
  assert.equal(await recoverClaudeModelAttempt(store as never, claim, 'cleanup',
    createClaudeModelPreventionTickets(), ops), false);
  assert.equal(closeCalls, 0);
  const allowed = { ...store, preflightClaudeModelCleanup: () => undefined };
  const changed = { ...ops, close: async () => ({ ...observation.journal,
    commandDigest: 'e'.repeat(64) }) };
  assert.equal(await recoverClaudeModelAttempt(allowed as never, claim, 'cleanup',
    createClaudeModelPreventionTickets(), changed), false);
});

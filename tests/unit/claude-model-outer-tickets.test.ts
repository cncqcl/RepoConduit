import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { mock, test } from 'node:test';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import { validateClaudeModelOuterFact, validateCurrentClaudeModelOuterFact,
  type ModelOuterConfinedFact } from '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import { createClaudeModelOuterTickets } from '../../src/runtime/claude-model-outer-tickets.js';
import { syntheticCurrentOuterFact } from '../fixtures/claude-model-current-outer.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
function setup() {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  const historical: ModelOuterConfinedFact = { kind: 'model_outer_confined_v1',
    networkMode: 'host_shared_pre_srt', srtState: 'not_started',
    expectation: { descriptor: meta.descriptor, paths: meta.paths,
      profile: meta.profile, profileRevision: 'fixture-revision', limits: { maxWallSeconds: 20 } },
    observation: { kind: 'outer_journal_candidate', journalAfter: meta.startup.journal,
      candidate: { kind: 'outer_probe_candidate', running: meta.running, startup: meta.startup,
        probe: JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8')) } } } as unknown as ModelOuterConfinedFact;
  const fact = syntheticCurrentOuterFact(historical, 3);
  const claim: InvestigationClaim = { requestId: 'request', attemptId: meta.descriptor.attemptId,
    workerId: 'original-worker', workerEpoch: meta.descriptor.launchWorkerEpoch,
    workspaceId: meta.descriptor.workspaceId, phase: 'started', nativeRef: 'native-original',
    launchProtocol: 'resource_reservation_v1', wslResource: fact.observation.candidate.running.resource };
  let finish!: () => void;
  const handle = { closed: new Promise<void>(resolve => { finish = resolve; }) };
  return { claim, fact, historical, handle, finish };
}

test('historical program cannot issue a new fact or prompt window ticket', () => {
  const { claim, fact, historical, handle } = setup();
  assert.equal(validateClaudeModelOuterFact(historical),true);
  assert.equal(validateCurrentClaudeModelOuterFact(historical),false);
  const tickets = createClaudeModelOuterTickets();
  const owner = tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits);
  assert.throws(() => owner.issueFact(historical));
  const receipt = owner.issueFact(fact);
  assert.equal(tickets.verifyOuter(claim, claim.wslResource!, fact, receipt), true);
  assert.throws(() => owner.issuePrompt(historical, 'intent'));
  owner.close();
});

function deepFreeze(value: object): void {
  for (const member of Object.values(value))
    if (member && typeof member === 'object') deepFreeze(member as object);
  Object.freeze(value);
}

test('synthetic original owner enforces ordered one-use fact and purpose tickets', () => {
  const {claim, fact, handle} = setup();
  deepFreeze(fact);
  const tickets = createClaudeModelOuterTickets();
  const owner = tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits);
  assert.throws(() => owner.issuePrompt(fact, 'intent'));
  const outer = owner.issueFact(fact);
  assert.throws(() => owner.issueFact(fact));
  assert.throws(() => owner.issuePrompt(fact, 'intent'));
  assert.equal(tickets.verifyOuter({...claim, workerEpoch: 2}, claim.wslResource!, fact, outer), false);
  assert.equal(tickets.verifyOuter(claim, claim.wslResource!, fact, outer), true);
  assert.equal(tickets.verifyOuter(claim, claim.wslResource!, fact, outer), false);
  const intent = owner.issuePrompt(fact, 'intent');
  assert.equal(tickets.verifyPromptWindow(claim, fact, intent, 'send'), false);
  assert.throws(() => owner.issuePrompt(fact, 'send'));
  assert.equal(tickets.verifyPromptWindow(claim, fact, intent, 'intent'), true);
  const send = owner.issuePrompt(fact, 'send');
  assert.equal(tickets.verifyPromptWindow(claim, fact, send, 'intent'), false);
  assert.equal(tickets.verifyPromptWindow(claim, fact, send, 'send'), true);
  assert.equal(tickets.verifyPromptWindow(claim, fact, send, 'send'), false);
  owner.close();
});

test('full claim, resource, fact and original launch are bound without mutable aliases', () => {
  const {claim, fact, handle} = setup();
  const tickets = createClaudeModelOuterTickets();
  const owner = tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits);
  const originalClaim = structuredClone(claim);
  const originalFact = structuredClone(fact);
  const outer = owner.issueFact(fact);
  claim.workerId = 'mutated';
  fact.expectation.profileRevision = 'mutated';
  assert.equal(tickets.verifyOuter(claim, originalClaim.wslResource!, originalFact, outer), false);
  assert.equal(tickets.verifyOuter(originalClaim, originalClaim.wslResource!, fact, outer), false);
  assert.equal(tickets.verifyOuter(originalClaim, {...originalClaim.wslResource!, bootId: 'other'}, originalFact, outer), false);
  assert.equal(tickets.verifyOuter(originalClaim, originalClaim.wslResource!, originalFact, outer), true);
  assert.throws(() => owner.issuePrompt(fact, 'intent'));
  owner.close();
});

test('owner refuses invalid start, stale epoch, recovery, closed and aborted window', async () => {
  const {claim, fact, handle, finish} = setup();
  const tickets = createClaudeModelOuterTickets();
  for (const bad of [{...claim, phase: 'reconcile' as const},
    {...claim, workerEpoch: claim.workerEpoch + 1}, {...claim, nativeRef: null}])
    assert.throws(() => tickets.beginOwner(bad, {closed: new Promise(() => {})}, new Date(), fact.expectation.limits));
  assert.throws(() => tickets.beginOwner(claim, {closed: new Promise(() => {})}, new Date(Date.now() + 100), fact.expectation.limits));
  assert.throws(() => tickets.beginOwner(claim, {closed: new Promise(() => {})}, new Date(Date.now() - 21_000), fact.expectation.limits));
  const controller = new AbortController(); controller.abort();
  assert.throws(() => tickets.beginOwner(claim, {closed: new Promise(() => {})}, new Date(), fact.expectation.limits, controller.signal));
  const owner = tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits);
  assert.ok(owner.deadline > 0);
  assert.throws(() => tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits));
  finish(); await Promise.resolve();
  assert.throws(() => owner.issueFact(fact));
});

test('abort and revoke invalidate pending tickets; owner close cleans state', () => {
  const {claim, fact, handle} = setup();
  const controller = new AbortController();
  const tickets = createClaudeModelOuterTickets();
  const owner = tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits, controller.signal);
  const outer = owner.issueFact(fact);
  tickets.revoke(outer);
  assert.equal(tickets.verifyOuter(claim, claim.wslResource!, fact, outer), false);
  controller.abort();
  assert.throws(() => owner.issuePrompt(fact, 'intent'));
  owner.close();
});

test('pending ticket is invalid after owner closes and issuance cannot overgrow', () => {
  const tickets = createClaudeModelOuterTickets();
  const owners: {close(): void}[] = [];
  let first: ReturnType<typeof setup> | undefined;
  let firstReceipt: string | undefined;
  for (let i = 0; i < 128; i++) {
    const input = setup();
    const owner = tickets.beginOwner(input.claim, input.handle, new Date(), input.fact.expectation.limits);
    owners.push(owner);
    const receipt = owner.issueFact(input.fact);
    if (i === 0) { first = input; firstReceipt = receipt; }
  }
  const overflow = setup();
  const overflowOwner = tickets.beginOwner(overflow.claim, overflow.handle,
    new Date(), overflow.fact.expectation.limits);
  assert.throws(() => overflowOwner.issueFact(overflow.fact));
  owners[0]!.close();
  assert.equal(tickets.verifyOuter(first!.claim, first!.claim.wslResource!, first!.fact, firstReceipt!), false);
  assert.ok(overflowOwner.issueFact(overflow.fact));
  overflowOwner.close();
  for (const owner of owners) owner.close();
});

test('issue and verify reject when validation crosses original monotonic deadline', () => {
  function crossing<T>(deadline: number, operation: () => T): T {
    let calls = 0;
    const mocked = mock.method(performance, 'now', () => ++calls === 1 ? deadline - 0.1 : deadline + 0.1);
    try { return operation(); } finally { mocked.mock.restore(); }
  }
  const {claim, fact, handle} = setup();
  const tickets = createClaudeModelOuterTickets();
  const owner = tickets.beginOwner(claim, handle, new Date(), fact.expectation.limits);
  assert.throws(() => crossing(owner.deadline, () => owner.issueFact(fact)));
  owner.close();

  const second = setup();
  const t = createClaudeModelOuterTickets();
  const o = t.beginOwner(second.claim, second.handle, new Date(), second.fact.expectation.limits);
  const outer = o.issueFact(second.fact);
  assert.equal(crossing(o.deadline, () =>
    t.verifyOuter(second.claim, second.claim.wslResource!, second.fact, outer)), false);
  o.close();

  const third = setup();
  const p = createClaudeModelOuterTickets();
  const w = p.beginOwner(third.claim, third.handle, new Date(), third.fact.expectation.limits);
  const first = w.issueFact(third.fact);
  assert.equal(p.verifyOuter(third.claim, third.claim.wslResource!, third.fact, first), true);
  const intent = w.issuePrompt(third.fact, 'intent');
  assert.equal(crossing(w.deadline, () =>
    p.verifyPromptWindow(third.claim, third.fact, intent, 'intent')), false);
  w.close();

  for (const stage of ['issue_intent', 'issue_send', 'verify_send'] as const) {
    const input = setup();
    const bridge = createClaudeModelOuterTickets();
    const window = bridge.beginOwner(input.claim, input.handle, new Date(), input.fact.expectation.limits);
    const outerReceipt = window.issueFact(input.fact);
    assert.equal(bridge.verifyOuter(input.claim, input.claim.wslResource!, input.fact, outerReceipt), true);
    if (stage === 'issue_intent') {
      assert.throws(() => crossing(window.deadline, () => window.issuePrompt(input.fact, 'intent')));
    } else {
      const intentReceipt = window.issuePrompt(input.fact, 'intent');
      assert.equal(bridge.verifyPromptWindow(input.claim, input.fact, intentReceipt, 'intent'), true);
      if (stage === 'issue_send') {
        assert.throws(() => crossing(window.deadline, () => window.issuePrompt(input.fact, 'send')));
      } else {
        const sendReceipt = window.issuePrompt(input.fact, 'send');
        assert.equal(crossing(window.deadline, () => bridge.verifyPromptWindow(
          input.claim, input.fact, sendReceipt, 'send')), false);
      }
    }
    window.close();
  }
});

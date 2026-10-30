import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { getEventListeners } from 'node:events';
import { observeClaudeModelOuter } from '../../src/adapters/secondary-investigator/claude-model-outer-observer.js';
import type { ClaudeModelOuterProbeInput, ClaudeModelOuterProbeObservation } from
  '../../src/adapters/secondary-investigator/claude-model-outer-probe.js';

const stem = 'tests/fixtures/legacy-runtime/outer-collector';
function fixture(): ClaudeModelOuterProbeInput {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  return { running: meta.running, startup: meta.startup, descriptor: meta.descriptor,
    paths: meta.paths, profile: meta.profile };
}
const owner = () => ({ deadline: performance.now() + 2000, closed: new Promise(() => {}) });
const collect = async (input: ClaudeModelOuterProbeInput): Promise<ClaudeModelOuterProbeObservation> => ({
  kind: 'outer_probe_candidate', running: structuredClone(input.running),
  startup: structuredClone(input.startup), probe: JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8')),
});

test('observed consumed journal binds the copied candidate and original root', async () => {
  const input = fixture(); const journal = structuredClone(input.startup.journal);
  let calls = 0;
  const result = await observeClaudeModelOuter(input, owner(), { collect,
    status: async (descriptor, root, signal) => {
      calls++; assert.deepEqual(descriptor, input.descriptor);
      assert.equal(root, input.running.resource.gate!.root);
      assert.equal(signal.aborted, false); return journal;
    } });
  assert.equal(result.kind, 'outer_journal_candidate'); assert.equal(calls, 1);
  if (result.kind === 'outer_journal_candidate') assert.deepEqual(result.journalAfter, journal);
});

test('missing, changed, closed or late status cannot form a candidate', async () => {
  const input = fixture();
  for (const status of [null, { ...input.startup.journal, closed: true },
    { ...input.startup.journal, enterStartTicks: input.startup.journal.enterStartTicks! + 1 }]) {
    assert.deepEqual(await observeClaudeModelOuter(input, owner(), {
      collect, status: async () => status,
    }), { kind: 'unconfirmed' });
  }
  let aborted = false;
  const result = await observeClaudeModelOuter(input,
    { ...owner(), deadline: performance.now() + 30 }, { collect,
      status: async (_d, _r, signal) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => {});
      } });
  assert.deepEqual(result, { kind: 'unconfirmed' }); assert.equal(aborted, true);
});

test('closed owner, expired deadline and invalid collector stop before status', async () => {
  const input = fixture(); let calls = 0;
  const ports = { collect: async () => { calls++; return {kind: 'unconfirmed'} as const; },
    status: async () => { throw new Error('unexpected status I/O'); } };
  assert.deepEqual(await observeClaudeModelOuter(input,
    { ...owner(), closed: Promise.resolve({}) }, ports), { kind: 'unconfirmed' });
  assert.equal(calls, 0);
  assert.deepEqual(await observeClaudeModelOuter(input,
    { ...owner(), deadline: performance.now() - 1 }, ports), { kind: 'unconfirmed' });
  assert.equal(calls, 0);
  assert.deepEqual(await observeClaudeModelOuter(input, owner(), ports), { kind: 'unconfirmed' });
  assert.equal(calls, 1);
});

test('caller mutation and owner closure cannot authorize a late collector result', async () => {
  const input = fixture(); const saved = structuredClone(input);
  let release!: (candidate: ClaudeModelOuterProbeObservation) => void;
  let close!: () => void;
  let calls = 0;
  const pending = observeClaudeModelOuter(input, { deadline: performance.now() + 2000,
    closed: new Promise(resolve => { close = () => resolve({}); }) }, {
    collect: async snapshot => {
      assert.deepEqual(snapshot, saved);
      return new Promise(resolve => { release = resolve; });
    }, status: async () => { calls++; return saved.startup.journal; },
  });
  await new Promise(resolve => setImmediate(resolve));
  input.running.resource.gate!.root = '/mutated'; close();
  assert.deepEqual(await pending, { kind: 'unconfirmed' });
  release(await collect(saved)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('candidate and owner signal are captured before asynchronous status', async () => {
  const input = fixture(); const candidate = await collect(input);
  assert.equal(candidate.kind, 'outer_probe_candidate');
  if (candidate.kind !== 'outer_probe_candidate') throw new Error('fixture candidate');
  const expected = structuredClone(candidate);
  const originalSignal = new AbortController(); const replacement = new AbortController();
  const window = { ...owner(), signal: originalSignal.signal };
  let release!: () => void;
  const pending = observeClaudeModelOuter(input, window, { collect: async () => candidate,
    status: async () => { await new Promise<void>(resolve => { release = resolve; });
      return input.startup.journal; } });
  await new Promise(resolve => setImmediate(resolve));
  candidate.probe.uid = 999; candidate.running.native.mainPid = 999;
  window.signal = replacement.signal;
  release(); const result = await pending;
  assert.equal(result.kind, 'outer_journal_candidate');
  if (result.kind === 'outer_journal_candidate') assert.deepEqual(result.candidate, expected);
  assert.equal(getEventListeners(originalSignal.signal, 'abort').length, 0);
  // Cancelling the original source after return cannot change the returned snapshot.
  originalSignal.abort();
  if (result.kind === 'outer_journal_candidate') assert.deepEqual(result.candidate, expected);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateClaudeModelOuterFact, validateCurrentClaudeModelOuterFact,
  type ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import { syntheticCurrentOuterFact } from '../fixtures/claude-model-current-outer.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
function fixture(): ModelOuterConfinedFact {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  return {kind: 'model_outer_confined_v1', networkMode: 'host_shared_pre_srt',
    srtState: 'not_started', expectation: {descriptor: meta.descriptor, paths: meta.paths,
      profile: meta.profile, profileRevision: 'fixture-revision', limits: {maxWallSeconds: 20}},
    observation: {kind: 'outer_journal_candidate', journalAfter: meta.startup.journal,
      candidate: {kind: 'outer_probe_candidate', running: meta.running, startup: meta.startup,
        probe: JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8'))}}} as unknown as ModelOuterConfinedFact;
}

test('accepts deidentified offline observation without mutation', () => {
  const fact = fixture();
  const original = structuredClone(fact);
  Object.freeze(fact);
  assert.equal(validateClaudeModelOuterFact(fact), true);
  assert.deepEqual(fact, original);
});

test('historical parent program remains readable but cannot grant a fresh current fact', () => {
  const historical = fixture();
  const current = syntheticCurrentOuterFact(historical, 3);
  assert.equal(validateClaudeModelOuterFact(historical), true);
  assert.equal(validateCurrentClaudeModelOuterFact(historical), false);
  assert.equal(validateClaudeModelOuterFact(current), true);
  assert.equal(validateCurrentClaudeModelOuterFact(current), true);
  const changed = structuredClone(current);
  changed.observation.candidate.probe.processes.parent.cmdline =
    changed.observation.candidate.probe.processes.parent.cmdline.replace('def frame_ready',
      'def frame_reidy');
  assert.equal(validateClaudeModelOuterFact(changed), false);
  assert.equal(validateCurrentClaudeModelOuterFact(changed), false);
});

test('rejects changed outer labels, expectation and observation', () => {
  const changes: ((fact: ModelOuterConfinedFact) => void)[] = [
    f => { (f as {kind: string}).kind = 'other'; },
    f => { (f as {networkMode: string}).networkMode = 'isolated'; },
    f => { (f as {srtState: string}).srtState = 'started'; },
    f => { f.expectation.limits.maxWallSeconds = 21; },
    f => { f.expectation.descriptor.commandDigest = '0'.repeat(64); },
    f => { f.expectation.profileRevision = ''; },
    f => { f.expectation.profileRevision = 'x'.repeat(257); },
    f => { f.observation.candidate.running.resource.invocationId = '0'.repeat(32); },
  ];
  for (const change of changes) {
    const fact = fixture(); change(fact);
    assert.equal(validateClaudeModelOuterFact(fact), false);
  }
});

test('rejects extra keys, oversized raw data and null without throwing', () => {
  const extraTop = {...fixture(), extra: true};
  const extraExpectation = fixture();
  Object.assign(extraExpectation.expectation, {extra: true});
  const oversized = fixture();
  oversized.observation.candidate.probe.hostMountinfoRaw = 'x'.repeat(524289);
  for (const invalid of [extraTop, extraExpectation, oversized, null])
    assert.equal(validateClaudeModelOuterFact(invalid as ModelOuterConfinedFact), false);
});

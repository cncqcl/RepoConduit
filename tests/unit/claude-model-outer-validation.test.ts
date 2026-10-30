import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateClaudeModelOuterObservation } from
  '../../src/adapters/secondary-investigator/claude-model-outer-validation.js';
import type { ClaudeModelOuterProbeInput } from
  '../../src/adapters/secondary-investigator/claude-model-outer-probe.js';
import type { ClaudeModelOuterObservation } from
  '../../src/adapters/secondary-investigator/claude-model-outer-observer.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
function fixture(): {input: ClaudeModelOuterProbeInput; observation: ClaudeModelOuterObservation} {
  const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  const input = {running: meta.running, startup: meta.startup, descriptor: meta.descriptor,
    paths: meta.paths, profile: meta.profile};
  return {input, observation: {kind:'outer_journal_candidate', journalAfter:meta.startup.journal,
    candidate: {kind:'outer_probe_candidate', running:structuredClone(meta.running),
      startup:structuredClone(meta.startup), probe:JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8'))}}};
}
test('requires complete mount and process semantics with the same consumed journal', () => {
  const {input,observation}=fixture();
  assert.equal(validateClaudeModelOuterObservation(input,observation,{maxWallSeconds:20}),true);
  assert.equal(validateClaudeModelOuterObservation(input,observation,{maxWallSeconds:21}),false);
  assert.equal(validateClaudeModelOuterObservation(input,{kind:'unconfirmed'},{maxWallSeconds:20}),false);
});
test('rejects candidate rebinding, journal changes and either semantic failure', () => {
  const changes: ((value: Extract<ClaudeModelOuterObservation,{kind:'outer_journal_candidate'}>)=>void)[]=[
    o=>{o.candidate.running.resource.invocationId='0'.repeat(32);},
    o=>{o.candidate.startup.outerCandidate.hostPid++;},
    o=>{o.journalAfter.closed=true;},
    o=>{o.journalAfter.enterStartTicks!++;},
    o=>{o.candidate.probe.processes.bootstrap.exe='/tmp/python3';},
    o=>{o.candidate.probe.mountedFixedFiles[0]!.sha256='0'.repeat(64);},
  ];
  for(const change of changes) {
    const {input,observation}=fixture();
    assert.equal(observation.kind,'outer_journal_candidate');
    if(observation.kind!=='outer_journal_candidate') throw new Error('fixture');
    change(observation);
    assert.equal(validateClaudeModelOuterObservation(input,observation,{maxWallSeconds:20}),false);
  }
});
test('malformed caller data fails closed without throwing or altering input', () => {
  const {input,observation}=fixture();const before=structuredClone({input,observation});
  for(const invalid of [null,{}, {kind:'outer_journal_candidate',candidate:null},
    {...observation,extra:true}])
    assert.equal(validateClaudeModelOuterObservation(input,invalid as ClaudeModelOuterObservation,
      {maxWallSeconds:20}),false);
  assert.deepEqual({input,observation},before);
});

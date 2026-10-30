import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseClaudeModelOutcomeCandidate } from
  '../../src/adapters/secondary-investigator/claude-model-outcome.js';

const valid = {type: 'result', subtype: 'success', is_error: false,
  num_turns: 2, result: 'Scoped finding'};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test('fixed SDK print-json success yields only project result metadata', () => {
  const raw = bytes({...valid, session_id: 'private', total_cost_usd: 1.25,
    usage: {input_tokens: 10}, errors: ['private']});
  assert.deepEqual(parseClaudeModelOutcomeCandidate(raw, 3), {
    kind: 'claude_model_outcome_candidate_v1',
    formatContract: 'claude_print_json_sdk_0_3_284',
    result: valid.result, numTurns: 2,
    rawBytesSha256: createHash('sha256').update(raw).digest('hex'),
  });
});

test('malformed, multiple, invalid UTF-8 and oversized output have no candidate', () => {
  for (const raw of [Buffer.from('{'), Buffer.concat([bytes(valid), bytes(valid)]),
    Buffer.from([0xff]), Buffer.alloc(256 * 1024 + 1, 0x20)]) {
    assert.equal(parseClaudeModelOutcomeCandidate(raw, 8), null);
  }
});

test('error envelopes, wrong required types and excess turns have no candidate', () => {
  for (const value of [
    {...valid, subtype: 'error_during_execution'},
    {...valid, subtype: 'error_max_turns'},
    {...valid, subtype: 'error_max_budget_usd'},
    {...valid, subtype: 'error_max_structured_output_retries'},
    {...valid, is_error: 0}, {...valid, num_turns: false},
    {...valid, num_turns: 0}, {...valid, num_turns: 4},
    {...valid, result: ''}, {...valid, result: 'nul\0byte'},
  ]) assert.equal(parseClaudeModelOutcomeCandidate(bytes(value), 3), null);
});

test('duplicate top-level keys including escaped spellings have no candidate', () => {
  const raw = Buffer.from('{"type":"result","subtype":"success","is_error":false,' +
    '"num_turns":1,"result":"safe","res\\u0075lt":"override"}');
  assert.equal(parseClaudeModelOutcomeCandidate(raw, 3), null);
  assert.equal(parseClaudeModelOutcomeCandidate(Buffer.from('{"type":"result",' +
    '"type":"result","subtype":"success","is_error":false,' +
    '"num_turns":1,"result":"safe"}'), 3), null);
});

test('invalid trusted budget and non-buffer inputs have no candidate', () => {
  assert.equal(parseClaudeModelOutcomeCandidate(bytes(valid), 0), null);
  assert.equal(parseClaudeModelOutcomeCandidate(bytes(valid), 9), null);
  assert.equal(parseClaudeModelOutcomeCandidate('text' as never, 3), null);
});

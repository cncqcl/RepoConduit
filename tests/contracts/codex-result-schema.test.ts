import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVESTIGATION_RESULT_OUTPUT_SCHEMA } from '../../src/core/investigation/result-schema.js';

test('fixed Codex result schema closes and bounds the complete wire shape', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema tree is inspected dynamically
  const schema = INVESTIGATION_RESULT_OUTPUT_SCHEMA as Record<string, any>;
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.isFrozen(schema.properties.evidence.items.properties), true);
  assert.deepEqual(schema.required, ['kind', 'requestId', 'attemptId', 'resultState', 'snapshotRef',
    'contextRevisionId', 'findings', 'evidence', 'coverage', 'openQuestions', 'limitsAndWarnings']);
  assert.deepEqual(schema.properties.kind.enum, ['investigation_result_v1']);
  assert.deepEqual(schema.properties.resultState.enum, ['completed']);
  assert.equal(schema.properties.evidence.maxItems, 40);
  assert.equal(schema.properties.evidence.minItems, 1);
  assert.equal(schema.properties.findings.maxItems, 64);
  for (const nested of [schema.properties.findings.items, schema.properties.evidence.items,
    schema.properties.coverage]) assert.equal(nested.additionalProperties, false);
  assert.deepEqual(schema.properties.evidence.items.required,
    ['path', 'symbol', 'lineRange', 'byteRange', 'contentHash', 'excerpt', 'toolReceipt']);
  assert.equal(schema.properties.evidence.items.properties.contentHash.pattern, '^[0-9a-f]{64}$');
  assert.equal(schema.properties.evidence.items.properties.excerpt.maxLength, 65536);
  assert.equal(schema.properties.evidence.items.properties.toolReceipt.maxLength, 128);
  assert.equal(schema.properties.coverage.properties.truncated.type, 'boolean');
});

test('range output hints use strict-provider-compatible fixed length arrays', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspect the provider schema, not model output
  const schema = INVESTIGATION_RESULT_OUTPUT_SCHEMA as Record<string, any>;
  for (const [name,minimum] of [['lineRange',1],['byteRange',0]] as const) {
    const range = schema.properties.evidence.items.properties[name];
    assert.equal(range.type,'array');
    assert.equal(typeof range.items,'object');
    assert.equal(range.items.type,'integer');
    assert.equal(range.items.minimum,minimum);
    assert.equal(range.minItems,2);assert.equal(range.maxItems,2);
    assert.equal('prefixItems' in range,false);
  }
});

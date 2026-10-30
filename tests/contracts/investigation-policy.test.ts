import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInvestigationInput } from '../../src/core/investigation/request.js';

const valid = { contextRevisionId: 'ctx-1', snapshotRef: 'snap-1', question: 'Trace state changes',
  scope: { paths: ['src/main.ts'], symbols: ['run'], relatedTests: ['tests/main.test.ts'] },
  requestedOutputs: ['flow', 'evidence', 'gaps'], parentInvestigationId: null };

test('investigation input rejects execution and authority fields at every external object level', () => {
  for (const field of ['shell', 'executable', 'model', 'env', 'root', 'cwd', 'command', 'profileRef', 'budgetRef', 'recipient']) {
    assert.throws(() => parseInvestigationInput({ ...valid, [field]: 'unsafe' }), /Invalid investigation input/);
  }
  assert.throws(() => parseInvestigationInput({ ...valid, scope: { ...valid.scope, command: 'git status' } }), /Invalid investigation input/);
  assert.throws(() => parseInvestigationInput({ ...valid, requestedOutputs: ['flow', 'execute'] }), /Invalid investigation input/);
});

test('question and scope have bounded, closed shapes', () => {
  assert.equal(parseInvestigationInput(valid).question, valid.question);
  assert.throws(() => parseInvestigationInput({ ...valid, question: 'x'.repeat(16 * 1024 + 1) }), /Invalid investigation input/);
  assert.throws(() => parseInvestigationInput({ ...valid, scope: { ...valid.scope, paths: ['../secret'] } }), /Invalid investigation input/);
  assert.throws(() => parseInvestigationInput({ ...valid, question: '' }), /Invalid investigation input/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '../../contracts/operation-catalog.json' with { type: 'json' };
import { operationPolicy, PolicyError } from '../../src/core/policy/authorize.js';

test('all catalog operations have a closed effect, grant and surface', () => {
  const names = new Set<string>();
  for (const entry of catalog.operations) {
    assert.equal(names.has(entry.name), false, entry.name);
    names.add(entry.name);
    assert.equal(operationPolicy(entry.name).effect, entry.effect);
    assert.equal(operationPolicy(entry.name).requiredGrant, entry.required_grant);
    assert.deepEqual(operationPolicy(entry.name).surfaces, entry.surfaces);
  }
  assert.throws(() => operationPolicy('repo.execute'), PolicyError);
});

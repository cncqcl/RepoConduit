import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const schema = JSON.parse(readFileSync(resolve('verification/evidence-record.schema.json'), 'utf8'));
const acceptance = JSON.parse(readFileSync(resolve('verification/RUNTIME_ACCEPTANCE.json'), 'utf8'));
const commands = ['typecheck', 'lint', 'test', 'test:contracts', 'test:integration', 'test:faults',
  'test:security', 'test:boundary', 'test:e2e:mock', 'build', 'package:smoke'];
const reviews = ['license_review', 'secret_scan', 'safety_defects', 'capability_report', 'model_loading'];

test('release receipt contract declares the closed gate vocabulary and matching layers', () => {
  const expected = [
    ...acceptance.acceptance_cases.map((item: { id: string }) => item.id),
    ...acceptance.live_runs.map((item: { id: string }) => item.id),
    'PACKAGE01',
    ...Object.keys(acceptance.stages).map((name) => `stage:${name}`),
    ...commands.map((name) => `offline:${name}`),
    ...reviews.map((name) => `release:${name}`),
  ];
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema_version.const, '0.2');
  assert.deepEqual([...schema.properties.case_id.enum].sort(), [...expected].sort());
  assert.equal(new Set(schema.properties.case_id.enum).size, expected.length);
  const matchesPurpose = (caseId: string, layer: string) => schema.oneOf.some((purpose: {
    properties: { case_id: { enum: string[] }; layer: { const?: string; enum?: string[] } };
  }) => purpose.properties.case_id.enum.includes(caseId) &&
    (purpose.properties.layer.const === layer || purpose.properties.layer.enum?.includes(layer)));
  for (const name of Object.keys(acceptance.stages)) {
    assert.equal(matchesPurpose(`stage:${name}`, 'review'), true);
    assert.equal(matchesPurpose(`stage:${name}`, 'live'), false);
  }
  for (const name of commands) {
    assert.equal(matchesPurpose(`offline:${name}`, 'offline_command'), true);
    assert.equal(matchesPurpose(`offline:${name}`, 'review'), false);
  }
  for (const name of reviews) {
    assert.equal(matchesPurpose(`release:${name}`, 'review'), true);
    assert.equal(matchesPurpose(`release:${name}`, 'live'), false);
  }
  for (const item of acceptance.acceptance_cases as Array<{ id: string }>) {
    assert.equal(matchesPurpose(item.id, 'review'), false);
    assert.equal(matchesPurpose(item.id, 'offline_command'), false);
  }
  assert.equal(matchesPurpose('release:unknown', 'review'), false);
  assert.equal(matchesPurpose('AC01', 'live'), true);
  assert.equal(matchesPurpose('AC02', 'live_human'), true);
});

test('passed package purposes declare a closed archive and smoke output identity', () => {
  const identity = schema.properties.package_artifact;
  assert.equal(identity.type, 'object');
  assert.equal(identity.additionalProperties, false);
  assert.deepEqual(identity.required, ['archive_ref', 'sha256', 'integrity']);
  assert.equal(schema.properties.package_smoke_output_ref.type, 'string');
  assert.equal(identity.properties.sha256.pattern, '^[0-9a-f]{64}$');
  assert.match(identity.properties.integrity.pattern, /sha512/);
  const condition = schema.allOf.find((entry: { if?: { properties?: { case_id?: { enum?: string[] } } } }) =>
    entry.if?.properties?.case_id?.enum?.includes('PACKAGE01'));
  assert.ok(condition);
  assert.deepEqual(condition.if.properties.case_id.enum,
    ['PACKAGE01', 'offline:package:smoke', 'AC14']);
  assert.deepEqual(condition.then.required, ['package_artifact', 'package_smoke_output_ref']);
  assert.equal(condition.if.properties.status.const, 'passed');
});

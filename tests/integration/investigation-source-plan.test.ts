import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildInvestigationSourcePlan } from '../../src/application/investigation-source-plan.js';
import { createSnapshotFromFiles, type PersistedSnapshot } from '../../src/adapters/repository/snapshots.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';

const bytes = (value: string) => Buffer.from(value);
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const snapshot = createSnapshotFromFiles('copy-a', 'a'.repeat(40), {
    'src/main.ts': bytes('main'), 'tests/main.test.ts': bytes('test'), 'src/private.ts': bytes('private'),
  }).toPersisted();
  const record = {
    id: 'inv-a', workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a',
    snapshotRef: snapshot.id, contextRevisionId: 'ctx-a', recipient: 'recipient-a',
    principal: 'external', audience: 'mcp-a', grantId: 'grant-a', profileRef: 'profile-a',
    budgetRef: 'budget-a', budget: { maxWallSeconds: 60, maxTurns: 3, maxToolCalls: 10 },
    question: 'Trace main', requestedOutputs: ['flow'], parentInvestigationId: null,
    scope: { paths: ['src/main.ts'], relatedTests: ['tests/main.test.ts'], symbols: [] },
    state: 'queued', cancelRequested: false, result: null, createdAt: new Date(0).toISOString(),
    attempts: [{ id: 'attempt-a', state: 'claimed', nativeRef: null, workerEpoch: 3,
      startedAt: null, finishedAt: null, terminationConfirmed: false }],
  } as InvestigationRecord;
  const claim = { requestId: record.id, attemptId: 'attempt-a', workerId: 'worker-a', workerEpoch: 3,
    workspaceId: record.workspaceId, nativeRef: null, phase: 'start_intent' } as InvestigationClaim;
  const expected = { workspaceId: record.workspaceId, collaborationId: record.collaborationId,
    workingCopyId: record.workingCopyId, snapshotRef: record.snapshotRef,
    contextRevisionId: record.contextRevisionId, recipient: record.recipient,
    requestId: record.id, attemptId: claim.attemptId, workerEpoch: claim.workerEpoch };
  return { snapshot, record, claim, expected };
}

test('selects exactly scoped snapshot bytes with stable digest and all identity bindings', () => {
  const f = fixture();
  const plan = buildInvestigationSourcePlan(f);
  assert.deepEqual(plan.binding, f.expected);
  assert.equal(plan.sourceConsistency, 'best_effort_capture');
  assert.deepEqual(plan.files.map(file => file.path), ['src/main.ts', 'tests/main.test.ts']);
  assert.equal(plan.files[0]?.base64, bytes('main').toString('base64'));
  assert.equal(plan.files[0]?.sha256, digest(bytes('main')));
  assert.equal(plan.files[0]?.sizeBytes, 4);
  assert.equal(plan.totalBytes, 8);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(buildInvestigationSourcePlan(f).digest, plan.digest);
  assert.ok(!plan.files.some(file => file.path === 'src/private.ts'));
  assert.notEqual(buildInvestigationSourcePlan({ ...f, expected: { ...f.expected, workerEpoch: 4 },
    claim: { ...f.claim, workerEpoch: 4 }, record: { ...f.record,
      attempts: [{ ...f.record.attempts[0]!, workerEpoch: 4 }] } }).digest, plan.digest);
});

test('rejects every mismatched caller binding and stale claim', () => {
  const f = fixture();
  for (const key of Object.keys(f.expected) as (keyof typeof f.expected)[]) {
    const replacement = key === 'workerEpoch' ? 4 : 'other';
    assert.throws(() => buildInvestigationSourcePlan({ ...f, expected: { ...f.expected, [key]: replacement } }), /NOT_AVAILABLE/);
  }
  assert.throws(() => buildInvestigationSourcePlan({ ...f, claim: { ...f.claim, workerEpoch: 4 } }), /NOT_AVAILABLE/);
  assert.throws(() => buildInvestigationSourcePlan({ ...f, record: { ...f.record, cancelRequested: true } }), /NOT_AVAILABLE/);
  for (const record of [
    { ...f.record, attempts: [] },
    { ...f.record, state: 'completed' as const },
    { ...f.record, result: {} as InvestigationRecord['result'] },
    { ...f.record, attempts: [{ ...f.record.attempts[0]!, state: 'recovery_required' as const }] },
  ]) assert.throws(() => buildInvestigationSourcePlan({ ...f, record }), /NOT_AVAILABLE/);
  assert.throws(() => buildInvestigationSourcePlan({ ...f, claim: { ...f.claim, workspaceId: 'ws-other' } }), /NOT_AVAILABLE/);
  assert.throws(() => buildInvestigationSourcePlan({ ...f, claim: { ...f.claim, requestId: 'inv-other' } }), /NOT_AVAILABLE/);
});

test('rejects missing scoped files and corrupted snapshot bytes, size or hash', () => {
  const f = fixture();
  assert.throws(() => buildInvestigationSourcePlan({ ...f, record: { ...f.record,
    scope: { ...f.record.scope, paths: ['missing.ts'] } } }), /NOT_AVAILABLE/);
  for (const mutate of [
    (value: PersistedSnapshot) => { value.files['src/main.ts'] = bytes('evil').toString('base64'); },
    (value: PersistedSnapshot) => { value.manifest[0]!.sizeBytes++; },
    (value: PersistedSnapshot) => { value.manifest[0]!.sha256 = '0'.repeat(64); },
  ]) {
    const snapshot = structuredClone(f.snapshot); mutate(snapshot);
    assert.throws(() => buildInvestigationSourcePlan({ ...f, snapshot }), /INTEGRITY_ERROR/);
  }
});

test('rejects case aliases at directory level and file-directory conflicts in the full snapshot', () => {
  for (const paths of [
    ['A/one.ts', 'a/two.ts'], ['dir', 'dir/child.ts'], ['Dir/one.ts', 'dir/two.ts'],
  ]) {
    const f = fixture();
    const extra = Object.fromEntries(paths.map(path => [path, bytes(path)]));
    const snapshot = createSnapshotFromFiles('copy-a', 'a'.repeat(40), {
      'src/main.ts': bytes('main'), 'tests/main.test.ts': bytes('test'), ...extra,
    }).toPersisted();
    const record = { ...f.record, snapshotRef: snapshot.id };
    const expected = { ...f.expected, snapshotRef: snapshot.id };
    assert.throws(() => buildInvestigationSourcePlan({ snapshot, record, claim: f.claim, expected }), /INTEGRITY_ERROR/);
  }
});

test('enforces file count, file size and total bytes without widening default limits', () => {
  const f = fixture();
  assert.throws(() => buildInvestigationSourcePlan({ ...f, limits: { maxFiles: 1 } }), /NOT_AVAILABLE/);
  assert.throws(() => buildInvestigationSourcePlan({ ...f, limits: { maxFileBytes: 3 } }), /NOT_AVAILABLE/);
  assert.throws(() => buildInvestigationSourcePlan({ ...f, limits: { maxTotalBytes: 7 } }), /NOT_AVAILABLE/);
  assert.throws(() => buildInvestigationSourcePlan({ ...f, limits: { maxFiles: 1000 } }), /INVALID_ARGUMENT/);
});

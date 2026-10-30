import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvestigationApplication, type InvestigationDependencies } from '../../src/application/investigations.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const context = { principal: 'external', audience: 'mcp-a', recipient: 'reviewer-a', surface: 'external_mcp' as const, now: new Date() };
const input = { contextRevisionId: 'ctx-1', snapshotRef: 'snap-1', question: 'Trace state changes',
  scope: { paths: ['src/main.ts'], symbols: ['run'], relatedTests: [] }, requestedOutputs: ['flow', 'evidence'], parentInvestigationId: null };
const binding = { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a' };

function fixture() {
  const records = new Map<string, InvestigationRecord>();
  const keys = new Map<string, { fingerprint: string; id: string }>();
  let readPaths: string[] = ['src/main.ts', 'tests/'];
  let calls = 0;
  const deps: InvestigationDependencies = {
    authorize: ({ context: requestContext, operation }) => ({ grantId: operation === 'repo.read' ? 'read-grant' : 'grant-a', operation,
      effect: operation === 'investigate.submit' ? 'agent_job' : operation === 'investigate.cancel' ? 'job_control' : 'read',
      principal: requestContext.principal, recipient: requestContext.recipient,
      scope: { workspaceId: binding.workspaceId, collaborationId: binding.collaborationId },
      ...(operation === 'repo.read' && readPaths.length ? { dataPaths: readPaths } : {}) }),
    resolveBinding: () => ({ ...binding, snapshotRef: 'snap-1', contextRevisionId: 'ctx-1', recipient: 'reviewer-a' }),
    selectProfile: () => ({ profileRef: 'static-readonly-v1', budgetRef: 'budget-a',
      budget: { maxWallSeconds: 600, maxTurns: 8, maxToolCalls: 40 }, isolationVerified: true }),
    enqueue: (record, key, fingerprint) => {
      calls++;
      const existing = keys.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
        return records.get(existing.id)!;
      }
      records.set(record.id, record); keys.set(key, { fingerprint, id: record.id });
      return record;
    },
    get: (id) => records.get(id) ?? null,
    requestCancel: (record, key) => {
      if (!key) throw new Error('missing cancel key');
      const updated = { ...record, cancelRequested: true };
      records.set(record.id, updated);
      return updated;
    },
  };
  return { deps, records, calls: () => calls, setReadPaths: (paths: string[]) => { readPaths = paths; } };
}

test('investigation requires current path-scoped data.read before enqueue or result disclosure', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const command = { context, ...binding, idempotencyKey: 'scoped', input };
  state.setReadPaths(['src/other.ts']);
  await assert.rejects(app.submit(command), /NOT_AVAILABLE/);
  assert.equal(state.records.size, 0);
  state.setReadPaths(['src/main.ts']);
  const record = await app.submit(command);
  state.setReadPaths(['src/other.ts']);
  await assert.rejects(app.get({ context, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
  await assert.rejects(app.result({ context, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
});

test('get rechecks data.read after the final asynchronous investigation permission check', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const record = await app.submit({ context, ...binding, idempotencyKey: 'read-race', input });
  const original = state.deps.authorize;
  let getChecks = 0;
  state.deps.authorize = (request) => {
    if (request.operation === 'investigate.get' && ++getChecks === 2) state.setReadPaths([]);
    return original(request);
  };
  await assert.rejects(app.get({ context, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
});

test('result and get reject coverage that includes paths outside the current read grant', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const record = await app.submit({ context, ...binding, idempotencyKey: 'coverage', input });
  state.records.set(record.id, { ...record, state: 'completed', result: {
    requestId: record.id, attemptId: 'attempt-a', resultState: 'completed', snapshotRef: input.snapshotRef,
    contextRevisionId: input.contextRevisionId,
    findings: [{ statement: 'derived from private path', classification: 'source_confirmed', evidenceRefs: [] }],
    evidence: [], coverage: { searchedScope: ['src/main.ts', 'src/private.ts'], excludedCategories: [],
      truncated: false, missingDependencies: [] }, openQuestions: [], limitsAndWarnings: [],
  } });
  await assert.rejects(app.get({ context, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
  await assert.rejects(app.result({ context, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
});

test('submit persists one queued request with local profile, fixed binding and separate attempts', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const command = { context, ...binding, idempotencyKey: 'key-a', input };
  const first = await app.submit(command);
  const replay = await new InvestigationApplication(state.deps).submit(command);
  assert.equal(first.id, replay.id);
  assert.equal(state.records.size, 1);
  assert.equal(first.state, 'queued');
  assert.equal(first.attempts.length, 0);
  assert.equal(first.profileRef, 'static-readonly-v1');
  assert.equal(first.recipient, context.recipient);
  assert.equal(first.snapshotRef, input.snapshotRef);
  assert.equal(first.budget.maxWallSeconds, 600);
  assert.equal(state.calls(), 2);
  await assert.rejects(app.submit({ ...command, input: { ...input, question: 'Different question' } }), /IDEMPOTENCY_CONFLICT/);
});

test('cancellation records intent and never claims worker termination', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const record = await app.submit({ context, ...binding, idempotencyKey: 'key-b', input });
  const cancelled = await app.cancel({ context, ...binding, requestId: record.id, idempotencyKey: 'cancel-b' });
  assert.equal(cancelled.state, 'queued');
  assert.equal(cancelled.cancelRequested, true);
  assert.deepEqual(Object.keys(cancelled).sort(), ['cancelRequested', 'requestId', 'state']);
  assert.equal((await app.get({ context, ...binding, requestId: record.id })).cancelRequested, true);
});

test('cross recipient or snapshot mismatch is unavailable', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  await assert.rejects(app.submit({ context, ...binding, idempotencyKey: 'bad', input: { ...input, snapshotRef: 'other' } }), /NOT_AVAILABLE/);
  const record = await app.submit({ context, ...binding, idempotencyKey: 'key-c', input });
  await assert.rejects(app.get({ context: { ...context, recipient: 'other' }, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
  await assert.rejects(app.get({ context: { ...context, principal: 'another' }, ...binding, requestId: record.id }), /NOT_AVAILABLE/);
});

test('follow-up parent must belong to the same fixed collaboration and snapshot', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const parent = await app.submit({ context, ...binding, idempotencyKey: 'parent', input });
  const followup = await app.submit({ context, ...binding, idempotencyKey: 'followup',
    input: { ...input, question: 'Trace cancellation too', parentInvestigationId: parent.id } });
  assert.equal(followup.parentInvestigationId, parent.id);
  state.records.set(parent.id, { ...parent, recipient: 'reviewer-b' });
  await assert.rejects(app.submit({ context, ...binding, idempotencyKey: 'cross-recipient',
    input: { ...input, parentInvestigationId: parent.id } }), /NOT_AVAILABLE/);
  await assert.rejects(app.submit({ context, ...binding, idempotencyKey: 'unknown-parent',
    input: { ...input, parentInvestigationId: 'inv_missing' } }), /NOT_AVAILABLE/);
});

test('submit replay and cancellation never disclose a result through command receipts', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const command = { context, ...binding, idempotencyKey: 'result-replay', input };
  const first = await app.submit(command);
  state.records.set(first.id, { ...state.records.get(first.id)!, state: 'completed', result: {
    requestId: first.id, attemptId: 'attempt-a', resultState: 'completed', snapshotRef: input.snapshotRef,
    contextRevisionId: input.contextRevisionId,
    findings: [{ statement: 'private result', classification: 'source_confirmed', evidenceRefs: [] }],
    evidence: [], coverage: { searchedScope: [], excludedCategories: [], truncated: false, missingDependencies: [] },
    openQuestions: [], limitsAndWarnings: [],
  } });
  const replay = await app.submit(command);
  const cancelled = await app.cancel({ context, ...binding, requestId: first.id, idempotencyKey: 'cancel-replay' });
  assert.ok(!JSON.stringify(replay).includes('private result'));
  assert.ok(!JSON.stringify(cancelled).includes('private result'));
});

test('cancel remains available after data.read revocation but returns no question or scope', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const record = await app.submit({ context, ...binding, idempotencyKey: 'submit-no-read', input });
  state.setReadPaths([]);
  const receipt = await app.cancel({ context, ...binding, requestId: record.id, idempotencyKey: 'cancel-no-read' });
  assert.deepEqual(receipt, { requestId: record.id, state: 'queued', cancelRequested: true });
});

test('cancel requires an idempotency key before writing intent', async () => {
  const state = fixture();
  const app = new InvestigationApplication(state.deps);
  const submitted = await app.submit({ context, ...binding, idempotencyKey: 'submit', input });
  await assert.rejects(app.cancel({ context, ...binding, requestId: submitted.id, idempotencyKey: '' }), /NOT_AVAILABLE/);
  assert.equal(state.records.get(submitted.id)?.cancelRequested, false);
});

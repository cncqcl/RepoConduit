import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import type { Grant, RequestContext } from '../../src/core/policy/authorize.js';

test('historical bundle keeps S1 and requires a computed S1 to S2 review before acceptance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-decision-baseline-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: ContextDecisionSqlite | undefined;
  try {
    const context: RequestContext = { principal: 'owner', audience: 'host', surface: 'local_host', recipient: 'local', now: new Date() };
    const grant: Grant = { id: 'grant', principal: 'owner', audience: 'host', workspaceId: 'ws-a', collaborationId: 'col-a', recipient: 'local',
      permissions: ['context.propose', 'context.accept', 'context.read', 'decision.record'], expiresAt: null, revokedAt: null };
    base.insertWorkspace({ id: 'ws-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'col-a', workspaceId: 'ws-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertWorkingCopy({ id: 'copy-a', workspaceId: 'ws-a', canonicalRoot: dir });
    base.insertGrant(grant);
    const s1 = createSnapshotFromFiles('copy-a', 'v1', { 'a.ts': Buffer.from('old'), 'b.ts': Buffer.from('same') }).toPersisted();
    await base.saveSnapshot({ workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', snapshot: s1 },
      { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', commitRef: 'v1' }, 's1', 'owner', 'host');
    store = new ContextDecisionSqlite(file);
    const app = new ContextDecisionApplication(store, () => [grant]);
    const binding = { context, workspaceId: 'ws-a', collaborationId: 'col-a' };
    const content = { goal: 'Review', constraints: [], acceptedDecisions: [], rejectedDecisions: [], currentQuestions: [],
      evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] };
    app.propose({ ...binding, proposalId: 'p1', parentRevisionId: null, snapshotId: s1.id, sourceRefs: ['m1'], content, idempotencyKey: 'p1' });
    app.accept({ ...binding, proposalId: 'p1', revisionId: 'v1', idempotencyKey: 'v1' });
    const bundle = { bundleId: 'bundle', workspaceId: 'ws-a', collaborationId: 'col-a', contextRevision: 'v1', snapshotRefs: [s1.id] };
    base.saveBundle({ input: bundle });
    base.publishBundle({ ...bundle, files: [], semanticStatus: 'not_reviewed', expectedSetBasis: 'receiver_observed' });
    const hash = store.getPublishedBundleHash('ws-a', 'col-a', 'bundle');
    const s2 = createSnapshotFromFiles('copy-a', 'v2', { 'a.ts': Buffer.from('new'), 'b.ts': Buffer.from('same'), 'c.ts': Buffer.from('added') }).toPersisted();
    await base.saveSnapshot({ workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', snapshot: s2 },
      { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', commitRef: 'v2' }, 's2', 'owner', 'host');
    app.propose({ ...binding, proposalId: 'p2', parentRevisionId: 'v1', snapshotId: s2.id, sourceRefs: ['m2'], content, idempotencyKey: 'p2' });
    app.accept({ ...binding, proposalId: 'p2', revisionId: 'v2', idempotencyKey: 'v2' });
    const decision = { ...binding, decisionId: 'd1', bundleId: 'bundle', bundleManifestHash: hash,
      snapshotId: s1.id, contextRevisionId: 'v1', outcome: 'accept' as const, reason: 'Reviewed changes', idempotencyKey: 'd1' };
    assert.throws(() => app.decide(decision), /BASELINE_REVIEW_REQUIRED/);
    assert.throws(() => app.decide({ ...decision, reviewId: 'unrecorded' }), /BASELINE_REVIEW_REQUIRED/);
    assert.throws(() => app.reviewBaseline({ ...binding,
      context: { ...context, surface: 'external_mcp' }, reviewId: 'external-review', bundleId: 'bundle',
      bundleManifestHash: hash, snapshotId: s1.id, contextRevisionId: 'v1', idempotencyKey: 'external-review' }),
    /not available/i);
    const review = app.reviewBaseline({ ...binding, reviewId: 'r1', bundleId: 'bundle', bundleManifestHash: hash,
      snapshotId: s1.id, contextRevisionId: 'v1', idempotencyKey: 'r1' });
    assert.equal(review.currentSnapshotId, s2.id);
    assert.equal(review.currentContextRevisionId, 'v2');
    assert.equal(review.reviewedBy, 'owner');
    assert.deepEqual(review.changedPaths.map((item) => [item.path, item.change]), [['a.ts', 'modified'], ['c.ts', 'added']]);
    assert.deepEqual(app.reviewBaseline({ ...binding, reviewId: 'r1', bundleId: 'bundle', bundleManifestHash: hash,
      snapshotId: s1.id, contextRevisionId: 'v1', idempotencyKey: 'r1' }), review);
    const accepted = app.decide({ ...decision, reviewId: 'r1' });
    assert.equal(accepted.snapshotId, s1.id);
    assert.equal(accepted.contextRevisionId, 'v1');
    assert.equal(accepted.currentSnapshotId, s2.id);
    assert.equal(accepted.currentContextRevisionId, 'v2');
    assert.equal(accepted.implementationAuthorized, false);
    assert.equal(app.decide({ ...decision, decisionId: 'd2', outcome: 'reject', idempotencyKey: 'd2' }).outcome, 'reject');
    const s3 = createSnapshotFromFiles('copy-a', 'v3', { 'a.ts': Buffer.from('newer') }).toPersisted();
    await base.saveSnapshot({ workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', snapshot: s3 },
      { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', commitRef: 'v3' }, 's3', 'owner', 'host');
    app.propose({ ...binding, proposalId: 'p3', parentRevisionId: 'v2', snapshotId: s3.id, sourceRefs: ['m3'], content, idempotencyKey: 'p3' });
    app.accept({ ...binding, proposalId: 'p3', revisionId: 'v3', idempotencyKey: 'v3' });
    assert.throws(() => app.decide({ ...decision, decisionId: 'd3', reviewId: 'r1', idempotencyKey: 'd3' }), /BASELINE_MISMATCH/);
    assert.equal(app.readDecision({ ...binding, decisionId: 'd3' }), null);
  } finally {
    store?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

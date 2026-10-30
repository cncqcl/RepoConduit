import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import { proposeContext, type ContextContent } from '../../src/core/collaboration/context.js';
import type { Grant, RequestContext } from '../../src/core/policy/authorize.js';

const content: ContextContent = { goal: 'Review', constraints: ['No writes'], acceptedDecisions: [],
  rejectedDecisions: [], currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] };
const external: RequestContext = { principal: 'external', audience: 'mcp', surface: 'external_mcp', recipient: 'external', now: new Date() };
const local: RequestContext = { principal: 'owner', audience: 'host', surface: 'local_host', recipient: 'local', now: new Date() };
const grant = (principal: string, audience: string, permissions: string[]): Grant => ({ id: `${principal}-grant`, principal, audience,
  workspaceId: 'ws-a', collaborationId: 'col-a', recipient: principal === 'external' ? 'external' : 'local',
  permissions, expiresAt: null, revokedAt: null });

test('application reauthorizes live grants and persists idempotent context and decision mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-context-app-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: ContextDecisionSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'ws-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'col-a', workspaceId: 'ws-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertWorkingCopy({ id: 'copy-a', workspaceId: 'ws-a', canonicalRoot: dir });
    const snapshot = createSnapshotFromFiles('copy-a', 'fixture', { 'src/a.ts': Buffer.from('x') }).toPersisted();
    await base.saveSnapshot({ workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', snapshot },
      { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', commitRef: 'fixture' }, 'capture', 'owner', 'host');
    store = new ContextDecisionSqlite(file);
    let grants: Grant[] = [grant('external', 'mcp', ['context.propose', 'context.read']),
      grant('owner', 'host', ['context.read', 'context.accept', 'decision.record'])];
    for (const item of grants) base.insertGrant(item);
    const app = new ContextDecisionApplication(store, () => grants, () => new Date('2026-09-26T00:00:00.000Z'));
    const binding = { workspaceId: 'ws-a', collaborationId: 'col-a' };
    const proposed = { context: external, ...binding, proposalId: 'prop-1', parentRevisionId: null,
      snapshotId: snapshot.id, sourceRefs: ['message-1'], content, idempotencyKey: 'propose-1' };
    assert.deepEqual(app.propose(proposed), app.propose(proposed));
    const rolledBack = proposeContext({ id: 'prop-rollback', ...binding, parentRevisionId: null,
      snapshotId: snapshot.id, proposedBy: 'external', sourceRefs: ['message-2'], content });
    assert.throws(() => store!.runIdempotent({ principal: 'external', audience: 'mcp', workspaceId: 'ws-a',
      operation: 'context.propose', idempotencyKey: 'rollback-key' }, { collaborationId: 'col-a', payload: rolledBack }, external, 'col-a', () => {
      store!.insertProposal(rolledBack);
      throw new Error('fault');
    }), /fault/);
    assert.equal(store.getProposal('ws-a', 'col-a', 'prop-rollback'), null);
    assert.equal(store.runIdempotent({ principal: 'external', audience: 'mcp', workspaceId: 'ws-a',
      operation: 'context.propose', idempotencyKey: 'rollback-key' }, { collaborationId: 'col-a', payload: rolledBack }, external, 'col-a', () => {
      store!.insertProposal(rolledBack);
      return rolledBack;
    }).id, 'prop-rollback');
    assert.equal(app.readProposal({ context: external, ...binding, proposalId: 'prop-1' })?.kind, 'proposal');
    assert.equal(app.readCurrentContext({ context: external, ...binding }), null);
    assert.throws(() => app.accept({ context: external, ...binding, proposalId: 'prop-1', revisionId: 'ctx-1', idempotencyKey: 'accept-1' }), /not available/i);
    const accepted = { context: local, ...binding, proposalId: 'prop-1', revisionId: 'ctx-1', idempotencyKey: 'accept-1' };
    assert.deepEqual(app.accept(accepted), app.accept(accepted));
    assert.equal(app.readCurrentContext({ context: local, ...binding })?.id, 'ctx-1');
    assert.throws(() => app.accept({ ...accepted, revisionId: 'ctx-2' }), /CONFLICT/);
    const bundle = { bundleId: 'bundle-1', ...binding, contextRevision: 'ctx-1', snapshotRefs: [snapshot.id] };
    base.saveBundle({ input: bundle });
    base.publishBundle({ ...bundle, files: [], semanticStatus: 'not_reviewed', expectedSetBasis: 'receiver_observed' });
    const review = app.reviewBaseline({ context: local, ...binding, reviewId: 'review-1', bundleId: 'bundle-1',
      bundleManifestHash: store.getPublishedBundleHash('ws-a', 'col-a', 'bundle-1'), snapshotId: snapshot.id,
      contextRevisionId: 'ctx-1', idempotencyKey: 'review-1' });
    assert.deepEqual(review.changedPaths, []);
    const decision = { context: local, ...binding, decisionId: 'decision-1', bundleId: 'bundle-1',
      bundleManifestHash: store.getPublishedBundleHash('ws-a', 'col-a', 'bundle-1'), snapshotId: snapshot.id,
      contextRevisionId: 'ctx-1', reviewId: 'review-1', outcome: 'accept' as const, reason: 'Reviewed',
      items: [{ id: 'proposal:one', sourceRef: 'bundle:bundle-1', outcome: 'accept' as const,
        reason: 'Reviewed item' }], idempotencyKey: 'decide-1' };
    assert.deepEqual(app.decide(decision), app.decide(decision));
    assert.equal(app.readDecision({ context: local, ...binding, decisionId: 'decision-1' })?.implementationAuthorized, false);
    assert.deepEqual(app.readDecision({ context: local, ...binding, decisionId: 'decision-1' })?.items, decision.items);
    const newer = createSnapshotFromFiles('copy-a', 'fixture-v2', { 'src/a.ts': Buffer.from('changed') }).toPersisted();
    await base.saveSnapshot({ workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', snapshot: newer },
      { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', commitRef: 'fixture-v2' },
      'capture-v2', 'owner', 'host');
    assert.equal(app.decide({ ...decision, decisionId: 'decision-stale', idempotencyKey: 'decide-stale' }).currentSnapshotId,
      snapshot.id);
    base.revokeGrant('owner-grant', '2026-09-25T00:00:00.000Z');
    assert.throws(() => app.decide(decision), /not available/i);
    grants = grants.filter((item) => item.principal !== 'owner');
    assert.throws(() => app.decide(decision), /not available/i);
    assert.throws(() => app.readDecision({ context: local, ...binding, decisionId: 'decision-1' }), /not available/i);
    store.close(); store = new ContextDecisionSqlite(file);
    const restored = { ...grant('owner', 'host', ['context.read', 'context.accept', 'decision.record']), id: 'owner-grant-2' };
    base.insertGrant(restored);
    grants.push(restored);
    const resumed = new ContextDecisionApplication(store, () => grants);
    assert.deepEqual(resumed.decide(decision), resumed.readDecision({ context: local, ...binding, decisionId: 'decision-1' }));
    assert.throws(() => resumed.decide({ ...decision, reason: 'changed' }), /CONFLICT/);
    const historical = resumed.readRevision({ context: local, ...binding, revisionId: 'ctx-1' });
    assert.equal(historical?.content.goal, 'Review');
    resumed.propose({ context: external, ...binding, proposalId: 'prop-2', parentRevisionId: 'ctx-1',
      snapshotId: newer.id, sourceRefs: ['message-3'], content: { ...content, goal: 'Follow-up' },
      idempotencyKey: 'propose-2' });
    resumed.accept({ context: local, ...binding, proposalId: 'prop-2', revisionId: 'ctx-2',
      idempotencyKey: 'accept-2' });
    assert.equal(resumed.readCurrentContext({ context: local, ...binding })?.id, 'ctx-2');
    assert.deepEqual(resumed.readRevision({ context: local, ...binding, revisionId: 'ctx-1' }), historical);
    assert.equal(resumed.readRevision({ context: local, ...binding, revisionId: 'missing' }), null);
    assert.throws(() => resumed.readRevision({ context: local, workspaceId: 'ws-a',
      collaborationId: 'col-other', revisionId: 'ctx-1' }), /not available/i);
    const competing = new DatabaseSync(file);
    try {
      competing.exec('PRAGMA busy_timeout=0');
      const revoke = competing.prepare('UPDATE grants SET revoked_at=? WHERE id=?');
      const result = store.runIdempotent({ principal: 'owner', audience: 'host', workspaceId: 'ws-a',
        operation: 'decision.record', idempotencyKey: 'race-key' }, { collaborationId: 'col-a', payload: 'race' },
      local, 'col-a', () => {
        assert.throws(() => revoke.run('2026-09-25T00:00:00.000Z', restored.id), /locked|BUSY/i);
        return { durable: true };
      });
      assert.deepEqual(result, { durable: true });
      assert.equal(revoke.run('2026-09-25T00:00:00.000Z', restored.id).changes, 1);
      grants = grants.filter((item) => item.id !== restored.id);
      assert.throws(() => resumed.readRevision({ context: local, ...binding, revisionId: 'ctx-1' }), /not available/i);
      assert.throws(() => store!.runIdempotent({ principal: 'owner', audience: 'host', workspaceId: 'ws-a',
        operation: 'decision.record', idempotencyKey: 'race-key' }, { collaborationId: 'col-a', payload: 'race' },
      local, 'col-a', () => ({ durable: false })), /not available/i);
    } finally { competing.close(); }
  } finally {
    store?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

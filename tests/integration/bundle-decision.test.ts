import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { recordDecision } from '../../src/core/collaboration/decision.js';
import { acceptContext, proposeContext, type ContextContent } from '../../src/core/collaboration/context.js';
import type { Permit } from '../../src/core/policy/authorize.js';

const content: ContextContent = { goal: 'Review', constraints: ['No writes'], acceptedDecisions: [],
  rejectedDecisions: [], currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] };
const localPermit = (operation: string): Permit => ({ grantId: 'grant-1', operation, effect: 'state_write',
  scope: { workspaceId: 'ws-a', collaborationId: 'col-a' }, principal: 'owner', recipient: 'local' });

test('proposal, accepted context and bundle decision persist immutably across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-context-decision-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: ContextDecisionSqlite | undefined;
  try {
    base.insertWorkspace({ id: 'ws-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'col-a', workspaceId: 'ws-a', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    base.insertWorkingCopy({ id: 'copy-a', workspaceId: 'ws-a', canonicalRoot: dir });
    const snapshot = createSnapshotFromFiles('copy-a', 'fixture', { 'src/a.ts': Buffer.from('export const a = 1;') }).toPersisted();
    await base.saveSnapshot({ workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', snapshot },
      { workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'copy-a', commitRef: 'fixture' }, 'capture', 'owner', 'cli');
    store = new ContextDecisionSqlite(file);
    const proposal = proposeContext({ id: 'prop-1', workspaceId: 'ws-a', collaborationId: 'col-a',
      parentRevisionId: null, snapshotId: snapshot.id, proposedBy: 'external', sourceRefs: ['message-1'], content });
    assert.throws(() => store!.insertProposal({ ...proposal, id: 'missing-snapshot', snapshotId: 'snap-missing' }), /NOT_AVAILABLE/);
    store.insertProposal(proposal);
    assert.equal(store.getCurrentRevision('ws-a', 'col-a'), null);
    const revision = acceptContext(proposal, 'ctx-1', localPermit('context.accept'), 'local_host');
    store.insertRevision(revision, localPermit('context.accept'), 'local_host');
    assert.equal(store.getCurrentRevision('ws-a', 'col-a')?.id, 'ctx-1');
    assert.throws(() => store!.insertRevision({ ...revision, id: 'ctx-2', content: { ...content, goal: 'Overwrite' } }, localPermit('context.accept'), 'local_host'), /CONFLICT/);
    assert.throws(() => store!.insertRevision({ ...revision, id: 'ctx-3' }, localPermit('context.accept'), 'external_mcp'), /NOT_AVAILABLE/);
    const bundle = { bundleId: 'bundle-1', workspaceId: 'ws-a', collaborationId: 'col-a', contextRevision: 'ctx-1', snapshotRefs: [snapshot.id] };
    base.saveBundle({ input: bundle });
    base.publishBundle({ ...bundle, files: [], semanticStatus: 'not_reviewed', expectedSetBasis: 'receiver_observed' });
    const manifestHash = store.getPublishedBundleHash('ws-a', 'col-a', 'bundle-1');
    const review = store.insertBaselineReview({ id: 'review-1', workspaceId: 'ws-a', collaborationId: 'col-a',
      bundleId: 'bundle-1', bundleManifestHash: manifestHash, snapshotId: snapshot.id,
      contextRevisionId: 'ctx-1', reviewedBy: 'owner' }, localPermit('decision.review'), 'local_host');
    const decision = recordDecision({ id: 'decision-1', workspaceId: 'ws-a', collaborationId: 'col-a',
      bundleId: 'bundle-1', bundleManifestHash: manifestHash, snapshotId: snapshot.id,
      contextRevisionId: 'ctx-1', reviewId: review.id, outcome: 'accept', reason: 'Reviewed', decidedBy: 'owner' },
      localPermit('decision.record'), 'local_host');
    const recorded = store.insertDecision(decision, localPermit('decision.record'), 'local_host');
    const items = [
      { id: 'proposal:cache', sourceRef: 'bundle:bundle-1', outcome: 'accept' as const, reason: 'Fits current constraints' },
      { id: 'proposal:script', sourceRef: 'bundle:bundle-1', outcome: 'reject' as const, reason: 'Would execute untrusted code' },
      { id: 'proposal:docs', sourceRef: 'bundle:bundle-1', outcome: 'modify' as const, reason: 'Clarify scope before promotion' }
    ];
    const partial = recordDecision({ ...decision, id: 'decision-items', outcome: 'modify', items },
      localPermit('decision.record'), 'local_host');
    assert.deepEqual(store.insertDecision(partial, localPermit('decision.record'), 'local_host').items, items);
    assert.deepEqual(store.insertDecision(partial, localPermit('decision.record'), 'local_host').items, items);
    const itemlessInput = { ...partial };
    delete itemlessInput.items;
    const itemlessReplay = recordDecision(itemlessInput, localPermit('decision.record'), 'local_host');
    assert.throws(() => store!.insertDecision(itemlessReplay, localPermit('decision.record'), 'local_host'), /CONFLICT/);
    const itemizedReplay = recordDecision({ ...decision,
      items: [{ ...items[0]!, reason: 'Reviewed' }] }, localPermit('decision.record'), 'local_host');
    assert.throws(() => store!.insertDecision(itemizedReplay, localPermit('decision.record'), 'local_host'), /CONFLICT/);
    const unknownFile = recordDecision({ ...decision, id: 'unknown-file', outcome: 'accept',
      items: [{ ...items[0]!, sourceRef: 'file:missing.md' }] }, localPermit('decision.record'), 'local_host');
    assert.throws(() => store!.insertDecision(unknownFile, localPermit('decision.record'), 'local_host'), /NOT_AVAILABLE/);
    assert.throws(() => recordDecision({ ...decision, id: 'duplicate-items', outcome: 'modify',
      items: [items[0]!, items[0]!] }, localPermit('decision.record'), 'local_host'), /NOT_AVAILABLE/);
    assert.throws(() => recordDecision({ ...decision, id: 'contradictory-items', outcome: 'accept', items },
      localPermit('decision.record'), 'local_host'), /NOT_AVAILABLE/);
    assert.throws(() => recordDecision({ ...decision, id: 'oversized-items', outcome: 'modify',
      items: Array.from({ length: 101 }, (_, index) => ({ ...items[0]!, id: `proposal:${index}` })) },
      localPermit('decision.record'), 'local_host'), /NOT_AVAILABLE/);
    assert.equal(store.getDecision('ws-a', 'col-a', 'decision-1')?.implementationAuthorized, false);
    assert.throws(() => store!.insertDecision({ ...decision, id: 'decision-2', bundleManifestHash: '0'.repeat(64) }, localPermit('decision.record'), 'local_host'), /NOT_AVAILABLE/);
    assert.throws(() => store!.insertDecision({ ...decision, id: 'decision-3' }, localPermit('decision.record'), 'external_mcp'), /NOT_AVAILABLE/);
    store.close(); store = new ContextDecisionSqlite(file);
    assert.equal(store.getProposal('ws-a', 'col-a', 'prop-1')?.content.goal, 'Review');
    assert.equal(store.getCurrentRevision('ws-a', 'col-a')?.content.constraints[0], 'No writes');
    assert.deepEqual(store.getDecision('ws-a', 'col-a', 'decision-1'), recorded);
    assert.deepEqual(store.getDecision('ws-a', 'col-a', 'decision-items')?.items, items);
    assert.throws(() => store!.insertDecision({ ...decision, reason: 'Changed' }, localPermit('decision.record'), 'local_host'), /CONFLICT/);
  } finally {
    store?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

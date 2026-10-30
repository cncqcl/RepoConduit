import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptContext, proposeContext, type ContextContent } from '../../src/core/collaboration/context.js';
import type { Permit } from '../../src/core/policy/authorize.js';

const content: ContextContent = {
  goal: 'Review design', constraints: ['No source writes'], acceptedDecisions: [],
  rejectedDecisions: [], currentQuestions: ['Is it safe?'], evidenceRefs: ['evidence:1'],
  expectedDeliverables: ['report'], unknowns: [], recentChanges: [],
};
const base = { id: 'proposal-1', workspaceId: 'ws-a', collaborationId: 'col-a',
  parentRevisionId: null, snapshotId: 'snap-a', proposedBy: 'external', sourceRefs: ['message-1'], content };
const permit: Permit = { grantId: 'grant-1', operation: 'context.accept', effect: 'state_write',
  scope: { workspaceId: 'ws-a', collaborationId: 'col-a' }, principal: 'owner', recipient: 'local' };

test('external context is only a proposal until a scoped local permit accepts it', () => {
  const proposal = proposeContext(base);
  assert.equal(proposal.kind, 'proposal');
  assert.throws(() => acceptContext(proposal, 'revision-1', permit, 'external_mcp'), /NOT_AVAILABLE/);
  assert.throws(() => acceptContext(proposal, 'revision-1', { ...permit, scope: { workspaceId: 'ws-b', collaborationId: 'col-a' } }, 'local_host'), /NOT_AVAILABLE/);
  const revision = acceptContext(proposal, 'revision-1', permit, 'local_host');
  assert.equal(revision.kind, 'revision');
  assert.equal(revision.acceptedBy, 'owner');
  assert.equal(revision.sourceProposalId, proposal.id);
  assert.equal(revision.content.constraints[0], 'No source writes');
  assert.throws(() => proposeContext({ ...base, content: { ...content, goal: '' } }), /Invalid/);
});

import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { acceptContext, proposeContext, type ContextContent } from '../../src/core/collaboration/context.js';
import type { SqliteStore } from '../../src/adapters/storage/sqlite.js';

/** Persist a real accepted context and snapshot for bundle tests. Caller owns workspace/collaboration. */
export async function seedBundleProvenance(db: SqliteStore, file: string, input: {
  workspaceId: string; collaborationId: string; workingCopyId: string; root: string; revisionIds: string[];
}): Promise<{ snapshotId: string }> {
  db.insertWorkingCopy({ id: input.workingCopyId, workspaceId: input.workspaceId, canonicalRoot: input.root });
  const snapshot = createSnapshotFromFiles(input.workingCopyId, 'bundle-fixture',
    { 'src/provenance.ts': Buffer.from('export const fixture = true;') }).toPersisted();
  await db.saveSnapshot({ workspaceId: input.workspaceId, collaborationId: input.collaborationId,
    workingCopyId: input.workingCopyId, snapshot },
  { workspaceId: input.workspaceId, collaborationId: input.collaborationId,
    workingCopyId: input.workingCopyId, commitRef: 'bundle-fixture' },
  'capture-bundle-fixture', 'owner', 'local_cli');
  const contexts = new ContextDecisionSqlite(file);
  const content: ContextContent = { goal: 'Bundle fixture', constraints: [], acceptedDecisions: [],
    rejectedDecisions: [], currentQuestions: [], evidenceRefs: [], expectedDeliverables: [],
    unknowns: [], recentChanges: [] };
  const permit = { grantId: 'local-fixture', operation: 'context.accept', effect: 'state_write' as const,
    scope: { workspaceId: input.workspaceId, collaborationId: input.collaborationId },
    principal: 'owner', recipient: 'owner' };
  try {
    let parentRevisionId: string | null = null;
    for (const [index, revisionId] of input.revisionIds.entries()) {
      const proposal = proposeContext({ id: `proposal-bundle-${index}`, workspaceId: input.workspaceId,
        collaborationId: input.collaborationId, parentRevisionId, snapshotId: snapshot.id,
        proposedBy: 'external', sourceRefs: ['fixture'], content });
      contexts.insertProposal(proposal);
      contexts.insertRevision(acceptContext(proposal, revisionId, permit, 'local_host'), permit, 'local_host');
      parentRevisionId = revisionId;
    }
  } finally { contexts.close(); }
  return { snapshotId: snapshot.id };
}

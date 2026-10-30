import type { Permit, Surface } from '../policy/authorize.js';

export interface ContextContent {
  goal: string;
  constraints: string[];
  acceptedDecisions: string[];
  rejectedDecisions: string[];
  currentQuestions: string[];
  evidenceRefs: string[];
  expectedDeliverables: string[];
  unknowns: string[];
  recentChanges: string[];
}

export interface ContextProposal {
  kind: 'proposal';
  id: string;
  workspaceId: string;
  collaborationId: string;
  parentRevisionId: string | null;
  snapshotId: string;
  proposedBy: string;
  sourceRefs: string[];
  content: ContextContent;
}

export interface ContextRevision extends Omit<ContextProposal, 'kind' | 'id' | 'proposedBy'> {
  kind: 'revision';
  id: string;
  sourceProposalId: string;
  acceptedBy: string;
  /** Inherited accepted content is not a new local acceptance of the external question. */
  inheritedFrom?: {
    sourceWorkspaceId: string;
    sourceCollaborationId: string;
    sourceRevisionId: string;
    sourceSnapshotId: string;
    materialId: string;
    requestedQuestion: { text: string; proposedBy: string; status: 'unaccepted' };
  };
}

/** Only the frozen-material application path uses this; ordinary acceptContext remains unchanged. */
export function inheritContext(source: ContextRevision, input: { id: string; workspaceId: string;
  collaborationId: string; snapshotId: string; materialId: string; question: string; requestedBy: string }): ContextRevision {
  if (source.kind !== 'revision' || source.inheritedFrom || !source.acceptedBy || !validContent(source.content) ||
      !input.id || !input.workspaceId || !input.collaborationId || !input.snapshotId || !input.materialId ||
      !input.requestedBy || !input.question.trim() || Buffer.byteLength(input.question, 'utf8') > 16384) throw new Error('NOT_AVAILABLE');
  return structuredClone({ ...source, id: input.id, workspaceId: input.workspaceId,
    collaborationId: input.collaborationId, parentRevisionId: null, snapshotId: input.snapshotId,
    inheritedFrom: { sourceWorkspaceId: source.workspaceId, sourceCollaborationId: source.collaborationId,
      sourceRevisionId: source.id, sourceSnapshotId: source.snapshotId, materialId: input.materialId,
      requestedQuestion: { text: input.question, proposedBy: input.requestedBy, status: 'unaccepted' as const } } });
}

function validContent(content: ContextContent): boolean {
  return Boolean(content.goal?.trim()) &&
    (['constraints', 'acceptedDecisions', 'rejectedDecisions', 'currentQuestions', 'evidenceRefs',
      'expectedDeliverables', 'unknowns', 'recentChanges'] as const)
      .every((field) => Array.isArray(content[field]) && content[field].every((item) => typeof item === 'string'));
}

export function proposeContext(input: Omit<ContextProposal, 'kind'>): ContextProposal {
  if (!input.id || !input.workspaceId || !input.collaborationId || !input.snapshotId ||
      !input.proposedBy || !input.sourceRefs.length || !validContent(input.content)) {
    throw new TypeError('Invalid context proposal');
  }
  return structuredClone({ ...input, kind: 'proposal' });
}

export function acceptContext(proposal: ContextProposal, revisionId: string, permit: Permit, surface: Surface): ContextRevision {
  if (surface !== 'local_host' && surface !== 'local_cli') throw new Error('NOT_AVAILABLE');
  if (permit.operation !== 'context.accept' || permit.effect !== 'state_write' ||
      permit.scope.workspaceId !== proposal.workspaceId || permit.scope.collaborationId !== proposal.collaborationId ||
      !permit.grantId || !permit.principal || !revisionId) throw new Error('NOT_AVAILABLE');
  return structuredClone({ kind: 'revision', id: revisionId, workspaceId: proposal.workspaceId,
    collaborationId: proposal.collaborationId, parentRevisionId: proposal.parentRevisionId,
    snapshotId: proposal.snapshotId, sourceProposalId: proposal.id, sourceRefs: proposal.sourceRefs,
    content: proposal.content, acceptedBy: permit.principal });
}

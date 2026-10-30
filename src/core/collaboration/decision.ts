import type { Permit, Surface } from '../policy/authorize.js';

export interface DecisionProposalInput {
  id: string; workspaceId: string; collaborationId: string; contextRevisionId: string;
  snapshotId: string; recommendation: 'accept' | 'modify' | 'reject'; reason: string;
  bundleId?: string; bundleManifestHash?: string; proposedBy: string;
}
export interface DecisionProposal extends DecisionProposalInput {
  kind: 'decision_proposal'; implementationAuthorized: false;
}

/** A suggestion carries no local decision, adoption, or implementation authority. */
export function proposeDecision(input: DecisionProposalInput, permit: Permit): DecisionProposal {
  const bounded = (value: unknown, max: number) => typeof value === 'string' &&
    value.length > 0 && Buffer.byteLength(value, 'utf8') <= max;
  const fields = ['id','workspaceId','collaborationId','contextRevisionId','snapshotId',
    'recommendation','reason','bundleId','bundleManifestHash','proposedBy'];
  if (!input || typeof input !== 'object' || Object.keys(input).some(key=>!fields.includes(key)) ||
      permit.operation !== 'decision.propose' || permit.effect !== 'state_write' ||
      permit.scope.workspaceId !== input.workspaceId ||
      permit.scope.collaborationId !== input.collaborationId || !permit.grantId ||
      permit.principal !== input.proposedBy ||
      typeof input.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/.test(input.id) ||
      !bounded(input.workspaceId, 256) || !bounded(input.collaborationId, 256) ||
      !bounded(input.contextRevisionId, 256) || !bounded(input.snapshotId, 256) ||
      !['accept', 'modify', 'reject'].includes(input.recommendation) ||
      typeof input.reason !== 'string' || !input.reason.trim() ||
      Buffer.byteLength(input.reason, 'utf8') > 16 * 1024 ||
      (input.bundleId === undefined) !== (input.bundleManifestHash === undefined) ||
      (input.bundleId !== undefined && (!bounded(input.bundleId, 128) ||
        typeof input.bundleManifestHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(input.bundleManifestHash!)))) throw new Error('NOT_AVAILABLE');
  return structuredClone({ kind: 'decision_proposal' as const, id: input.id,
    workspaceId: input.workspaceId, collaborationId: input.collaborationId,
    contextRevisionId: input.contextRevisionId, snapshotId: input.snapshotId,
    recommendation: input.recommendation, reason: input.reason,
    ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId,
      bundleManifestHash: input.bundleManifestHash }),
    proposedBy: input.proposedBy, implementationAuthorized: false as const });
}

export interface DecisionItem {
  id: string;
  sourceRef: string;
  outcome: 'accept' | 'modify' | 'reject';
  reason: string;
}

interface DecisionCommon {
  id: string;
  workspaceId: string;
  collaborationId: string;
  snapshotId: string;
  contextRevisionId: string;
  reviewId?: string;
  outcome: 'accept' | 'modify' | 'reject';
  reason: string;
  decidedBy: string;
  items?: DecisionItem[];
}
type BundleTarget={bundleId:string;bundleManifestHash:string;proposalId?:never};
type ProposalTarget={proposalId:string;bundleId?:never;bundleManifestHash?:never};
export type DecisionInput = DecisionCommon & (BundleTarget | ProposalTarget);

type DecisionRecordFields = {
  implementationAuthorized: false;
  currentSnapshotId?: string;
  currentContextRevisionId?: string;
};
export type DecisionRecord = DecisionInput & DecisionRecordFields;

export function recordDecision(input: DecisionCommon & BundleTarget, permit: Permit,
  surface: Surface): DecisionCommon & BundleTarget & DecisionRecordFields;
export function recordDecision(input: DecisionCommon & ProposalTarget, permit: Permit,
  surface: Surface): DecisionCommon & ProposalTarget & DecisionRecordFields;
export function recordDecision(input: DecisionInput, permit: Permit, surface: Surface): DecisionRecord;
export function recordDecision(input: DecisionInput, permit: Permit, surface: Surface): DecisionRecord {
  if (surface !== 'local_host' && surface !== 'local_cli') throw new Error('NOT_AVAILABLE');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('NOT_AVAILABLE');
  const proposalTarget=Object.hasOwn(input,'proposalId');
  const bundleTarget=Object.hasOwn(input,'bundleId') || Object.hasOwn(input,'bundleManifestHash');
  if (permit.operation !== 'decision.record' || permit.effect !== 'state_write' ||
      permit.scope.workspaceId !== input.workspaceId || permit.scope.collaborationId !== input.collaborationId ||
      !permit.grantId || permit.principal !== input.decidedBy ||
      typeof input.id !== 'string' || !input.id ||
      proposalTarget === bundleTarget ||
      (proposalTarget ? typeof input.proposalId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/.test(input.proposalId) :
        typeof input.bundleId !== 'string' || !input.bundleId ||
        typeof input.bundleManifestHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.bundleManifestHash)) ||
      typeof input.snapshotId !== 'string' || !input.snapshotId ||
      typeof input.contextRevisionId !== 'string' || !input.contextRevisionId ||
      !['accept', 'modify', 'reject'].includes(input.outcome) ||
      typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('NOT_AVAILABLE');
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) throw new Error('NOT_AVAILABLE');
    const ids = new Set<string>();
    for (const item of input.items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/.test(item.id) || ids.has(item.id) ||
          typeof item.sourceRef !== 'string' || item.sourceRef.length > 512 ||
          !(proposalTarget ? item.sourceRef === `proposal:${input.proposalId}` :
            item.sourceRef === `bundle:${input.bundleId}` || item.sourceRef.startsWith('file:')) ||
          !['accept', 'modify', 'reject'].includes(item.outcome) ||
          typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 4096) throw new Error('NOT_AVAILABLE');
      ids.add(item.id);
    }
    const expected = input.items.every((item) => item.outcome === 'accept') ? 'accept' :
      input.items.every((item) => item.outcome === 'reject') ? 'reject' : 'modify';
    if (input.outcome !== expected) throw new Error('NOT_AVAILABLE');
  }
  return structuredClone({ id: input.id, workspaceId: input.workspaceId, collaborationId: input.collaborationId,
    ...(proposalTarget ? { proposalId: input.proposalId } :
      { bundleId: input.bundleId, bundleManifestHash: input.bundleManifestHash }),
    snapshotId: input.snapshotId,
    contextRevisionId: input.contextRevisionId, ...(input.reviewId ? { reviewId: input.reviewId } : {}),
    outcome: input.outcome, reason: input.reason, decidedBy: input.decidedBy,
    ...(input.items === undefined ? {} : { items: input.items.map((item) => ({ id: item.id,
      sourceRef: item.sourceRef, outcome: item.outcome, reason: item.reason })) }), implementationAuthorized: false }) as DecisionRecord;
}

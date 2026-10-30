import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ContextProposal, ContextRevision } from '../../core/collaboration/context.js';
import type { DecisionProposal, DecisionRecord } from '../../core/collaboration/decision.js';
import type { BundleManifest } from '../../core/artifact/types.js';
import { acceptContext } from '../../core/collaboration/context.js';
import { proposeDecision, recordDecision } from '../../core/collaboration/decision.js';
import { authorize, type Grant, type Permit, type RequestContext, type Surface } from '../../core/policy/authorize.js';
import type { IdempotencyScope } from './sqlite.js';
import { RepositorySnapshot, type PersistedSnapshot } from '../repository/snapshots.js';

type ReviewTarget = {bundleId:string;bundleManifestHash:string;proposalId?:never} |
  {proposalId:string;bundleId?:never;bundleManifestHash?:never};
export type BaselineReviewInput = ReviewTarget & {
  id: string; workspaceId: string; collaborationId: string;
  snapshotId: string; contextRevisionId: string; reviewedBy: string;
};
export type BaselineReview = BaselineReviewInput & {
  currentSnapshotId: string; currentContextRevisionId: string;
  changedPaths: { path: string; change: 'added' | 'removed' | 'modified'; beforeHash?: string; afterHash?: string }[];
  sourceConsistency: { before: string; after: string };
  exclusions: { before: unknown[]; after: unknown[] };
};

function conflict(): never { throw new Error('CONFLICT'); }
function unavailable(): never { throw new Error('NOT_AVAILABLE'); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new TypeError('Undefined idempotency input');
      return `${JSON.stringify(key)}:${canonical(record[key])}`;
    }).join(',')}}`;
  }
  throw new TypeError('Unsupported idempotency input');
}

export class ContextDecisionSqlite {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_proposals (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), proposal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_revisions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), revision_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_heads (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), revision_id TEXT NOT NULL REFERENCES context_revisions(id),
        PRIMARY KEY (workspace_id,collaboration_id)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), decision_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_proposals (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), proposal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS baseline_reviews (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), review_json TEXT NOT NULL
      );
    `);
    } catch (error) {
      try { this.db.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'SQLite constructor cleanup uncertain',
        { cause: closeError }); }
      throw error;
    }
  }

  private collaborationExists(workspaceId: string, collaborationId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM collaborations WHERE id=? AND workspace_id=?')
      .get(collaborationId, workspaceId);
  }

  private snapshotExists(workspaceId: string, collaborationId: string, snapshotId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM snapshots WHERE id=? AND workspace_id=? AND collaboration_id=?')
      .get(snapshotId, workspaceId, collaborationId);
  }

  private persistedPermit(context: RequestContext, operation: string, workspaceId: string, collaborationId: string): Permit {
    const rows = this.db.prepare(`SELECT id,principal,audience,workspace_id,collaboration_id,recipient,
      permissions_json,data_paths_json,expires_at,revoked_at FROM grants
      WHERE principal=? AND audience=? AND workspace_id=?`).all(context.principal, context.audience, workspaceId) as {
      id: string; principal: string; audience: string; workspace_id: string; collaboration_id: string | null;
      recipient: string | null; permissions_json: string; data_paths_json: string | null;
      expires_at: string | null; revoked_at: string | null;
    }[];
    const grants: Grant[] = rows.map((row) => ({ id: row.id, principal: row.principal,
      audience: row.audience, workspaceId: row.workspace_id,
      ...(row.collaboration_id ? { collaborationId: row.collaboration_id } : {}),
      ...(row.recipient ? { recipient: row.recipient } : {}),
      permissions: JSON.parse(row.permissions_json) as string[],
      ...(row.data_paths_json === null ? {} : { dataPaths: JSON.parse(row.data_paths_json) as string[] }),
      expiresAt: row.expires_at, revokedAt: row.revoked_at }));
    return authorize(context, operation, { workspaceId, collaborationId }, grants);
  }

  runIdempotent<T>(scope: IdempotencyScope, payload: unknown, context: RequestContext,
    collaborationId: string, mutation: (permit: Permit) => T): T {
    if (Object.values(scope).some((part) => !part) || mutation.constructor.name === 'AsyncFunction') {
      throw new TypeError('Invalid idempotent mutation');
    }
    if (scope.principal !== context.principal || scope.audience !== context.audience || !collaborationId) unavailable();
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    const values = [scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const permit = this.persistedPermit(context, scope.operation, scope.workspaceId, collaborationId);
      const prior = this.db.prepare(`SELECT payload_hash,result_json FROM idempotency_records
        WHERE principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`)
        .get(...values) as { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== hash) conflict();
        this.db.exec('COMMIT');
        return JSON.parse(prior.result_json) as T;
      }
      const result = mutation(permit);
      if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        throw new TypeError('Idempotent mutation must be synchronous');
      }
      this.db.prepare(`INSERT INTO idempotency_records
        (principal,audience,workspace_id,operation,idempotency_key,payload_hash,result_json)
        VALUES (?,?,?,?,?,?,?)`).run(...values, hash, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  insertProposal(proposal: ContextProposal): void {
    if (!this.collaborationExists(proposal.workspaceId, proposal.collaborationId) ||
        !this.snapshotExists(proposal.workspaceId, proposal.collaborationId, proposal.snapshotId)) unavailable();
    const prior = this.db.prepare('SELECT proposal_json FROM context_proposals WHERE id=?').get(proposal.id) as
      { proposal_json: string } | undefined;
    const json = JSON.stringify(proposal);
    if (prior) { if (prior.proposal_json !== json) conflict(); return; }
    this.db.prepare('INSERT INTO context_proposals VALUES (?,?,?,?)')
      .run(proposal.id, proposal.workspaceId, proposal.collaborationId, json);
  }

  getProposal(workspaceId: string, collaborationId: string, id: string): ContextProposal | null {
    const row = this.db.prepare('SELECT proposal_json FROM context_proposals WHERE id=? AND workspace_id=? AND collaboration_id=?')
      .get(id, workspaceId, collaborationId) as { proposal_json: string } | undefined;
    return row ? JSON.parse(row.proposal_json) as ContextProposal : null;
  }

  getCurrentRevision(workspaceId: string, collaborationId: string): ContextRevision | null {
    const row = this.db.prepare(`SELECT r.revision_json FROM context_heads h JOIN context_revisions r ON r.id=h.revision_id
      WHERE h.workspace_id=? AND h.collaboration_id=?`).get(workspaceId, collaborationId) as
      { revision_json: string } | undefined;
    return row ? JSON.parse(row.revision_json) as ContextRevision : null;
  }

  getRevision(workspaceId: string, collaborationId: string, revisionId: string): ContextRevision | null {
    const row = this.db.prepare(`SELECT revision_json FROM context_revisions
      WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(revisionId, workspaceId, collaborationId) as { revision_json: string } | undefined;
    if (!row) return null;
    const revision = JSON.parse(row.revision_json) as ContextRevision;
    return revision.id === revisionId && revision.workspaceId === workspaceId &&
      revision.collaborationId === collaborationId ? revision : null;
  }

  insertRevision(revision: ContextRevision, permit: Permit, surface: Surface): void {
    this.db.exec('SAVEPOINT insert_context_revision');
    try {
      const json = JSON.stringify(revision);
      const proposal = this.getProposal(revision.workspaceId, revision.collaborationId, revision.sourceProposalId);
      if (!proposal) unavailable();
      const authorized = acceptContext(proposal, revision.id, permit, surface);
      const prior = this.db.prepare('SELECT revision_json FROM context_revisions WHERE id=?').get(revision.id) as
        { revision_json: string } | undefined;
      if (prior) { if (prior.revision_json !== json || JSON.stringify(authorized) !== json) conflict(); this.db.exec('RELEASE SAVEPOINT insert_context_revision'); return; }
      const head = this.getCurrentRevision(revision.workspaceId, revision.collaborationId);
      if (head?.id !== (revision.parentRevisionId ?? undefined) ||
          proposal.parentRevisionId !== revision.parentRevisionId || proposal.snapshotId !== revision.snapshotId ||
          JSON.stringify(proposal.content) !== JSON.stringify(revision.content) ||
          JSON.stringify(proposal.sourceRefs) !== JSON.stringify(revision.sourceRefs) ||
          JSON.stringify(authorized) !== json) conflict();
      this.db.prepare('INSERT INTO context_revisions VALUES (?,?,?,?)')
        .run(revision.id, revision.workspaceId, revision.collaborationId, json);
      this.db.prepare(`INSERT INTO context_heads(workspace_id,collaboration_id,revision_id) VALUES (?,?,?)
        ON CONFLICT(workspace_id,collaboration_id) DO UPDATE SET revision_id=excluded.revision_id`)
        .run(revision.workspaceId, revision.collaborationId, revision.id);
      this.db.exec('RELEASE SAVEPOINT insert_context_revision');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT insert_context_revision');
      this.db.exec('RELEASE SAVEPOINT insert_context_revision');
      throw error;
    }
  }

  getPublishedBundleHash(workspaceId: string, collaborationId: string, bundleId: string): string {
    const row = this.db.prepare(`SELECT manifest_json FROM bundles WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(bundleId, workspaceId, collaborationId) as { manifest_json: string | null } | undefined;
    if (!row?.manifest_json) unavailable();
    return createHash('sha256').update(row.manifest_json).digest('hex');
  }

  private bundleBaseline(workspaceId: string, collaborationId: string, bundleId: string,
    bundleManifestHash: string, snapshotId: string, contextRevisionId: string): void {
    const row = this.db.prepare(`SELECT manifest_json FROM bundles WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(bundleId, workspaceId, collaborationId) as { manifest_json: string | null } | undefined;
    if (!row?.manifest_json || this.getPublishedBundleHash(workspaceId, collaborationId, bundleId) !== bundleManifestHash) unavailable();
    const manifest = JSON.parse(row.manifest_json) as { contextRevision: string; snapshotRefs: string[] };
    if (manifest.contextRevision !== contextRevisionId || !manifest.snapshotRefs.includes(snapshotId) ||
        !this.snapshotExists(workspaceId, collaborationId, snapshotId)) unavailable();
    const revision = this.db.prepare(`SELECT revision_json FROM context_revisions WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(contextRevisionId, workspaceId, collaborationId) as { revision_json: string } | undefined;
    if (!revision || (JSON.parse(revision.revision_json) as ContextRevision).snapshotId !== snapshotId) unavailable();
  }

  private proposalBaseline(workspaceId:string,collaborationId:string,proposalId:string,
    snapshotId:string,contextRevisionId:string): DecisionProposal {
    const proposal=this.getDecisionProposal(workspaceId,collaborationId,proposalId);
    if (!proposal || proposal.id!==proposalId || proposal.workspaceId!==workspaceId ||
        proposal.collaborationId!==collaborationId || proposal.snapshotId!==snapshotId ||
        proposal.contextRevisionId!==contextRevisionId || proposal.kind!=='decision_proposal' ||
        proposal.implementationAuthorized!==false) unavailable();
    const revision=this.getRevision(workspaceId,collaborationId,contextRevisionId);
    if (!revision || revision.snapshotId!==snapshotId ||
        !this.snapshotExists(workspaceId,collaborationId,snapshotId)) unavailable();
    if (proposal.bundleId!==undefined) this.bundleBaseline(workspaceId,collaborationId,
      proposal.bundleId,proposal.bundleManifestHash!,snapshotId,contextRevisionId);
    return proposal;
  }

  insertBaselineReview(input: BaselineReviewInput, permit: Permit, surface: Surface): BaselineReview {
    if (!input || typeof input!=='object' || Array.isArray(input) ||
        Object.keys(input).some(key=>!['id','workspaceId','collaborationId','bundleId',
          'bundleManifestHash','proposalId','snapshotId','contextRevisionId','reviewedBy'].includes(key))) unavailable();
    const proposalTarget=Object.hasOwn(input,'proposalId');
    const bundleTarget=Object.hasOwn(input,'bundleId') || Object.hasOwn(input,'bundleManifestHash');
    if ((surface !== 'local_host' && surface !== 'local_cli') || permit.operation !== 'decision.review' ||
        permit.effect !== 'state_write' || !permit.grantId || permit.scope.workspaceId !== input.workspaceId ||
        permit.scope.collaborationId !== input.collaborationId || permit.principal !== input.reviewedBy ||
        !input.id || proposalTarget===bundleTarget ||
        (proposalTarget && typeof input.proposalId!=='string') ||
        (bundleTarget && (typeof input.bundleId!=='string' ||
          typeof input.bundleManifestHash!=='string'))) unavailable();
    const prior = this.db.prepare('SELECT review_json FROM baseline_reviews WHERE id=?').get(input.id) as
      { review_json: string } | undefined;
    if (prior) {
      const review = JSON.parse(prior.review_json) as BaselineReview;
      if (Object.entries(input).some(([key, value]) => review[key as keyof BaselineReview] !== value)) conflict();
      return review;
    }
    if (proposalTarget) this.proposalBaseline(input.workspaceId,input.collaborationId,
      input.proposalId!,input.snapshotId,input.contextRevisionId);
    else this.bundleBaseline(input.workspaceId,input.collaborationId,input.bundleId!,input.bundleManifestHash!,
      input.snapshotId,input.contextRevisionId);
    const current = this.getCurrentRevision(input.workspaceId, input.collaborationId);
    if (!current) throw new Error('BASELINE_MISMATCH');
    const rows = this.db.prepare(`SELECT id,working_copy_id,snapshot_json FROM snapshots
      WHERE workspace_id=? AND collaboration_id=? AND id IN (?,?)`).all(input.workspaceId, input.collaborationId,
      input.snapshotId, current.snapshotId) as { id: string; working_copy_id: string; snapshot_json: string }[];
    const before = rows.find((row) => row.id === input.snapshotId);
    const after = rows.find((row) => row.id === current.snapshotId);
    if (!before || !after || before.working_copy_id !== after.working_copy_id) throw new Error('BASELINE_MISMATCH');
    const s1 = RepositorySnapshot.fromPersisted(JSON.parse(before.snapshot_json) as PersistedSnapshot);
    const s2 = RepositorySnapshot.fromPersisted(JSON.parse(after.snapshot_json) as PersistedSnapshot);
    const oldFiles = new Map(s1.manifest.map((entry) => [entry.path, entry.sha256]));
    const newFiles = new Map(s2.manifest.map((entry) => [entry.path, entry.sha256]));
    const changedPaths: BaselineReview['changedPaths'] = [];
    for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
      const oldHash = oldFiles.get(path), newHash = newFiles.get(path);
      if (oldHash === newHash) continue;
      changedPaths.push({ path, change: oldHash === undefined ? 'added' : newHash === undefined ? 'removed' : 'modified',
        ...(oldHash === undefined ? {} : { beforeHash: oldHash }), ...(newHash === undefined ? {} : { afterHash: newHash }) });
    }
    const review: BaselineReview = { ...input, currentSnapshotId: current.snapshotId,
      currentContextRevisionId: current.id, changedPaths,
      sourceConsistency: { before: s1.sourceConsistency, after: s2.sourceConsistency },
      exclusions: { before: [...s1.exclusions], after: [...s2.exclusions] } };
    this.db.prepare('INSERT INTO baseline_reviews VALUES (?,?,?,?)')
      .run(review.id, review.workspaceId, review.collaborationId, JSON.stringify(review));
    return review;
  }

  insertDecision(decision: DecisionRecord, permit: Permit, surface: Surface): DecisionRecord {
    if (JSON.stringify(recordDecision(decision, permit, surface)) !== JSON.stringify(decision)) conflict();
    if (decision.implementationAuthorized !== false || !this.collaborationExists(decision.workspaceId, decision.collaborationId)) unavailable();
    const prior = this.db.prepare('SELECT decision_json FROM decisions WHERE id=?').get(decision.id) as
      { decision_json: string } | undefined;
    const json = JSON.stringify(decision);
    if (prior) {
      const existing = JSON.parse(prior.decision_json) as DecisionRecord;
      const existingCore = { ...existing };
      delete existingCore.currentSnapshotId;
      delete existingCore.currentContextRevisionId;
      if (canonical(existingCore) !== canonical(decision)) conflict();
      return existing;
    }
    if (decision.proposalId!==undefined) this.proposalBaseline(decision.workspaceId,
      decision.collaborationId,decision.proposalId,decision.snapshotId,decision.contextRevisionId);
    else this.bundleBaseline(decision.workspaceId, decision.collaborationId, decision.bundleId!,
      decision.bundleManifestHash!, decision.snapshotId, decision.contextRevisionId);
    if (decision.proposalId===undefined &&
        decision.items?.some((item) => item.sourceRef.startsWith('file:'))) {
      const row = this.db.prepare(`SELECT manifest_json FROM bundles WHERE id=? AND workspace_id=? AND collaboration_id=?`)
        .get(decision.bundleId, decision.workspaceId, decision.collaborationId) as { manifest_json: string };
      const manifest = JSON.parse(row.manifest_json) as BundleManifest;
      const paths = new Set(manifest.files.map((file) => file.normalizedRelativePath));
      if (decision.items.some((item) => item.sourceRef.startsWith('file:') && !paths.has(item.sourceRef.slice(5)))) unavailable();
    }
    if (decision.outcome === 'reject') {
      this.db.prepare('INSERT INTO decisions VALUES (?,?,?,?)')
        .run(decision.id, decision.workspaceId, decision.collaborationId, json);
      return decision;
    }
    if (!decision.reviewId) throw new Error('BASELINE_REVIEW_REQUIRED');
    const row = this.db.prepare(`SELECT review_json FROM baseline_reviews WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(decision.reviewId, decision.workspaceId, decision.collaborationId) as { review_json: string } | undefined;
    if (!row) throw new Error('BASELINE_REVIEW_REQUIRED');
    const review = JSON.parse(row.review_json) as BaselineReview;
    if (review.proposalId !== decision.proposalId || review.bundleId !== decision.bundleId ||
        review.bundleManifestHash !== decision.bundleManifestHash ||
        review.snapshotId !== decision.snapshotId || review.contextRevisionId !== decision.contextRevisionId)
      unavailable();
    const current = this.getCurrentRevision(decision.workspaceId, decision.collaborationId);
    if (!current || current.id !== review.currentContextRevisionId || current.snapshotId !== review.currentSnapshotId ||
        !this.snapshotExists(decision.workspaceId, decision.collaborationId, current.snapshotId)) {
      throw new Error('BASELINE_MISMATCH');
    }
    const recorded = { ...decision, currentSnapshotId: current.snapshotId, currentContextRevisionId: current.id };
    this.db.prepare('INSERT INTO decisions VALUES (?,?,?,?)')
      .run(decision.id, decision.workspaceId, decision.collaborationId, JSON.stringify(recorded));
    return recorded;
  }

  insertDecisionProposal(proposal: DecisionProposal, permit: Permit): DecisionProposal {
    const input={id:proposal.id,workspaceId:proposal.workspaceId,
      collaborationId:proposal.collaborationId,contextRevisionId:proposal.contextRevisionId,
      snapshotId:proposal.snapshotId,recommendation:proposal.recommendation,reason:proposal.reason,
      ...(proposal.bundleId===undefined?{}:{bundleId:proposal.bundleId}),
      ...(proposal.bundleManifestHash===undefined?{}:{bundleManifestHash:proposal.bundleManifestHash}),
      proposedBy:proposal.proposedBy};
    if (canonical(proposeDecision(input, permit)) !== canonical(proposal) ||
        !this.collaborationExists(proposal.workspaceId, proposal.collaborationId)) unavailable();
    const prior = this.db.prepare('SELECT proposal_json FROM decision_proposals WHERE id=?')
      .get(proposal.id) as { proposal_json: string } | undefined;
    const json = JSON.stringify(proposal);
    if (prior) {
      if (canonical(JSON.parse(prior.proposal_json)) !== canonical(proposal)) conflict();
      return JSON.parse(prior.proposal_json) as DecisionProposal;
    }
    const revision = this.getRevision(proposal.workspaceId, proposal.collaborationId,
      proposal.contextRevisionId);
    if (!revision || revision.snapshotId !== proposal.snapshotId ||
        !this.snapshotExists(proposal.workspaceId, proposal.collaborationId, proposal.snapshotId)) unavailable();
    if (proposal.bundleId !== undefined) this.bundleBaseline(proposal.workspaceId,
      proposal.collaborationId, proposal.bundleId, proposal.bundleManifestHash!,
      proposal.snapshotId, proposal.contextRevisionId);
    this.db.prepare('INSERT INTO decision_proposals VALUES (?,?,?,?)')
      .run(proposal.id, proposal.workspaceId, proposal.collaborationId, json);
    return proposal;
  }

  getDecisionProposal(workspaceId: string, collaborationId: string, id: string): DecisionProposal | null {
    const row = this.db.prepare(`SELECT proposal_json FROM decision_proposals
      WHERE id=? AND workspace_id=? AND collaboration_id=?`).get(id,workspaceId,collaborationId) as
      { proposal_json: string } | undefined;
    return row ? JSON.parse(row.proposal_json) as DecisionProposal : null;
  }

  decisionProposalHighWater(workspaceId: string, collaborationId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS high_water FROM decision_proposals
      WHERE workspace_id=? AND collaboration_id=?`).get(workspaceId,collaborationId) as { high_water: number };
    return row.high_water;
  }

  listDecisionProposals(workspaceId: string, collaborationId: string, afterSeq: number,
    highWater: number, limit: number): { proposalSeq: number; proposal: DecisionProposal }[] {
    const rows = this.db.prepare(`SELECT rowid AS proposal_seq,proposal_json FROM decision_proposals
      WHERE workspace_id=? AND collaboration_id=? AND rowid>? AND rowid<=?
      ORDER BY rowid ASC LIMIT ?`).all(workspaceId,collaborationId,afterSeq,highWater,limit) as
      { proposal_seq: number; proposal_json: string }[];
    return rows.map(row => ({ proposalSeq: row.proposal_seq,
      proposal: JSON.parse(row.proposal_json) as DecisionProposal }));
  }

  getDecision(workspaceId: string, collaborationId: string, id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT decision_json FROM decisions WHERE id=? AND workspace_id=? AND collaboration_id=?')
      .get(id, workspaceId, collaborationId) as { decision_json: string } | undefined;
    return row ? JSON.parse(row.decision_json) as DecisionRecord : null;
  }

  decisionHighWater(workspaceId: string, collaborationId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS high_water FROM decisions
      WHERE workspace_id=? AND collaboration_id=?`).get(workspaceId, collaborationId) as { high_water: number };
    return row.high_water;
  }

  listDecisions(workspaceId: string, collaborationId: string, afterSeq: number,
    highWater: number, limit: number): { decisionSeq: number; decision: DecisionRecord }[] {
    const rows = this.db.prepare(`SELECT rowid AS decision_seq,decision_json FROM decisions
      WHERE workspace_id=? AND collaboration_id=? AND rowid>? AND rowid<=?
      ORDER BY rowid ASC LIMIT ?`).all(workspaceId, collaborationId, afterSeq, highWater, limit) as
      { decision_seq: number; decision_json: string }[];
    return rows.map((row) => ({ decisionSeq: row.decision_seq,
      decision: JSON.parse(row.decision_json) as DecisionRecord }));
  }

  close(): void { this.db.close(); }
}

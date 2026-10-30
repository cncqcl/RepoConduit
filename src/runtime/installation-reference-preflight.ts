import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RepositorySnapshot, type PersistedSnapshot } from '../adapters/repository/snapshots.js';
import { inspectHostConversationDatabase } from '../adapters/storage/host-conversation-sqlite.js';
import { inspectBrowserCaptureDatabase } from '../adapters/storage/browser-capture-sqlite.js';
import { assertSnapshotCapacityHeader, boundedReferenceRows, createReferenceBudget,
  type ReferenceBudget, type ReferenceLimits } from '../adapters/storage/reference-budget.js';

type Value = Record<string, unknown>;
type Row = Record<string, unknown>;
type SnapshotMetadata = { id: string; workingCopyId: string; baseCommit: string; sourceConsistency: string;
  files: Map<string, { sizeBytes: number; sha256: string }>; canonicalDigest: string };

function unsafe(reason: 'scope' | 'state' | 'limit' | 'storage'): never {
  throw new Error('INSTALLATION_REFERENCES_UNSAFE', { cause: Object.freeze({
    component: 'installation_reference_preflight', reason,
  }) });
}
function obj(value: unknown): Value {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsafe('state');
  return value as Value;
}
function str(value: unknown): string {
  if (typeof value !== 'string' || !value) unsafe('state');
  return value;
}
function json(value: unknown): Value {
  try { return obj(JSON.parse(str(value)) as unknown); } catch { return unsafe('state'); }
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) unsafe('state');
  return value as string[];
}
function scoped(workspace: unknown, collaboration: unknown, id: unknown): string {
  return JSON.stringify([str(workspace), str(collaboration), str(id)]);
}
function scopeMatches(row: Row, value: Value): void {
  if (row.id !== value.id || row.workspace_id !== value.workspaceId ||
      row.collaboration_id !== value.collaborationId) unsafe('scope');
}

/** Count bytes in SQLite before reading any unbounded TEXT field into JS. */
function boundedRows(db: DatabaseSync, table: string, columns: readonly string[], budget: ReferenceBudget): Iterable<Row> {
  try { return boundedReferenceRows(db, table, columns, budget); }
  catch (error) { if (error instanceof Error && error.message === 'REFERENCE_CAPACITY_EXCEEDED') unsafe('limit'); throw error; }
}

function validatedSnapshot(value: Value, limits: ReferenceLimits): SnapshotMetadata {
  let snapshot: RepositorySnapshot;
  try {
    assertSnapshotCapacityHeader(value as PersistedSnapshot, limits);
    snapshot = RepositorySnapshot.fromPersisted(value as PersistedSnapshot);
  } catch { unsafe('state'); }
  return { id: snapshot.id, workingCopyId: snapshot.workingCopyId, baseCommit: snapshot.baseCommit,
    sourceConsistency: snapshot.sourceConsistency,
    files: new Map(snapshot.manifest.map(file => [file.path, { sizeBytes: file.sizeBytes, sha256: file.sha256 }])),
    canonicalDigest: createHash('sha256').update(JSON.stringify(snapshot.toPersisted())).digest('hex') };
}

/** Pure database reference check. The caller opens and closes a private read-only database. */
export function inspectInstallationReferenceDatabase(db: DatabaseSync, limits: Partial<ReferenceLimits> = {}): void {
  try {
    inspectHostConversationDatabase(db);
    if (db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get()) unsafe('scope');
    const budget = createReferenceBudget(limits);
    const workspaces = new Set([...boundedRows(db, 'workspaces', ['id'], budget)].map(row => str(row.id)));
    const collaborations = new Map<string, string>();
    const collaborationActors = new Map<string, string>();
    for (const row of boundedRows(db, 'collaborations', ['id', 'workspace_id', 'opened_by'], budget)) {
      if (!workspaces.has(str(row.workspace_id))) unsafe('scope');
      collaborations.set(str(row.id), str(row.workspace_id));
      collaborationActors.set(str(row.id), str(row.opened_by));
    }
    const copies = new Map<string, string>();
    for (const row of boundedRows(db, 'working_copies', ['id', 'workspace_id'], budget)) {
      if (!workspaces.has(str(row.workspace_id))) unsafe('scope');
      copies.set(str(row.id), str(row.workspace_id));
    }
    const snapshots = new Map<string, SnapshotMetadata>();
    for (const row of boundedRows(db, 'snapshots',
      ['id', 'workspace_id', 'collaboration_id', 'working_copy_id', 'snapshot_json'], budget)) {
      if (collaborations.get(str(row.collaboration_id)) !== row.workspace_id ||
          copies.get(str(row.working_copy_id)) !== row.workspace_id) unsafe('scope');
      const persisted = json(row.snapshot_json);
      if (persisted.id !== row.id || persisted.workingCopyId !== row.working_copy_id) unsafe('scope');
      const snapshot = validatedSnapshot(persisted, budget.limits);
      if (snapshot.id !== row.id || snapshot.workingCopyId !== row.working_copy_id) unsafe('state');
      snapshots.set(scoped(row.workspace_id, row.collaboration_id, row.id),
        snapshot);
    }
    const hasSnapshot = (workspace: unknown, collaboration: unknown, id: unknown) =>
      snapshots.has(scoped(workspace, collaboration, id));
    const materials = new Map<string, Value>();
    const materialSnapshotDigests = new Map<string, string>();
    const materialTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_project_materials','daily_project_material_heads')")
      .all() as { name: string }[];
    if (materialTables.length !== 0 && materialTables.length !== 2) unsafe('storage');
    if (materialTables.length) {
      for (const row of boundedRows(db, 'daily_project_materials', ['id', 'workspace_id', 'material_json'], budget)) {
        const value = json(row.material_json); const source = obj(value.sourceContext);
        const frozenValue = obj(value.snapshot);
        if (value.id !== row.id || value.workspaceId !== row.workspace_id || !workspaces.has(str(row.workspace_id)) ||
            collaborations.get(str(value.sourceCollaborationId)) !== row.workspace_id || source.workspaceId !== row.workspace_id ||
            source.collaborationId !== value.sourceCollaborationId || source.snapshotId !== value.sourceSnapshotId ||
            source.acceptedBy !== value.preparedBy || source.inheritedFrom !== undefined) unsafe('scope');
        str(value.principal); str(value.audience); str(value.recipient); str(value.preparedBy);
        const original = snapshots.get(scoped(value.workspaceId, value.sourceCollaborationId, value.sourceSnapshotId));
        if (!original) unsafe('scope');
        const frozen = validatedSnapshot(frozenValue, budget.limits);
        const paths = strings(value.dataPaths);
        if (new Set(paths).size !== paths.length || paths.length !== frozen.files.size ||
            frozen.workingCopyId !== original.workingCopyId || frozen.baseCommit !== original.baseCommit ||
            frozen.sourceConsistency !== original.sourceConsistency || [...frozen.files].some(([path, file]) =>
              !paths.includes(path) || original.files.get(path)?.sha256 !== file.sha256 || original.files.get(path)?.sizeBytes !== file.sizeBytes)) unsafe('scope');
        materialSnapshotDigests.set(str(value.id), createHash('sha256').update(JSON.stringify(frozenValue)).digest('hex'));
        // Keep only verified metadata. No snapshot objects, Base64 payloads or decoded buffers survive this row.
        delete frozenValue.files;
        materials.set(str(value.id), value);
      }
      for (const row of boundedRows(db, 'daily_project_material_heads',
        ['workspace_id', 'principal', 'audience', 'recipient', 'material_id'], budget)) {
        const material = materials.get(str(row.material_id));
        if (!material || material.workspaceId !== row.workspace_id || material.principal !== row.principal ||
            material.audience !== row.audience || material.recipient !== row.recipient) unsafe('scope');
      }
    }
    const proposals = new Map<string, Value>();
    for (const row of boundedRows(db, 'context_proposals',
      ['id', 'workspace_id', 'collaboration_id', 'proposal_json'], budget)) {
      const value = json(row.proposal_json);
      scopeMatches(row, value);
      if (value.kind !== 'proposal' || collaborations.get(str(row.collaboration_id)) !== row.workspace_id ||
          !hasSnapshot(row.workspace_id, row.collaboration_id, value.snapshotId) ||
          !Array.isArray(value.sourceRefs) || value.sourceRefs.some(ref => typeof ref !== 'string') ||
          !value.content || typeof value.content !== 'object') unsafe('scope');
      proposals.set(scoped(row.workspace_id, row.collaboration_id, row.id), value);
    }
    const revisions = new Map<string, Value>();
    for (const row of boundedRows(db, 'context_revisions',
      ['id', 'workspace_id', 'collaboration_id', 'revision_json'], budget)) {
      const value = json(row.revision_json);
      scopeMatches(row, value);
      const parentProposal = proposals.get(scoped(row.workspace_id, row.collaboration_id, value.sourceProposalId));
      if (value.kind !== 'revision' || collaborations.get(str(row.collaboration_id)) !== row.workspace_id ||
          !hasSnapshot(row.workspace_id, row.collaboration_id, value.snapshotId)) unsafe('scope');
      if (value.inheritedFrom === undefined && (!parentProposal || parentProposal.snapshotId !== value.snapshotId ||
          parentProposal.parentRevisionId !== value.parentRevisionId ||
          JSON.stringify(parentProposal.content) !== JSON.stringify(value.content) ||
          JSON.stringify(parentProposal.sourceRefs) !== JSON.stringify(value.sourceRefs))) unsafe('scope');
      revisions.set(scoped(row.workspace_id, row.collaboration_id, row.id), value);
    }
    for (const material of materials.values()) {
      const source = obj(material.sourceContext);
      if (JSON.stringify(revisions.get(scoped(material.workspaceId, material.sourceCollaborationId, source.id))) !==
          JSON.stringify(source)) unsafe('scope');
    }
    for (const revision of revisions.values()) {
      if (revision.parentRevisionId !== null && !revisions.has(scoped(revision.workspaceId,
        revision.collaborationId, revision.parentRevisionId))) unsafe('scope');
      if (revision.inheritedFrom !== undefined) {
        const origin = obj(revision.inheritedFrom); const question = obj(origin.requestedQuestion);
        const fields = ['sourceWorkspaceId', 'sourceCollaborationId', 'sourceRevisionId', 'sourceSnapshotId', 'materialId', 'requestedQuestion'];
        if (Object.keys(origin).length !== fields.length || Object.keys(origin).some(key => !fields.includes(key)) ||
            Object.keys(question).length !== 3 || Object.keys(question).some(key => !['text', 'proposedBy', 'status'].includes(key))) unsafe('scope');
        const material = materials.get(str(origin.materialId));
        const source = revisions.get(scoped(origin.sourceWorkspaceId, origin.sourceCollaborationId, origin.sourceRevisionId));
        const targetSnapshot = snapshots.get(scoped(revision.workspaceId, revision.collaborationId, revision.snapshotId));
        if (!material || !source || source.inheritedFrom !== undefined || origin.sourceWorkspaceId !== revision.workspaceId ||
            origin.sourceCollaborationId === revision.collaborationId || material.workspaceId !== revision.workspaceId ||
            material.sourceCollaborationId !== origin.sourceCollaborationId || material.sourceSnapshotId !== origin.sourceSnapshotId ||
            source.snapshotId !== origin.sourceSnapshotId || source.id !== obj(material.sourceContext).id ||
            revision.snapshotId !== obj(material.snapshot).id || revision.acceptedBy !== source.acceptedBy ||
            revision.sourceProposalId !== source.sourceProposalId || revision.parentRevisionId !== null ||
            JSON.stringify(revision.content) !== JSON.stringify(source.content) || JSON.stringify(revision.sourceRefs) !== JSON.stringify(source.sourceRefs) ||
            question.status !== 'unaccepted' || Buffer.byteLength(str(question.text), 'utf8') > 16384 || question.proposedBy !== material.principal ||
            collaborationActors.get(str(revision.collaborationId)) !== material.principal || !targetSnapshot ||
            targetSnapshot.canonicalDigest !== materialSnapshotDigests.get(str(material.id))) unsafe('scope');
      }
    }
    for (const row of boundedRows(db, 'context_heads',
      ['workspace_id', 'collaboration_id', 'revision_id'], budget)) {
      if (collaborations.get(str(row.collaboration_id)) !== row.workspace_id ||
          !revisions.has(scoped(row.workspace_id, row.collaboration_id, row.revision_id))) unsafe('scope');
    }
    const bundles = new Map<string, { input: Value; manifest: Value | null; hash: string | null; parentId: string | null }>();
    for (const row of boundedRows(db, 'bundles',
      ['id', 'workspace_id', 'collaboration_id', 'parent_id', 'input_json', 'manifest_json'], budget)) {
      const input = json(row.input_json);
      if (input.bundleId !== row.id || input.workspaceId !== row.workspace_id ||
          input.collaborationId !== row.collaboration_id || (input.parentBundleId ?? null) !== row.parent_id ||
          collaborations.get(str(row.collaboration_id)) !== row.workspace_id) unsafe('scope');
      const revision = revisions.get(scoped(row.workspace_id, row.collaboration_id, input.contextRevision));
      const refs = strings(input.snapshotRefs);
      if (!revision || !refs.includes(str(revision.snapshotId)) ||
          refs.some(ref => !hasSnapshot(row.workspace_id, row.collaboration_id, ref))) unsafe('scope');
      const manifestText = row.manifest_json;
      const manifest = manifestText === null ? null : json(manifestText);
      if (manifest && (manifest.bundleId !== row.id || manifest.workspaceId !== row.workspace_id ||
          manifest.collaborationId !== row.collaboration_id ||
          manifest.contextRevision !== input.contextRevision ||
          (manifest.parentBundleId ?? null) !== row.parent_id ||
          JSON.stringify(manifest.snapshotRefs) !== JSON.stringify(refs))) unsafe('scope');
      bundles.set(str(row.id), { input, manifest, hash: manifestText === null ? null :
        createHash('sha256').update(str(manifestText)).digest('hex'), parentId: row.parent_id as string | null });
    }
    for (const bundle of bundles.values()) {
      if (bundle.parentId !== null) {
        const parent = bundles.get(bundle.parentId);
        if (!parent?.manifest || parent.input.workspaceId !== bundle.input.workspaceId ||
            parent.input.collaborationId !== bundle.input.collaborationId) unsafe('scope');
      }
    }
    for (const capture of inspectBrowserCaptureDatabase(db)) {
      const input = capture.input;
      const bundle = bundles.get(input.bundleId);
      if (capture.state !== 'verified_candidate' && capture.state !== 'aborted_before_capture') unsafe('state');
      if (!workspaces.has(input.workspaceId) || collaborations.get(input.collaborationId) !== input.workspaceId ||
          !bundle || bundle.input.workspaceId !== input.workspaceId ||
          bundle.input.collaborationId !== input.collaborationId) unsafe('scope');
      const account = db.prepare('SELECT provider_id FROM host_conversation_accounts WHERE account_id=?')
        .get(input.accountKey) as { provider_id: string } | undefined;
      if (account?.provider_id !== 'chatgpt-host-web') unsafe('scope');
      const grant = db.prepare(`SELECT principal,audience,workspace_id,collaboration_id,recipient FROM grants WHERE id=?`)
        .get(input.grantId) as Row | undefined;
      // A revoked historical grant may remain in a backup, but its original authority scope cannot change.
      if (!grant || grant.principal !== input.principal || grant.audience !== input.audience ||
          grant.workspace_id !== input.workspaceId ||
          (grant.collaboration_id !== null && grant.collaboration_id !== input.collaborationId) ||
          (grant.recipient !== null && grant.recipient !== input.recipient)) unsafe('scope');
    }
    const contextRefs = boundedRows(db, 'bundle_context_refs',
      ['bundle_id', 'workspace_id', 'collaboration_id', 'revision_id'], budget);
    const snapshotRefs = boundedRows(db, 'bundle_snapshot_refs',
      ['bundle_id', 'workspace_id', 'collaboration_id', 'snapshot_id'], budget);
    const contextByBundle = new Map<string, Row>();
    const snapshotsByBundle = new Map<string, Set<string>>();
    for (const row of contextRefs) {
      const bundle = bundles.get(str(row.bundle_id));
      if (!bundle || bundle.input.workspaceId !== row.workspace_id ||
          bundle.input.collaborationId !== row.collaboration_id ||
          bundle.input.contextRevision !== row.revision_id || contextByBundle.has(str(row.bundle_id))) unsafe('scope');
      contextByBundle.set(str(row.bundle_id), row);
    }
    for (const row of snapshotRefs) {
      const bundle = bundles.get(str(row.bundle_id));
      if (!bundle || bundle.input.workspaceId !== row.workspace_id ||
          bundle.input.collaborationId !== row.collaboration_id ||
          !hasSnapshot(row.workspace_id, row.collaboration_id, row.snapshot_id)) unsafe('scope');
      const found = snapshotsByBundle.get(str(row.bundle_id)) ?? new Set<string>();
      if (found.has(str(row.snapshot_id))) unsafe('scope');
      found.add(str(row.snapshot_id));
      snapshotsByBundle.set(str(row.bundle_id), found);
    }
    for (const [id, bundle] of bundles) {
      const refs = strings(bundle.input.snapshotRefs);
      const uniqueRefs = new Set(refs);
      const stored = snapshotsByBundle.get(id) ?? new Set<string>();
      if (!contextByBundle.has(id) || stored.size !== uniqueRefs.size ||
          [...uniqueRefs].some(ref => !stored.has(ref))) unsafe('scope');
    }
    const bundleBaseline = (target: Value): void => {
      const bundle = bundles.get(str(target.bundleId));
      if (!bundle?.manifest || bundle.hash !== target.bundleManifestHash ||
          bundle.input.workspaceId !== target.workspaceId || bundle.input.collaborationId !== target.collaborationId ||
          bundle.input.contextRevision !== target.contextRevisionId ||
          !strings(bundle.input.snapshotRefs).includes(str(target.snapshotId))) unsafe('scope');
    };
    const revisionBaseline = (value: Value): void => {
      const revision = revisions.get(scoped(value.workspaceId, value.collaborationId, value.contextRevisionId));
      if (!revision || revision.snapshotId !== value.snapshotId ||
          !hasSnapshot(value.workspaceId, value.collaborationId, value.snapshotId)) unsafe('scope');
    };
    const decisionProposals = new Map<string, Value>();
    for (const row of boundedRows(db, 'decision_proposals',
      ['id', 'workspace_id', 'collaboration_id', 'proposal_json'], budget)) {
      const value = json(row.proposal_json);
      scopeMatches(row, value);
      if (value.kind !== 'decision_proposal' || value.implementationAuthorized !== false ||
          (value.bundleId === undefined) !== (value.bundleManifestHash === undefined)) unsafe('state');
      revisionBaseline(value);
      if (value.bundleId !== undefined) bundleBaseline(value);
      decisionProposals.set(scoped(row.workspace_id, row.collaboration_id, row.id), value);
    }
    const target = (value: Value): void => {
      const byProposal = value.proposalId !== undefined;
      if (byProposal === (value.bundleId !== undefined || value.bundleManifestHash !== undefined)) unsafe('state');
      if (byProposal) {
        const proposal = decisionProposals.get(scoped(value.workspaceId, value.collaborationId, value.proposalId));
        if (!proposal || proposal.snapshotId !== value.snapshotId ||
            proposal.contextRevisionId !== value.contextRevisionId) unsafe('scope');
      } else bundleBaseline(value);
    };
    const reviews = new Map<string, Value>();
    for (const row of boundedRows(db, 'baseline_reviews',
      ['id', 'workspace_id', 'collaboration_id', 'review_json'], budget)) {
      const value = json(row.review_json);
      scopeMatches(row, value);
      revisionBaseline(value);
      target(value);
      const current = revisions.get(scoped(value.workspaceId, value.collaborationId, value.currentContextRevisionId));
      if (!current || current.snapshotId !== value.currentSnapshotId ||
          !hasSnapshot(value.workspaceId, value.collaborationId, value.currentSnapshotId) ||
          snapshots.get(scoped(value.workspaceId, value.collaborationId, value.snapshotId))?.workingCopyId !==
          snapshots.get(scoped(value.workspaceId, value.collaborationId, value.currentSnapshotId))?.workingCopyId)
        unsafe('scope');
      reviews.set(scoped(row.workspace_id, row.collaboration_id, row.id), value);
    }
    for (const row of boundedRows(db, 'decisions',
      ['id', 'workspace_id', 'collaboration_id', 'decision_json'], budget)) {
      const value = json(row.decision_json);
      scopeMatches(row, value);
      if (value.implementationAuthorized !== false ||
          !['accept', 'modify', 'reject'].includes(String(value.outcome))) unsafe('state');
      revisionBaseline(value);
      target(value);
      if (value.outcome !== 'reject') {
        const review = reviews.get(scoped(value.workspaceId, value.collaborationId, value.reviewId));
        if (!review || review.snapshotId !== value.snapshotId || review.contextRevisionId !== value.contextRevisionId ||
            review.proposalId !== value.proposalId || review.bundleId !== value.bundleId ||
            review.bundleManifestHash !== value.bundleManifestHash ||
            review.currentSnapshotId !== value.currentSnapshotId ||
            review.currentContextRevisionId !== value.currentContextRevisionId) unsafe('scope');
      }
      if (value.items !== undefined) {
        if (!Array.isArray(value.items)) unsafe('state');
        const bundle = value.bundleId === undefined ? null : bundles.get(str(value.bundleId));
        const paths = new Set((bundle?.manifest?.files as { normalizedRelativePath: string }[] | undefined ?? [])
          .map(file => file.normalizedRelativePath));
        for (const item of value.items as Value[]) {
          const source = str(obj(item).sourceRef);
          if (value.proposalId !== undefined ? source !== `proposal:${value.proposalId}` :
            source !== `bundle:${value.bundleId}` &&
            !(source.startsWith('file:') && paths.has(source.slice(5)))) unsafe('scope');
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'INSTALLATION_REFERENCES_UNSAFE') throw error;
    return unsafe('storage');
  }
}

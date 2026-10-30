import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { authorize, isDataPathPermitted, PolicyError, type Grant, type RequestContext } from '../../core/policy/authorize.js';
import { RepositorySnapshot, type PersistedSnapshot } from '../repository/snapshots.js';
import { inheritContext, type ContextRevision } from '../../core/collaboration/context.js';
import { openCollaboration } from '../../core/collaboration/identity.js';
import { parseWorkspaceId } from '../../core/identity/index.js';
import { assertReferenceCapacity, createReferenceBudget, type ReferenceLimits } from './reference-budget.js';
import type { CaptureInput, SnapshotReceipt, SnapshotRecord } from '../../application/repository.js';
import type { ArtifactRecord, IntegrityStatus } from '../../application/artifacts.js';
import type { BundleInput, BundleManifest, DeliveryState } from '../../core/artifact/types.js';
import { parseProfileConfiguration, type ProfileConfiguration, type ProfileRevision }
  from '../../core/investigation/trusted-profile.js';

export interface IdempotencyScope {
  principal: string;
  audience: string;
  workspaceId: string;
  operation: string;
  idempotencyKey: string;
}

export class StoreConflict extends Error {
  readonly code = 'CONFLICT';
  constructor() { super('Idempotency key was used with different input'); }
}

export class ProfileRevisionConflict extends Error {
  readonly code = 'CONFLICT';
  constructor() { super('Profile revision changed'); }
}

export interface StoredWorkspace {
  id: string;
  name: string;
  canonicalRoot: string;
  registeredBy: string;
}

export interface StoredCollaboration {
  id: string;
  workspaceId: string;
  openedBy: string;
  purpose: string;
  hostThreadId: string | null;
  state: 'open' | 'paused' | 'archived';
}

export interface StoredWorkingCopy { id: string; workspaceId: string; canonicalRoot: string }

export interface ProjectMaterial {
  id: string; workspaceId: string; sourceCollaborationId: string; sourceSnapshotId: string;
  principal: string; audience: string; recipient: string; preparedBy: string;
  dataPaths: string[]; snapshot: PersistedSnapshot; sourceContext: ContextRevision;
}

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

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(file: string, private readonly referenceLimits: Partial<ReferenceLimits> = {}) {
    createReferenceBudget(referenceLimits);
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
    this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        canonical_root TEXT NOT NULL UNIQUE,
        registered_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaborations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        opened_by TEXT NOT NULL,
        purpose TEXT NOT NULL,
        host_thread_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('open','paused','archived'))
      );
      CREATE INDEX IF NOT EXISTS collaborations_workspace ON collaborations(workspace_id);
      CREATE TABLE IF NOT EXISTS working_copies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        canonical_root TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id),
        working_copy_id TEXT NOT NULL REFERENCES working_copies(id),
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (id,workspace_id,collaboration_id)
      );
      CREATE TABLE IF NOT EXISTS context_revisions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id), revision_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS context_revisions_scoped
        ON context_revisions(id,workspace_id,collaboration_id);
      CREATE TABLE IF NOT EXISTS bundles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id),
        parent_id TEXT REFERENCES bundles(id),
        input_json TEXT NOT NULL,
        manifest_json TEXT,
        published_seq INTEGER,
        integrity_status TEXT CHECK (integrity_status IN ('ok','missing','corrupt')),
        aborted_state_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bundles_scoped ON bundles(id,workspace_id,collaboration_id);
      CREATE TABLE IF NOT EXISTS bundle_cursor_secret (
        id INTEGER PRIMARY KEY CHECK (id=1), secret BLOB NOT NULL CHECK (length(secret)=32)
      );
      CREATE TABLE IF NOT EXISTS bundle_context_refs (
        bundle_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        FOREIGN KEY (bundle_id,workspace_id,collaboration_id)
          REFERENCES bundles(id,workspace_id,collaboration_id) ON DELETE RESTRICT,
        FOREIGN KEY (revision_id,workspace_id,collaboration_id)
          REFERENCES context_revisions(id,workspace_id,collaboration_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS bundle_snapshot_refs (
        bundle_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        PRIMARY KEY (bundle_id,snapshot_id),
        FOREIGN KEY (bundle_id,workspace_id,collaboration_id)
          REFERENCES bundles(id,workspace_id,collaboration_id) ON DELETE RESTRICT,
        FOREIGN KEY (snapshot_id,workspace_id,collaboration_id)
          REFERENCES snapshots(id,workspace_id,collaboration_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS bundle_files (
        bundle_id TEXT NOT NULL REFERENCES bundles(id),
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        source_receipt TEXT NOT NULL,
        source_identity TEXT,
        PRIMARY KEY (bundle_id,path)
      );
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        audience TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT,
        recipient TEXT,
        permissions_json TEXT NOT NULL,
        data_paths_json TEXT,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS grants_subject ON grants(principal,audience,workspace_id);
      CREATE TABLE IF NOT EXISTS permission_epochs (
        principal TEXT NOT NULL,
        audience TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (principal,audience,workspace_id)
      );
      CREATE TABLE IF NOT EXISTS profile_revisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        previous_revision_id TEXT,
        revision_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profile_revisions_workspace ON profile_revisions(workspace_id);
      CREATE TABLE IF NOT EXISTS profile_heads (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
        revision_id TEXT NOT NULL REFERENCES profile_revisions(id)
      );
      CREATE TABLE IF NOT EXISTS idempotency_records (
        principal TEXT NOT NULL,
        audience TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (principal, audience, workspace_id, operation, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS daily_project_materials (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        material_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_project_material_heads (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal TEXT NOT NULL,
        audience TEXT NOT NULL, recipient TEXT NOT NULL,
        material_id TEXT NOT NULL REFERENCES daily_project_materials(id),
        PRIMARY KEY (workspace_id,principal,audience,recipient)
      );
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const bundleColumns = this.db.prepare('PRAGMA table_info(bundles)').all() as { name: string }[];
      if (!bundleColumns.some((column) => column.name === 'aborted_state_json')) {
        this.db.exec('ALTER TABLE bundles ADD COLUMN aborted_state_json TEXT');
      }
      if (!bundleColumns.some((column) => column.name === 'published_seq')) {
        this.db.exec('ALTER TABLE bundles ADD COLUMN published_seq INTEGER');
      }
      const unsequenced = this.db.prepare(`SELECT id FROM bundles WHERE manifest_json IS NOT NULL
        AND published_seq IS NULL ORDER BY rowid`).all() as { id: string }[];
      let nextSequence = (this.db.prepare('SELECT COALESCE(MAX(published_seq),0) AS max_seq FROM bundles')
        .get() as { max_seq: number }).max_seq;
      const assignSequence = this.db.prepare('UPDATE bundles SET published_seq=? WHERE id=?');
      for (const row of unsequenced) assignSequence.run(++nextSequence, row.id);
      if (this.db.prepare(`SELECT 1 FROM bundles WHERE (manifest_json IS NULL) != (published_seq IS NULL)`).get()) {
        throw new Error('NOT_AVAILABLE');
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bundles_published_seq ON bundles(published_seq)');
      this.db.exec(`CREATE INDEX IF NOT EXISTS bundles_scope_publication
        ON bundles(workspace_id,collaboration_id,published_seq)`);
      this.db.prepare('INSERT OR IGNORE INTO bundle_cursor_secret(id,secret) VALUES (1,?)').run(randomBytes(32));
      const fileColumns = this.db.prepare('PRAGMA table_info(bundle_files)').all() as { name: string }[];
      if (!fileColumns.some((column) => column.name === 'source_identity')) {
        this.db.exec('ALTER TABLE bundle_files ADD COLUMN source_identity TEXT');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'SQLite constructor rollback failed',
        { cause: rollbackError }); }
      throw error;
    }
    const grantColumns = this.db.prepare('PRAGMA table_info(grants)').all() as { name: string }[];
    if (!grantColumns.some((column) => column.name === 'data_paths_json')) {
      this.db.exec('ALTER TABLE grants ADD COLUMN data_paths_json TEXT');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT id,workspace_id,collaboration_id,input_json FROM bundles').all() as
        { id: string; workspace_id: string; collaboration_id: string; input_json: string }[];
      const insertContext = this.db.prepare(`INSERT OR IGNORE INTO bundle_context_refs
        (bundle_id,workspace_id,collaboration_id,revision_id) VALUES (?,?,?,?)`);
      const insertSnapshot = this.db.prepare(`INSERT OR IGNORE INTO bundle_snapshot_refs
        (bundle_id,workspace_id,collaboration_id,snapshot_id) VALUES (?,?,?,?)`);
      for (const row of rows) {
        let input: BundleInput;
        try { input = JSON.parse(row.input_json) as BundleInput; }
        catch { throw new Error('NOT_AVAILABLE'); }
        if (input.bundleId !== row.id || input.workspaceId !== row.workspace_id ||
            input.collaborationId !== row.collaboration_id) throw new Error('NOT_AVAILABLE');
        this.validateBundleReferences(input);
        insertContext.run(row.id, row.workspace_id, row.collaboration_id, input.contextRevision);
        for (const snapshotId of input.snapshotRefs) {
          insertSnapshot.run(row.id, row.workspace_id, row.collaboration_id, snapshotId);
        }
        const contextLink = this.db.prepare(`SELECT workspace_id,collaboration_id,revision_id
          FROM bundle_context_refs WHERE bundle_id=?`).get(row.id) as
          { workspace_id: string; collaboration_id: string; revision_id: string } | undefined;
        const snapshotLinks = this.db.prepare(`SELECT workspace_id,collaboration_id,snapshot_id
          FROM bundle_snapshot_refs WHERE bundle_id=?`).all(row.id) as
          { workspace_id: string; collaboration_id: string; snapshot_id: string }[];
        if (contextLink?.workspace_id !== row.workspace_id || contextLink.collaboration_id !== row.collaboration_id ||
            contextLink.revision_id !== input.contextRevision ||
            snapshotLinks.some((link) => link.workspace_id !== row.workspace_id ||
              link.collaboration_id !== row.collaboration_id) ||
            JSON.stringify(snapshotLinks.map((link) => link.snapshot_id).sort()) !==
              JSON.stringify([...new Set(input.snapshotRefs)].sort())) throw new Error('NOT_AVAILABLE');
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('NOT_AVAILABLE');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'SQLite constructor rollback failed',
        { cause: rollbackError }); }
      throw error;
    }
    this.db.exec('PRAGMA busy_timeout=0');
    } catch (error) {
      try { this.db.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'SQLite constructor cleanup uncertain',
        { cause: closeError }); }
      throw error;
    }
  }

  insertWorkspace(workspace: StoredWorkspace): void {
    this.db.prepare('INSERT INTO workspaces(id,name,canonical_root,registered_by) VALUES (?,?,?,?)')
      .run(workspace.id, workspace.name, workspace.canonicalRoot, workspace.registeredBy);
  }

  getCurrentProjectMaterial(workspaceId: string, target: { principal: string; audience: string; recipient: string }): ProjectMaterial | null {
    const row = this.db.prepare(`SELECT m.material_json FROM daily_project_material_heads h JOIN daily_project_materials m ON m.id=h.material_id
      WHERE h.workspace_id=? AND h.principal=? AND h.audience=? AND h.recipient=?`)
      .get(workspaceId, target.principal, target.audience, target.recipient) as { material_json: string } | undefined;
    return row ? JSON.parse(row.material_json) as ProjectMaterial : null;
  }

  private snapshotSync(snapshotId: string, workspaceId: string, collaborationId: string): SnapshotRecord | null {
    const row = this.db.prepare(`SELECT working_copy_id,snapshot_json FROM snapshots WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(snapshotId, workspaceId, collaborationId) as { working_copy_id: string; snapshot_json: string } | undefined;
    return row ? { workspaceId, collaborationId, workingCopyId: row.working_copy_id,
      snapshot: JSON.parse(row.snapshot_json) as PersistedSnapshot } : null;
  }

  /** Called inside the dispatcher's short, authorized SQLite transaction. No live filesystem input. */
  publishProjectMaterial(context: RequestContext, input: { workspaceId: string; sourceCollaborationId: string;
    sourceContextRevisionId: string; dataPaths: string[]; external: { principal: string; audience: string; recipient: string } }): { materialId: string; projectId: string; sourceTopicHandle: string } {
    if (context.surface !== 'local_admin' || context.audience !== 'local-os' || context.recipient !== context.principal ||
        this.getWorkspace(input.workspaceId)?.registeredBy !== context.principal) throw new PolicyError();
    const row = this.db.prepare(`SELECT revision_json FROM context_revisions WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(input.sourceContextRevisionId, input.workspaceId, input.sourceCollaborationId) as { revision_json: string } | undefined;
    if (!row) throw new PolicyError();
    const sourceContext = JSON.parse(row.revision_json) as ContextRevision;
    if (sourceContext.kind !== 'revision' || sourceContext.inheritedFrom || sourceContext.acceptedBy !== context.principal ||
        sourceContext.id !== input.sourceContextRevisionId || sourceContext.workspaceId !== input.workspaceId ||
        sourceContext.collaborationId !== input.sourceCollaborationId) throw new PolicyError();
    const external: RequestContext = { ...input.external, surface: 'external_mcp', now: context.now };
    const sourceScope = { workspaceId: input.workspaceId, collaborationId: input.sourceCollaborationId };
    const externalGrants = this.grantsFor(external.principal, external.audience);
    authorize(external, 'collab.get', sourceScope, externalGrants);
    authorize(external, 'context.read', sourceScope, externalGrants);
    const read = authorize(external, 'repo.read', sourceScope, externalGrants);
    if (JSON.stringify([...read.dataPaths ?? []].sort()) !== JSON.stringify([...input.dataPaths].sort())) throw new PolicyError();
    const record = this.snapshotSync(sourceContext.snapshotId, input.workspaceId, input.sourceCollaborationId);
    if (!record) throw new PolicyError();
    const original = RepositorySnapshot.fromPersisted(record.snapshot);
    if (original.workingCopyId !== record.workingCopyId) throw new PolicyError();
    const manifest = original.manifest.filter(file => isDataPathPermitted(file.path, read.dataPaths ?? []));
    if (!manifest.length) throw new PolicyError();
    const paths = new Set(manifest.map(file => file.path));
    const snapshot = new RepositorySnapshot(original.workingCopyId, original.baseCommit,
      new Map(manifest.map(file => [file.path, original.file(file.path)!])), [...manifest],
      original.exclusions.filter(item => item.path === undefined || paths.has(item.path)), undefined, original.sourceConsistency).toPersisted();
    const id = `material_${createHash('sha256').update(canonical({ workspaceId: input.workspaceId,
      sourceCollaborationId: input.sourceCollaborationId, revisionId: sourceContext.id, snapshotId: snapshot.id, external: input.external })).digest('hex')}`;
    const material: ProjectMaterial = { id, workspaceId: input.workspaceId, sourceCollaborationId: input.sourceCollaborationId,
      sourceSnapshotId: original.id, ...input.external, preparedBy: context.principal,
      dataPaths: [...paths].sort(), snapshot, sourceContext };
    this.db.prepare('INSERT OR IGNORE INTO daily_project_materials(id,workspace_id,material_json) VALUES (?,?,?)')
      .run(id, input.workspaceId, JSON.stringify(material));
    this.db.prepare(`INSERT INTO daily_project_material_heads(workspace_id,principal,audience,recipient,material_id) VALUES (?,?,?,?,?)
      ON CONFLICT(workspace_id,principal,audience,recipient) DO UPDATE SET material_id=excluded.material_id`)
      .run(input.workspaceId, external.principal, external.audience, external.recipient, id);
    return { materialId: id, projectId: input.workspaceId, sourceTopicHandle: input.sourceCollaborationId };
  }

  /** Rechecked before idempotent replay as well as before new topic creation. */
  assertProjectMaterialAuthority(context: RequestContext, workspaceId: string, materialId: string): ProjectMaterial {
    const row = this.db.prepare('SELECT material_json FROM daily_project_materials WHERE id=? AND workspace_id=?')
      .get(materialId, workspaceId) as { material_json: string } | undefined;
    if (!row) throw new PolicyError();
    const material = JSON.parse(row.material_json) as ProjectMaterial;
    if (material.id !== materialId || material.workspaceId !== workspaceId || material.principal !== context.principal ||
        material.audience !== context.audience || material.recipient !== context.recipient) throw new PolicyError();
    const sourceScope = { workspaceId, collaborationId: material.sourceCollaborationId };
    const current = { ...context, now: new Date(context.now) };
    const grants = this.grantsFor(current.principal, current.audience);
    authorize(current, 'collab.get', sourceScope, grants);
    authorize(current, 'context.read', sourceScope, grants);
    const read = authorize(current, 'repo.read', sourceScope, grants);
    const source = this.snapshotSync(material.sourceSnapshotId, workspaceId, material.sourceCollaborationId);
    if (!source || source.workingCopyId !== material.snapshot.workingCopyId ||
        material.sourceContext.snapshotId !== material.sourceSnapshotId || material.sourceContext.workspaceId !== workspaceId ||
        material.sourceContext.collaborationId !== material.sourceCollaborationId) throw new PolicyError();
    RepositorySnapshot.fromPersisted(source.snapshot);
    const frozen = RepositorySnapshot.fromPersisted(material.snapshot);
    if (frozen.manifest.some(file => !isDataPathPermitted(file.path, read.dataPaths ?? []) ||
        !material.dataPaths.includes(file.path)) || frozen.manifest.length !== material.dataPaths.length) throw new PolicyError();
    return material;
  }

  openCollaborationFromMaterial(context: RequestContext, workspaceId: string,
    input: { materialId: string; title: string; question: string }): { topicHandle: string; title: string; projectId: string; question: string } {
    const material = this.assertProjectMaterialAuthority(context, workspaceId, input.materialId);
    const workspace = parseWorkspaceId(workspaceId);
    const collaboration = openCollaboration({ authenticatedPrincipal: context.principal, audience: 'external_mcp', workspaceId: workspace },
      { workspaceId: workspace, purpose: `daily: ${input.title}` });
    this.insertCollaboration(collaboration);
    this.db.prepare('INSERT INTO snapshots(id,workspace_id,collaboration_id,working_copy_id,snapshot_json) VALUES (?,?,?,?,?)')
      .run(material.snapshot.id, workspaceId, collaboration.id, material.snapshot.workingCopyId, JSON.stringify(material.snapshot));
    const revision = inheritContext(material.sourceContext, { id: `ctx_material_${randomUUID()}`, workspaceId,
      collaborationId: collaboration.id, snapshotId: material.snapshot.id, materialId: material.id,
      question: input.question, requestedBy: context.principal });
    this.db.prepare('INSERT INTO context_revisions(id,workspace_id,collaboration_id,revision_json) VALUES (?,?,?,?)')
      .run(revision.id, workspaceId, collaboration.id, JSON.stringify(revision));
    this.db.prepare('INSERT INTO context_heads(workspace_id,collaboration_id,revision_id) VALUES (?,?,?)')
      .run(workspaceId, collaboration.id, revision.id);
    return { topicHandle: collaboration.id, title: input.title, projectId: workspaceId, question: input.question };
  }

  getWorkspace(id: string): StoredWorkspace | null {
    const row = this.db.prepare('SELECT id,name,canonical_root,registered_by FROM workspaces WHERE id=?').get(id) as
      { id: string; name: string; canonical_root: string; registered_by: string } | undefined;
    return row ? { id: row.id, name: row.name, canonicalRoot: row.canonical_root, registeredBy: row.registered_by } : null;
  }

  getWorkspaceByRoot(realpathRoot: string): StoredWorkspace | null {
    const row = this.db.prepare('SELECT id FROM workspaces WHERE canonical_root=?').get(realpathRoot) as { id: string } | undefined;
    return row ? this.getWorkspace(row.id) : null;
  }

  listWorkspaces(): StoredWorkspace[] {
    const rows = this.db.prepare('SELECT id FROM workspaces ORDER BY id').all() as { id: string }[];
    return rows.flatMap((row) => { const workspace = this.getWorkspace(row.id); return workspace ? [workspace] : []; });
  }

  getProfileRevision(workspaceId: string, revisionId: string): ProfileRevision | null {
    const row=this.db.prepare(`SELECT revision_json FROM profile_revisions WHERE id=? AND workspace_id=?`)
      .get(revisionId,workspaceId) as {revision_json:string}|undefined;
    return row ? JSON.parse(row.revision_json) as ProfileRevision : null;
  }

  getCurrentProfileRevision(workspaceId: string): ProfileRevision | null {
    const row=this.db.prepare(`SELECT r.revision_json FROM profile_heads h JOIN profile_revisions r
      ON r.id=h.revision_id WHERE h.workspace_id=?`).get(workspaceId) as {revision_json:string}|undefined;
    return row ? JSON.parse(row.revision_json) as ProfileRevision : null;
  }

  insertProfileRevision(input: ProfileConfiguration, configuredBy: string, configuredAt: Date): ProfileRevision {
    const saved=parseProfileConfiguration(input);
    this.db.exec('SAVEPOINT insert_profile_revision');
    try {
      if (!this.getWorkspace(saved.workspaceId)) throw new Error('NOT_AVAILABLE');
      const previous=this.getCurrentProfileRevision(saved.workspaceId);
      if ((previous?.id ?? null)!==saved.expectedRevisionId) throw new ProfileRevisionConflict();
      const revision:ProfileRevision={id:`profile_${randomUUID()}`,workspaceId:saved.workspaceId,
        previousRevisionId:previous?.id ?? null,presetRef:saved.presetRef,
        budget:{...saved.budget},configuredBy,configuredAt:configuredAt.toISOString(),
        runtimeAvailability:'unavailable',reason:'runtime_not_configured_or_verified'};
      this.db.prepare(`INSERT INTO profile_revisions(id,workspace_id,previous_revision_id,revision_json)
        VALUES (?,?,?,?)`).run(revision.id,revision.workspaceId,revision.previousRevisionId,JSON.stringify(revision));
      if (previous) {
        const updated=this.db.prepare(`UPDATE profile_heads SET revision_id=? WHERE workspace_id=? AND revision_id=?`)
          .run(revision.id,saved.workspaceId,previous.id);
        if (updated.changes!==1) throw new ProfileRevisionConflict();
      } else {
        this.db.prepare(`INSERT INTO profile_heads(workspace_id,revision_id) VALUES (?,?)`)
          .run(saved.workspaceId,revision.id);
      }
      this.db.exec('RELEASE SAVEPOINT insert_profile_revision');
      return revision;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT insert_profile_revision');
      this.db.exec('RELEASE SAVEPOINT insert_profile_revision');
      throw error;
    }
  }

  /** Local collector exclusion set; every registered root is protected across workspaces. */
  localSourceExclusionRoots(): string[] {
    const workspaces = this.db.prepare('SELECT canonical_root FROM workspaces').all() as { canonical_root: string }[];
    const copies = this.db.prepare('SELECT canonical_root FROM working_copies').all() as { canonical_root: string }[];
    return [...workspaces, ...copies].map((row) => row.canonical_root);
  }

  insertCollaboration(collaboration: StoredCollaboration): void {
    this.db.prepare(`INSERT INTO collaborations(id,workspace_id,opened_by,purpose,host_thread_id,state)
      VALUES (?,?,?,?,?,?)`).run(collaboration.id, collaboration.workspaceId, collaboration.openedBy,
      collaboration.purpose, collaboration.hostThreadId, collaboration.state);
  }

  getCollaboration(id: string, workspaceId: string): StoredCollaboration | null {
    const row = this.db.prepare(`SELECT id,workspace_id,opened_by,purpose,host_thread_id,state FROM collaborations
      WHERE id=? AND workspace_id=?`).get(id, workspaceId) as
      { id: string; workspace_id: string; opened_by: string; purpose: string; host_thread_id: string | null; state: StoredCollaboration['state'] } | undefined;
    return row ? { id: row.id, workspaceId: row.workspace_id, openedBy: row.opened_by,
      purpose: row.purpose, hostThreadId: row.host_thread_id, state: row.state } : null;
  }

  getCollaborationById(id: string): StoredCollaboration | null {
    const row = this.db.prepare('SELECT workspace_id FROM collaborations WHERE id=?').get(id) as { workspace_id: string } | undefined;
    return row ? this.getCollaboration(id, row.workspace_id) : null;
  }

  listCollaborations(workspaceId: string): StoredCollaboration[] {
    const rows = this.db.prepare(`SELECT id FROM collaborations WHERE workspace_id=? ORDER BY id`).all(workspaceId) as { id: string }[];
    return rows.flatMap((row) => {
      const collaboration = this.getCollaboration(row.id, workspaceId);
      return collaboration ? [collaboration] : [];
    });
  }

  insertWorkingCopy(copy: StoredWorkingCopy): void {
    this.db.prepare('INSERT INTO working_copies(id,workspace_id,canonical_root) VALUES (?,?,?)')
      .run(copy.id, copy.workspaceId, copy.canonicalRoot);
  }

  async getWorkingCopy(workspaceId: string, workingCopyId: string): Promise<{ canonicalRoot: string } | null> {
    const row = this.db.prepare('SELECT canonical_root FROM working_copies WHERE id=? AND workspace_id=?')
      .get(workingCopyId, workspaceId) as { canonical_root: string } | undefined;
    return row ? { canonicalRoot: row.canonical_root } : null;
  }

  getWorkingCopyByRoot(workspaceId: string, realpathRoot: string): StoredWorkingCopy | null {
    const row = this.db.prepare(`SELECT id,workspace_id,canonical_root FROM working_copies
      WHERE workspace_id=? AND canonical_root=? ORDER BY id LIMIT 1`).get(workspaceId, realpathRoot) as
      { id: string; workspace_id: string; canonical_root: string } | undefined;
    return row ? { id: row.id, workspaceId: row.workspace_id, canonicalRoot: row.canonical_root } : null;
  }

  async collaborationBelongsToWorkspace(workspaceId: string, collaborationId: string): Promise<boolean> {
    return this.getCollaboration(collaborationId, workspaceId) !== null;
  }

  lookupCapture(input: CaptureInput, idempotencyKey: string, principal: string, audience: string): SnapshotReceipt | null {
    return this.lookupIdempotent<SnapshotReceipt>({ principal, audience, workspaceId: input.workspaceId,
      operation: 'snapshot.capture', idempotencyKey }, input);
  }

  async saveSnapshot(record: SnapshotRecord, input: CaptureInput, idempotencyKey: string, principal: string, audience: string): Promise<SnapshotReceipt> {
    if (record.workspaceId !== input.workspaceId || record.collaborationId !== input.collaborationId || record.workingCopyId !== input.workingCopyId) throw new Error('NOT_AVAILABLE');
    return this.runIdempotent({ principal, audience, workspaceId: record.workspaceId, operation: 'snapshot.capture', idempotencyKey },
      input, () => {
        if (!this.getCollaboration(record.collaborationId, record.workspaceId)) throw new Error('NOT_AVAILABLE');
        const copy = this.db.prepare('SELECT id FROM working_copies WHERE id=? AND workspace_id=?')
          .get(record.workingCopyId, record.workspaceId);
        if (!copy) throw new Error('NOT_AVAILABLE');
        const prior = this.db.prepare(`SELECT snapshot_json FROM snapshots WHERE id=? AND workspace_id=? AND collaboration_id=?`)
          .get(record.snapshot.id, record.workspaceId, record.collaborationId) as { snapshot_json: string } | undefined;
        if (prior) {
          const existing = JSON.parse(prior.snapshot_json) as SnapshotRecord['snapshot'];
          const existingContent = { ...existing, cursorKey: '' };
          const newContent = { ...record.snapshot, cursorKey: '' };
          if (canonical(existingContent) !== canonical(newContent)) throw new StoreConflict();
          return this.snapshotReceipt(record);
        }
        this.db.prepare(`INSERT INTO snapshots(id,workspace_id,collaboration_id,working_copy_id,snapshot_json)
          VALUES (?,?,?,?,?)`).run(record.snapshot.id, record.workspaceId, record.collaborationId,
          record.workingCopyId, JSON.stringify(record.snapshot));
        return this.snapshotReceipt(record);
      });
  }

  private snapshotReceipt(record: SnapshotRecord): SnapshotReceipt {
    return { snapshotId: record.snapshot.id, workspaceId: record.workspaceId, collaborationId: record.collaborationId,
      workingCopyId: record.workingCopyId, baseCommit: record.snapshot.baseCommit,
      sourceConsistency: record.snapshot.sourceConsistency,
      excludedCategories: [...new Set(record.snapshot.exclusions.map((item) => item.reason))] };
  }

  async getSnapshot(snapshotId: string, workspaceId: string, collaborationId: string): Promise<SnapshotRecord | null> {
    const row = this.db.prepare(`SELECT working_copy_id,snapshot_json FROM snapshots
      WHERE id=? AND workspace_id=? AND collaboration_id=?`).get(snapshotId, workspaceId, collaborationId) as
      { working_copy_id: string; snapshot_json: string } | undefined;
    return row ? { workspaceId, collaborationId, workingCopyId: row.working_copy_id,
      snapshot: JSON.parse(row.snapshot_json) as SnapshotRecord['snapshot'] } : null;
  }

  getBundle(bundleId: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT input_json,manifest_json,integrity_status,aborted_state_json FROM bundles WHERE id=?').get(bundleId) as
      { input_json: string; manifest_json: string | null; integrity_status: IntegrityStatus | null; aborted_state_json: string | null } | undefined;
    if (row?.manifest_json && row.aborted_state_json) throw new Error('CONFLICT: bundle is both published and aborted');
    return row ? { input: JSON.parse(row.input_json) as ArtifactRecord['input'],
      ...(row.manifest_json ? { manifest: JSON.parse(row.manifest_json) as BundleManifest } : {}),
      ...(row.aborted_state_json ? { abortedState: JSON.parse(row.aborted_state_json) as DeliveryState } : {}),
      ...(row.integrity_status ? { integrityStatus: row.integrity_status } : {}) } : null;
  }

  publishedBundleHighWater(workspaceId: string, collaborationId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(published_seq),0) AS high_water FROM bundles
      WHERE workspace_id=? AND collaboration_id=? AND manifest_json IS NOT NULL`)
      .get(workspaceId, collaborationId) as { high_water: number };
    return row.high_water;
  }

  signBundleCursor(body: string): string {
    const row = this.db.prepare('SELECT secret FROM bundle_cursor_secret WHERE id=1').get() as
      { secret: Uint8Array } | undefined;
    if (!row || row.secret.length !== 32) throw new Error('NOT_AVAILABLE');
    return createHmac('sha256', row.secret).update(body).digest('base64url');
  }

  verifyBundleCursor(body: string, signature: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const actual = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(this.signBundleCursor(body), 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  listPublishedBundles(workspaceId: string, collaborationId: string, afterSeq: number,
    highWater: number, limit: number): { bundleId: string; publishedSeq: number; integrityStatusRecorded: IntegrityStatus | null }[] {
    const rows = this.db.prepare(`SELECT id,published_seq,integrity_status FROM bundles
      WHERE workspace_id=? AND collaboration_id=? AND manifest_json IS NOT NULL
        AND published_seq>? AND published_seq<=?
      ORDER BY published_seq LIMIT ?`).all(workspaceId, collaborationId, afterSeq, highWater, limit) as
      { id: string; published_seq: number; integrity_status: IntegrityStatus | null }[];
    return rows.map((row) => ({ bundleId: row.id, publishedSeq: row.published_seq,
      integrityStatusRecorded: row.integrity_status }));
  }

  validateBundleReferences(input: BundleInput): void {
    if (!input.workspaceId || !input.collaborationId || !input.contextRevision ||
        !Array.isArray(input.snapshotRefs) || !input.snapshotRefs.length ||
        !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_revisions'").get()) {
      throw new Error('NOT_AVAILABLE');
    }
    const row = this.db.prepare(`SELECT revision_json FROM context_revisions
      WHERE id=? AND workspace_id=? AND collaboration_id=?`)
      .get(input.contextRevision, input.workspaceId, input.collaborationId) as { revision_json: string } | undefined;
    if (!row) throw new Error('NOT_AVAILABLE');
    let revision: Record<string, unknown>;
    try { revision = JSON.parse(row.revision_json) as Record<string, unknown>; }
    catch { throw new Error('NOT_AVAILABLE'); }
    if (revision.kind !== 'revision' || revision.id !== input.contextRevision ||
        revision.workspaceId !== input.workspaceId || revision.collaborationId !== input.collaborationId ||
        typeof revision.acceptedBy !== 'string' || !revision.acceptedBy ||
        typeof revision.snapshotId !== 'string' || !input.snapshotRefs.includes(revision.snapshotId)) {
      throw new Error('NOT_AVAILABLE');
    }
    const exists = this.db.prepare(`SELECT 1 FROM snapshots WHERE id=? AND workspace_id=? AND collaboration_id=?`);
    for (const snapshotId of input.snapshotRefs) {
      if (typeof snapshotId !== 'string' || !snapshotId ||
          !exists.get(snapshotId, input.workspaceId, input.collaborationId)) throw new Error('NOT_AVAILABLE');
    }
  }

  saveBundle(record: ArtifactRecord): void {
    const { input } = record;
    this.db.exec('SAVEPOINT save_bundle');
    try {
      if (!this.getCollaboration(input.collaborationId, input.workspaceId)) throw new Error('NOT_AVAILABLE');
      this.validateBundleReferences(input);
      if (input.parentBundleId) {
        const parent = this.getBundle(input.parentBundleId);
        if (!parent?.manifest || parent.input.workspaceId !== input.workspaceId || parent.input.collaborationId !== input.collaborationId) {
          throw new Error('NOT_AVAILABLE');
        }
      }
      this.db.prepare(`INSERT INTO bundles(id,workspace_id,collaboration_id,parent_id,input_json)
        VALUES (?,?,?,?,?)`).run(input.bundleId, input.workspaceId, input.collaborationId,
        input.parentBundleId ?? null, JSON.stringify(input));
      this.db.prepare(`INSERT INTO bundle_context_refs(bundle_id,workspace_id,collaboration_id,revision_id)
        VALUES (?,?,?,?)`).run(input.bundleId, input.workspaceId, input.collaborationId, input.contextRevision);
      const insertSnapshot = this.db.prepare(`INSERT OR IGNORE INTO bundle_snapshot_refs
        (bundle_id,workspace_id,collaboration_id,snapshot_id) VALUES (?,?,?,?)`);
      for (const snapshotId of input.snapshotRefs) {
        insertSnapshot.run(input.bundleId, input.workspaceId, input.collaborationId, snapshotId);
      }
      this.db.exec('RELEASE SAVEPOINT save_bundle');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT save_bundle');
      this.db.exec('RELEASE SAVEPOINT save_bundle');
      throw error;
    }
  }

  publishBundle(manifest: BundleManifest): void {
    this.db.exec('SAVEPOINT publish_bundle');
    try {
      const record = this.getBundle(manifest.bundleId);
      if (!record || record.input.workspaceId !== manifest.workspaceId || record.input.collaborationId !== manifest.collaborationId ||
          record.input.contextRevision !== manifest.contextRevision || record.input.parentBundleId !== manifest.parentBundleId ||
          JSON.stringify(record.input.snapshotRefs) !== JSON.stringify(manifest.snapshotRefs) ||
          JSON.stringify(record.input.expectedPaths ?? null) !== JSON.stringify(manifest.expectedPaths ?? null)) {
        throw new Error('CONFLICT');
      }
      this.validateBundleReferences(manifest);
      if (record.abortedState) throw new Error('CONFLICT');
      if (record.manifest) {
        if (JSON.stringify(record.manifest) !== JSON.stringify(manifest)) throw new Error('CONFLICT');
        this.db.exec('RELEASE SAVEPOINT publish_bundle');
        return;
      }
      this.db.prepare(`UPDATE bundles SET manifest_json=?,integrity_status=?,
        published_seq=(SELECT COALESCE(MAX(published_seq),0)+1 FROM bundles) WHERE id=?`)
        .run(JSON.stringify(manifest), 'ok', manifest.bundleId);
      const insert = this.db.prepare(`INSERT INTO bundle_files(bundle_id,path,sha256,size_bytes,media_type,source_receipt,source_identity)
        VALUES (?,?,?,?,?,?,?)`);
      for (const file of manifest.files) insert.run(manifest.bundleId, file.normalizedRelativePath, file.sha256,
        file.actualSizeBytes, file.mediaType, file.sourceReceipt, file.sourceIdentity ?? null);
      this.db.exec('RELEASE SAVEPOINT publish_bundle');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT publish_bundle');
      this.db.exec('RELEASE SAVEPOINT publish_bundle');
      throw error;
    }
  }

  abortBundle(bundleId: string, state: DeliveryState): void {
    if (state.state !== 'aborted') throw new Error('CONFLICT');
    const changed = this.db.prepare(`UPDATE bundles SET aborted_state_json=?
      WHERE id=? AND manifest_json IS NULL AND aborted_state_json IS NULL`)
      .run(JSON.stringify(state), bundleId).changes;
    if (changed !== 1) throw new Error('CONFLICT');
  }

  setIntegrityStatus(bundleId: string, status: IntegrityStatus): void {
    const changed = this.db.prepare('UPDATE bundles SET integrity_status=? WHERE id=? AND manifest_json IS NOT NULL')
      .run(status, bundleId).changes;
    if (changed === 0) throw new Error('NOT_AVAILABLE');
  }

  insertGrant(grant: Grant): void {
    this.db.prepare(`INSERT INTO grants
      (id,principal,audience,workspace_id,collaboration_id,recipient,permissions_json,data_paths_json,expires_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(grant.id, grant.principal, grant.audience, grant.workspaceId,
      grant.collaborationId ?? null, grant.recipient ?? null, JSON.stringify(grant.permissions),
      grant.dataPaths === undefined ? null : JSON.stringify(grant.dataPaths), grant.expiresAt, grant.revokedAt);
  }

  grantsFor(principal: string, audience: string): Grant[] {
    const rows = this.db.prepare(`SELECT id,principal,audience,workspace_id,collaboration_id,recipient,
      permissions_json,data_paths_json,expires_at,revoked_at FROM grants WHERE principal=? AND audience=?`).all(principal, audience) as {
      id: string; principal: string; audience: string; workspace_id: string; collaboration_id: string | null;
      recipient: string | null; permissions_json: string; data_paths_json: string | null;
      expires_at: string | null; revoked_at: string | null;
    }[];
    return rows.map((row) => ({ id: row.id, principal: row.principal, audience: row.audience,
      workspaceId: row.workspace_id, ...(row.collaboration_id ? { collaborationId: row.collaboration_id } : {}),
      ...(row.recipient ? { recipient: row.recipient } : {}), permissions: JSON.parse(row.permissions_json) as string[],
      ...(row.data_paths_json === null ? {} : { dataPaths: JSON.parse(row.data_paths_json) as string[] }),
      expiresAt: row.expires_at, revokedAt: row.revoked_at }));
  }

  permissionEpoch(principal: string, audience: string, workspaceId: string): number {
    const row = this.db.prepare(`SELECT epoch FROM permission_epochs WHERE principal=? AND audience=? AND workspace_id=?`)
      .get(principal, audience, workspaceId) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  revokeGrant(id: string, revokedAt: string): void {
    this.db.exec('SAVEPOINT revoke_grant');
    try {
      const row = this.db.prepare('SELECT principal,audience,workspace_id,revoked_at FROM grants WHERE id=?').get(id) as
        { principal: string; audience: string; workspace_id: string; revoked_at: string | null } | undefined;
      if (!row) throw new Error('NOT_AVAILABLE');
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(revokedAt, id);
        this.db.prepare(`INSERT INTO permission_epochs(principal,audience,workspace_id,epoch) VALUES (?,?,?,1)
          ON CONFLICT(principal,audience,workspace_id) DO UPDATE SET epoch=epoch+1`)
          .run(row.principal, row.audience, row.workspace_id);
      }
      this.db.exec('RELEASE SAVEPOINT revoke_grant');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT revoke_grant');
      this.db.exec('RELEASE SAVEPOINT revoke_grant');
      throw error;
    }
  }

  lookupIdempotent<T>(scope: IdempotencyScope, payload: unknown): T | null {
    if (Object.values(scope).some((part) => !part)) throw new TypeError('Incomplete idempotency scope');
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    const prior = this.db.prepare(`SELECT payload_hash,result_json FROM idempotency_records
      WHERE principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`)
      .get(scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey) as
      { payload_hash: string; result_json: string } | undefined;
    if (!prior) return null;
    if (prior.payload_hash !== hash) throw new StoreConflict();
    return JSON.parse(prior.result_json) as T;
  }

  runIdempotent<T>(scope: IdempotencyScope, payload: unknown,
    mutation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
    beforeLookup?: () => void): T {
    if (Object.values(scope).some((part) => !part)) throw new TypeError('Incomplete idempotency scope');
    // Transaction callbacks are trusted synchronous code. Reject native async
    // functions before invocation so their continuation cannot write after rollback.
    if (mutation.constructor.name === 'AsyncFunction') throw new TypeError('Idempotent mutation must be synchronous');
    if (beforeLookup?.constructor.name === 'AsyncFunction')
      throw new TypeError('Idempotent authorization must be synchronous');
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const checked:unknown=beforeLookup?.();
      if (checked && typeof checked==='object' && 'then' in checked &&
          typeof checked.then==='function') throw new TypeError('Idempotent authorization must be synchronous');
      const values = [scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey];
      const prior = this.db.prepare(`SELECT payload_hash, result_json FROM idempotency_records
        WHERE principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`).get(...values) as { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== hash) throw new StoreConflict();
        this.db.exec('COMMIT');
        return JSON.parse(prior.result_json) as T;
      }
      const result = mutation();
      if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        throw new TypeError('Idempotent mutation must be synchronous');
      }
      if (scope.operation === 'snapshot.capture' || scope.operation === 'admin.publish_project_material' ||
          scope.operation === 'collab.open_from_template') assertReferenceCapacity(this.db, this.referenceLimits);
      const encoded = canonical(result);
      this.db.prepare(`INSERT INTO idempotency_records
        (principal,audience,workspace_id,operation,idempotency_key,payload_hash,result_json)
        VALUES (?,?,?,?,?,?,?)`).run(...values, hash, encoded);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

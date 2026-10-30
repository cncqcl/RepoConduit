import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { acceptContext, proposeContext, type ContextContent } from '../../src/core/collaboration/context.js';
import type { BundleInput, BundleManifest } from '../../src/core/artifact/types.js';

const content: ContextContent = { goal: 'Review', constraints: [], acceptedDecisions: [], rejectedDecisions: [],
  currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] };

test('bundle storage binds accepted historical revision and every snapshot reference to one collaboration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-refs-'));
  const file = join(dir, 'state.sqlite');
  const db = new SqliteStore(file);
  let contexts: ContextDecisionSqlite | undefined;
  try {
    for (const suffix of ['a', 'b']) {
      db.insertWorkspace({ id: `ws-${suffix}`, name: suffix, canonicalRoot: join(dir, suffix), registeredBy: 'owner' });
      db.insertCollaboration({ id: `col-${suffix}`, workspaceId: `ws-${suffix}`, openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
      db.insertWorkingCopy({ id: `copy-${suffix}`, workspaceId: `ws-${suffix}`, canonicalRoot: join(dir, suffix) });
    }
    async function snapshot(id: string, workspaceId: string, collaborationId: string, workingCopyId: string) {
      const value = createSnapshotFromFiles(workingCopyId, id, { 'src/a.ts': Buffer.from(id) }).toPersisted();
      await db.saveSnapshot({ workspaceId, collaborationId, workingCopyId, snapshot: value },
        { workspaceId, collaborationId, workingCopyId, commitRef: id }, id, 'owner', 'host');
      return value.id;
    }
    const first = await snapshot('first', 'ws-a', 'col-a', 'copy-a');
    const second = await snapshot('second', 'ws-a', 'col-a', 'copy-a');
    const foreign = await snapshot('foreign', 'ws-b', 'col-b', 'copy-b');
    contexts = new ContextDecisionSqlite(file);
    const permit = { grantId: 'owner-grant', operation: 'context.accept', effect: 'state_write' as const,
      scope: { workspaceId: 'ws-a', collaborationId: 'col-a' }, principal: 'owner', recipient: 'local' };
    const proposal = proposeContext({ id: 'proposal-1', workspaceId: 'ws-a', collaborationId: 'col-a',
      parentRevisionId: null, snapshotId: first, proposedBy: 'external', sourceRefs: ['message-1'], content });
    contexts.insertProposal(proposal);
    contexts.insertRevision(acceptContext(proposal, 'revision-1', permit, 'local_host'), permit, 'local_host');
    const next = proposeContext({ ...proposal, id: 'proposal-2', parentRevisionId: 'revision-1', snapshotId: second });
    contexts.insertProposal(next);
    contexts.insertRevision(acceptContext(next, 'revision-2', permit, 'local_host'), permit, 'local_host');
    const seed = new DatabaseSync(file);
    try {
      seed.prepare('INSERT INTO context_revisions(id,workspace_id,collaboration_id,revision_json) VALUES (?,?,?,?)')
        .run('forged', 'ws-a', 'col-a', JSON.stringify({ ...proposal, id: 'forged' }));
    } finally { seed.close(); }

    const input: BundleInput = { bundleId: 'valid', workspaceId: 'ws-a', collaborationId: 'col-a',
      contextRevision: 'revision-1', snapshotRefs: [first, second] };
    assert.doesNotThrow(() => db.validateBundleReferences(input));
    assert.doesNotThrow(() => db.saveBundle({ input }));
    const manifest: BundleManifest = { ...input, files: [], semanticStatus: 'not_reviewed', expectedSetBasis: 'receiver_observed' };
    assert.doesNotThrow(() => db.publishBundle(manifest));
    assert.deepEqual(db.getBundle('valid')?.manifest, manifest);
    const protectedDb = new DatabaseSync(file);
    try {
      protectedDb.exec('PRAGMA foreign_keys=ON');
      assert.throws(() => protectedDb.prepare('DELETE FROM snapshots WHERE id=? AND workspace_id=? AND collaboration_id=?')
        .run(second, 'ws-a', 'col-a'), /FOREIGN KEY constraint failed/);
      assert.throws(() => protectedDb.prepare('DELETE FROM context_revisions WHERE id=? AND workspace_id=? AND collaboration_id=?')
        .run('revision-1', 'ws-a', 'col-a'), /FOREIGN KEY constraint failed/);
    } finally { protectedDb.close(); }

    for (const [bundleId, changes] of Object.entries({
      unknown_revision: { contextRevision: 'missing' },
      forged_revision: { contextRevision: 'forged' },
      unknown_snapshot: { snapshotRefs: [first, 'missing'] },
      foreign_snapshot: { snapshotRefs: [first, foreign] },
      absent_revision_snapshot: { snapshotRefs: [second] },
      foreign_scope: { workspaceId: 'ws-b', collaborationId: 'col-b' },
    })) {
      const invalid = { ...input, ...changes, bundleId };
      assert.throws(() => db.validateBundleReferences(invalid), /NOT_AVAILABLE/, bundleId);
      assert.throws(() => db.saveBundle({ input: invalid }), /NOT_AVAILABLE/, bundleId);
      assert.equal(db.getBundle(bundleId), null);
    }
    db.saveBundle({ input: { ...input, bundleId: 'pending' } });
    const raw = new DatabaseSync(file);
    try {
      raw.exec('PRAGMA foreign_keys=ON');
      assert.throws(() => raw.prepare('DELETE FROM snapshots WHERE id=? AND workspace_id=? AND collaboration_id=?')
        .run(second, 'ws-a', 'col-a'), /FOREIGN KEY constraint failed/);
      assert.doesNotThrow(() => db.publishBundle({ ...manifest, bundleId: 'pending' }));
    } finally { raw.close(); }
  } finally {
    contexts?.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle reference migration rejects legacy rows with missing provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-migrate-'));
  const file = join(dir, 'state.sqlite');
  const db = new SqliteStore(file);
  db.close();
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys=ON');
    raw.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run('ws', 'A', dir, 'owner');
    raw.prepare('INSERT INTO collaborations VALUES (?,?,?,?,?,?)').run('col', 'ws', 'owner', 'review', null, 'open');
    raw.prepare('INSERT INTO bundles(id,workspace_id,collaboration_id,parent_id,input_json) VALUES (?,?,?,?,?)')
      .run('legacy', 'ws', 'col', null, JSON.stringify({ bundleId: 'legacy', workspaceId: 'ws', collaborationId: 'col',
        contextRevision: 'missing', snapshotRefs: ['missing'] }));
    raw.exec('DROP TABLE bundle_snapshot_refs; DROP TABLE bundle_context_refs');
  } finally { raw.close(); }
  try {
    assert.throws(() => new SqliteStore(file), /NOT_AVAILABLE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundle reference migration backfills valid legacy rows with durable scoped links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-backfill-'));
  const file = join(dir, 'state.sqlite');
  new SqliteStore(file).close();
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys=ON');
    raw.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run('ws', 'A', dir, 'owner');
    raw.prepare('INSERT INTO collaborations VALUES (?,?,?,?,?,?)').run('col', 'ws', 'owner', 'review', null, 'open');
    raw.prepare('INSERT INTO working_copies VALUES (?,?,?)').run('copy', 'ws', dir);
    raw.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?)').run('snapshot', 'ws', 'col', 'copy', '{}');
    raw.prepare('INSERT INTO context_revisions VALUES (?,?,?,?)').run('revision', 'ws', 'col',
      JSON.stringify({ kind: 'revision', id: 'revision', workspaceId: 'ws', collaborationId: 'col',
        acceptedBy: 'owner', snapshotId: 'snapshot' }));
    raw.prepare('INSERT INTO bundles(id,workspace_id,collaboration_id,parent_id,input_json) VALUES (?,?,?,?,?)')
      .run('legacy', 'ws', 'col', null, JSON.stringify({ bundleId: 'legacy', workspaceId: 'ws',
        collaborationId: 'col', contextRevision: 'revision', snapshotRefs: ['snapshot'] }));
    raw.exec('DROP TABLE bundle_snapshot_refs; DROP TABLE bundle_context_refs');
  } finally { raw.close(); }
  const migrated = new SqliteStore(file);
  const verify = new DatabaseSync(file);
  try {
    verify.exec('PRAGMA foreign_keys=ON');
    assert.equal(verify.prepare('SELECT count(*) AS count FROM bundle_snapshot_refs WHERE bundle_id=?')
      .get('legacy')?.count, 1);
    assert.throws(() => verify.prepare('DELETE FROM snapshots WHERE id=?').run('snapshot'), /FOREIGN KEY constraint failed/);
    assert.throws(() => verify.prepare('DELETE FROM context_revisions WHERE id=?').run('revision'), /FOREIGN KEY constraint failed/);
  } finally { verify.close(); migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bundle references fail closed when context revision storage is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-no-context-'));
  const db = new SqliteStore(join(dir, 'state.sqlite'));
  try {
    db.insertWorkspace({ id: 'ws', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'review', hostThreadId: null, state: 'open' });
    const input = { bundleId: 'b', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'forged', snapshotRefs: ['s'] };
    assert.throws(() => db.validateBundleReferences(input), /NOT_AVAILABLE/);
    assert.throws(() => db.saveBundle({ input }), /NOT_AVAILABLE/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

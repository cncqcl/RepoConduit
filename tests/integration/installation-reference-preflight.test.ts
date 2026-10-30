import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { proposeDecision, recordDecision } from '../../src/core/collaboration/decision.js';
import { proposeContext } from '../../src/core/collaboration/context.js';
import type { Permit } from '../../src/core/policy/authorize.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';
import { inspectInstallationReferenceDatabase } from '../../src/runtime/installation-reference-preflight.js';
import { BrowserCaptureSqlite } from '../../src/adapters/storage/browser-capture-sqlite.js';
import { HostConversationSqlite } from '../../src/adapters/storage/host-conversation-sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { establishBrowserDownloadBaseline } from '../../src/adapters/transfers/browser-download.js';

const scope = { workspaceId: 'ws-a', collaborationId: 'col-a' };
const permit = (operation: string): Permit => ({ grantId: 'g', operation, effect: 'state_write',
  scope, principal: 'owner', recipient: 'local' });

async function fixture(privateRoot = false): Promise<{ file: string; snapshotId: string; dispose(): void }> {
  const parent = privateRoot ? (process.env.RCAC_TEST_PRIVATE_PARENT ??
    (process.platform === 'win32' ? homedir() : tmpdir())) : tmpdir();
  const outer = mkdtempSync(join(parent, 'rcac-ref-preflight-'));
  const dir = privateRoot ? join(outer, 'data') : outer;
  if (privateRoot) mkdirSync(dir, { mode: 0o700 });
  if (privateRoot) protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  try {
    base.insertWorkspace({ id: scope.workspaceId, name: 'Fixture', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: scope.collaborationId, workspaceId: scope.workspaceId,
      openedBy: 'owner', purpose: 'fixture', hostThreadId: null, state: 'open' });
    const { snapshotId } = await seedBundleProvenance(base, file,
      { ...scope, workingCopyId: 'copy-a', root: dir, revisionIds: ['ctx-1', 'ctx-2'] });
    const bundle = { bundleId: 'bundle-1', ...scope, contextRevision: 'ctx-1', snapshotRefs: [snapshotId] };
    base.saveBundle({ input: bundle });
    base.publishBundle({ ...bundle, files: [], semanticStatus: 'not_reviewed', expectedSetBasis: 'receiver_observed' });
    const second = { bundleId: 'bundle-2', ...scope, contextRevision: 'ctx-2',
      snapshotRefs: [snapshotId], parentBundleId: 'bundle-1' };
    base.saveBundle({ input: second });
    base.publishBundle({ ...second, files: [], semanticStatus: 'not_reviewed', expectedSetBasis: 'receiver_observed' });
    const contexts = new ContextDecisionSqlite(file);
    try {
      const hash = contexts.getPublishedBundleHash(scope.workspaceId, scope.collaborationId, 'bundle-1');
      const proposal = proposeDecision({ id: 'suggestion-1', ...scope, snapshotId, contextRevisionId: 'ctx-1',
        recommendation: 'modify', reason: 'Synthetic review', proposedBy: 'owner',
        bundleId: 'bundle-1', bundleManifestHash: hash }, permit('decision.propose'));
      contexts.insertDecisionProposal(proposal, permit('decision.propose'));
      const review = contexts.insertBaselineReview({ id: 'review-1', ...scope, snapshotId,
        contextRevisionId: 'ctx-1', proposalId: proposal.id, reviewedBy: 'owner' },
      permit('decision.review'), 'local_host');
      const decision = recordDecision({ id: 'decision-1', ...scope, proposalId: proposal.id,
        snapshotId, contextRevisionId: 'ctx-1', reviewId: review.id, outcome: 'modify',
        reason: 'Synthetic decision', decidedBy: 'owner' }, permit('decision.record'), 'local_host');
      contexts.insertDecision(decision, permit('decision.record'), 'local_host');
    } finally { contexts.close(); }
    base.close();
    return { file, snapshotId, dispose() {
      assert.match(relative(resolve(parent), resolve(outer)), /^rcac-ref-preflight-[A-Za-z0-9_-]{6}$/);
      rmSync(outer, { recursive: true, force: true });
    } };
  } catch (error) {
    base.close();
    assert.match(relative(resolve(parent), resolve(outer)), /^rcac-ref-preflight-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
    throw error;
  }
}

function inspect(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try { inspectInstallationReferenceDatabase(db); } finally { db.close(); }
}
function mutate(file: string, sql: string, ...args: (string | null)[]): void {
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA foreign_keys=OFF'); db.prepare(sql).run(...args); } finally { db.close(); }
}

for (const fault of ['none', 'unresolved', 'workspace', 'bundle', 'account', 'grant',
  'aborted', 'aborted_workspace', 'aborted_bundle', 'aborted_account', 'aborted_grant'] as const) {
  test(`browser capture reference preflight checks ${fault}`, async () => {
    const f = await fixture(true);
    const root = dirname(f.file);
    let captures: BrowserCaptureSqlite | undefined;
    let accounts: HostConversationSqlite | undefined;
    try {
      accounts = new HostConversationSqlite(root);
      const accountKey = accounts.accountKey('chatgpt-host-web', 'settings-account-email', 'synthetic@example.test');
      const base = new SqliteStore(f.file);
      try { base.insertGrant({ id: 'capture-grant', principal: 'owner', audience: 'local-os', recipient: 'owner',
        ...scope, permissions: ['artifact.collect'], expiresAt: null, revokedAt: null }); } finally { base.close(); }
      captures = new BrowserCaptureSqlite(f.file);
      const id = createHash('sha256').update(fault).digest('hex');
      captures.prepare({ id, ...scope, workspaceId: fault === 'workspace' || fault === 'aborted_workspace' ? 'other' : scope.workspaceId,
        bundleId: fault === 'bundle' || fault === 'aborted_bundle' ? 'absent' : 'bundle-1', path: 'result.txt', principal: 'owner', audience: 'local-os',
        recipient: 'owner', grantId: fault === 'grant' || fault === 'aborted_grant' ? 'absent' : 'capture-grant',
        accountKey: fault === 'account' || fault === 'aborted_account' ? 'hacc_00000000-0000-4000-8000-000000000103' : accountKey,
        bindingFingerprint: null, nativeSessionId: '11111111-1111-4111-8111-111111111111',
        nativeMessageId: '00000000-0000-4000-8000-000000000101', filename: 'result.txt',
        sourceFingerprint: id, expectedSha256: id, expectedSize: 0,
        baseline: establishBrowserDownloadBaseline(root, 'result.txt', []) });
      if (fault.startsWith('aborted')) captures.abortPreparedForSourceChange(id, id, createHash('sha256').update('changed').digest('hex'));
      else if (fault !== 'unresolved') { captures.transition(id, 'prepared', 'capturing'); captures.transition(id, 'capturing', 'verified_candidate', id); }
      if (fault === 'none' || fault === 'aborted') assert.doesNotThrow(() => inspect(f.file));
      else assert.throws(() => inspect(f.file), /INSTALLATION_REFERENCES_UNSAFE/);
    } finally { captures?.close(); accounts?.close(); f.dispose(); }
  });
}

test('real persisted snapshot, context chain, bundle v1/v2 and historical reviewed decision survive reference preflight', async () => {
  const f = await fixture();
  try { assert.doesNotThrow(() => inspect(f.file)); } finally { f.dispose(); }
});

test('reference preflight rejects changed snapshot bytes and missing typed bundle references', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare('SELECT snapshot_json FROM snapshots WHERE id=?').get(f.snapshotId) as { snapshot_json: string };
      const value = JSON.parse(row.snapshot_json) as { files: Record<string, string> };
      value.files['src/provenance.ts'] = Buffer.from('changed').toString('base64');
      db.prepare('UPDATE snapshots SET snapshot_json=? WHERE id=?').run(JSON.stringify(value), f.snapshotId);
    } finally { db.close(); }
    assert.throws(() => inspect(f.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { f.dispose(); }
  const g = await fixture();
  try {
    mutate(g.file, 'DELETE FROM bundle_snapshot_refs WHERE bundle_id=?', 'bundle-1');
    assert.throws(() => inspect(g.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { g.dispose(); }
  const h = await fixture();
  try {
    mutate(h.file, 'UPDATE bundle_snapshot_refs SET workspace_id=? WHERE bundle_id=?', 'wrong-ws', 'bundle-2');
    assert.throws(() => inspect(h.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { h.dispose(); }
});

test('reference preflight rejects mismatched scoped context and decision baseline hash', async () => {
  const f = await fixture();
  try {
    mutate(f.file, 'UPDATE context_heads SET revision_id=? WHERE collaboration_id=?', 'missing', 'col-a');
    assert.throws(() => inspect(f.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { f.dispose(); }
  const g = await fixture();
  try {
    const db = new DatabaseSync(g.file);
    try {
      const row = db.prepare('SELECT proposal_json FROM decision_proposals WHERE id=?').get('suggestion-1') as { proposal_json: string };
      const value = JSON.parse(row.proposal_json) as { bundleManifestHash: string };
      value.bundleManifestHash = createHash('sha256').update('bad').digest('hex');
      db.prepare('UPDATE decision_proposals SET proposal_json=? WHERE id=?').run(JSON.stringify(value), 'suggestion-1');
    } finally { db.close(); }
    assert.throws(() => inspect(g.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { g.dispose(); }
  const h = await fixture();
  try {
    const db = new DatabaseSync(h.file);
    try {
      const row = db.prepare('SELECT decision_json FROM decisions WHERE id=?').get('decision-1') as { decision_json: string };
      const value = JSON.parse(row.decision_json) as { implementationAuthorized: boolean };
      value.implementationAuthorized = true;
      db.prepare('UPDATE decisions SET decision_json=? WHERE id=?').run(JSON.stringify(value), 'decision-1');
    } finally { db.close(); }
    assert.throws(() => inspect(h.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { h.dispose(); }
});

test('reference preflight rejects changed accepted context and historical review links', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare('SELECT revision_json FROM context_revisions WHERE id=?').get('ctx-1') as { revision_json: string };
      const value = JSON.parse(row.revision_json) as { sourceRefs: string[] };
      value.sourceRefs = ['other-message'];
      db.prepare('UPDATE context_revisions SET revision_json=? WHERE id=?').run(JSON.stringify(value), 'ctx-1');
    } finally { db.close(); }
    assert.throws(() => inspect(f.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { f.dispose(); }
  const g = await fixture();
  try {
    const db = new DatabaseSync(g.file);
    try {
      const row = db.prepare('SELECT decision_json FROM decisions WHERE id=?').get('decision-1') as { decision_json: string };
      const value = JSON.parse(row.decision_json) as { currentContextRevisionId: string };
      value.currentContextRevisionId = 'ctx-1';
      db.prepare('UPDATE decisions SET decision_json=? WHERE id=?').run(JSON.stringify(value), 'decision-1');
    } finally { db.close(); }
    assert.throws(() => inspect(g.file), /INSTALLATION_REFERENCES_UNSAFE/);
  } finally { g.dispose(); }
});

test('pending context proposal may refer to an unaccepted parent revision', async () => {
  const f = await fixture();
  try {
    const contexts = new ContextDecisionSqlite(f.file);
    try {
      contexts.insertProposal(proposeContext({ id: 'pending-context', ...scope,
        parentRevisionId: 'revision-not-yet-accepted', snapshotId: f.snapshotId,
        proposedBy: 'external', sourceRefs: ['message-pending'],
        content: { goal: 'Pending', constraints: [], acceptedDecisions: [], rejectedDecisions: [],
          currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] } }));
    } finally { contexts.close(); }
    assert.doesNotThrow(() => inspect(f.file));
  } finally { f.dispose(); }
});

test('producer preserves duplicate snapshot input refs while typed index deduplicates', async () => {
  const f = await fixture();
  try {
    const base = new SqliteStore(f.file);
    try {
      const input = { bundleId: 'bundle-3', ...scope, contextRevision: 'ctx-2',
        snapshotRefs: [f.snapshotId, f.snapshotId], parentBundleId: 'bundle-2' };
      base.saveBundle({ input });
      base.publishBundle({ ...input, files: [], semanticStatus: 'not_reviewed',
        expectedSetBasis: 'receiver_observed' });
    } finally { base.close(); }
    assert.doesNotThrow(() => inspect(f.file));
  } finally { f.dispose(); }
});

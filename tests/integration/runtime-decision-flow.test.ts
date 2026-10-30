import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

test('installed application path binds snapshot, accepted context, multi-file bundle, and local decision', async () => {
  const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
  const dir = mkdtempSync(join(fixtureRoot, 'rcac-decision-'));
  const repo = join(dir, 'source'), data = join(dir, 'data');
  mkdirSync(repo);
  mkdirSync(data);
  protectNewDataDirectory(data);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'main.ts'), 'export const answer = 42;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = new SqliteStore(join(data, 'state.sqlite'));
  const ws = 'ws_a', col = 'col_a', wc = 'wc_a';
  db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: repo, registeredBy: 'owner' });
  db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'decide', hostThreadId: null, state: 'open' });
  db.insertWorkingCopy({ id: wc, workspaceId: ws, canonicalRoot: repo });
  db.insertGrant({ id: 'grant', principal: 'owner', audience: 'local', recipient: 'owner', workspaceId: ws,
    collaborationId: col, permissions: ['snapshot.create', 'context.propose', 'context.read', 'context.accept',
      'artifact.submit', 'artifact.read', 'decision.record', 'data.read'], dataPaths: ['src/'],
    expiresAt: null, revokedAt: null });
  db.close();
  let app = openApplication(data);
  const context = { principal: 'owner', audience: 'local', recipient: 'owner', surface: 'local_cli' as const, now: new Date() };
  const scope = { workspaceId: ws, collaborationId: col };
  try {
    const captured = await app.dispatch.dispatch(context, { operation: 'snapshot.capture', scope,
      idempotencyKey: 'capture', payload: { workingCopyId: wc } }) as { snapshotId: string };
    const content = { goal: 'Review answer', constraints: [], acceptedDecisions: [], rejectedDecisions: [],
      currentQuestions: ['Is answer correct?'], evidenceRefs: [], expectedDeliverables: ['plan.md', 'notes.md'],
      unknowns: [], recentChanges: [] };
    const proposal = await app.dispatch.dispatch(context, { operation: 'context.propose', scope,
      idempotencyKey: 'proposal', payload: { proposalId: 'prop_a', parentRevisionId: null,
        snapshotId: captured.snapshotId, sourceRefs: ['local-question'], content } }) as { id: string };
    assert.equal(proposal.id, 'prop_a');
    const revision = await app.dispatch.dispatch(context, { operation: 'context.accept', scope,
      idempotencyKey: 'accept', payload: { proposalId: 'prop_a', revisionId: 'ctx_a' } }) as { id: string };
    assert.equal(revision.id, 'ctx_a');
    await app.dispatch.dispatch(context, { operation: 'artifact.begin', scope, idempotencyKey: 'begin',
      payload: { bundleId: 'bundle_a', contextRevision: revision.id, snapshotRefs: [captured.snapshotId],
        expectedPaths: ['plan.md', 'notes.md'] } });
    for (const path of ['plan.md', 'notes.md']) {
      await app.dispatch.dispatch(context, { operation: 'artifact.put_text', scope, idempotencyKey: path,
        payload: { bundleId: 'bundle_a', path, text: `# ${path}`, mediaType: 'text/markdown' } });
    }
    const manifest = await app.dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
      idempotencyKey: 'finalize', payload: { bundleId: 'bundle_a' } });
    const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const review = await app.dispatch.dispatch(context, { operation: 'decision.review', scope,
      idempotencyKey: 'review', payload: { reviewId: 'review_a', bundleId: 'bundle_a',
        bundleManifestHash: hash, snapshotId: captured.snapshotId, contextRevisionId: revision.id } }) as { id: string };
    const decision = { decisionId: 'decision_a', bundleId: 'bundle_a', bundleManifestHash: hash,
      snapshotId: captured.snapshotId, contextRevisionId: revision.id, reviewId: review.id,
      outcome: 'accept', reason: 'Reviewed locally', items: [
        { id: 'plan', sourceRef: 'file:plan.md', outcome: 'accept', reason: 'Matches the accepted context' },
        { id: 'notes', sourceRef: 'file:notes.md', outcome: 'accept', reason: 'Evidence is sufficient' }
      ] };
    const saved = await app.dispatch.dispatch(context, { operation: 'decision.record', scope,
      idempotencyKey: 'decision', payload: decision }) as { implementationAuthorized: boolean; items: unknown[] };
    assert.equal(saved.implementationAuthorized, false);
    assert.deepEqual(saved.items, decision.items);
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'decision.record', scope,
      idempotencyKey: 'malformed-items', payload: { ...decision, decisionId: 'invalid',
        items: [{ ...decision.items[0], unexpected: 'untrusted' }] } }));
    app.close();
    app = openApplication(data);
    assert.equal((await app.dispatch.dispatch(context, { operation: 'context.read', scope,
      payload: {} }) as { id: string }).id, revision.id);
    assert.deepEqual(await app.dispatch.dispatch(context, { operation: 'context.read', scope,
      payload: { revisionId: revision.id } }), revision);
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'context.read', scope,
      payload: { revisionId: revision.id, proposalId: 'proposal_a' } }));
    const other = new SqliteStore(join(data, 'state.sqlite'));
    try {
      other.insertCollaboration({ id: 'col_b', workspaceId: ws, openedBy: 'owner', purpose: 'other',
        hostThreadId: null, state: 'open' });
      other.insertGrant({ id: 'grant-b', principal: 'owner', audience: 'local', recipient: 'owner',
        workspaceId: ws, collaborationId: 'col_b', permissions: ['context.read'],
        expiresAt: null, revokedAt: null });
      assert.equal(await app.dispatch.dispatch(context, { operation: 'context.read',
        scope: { workspaceId: ws, collaborationId: 'col_b' }, payload: { revisionId: revision.id } }), null);
    } finally { other.close(); }
    const page = await app.dispatch.dispatch(context, { operation: 'decision.list', scope,
      payload: { limit: 10 } }) as { decisions: { decisionId: string; implementationAuthorized: boolean }[] };
    assert.deepEqual(page.decisions, [{ decisionId: 'decision_a', decisionSeq: 1,
      bundleId: 'bundle_a', outcome: 'accept', contextRevisionId: revision.id,
      snapshotId: captured.snapshotId, implementationAuthorized: false }]);
    assert.deepEqual(await app.dispatch.dispatch(context, { operation: 'decision.get', scope,
      payload: { decisionId: 'decision_a' } }), saved);
    assert.deepEqual(await app.dispatch.dispatch(context, { operation: 'decision.record', scope,
      idempotencyKey: 'decision', payload: decision }), saved);
    const revoked = new SqliteStore(join(data, 'state.sqlite'));
    try {
      revoked.revokeGrant('grant', new Date().toISOString());
      await assert.rejects(app.dispatch.dispatch(context, { operation: 'context.read', scope,
        payload: { revisionId: revision.id } }));
    } finally { revoked.close(); }
  } finally {
    app.close();
    const child = relative(resolve(fixtureRoot), resolve(dir));
    assert.ok(child.startsWith('rcac-decision-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

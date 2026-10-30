import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { RepositoryApplication } from '../../src/application/repository.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { authorize, type Grant } from '../../src/core/policy/authorize.js';

test('fixed Git snapshot can be captured and read after SQLite restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-repo-db-'));
  const repo = join(dir, 'source');
  mkdirSync(repo);
  let db = new SqliteStore(join(dir, 'state.sqlite'));
  const ws = 'ws_a', col = 'col_a', wc = 'wc_a';
  const context = { principal: 'owner', audience: 'cli', surface: 'local_cli' as const, recipient: 'owner', now: new Date() };
  const grants: Grant[] = [
    { id: 'gr_snap', principal: 'owner', audience: 'cli', workspaceId: ws, collaborationId: col,
      recipient: 'owner', permissions: ['snapshot.create', 'data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null },
  ];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const app = () => new RepositoryApplication({
    authorize: ({ context: requestContext, operation, workspaceId, collaborationId }) =>
      authorize(requestContext, operation, { workspaceId, collaborationId }, db.grantsFor(requestContext.principal, requestContext.audience)),
    getWorkingCopy: (workspaceId, workingCopyId) => db.getWorkingCopy(workspaceId, workingCopyId),
    collaborationBelongsToWorkspace: (workspaceId, collaborationId) => db.collaborationBelongsToWorkspace(workspaceId, collaborationId),
    lookupCapture: (input, key, principal, audience) => db.lookupCapture(input, key, principal, audience),
    saveSnapshot: (record, input, key, principal, audience) => db.saveSnapshot(record, input, key, principal, audience),
    getSnapshot: (id, workspaceId, collaborationId) => db.getSnapshot(id, workspaceId, collaborationId),
  });
  try {
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'flow.ts'), 'export const state = "ready";\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    db.insertWorkspace({ id: ws, name: 'A', canonicalRoot: repo, registeredBy: 'owner' });
    db.insertCollaboration({ id: col, workspaceId: ws, openedBy: 'owner', purpose: 'flow', hostThreadId: null, state: 'open' });
    db.insertWorkingCopy({ id: wc, workspaceId: ws, canonicalRoot: repo });
    db.insertGrant(grants[0]!);
    const captured = await app().capture({ context, workspaceId: ws, collaborationId: col, workingCopyId: wc, idempotencyKey: 'capture-1' });
    assert.equal(captured.sourceConsistency, 'verified_git_tree');
    writeFileSync(join(repo, 'src', 'flow.ts'), 'export const state = "changed";\n');
    git('add', '.');
    git('commit', '-qm', 'changed');
    const replay = await app().capture({ context, workspaceId: ws, collaborationId: col, workingCopyId: wc, idempotencyKey: 'capture-1' });
    assert.deepEqual(replay, captured);
    db.close();
    db = new SqliteStore(join(dir, 'state.sqlite'));
    const read = await app().read({ context, workspaceId: ws, collaborationId: col, workingCopyId: wc,
      snapshotId: captured.snapshotId, path: 'src/flow.ts' });
    assert.match(read.content, /ready/);
    assert.equal(JSON.stringify(read).includes('cursorKey'), false);
    const dispatcher = new DispatchService(db, undefined, undefined, { repository: app() });
    const routed = await dispatcher.dispatch(context, { operation: 'repo.read', scope: { workspaceId: ws, collaborationId: col },
      payload: { workingCopyId: wc, snapshotId: captured.snapshotId, path: 'src/flow.ts' } }) as typeof read;
    assert.equal(routed.content, read.content);
    let outerChecks = 0;
    const narrowed = new DispatchService(db, () => {
      outerChecks++;
      return outerChecks === 1 ? db.grantsFor('owner', 'cli') :
        [{ ...grants[0]!, dataPaths: ['src/public.ts'] }];
    }, undefined, { repository: app() });
    await assert.rejects(narrowed.dispatch(context, { operation: 'repo.read',
      scope: { workspaceId: ws, collaborationId: col },
      payload: { workingCopyId: wc, snapshotId: captured.snapshotId, path: 'src/flow.ts' } }), /NOT_AVAILABLE|not available/);
    assert.equal(outerChecks, 2);
  } finally {
    db.close();
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-repo-db-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

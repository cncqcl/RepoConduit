import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { DailyUseApplication } from '../../src/application/daily-use.js';
import { authorize, type Grant, type RequestContext } from '../../src/core/policy/authorize.js';

const owner: RequestContext = { principal: 'owner', audience: 'local-os', recipient: 'owner', surface: 'local_admin', now: new Date() };
const visitor: RequestContext = { principal: 'visitor', audience: 'chat', recipient: 'approved', surface: 'external_mcp', now: new Date() };
const external = { principal: visitor.principal, audience: visitor.audience, recipient: visitor.recipient };
type Report = { workspaceId: string; localGrantId: string; externalGrantId: string; dataPaths: string[] };

function fixture() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-share-'));
  const db = join(dir, 'state.sqlite');
  let store = new SqliteStore(db);
  let contexts = new ContextDecisionSqlite(db);
  const makeDispatch = () => new DispatchService(store, undefined, undefined, { repository: new RepositoryApplication({
    authorize: ({ context, operation, workspaceId, collaborationId }) => authorize({ ...context, now: new Date() }, operation,
      { workspaceId, collaborationId }, store.grantsFor(context.principal, context.audience)),
    getWorkingCopy: (ws, wc) => store.getWorkingCopy(ws, wc),
    collaborationBelongsToWorkspace: (ws, col) => store.collaborationBelongsToWorkspace(ws, col),
    lookupCapture: (...args) => store.lookupCapture(...args), saveSnapshot: (...args) => store.saveSnapshot(...args),
    getSnapshot: (...args) => store.getSnapshot(...args),
  }), contextDecision: new ContextDecisionApplication(contexts, ctx => store.grantsFor(ctx.principal, ctx.audience)) });
  let dispatch = makeDispatch();
  let daily = new DailyUseApplication(store, dispatch);
  store.insertGrant({ id: 'management', principal: owner.principal, audience: owner.audience,
    recipient: owner.recipient, workspaceId: 'management', permissions: ['admin.workspace', 'admin.grant'],
    expiresAt: null, revokedAt: null });
  const root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'README.md'), 'first');
  writeFileSync(join(root, 'new.md'), 'second');
  writeFileSync(join(root, 'secret.md'), 'secret');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  const grants = (ctx: RequestContext, projectId: string) => store.grantsFor(ctx.principal, ctx.audience)
    .filter(g => g.workspaceId === projectId && g.recipient === ctx.recipient && !g.collaborationId);
  const current = (ctx: RequestContext, projectId: string) => {
    const active = grants(ctx, projectId).filter(g => !g.revokedAt && (!g.expiresAt || Date.parse(g.expiresAt) > Date.now()) && g.permissions.includes('collab.read'));
    assert.equal(active.length, 1); return active[0]!;
  };
  const prepare = async () => daily.prepareProject(owner, { root, dataPaths: ['README.md'], external });
  const update = (projectId: string, dataPaths: string[]) => daily.replaceProjectShare(owner, {
    workspaceId: projectId, external, dataPaths,
    expectedLocalGrantId: current(owner, projectId).id,
    expectedExternalGrantId: current(visitor, projectId).id,
  });
  return { root, db, get store() { return store; }, get dispatch() { return dispatch; }, get daily() { return daily; },
    grants, current, prepare, update, reopen() { contexts.close(); store.close(); store = new SqliteStore(db);
      contexts = new ContextDecisionSqlite(db); dispatch = makeDispatch(); daily = new DailyUseApplication(store, dispatch); },
    close() { contexts.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('explicit share expansion and contraction replace both scopes while retaining old topic snapshot', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const old = await f.daily.openTopic(owner, { root: f.root, topic: 'old', question: 'Old?' });
    const original = await f.daily.resolveTopic(visitor, { topicHandle: old.topicHandle });
    const expanded = await f.update(project.id, ['README.md', 'new.md']) as Report;
    assert.deepEqual(expanded.dataPaths, ['README.md', 'new.md']);
    assert.equal((await f.daily.prepareProject(owner, { root: f.root,
      dataPaths: ['new.md', 'README.md'], external })).id, project.id);
    assert.deepEqual(authorize(visitor, 'repo.read', { workspaceId: project.id, collaborationId: old.topicHandle },
      f.store.grantsFor(visitor.principal, visitor.audience)).dataPaths, ['README.md', 'new.md']);
    const fresh = await f.daily.openTopic(owner, { root: f.root, topic: 'new', question: 'New?' });
    assert.notEqual(fresh.topicHandle, old.topicHandle);
    assert.equal((await f.daily.resolveTopic(visitor, { topicHandle: old.topicHandle })).snapshotId, original.snapshotId);
    await f.update(project.id, ['new.md']);
    assert.deepEqual(authorize(visitor, 'repo.read', { workspaceId: project.id, collaborationId: old.topicHandle },
      f.store.grantsFor(visitor.principal, visitor.audience)).dataPaths, ['new.md']);
  } finally { f.close(); }
});

test('repeat project preparation explicitly updates the selected share paths without grant IDs', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const old = f.current(visitor, project.id);
    const repeated = await f.daily.prepareProject(owner, { root: f.root,
      dataPaths: ['README.md', 'new.md'], external });
    assert.equal(repeated.id, project.id);
    assert.deepEqual(f.current(visitor, project.id).dataPaths, ['README.md', 'new.md']);
    assert.notEqual(f.current(visitor, project.id).id, old.id);
    assert.equal(f.store.grantsFor(visitor.principal, visitor.audience).find(g => g.id === old.id)?.revokedAt !== null, true);
  } finally { f.close(); }
});

test('extra effective data grants prevent contraction without revoking unrelated grants', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const extra: Grant = { id: 'extra', principal: visitor.principal, audience: visitor.audience,
      recipient: visitor.recipient, workspaceId: project.id, permissions: ['data.read'], dataPaths: ['secret.md'],
      expiresAt: null, revokedAt: null };
    f.store.insertGrant(extra);
    await assert.rejects(f.update(project.id, ['new.md']));
    assert.equal(f.current(visitor, project.id).dataPaths?.[0], 'README.md');
    assert.equal(f.store.grantsFor(visitor.principal, visitor.audience).find(g => g.id === extra.id)?.revokedAt, null);
  } finally { f.close(); }
});

test('recipientless local data grant cannot retain a removed path after share contraction', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    f.store.insertGrant({ id: 'legacy-local-read', principal: owner.principal, audience: owner.audience,
      workspaceId: project.id, permissions: ['data.read'], dataPaths: ['secret.md'],
      expiresAt: null, revokedAt: null });
    const localGrant = f.current(owner, project.id);
    const externalGrant = f.current(visitor, project.id);
    const localEpoch = f.store.permissionEpoch(owner.principal, owner.audience, project.id);
    const externalEpoch = f.store.permissionEpoch(visitor.principal, visitor.audience, project.id);
    await assert.rejects(f.update(project.id, ['new.md']));
    assert.equal(f.current(owner, project.id).id, localGrant.id);
    assert.equal(f.current(visitor, project.id).id, externalGrant.id);
    assert.equal(f.store.permissionEpoch(owner.principal, owner.audience, project.id), localEpoch);
    assert.equal(f.store.permissionEpoch(visitor.principal, visitor.audience, project.id), externalEpoch);
    assert.equal(f.store.grantsFor(owner.principal, owner.audience).find(g => g.id === 'legacy-local-read')?.revokedAt, null);
    f.store.revokeGrant('legacy-local-read', new Date().toISOString());
    f.store.insertGrant({ id: 'legacy-local-subset', principal: owner.principal, audience: owner.audience,
      workspaceId: project.id, permissions: ['data.read'], dataPaths: ['new.md'],
      expiresAt: null, revokedAt: null });
    await f.update(project.id, ['new.md']);
    assert.equal(f.store.grantsFor(owner.principal, owner.audience).find(g => g.id === 'legacy-local-subset')?.revokedAt, null);
  } finally { f.close(); }
});

test('directory prefix containment permits narrower extra grant and rejects a broader one', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    f.store.insertGrant({ id: 'file-extra', principal: visitor.principal, audience: visitor.audience,
      recipient: visitor.recipient, workspaceId: project.id, permissions: ['data.read'], dataPaths: ['src/file.md'],
      expiresAt: null, revokedAt: null });
    await f.update(project.id, ['src/']);
    f.store.insertGrant({ id: 'directory-extra', principal: visitor.principal, audience: visitor.audience,
      recipient: visitor.recipient, workspaceId: project.id, permissions: ['data.read'], dataPaths: ['secret/'],
      expiresAt: null, revokedAt: null });
    await assert.rejects(f.update(project.id, ['src/file.md']));
  } finally { f.close(); }
});

test('replacement preserves each still valid grant expiry', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const localGrant = f.current(owner, project.id); const externalGrant = f.current(visitor, project.id);
    const localExpiry = '2099-01-01T00:00:00.000Z';
    const externalExpiry = '2098-01-01T00:00:00.000Z';
    const db = new DatabaseSync(f.db);
    try {
      db.prepare('UPDATE grants SET expires_at=? WHERE id=?').run(localExpiry, localGrant.id);
      db.prepare('UPDATE grants SET expires_at=? WHERE id=?').run(externalExpiry, externalGrant.id);
    } finally { db.close(); }
    const report = await f.update(project.id, ['new.md']) as Report;
    assert.equal(f.store.grantsFor(owner.principal, owner.audience).find(g => g.id === report.localGrantId)?.expiresAt, localExpiry);
    assert.equal(f.store.grantsFor(visitor.principal, visitor.audience).find(g => g.id === report.externalGrantId)?.expiresAt, externalExpiry);
  } finally { f.close(); }
});

test('scope, owner, recipient and stale grant IDs reject; revoked or expired shares do not revive', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const payload = { workspaceId: project.id, external, dataPaths: ['new.md'],
      expectedLocalGrantId: f.current(owner, project.id).id, expectedExternalGrantId: f.current(visitor, project.id).id };
    await assert.rejects(f.daily.replaceProjectShare({ ...owner, principal: 'other', recipient: 'other' }, payload));
    await assert.rejects(f.daily.replaceProjectShare({ ...owner, surface: 'local_cli' }, payload));
    await assert.rejects(f.daily.replaceProjectShare(owner, { ...payload, external: { ...external, recipient: 'wrong' } }));
    await assert.rejects(f.daily.replaceProjectShare(owner, { ...payload, expectedExternalGrantId: 'gr_wrong' }));
    const old = f.current(visitor, project.id);
    f.store.revokeGrant(old.id, new Date().toISOString());
    await assert.rejects(f.daily.replaceProjectShare(owner, payload));
    await assert.rejects(f.daily.prepareProject(owner, { root: f.root, dataPaths: ['README.md'], external }));
    f.store.insertGrant({ ...old, id: 'expired', revokedAt: null, expiresAt: '2020-01-01T00:00:00Z' });
    await assert.rejects(f.daily.replaceProjectShare(owner, { ...payload, expectedExternalGrantId: 'expired' }));
  } finally { f.close(); }
});

test('fault after first successor rolls back both grants, epochs and idempotency; reopen recovers', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const localEpoch = f.store.permissionEpoch(owner.principal, owner.audience, project.id);
    const externalEpoch = f.store.permissionEpoch(visitor.principal, visitor.audience, project.id);
    const originalInsert = f.store.insertGrant.bind(f.store);
    let inserted = 0;
    f.store.insertGrant = grant => { if (++inserted === 2) throw new Error('synthetic insert fault'); originalInsert(grant); };
    await assert.rejects(f.update(project.id, ['new.md']), /synthetic insert fault/);
    f.store.insertGrant = originalInsert;
    assert.equal(f.store.permissionEpoch(owner.principal, owner.audience, project.id), localEpoch);
    assert.equal(f.store.permissionEpoch(visitor.principal, visitor.audience, project.id), externalEpoch);
    assert.equal(f.current(owner, project.id).revokedAt, null);
    assert.equal(f.current(visitor, project.id).revokedAt, null);
    f.reopen();
    assert.deepEqual((await f.update(project.id, ['new.md']) as Report).dataPaths, ['new.md']);
  } finally { f.close(); }
});

test('replay is stable, A to B to A uses new successor, revoked successor cannot replay or revive', async () => {
  const f = fixture(); try {
    const project = await f.prepare();
    const first = await f.update(project.id, ['new.md']) as Report;
    const replay = await f.daily.replaceProjectShare(owner, { workspaceId: project.id, external, dataPaths: ['new.md'],
      expectedLocalGrantId: f.grants(owner, project.id).find(g => g.revokedAt)!.id,
      expectedExternalGrantId: f.grants(visitor, project.id).find(g => g.revokedAt)!.id }) as Report;
    assert.deepEqual(replay, first);
    await f.update(project.id, ['README.md']);
    const priorLocal = f.current(owner, project.id).id;
    const priorExternal = f.current(visitor, project.id).id;
    const again = await f.update(project.id, ['new.md']) as Report;
    assert.notEqual(again.externalGrantId, first.externalGrantId);
    f.store.revokeGrant(again.externalGrantId, new Date().toISOString());
    await assert.rejects(f.daily.replaceProjectShare(owner, { workspaceId: project.id, external, dataPaths: ['new.md'],
      expectedLocalGrantId: priorLocal, expectedExternalGrantId: priorExternal }));
  } finally { f.close(); }
});

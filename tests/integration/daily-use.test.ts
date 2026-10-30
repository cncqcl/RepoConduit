import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { DailyUseApplication } from '../../src/application/daily-use.js';
import { authorize, type RequestContext } from '../../src/core/policy/authorize.js';

const local: RequestContext = { principal: 'owner', audience: 'local-os', surface: 'local_admin', recipient: 'owner', now: new Date() };
const external: RequestContext = { principal: 'visitor', audience: 'external', surface: 'external_mcp', recipient: 'visitor', now: new Date() };

function fixture() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-'));
  const file = join(dir, 'state.sqlite');
  let store = new SqliteStore(file);
  let contexts = new ContextDecisionSqlite(file);
  const make = (failure?: string) => {
    const repository = new RepositoryApplication({
      authorize: ({ context, operation, workspaceId, collaborationId }) => authorize({ ...context, now: new Date() }, operation,
        { workspaceId, collaborationId }, store.grantsFor(context.principal, context.audience)),
      getWorkingCopy: (ws, wc) => store.getWorkingCopy(ws, wc),
      collaborationBelongsToWorkspace: (ws, col) => store.collaborationBelongsToWorkspace(ws, col),
      lookupCapture: (input, key, principal, audience) => store.lookupCapture(input, key, principal, audience),
      saveSnapshot: (record, input, key, principal, audience) => store.saveSnapshot(record, input, key, principal, audience),
      getSnapshot: (id, ws, col) => store.getSnapshot(id, ws, col),
    });
    const dispatcher = new DispatchService(store, undefined, undefined, { repository,
      contextDecision: new ContextDecisionApplication(contexts, (ctx) => store.grantsFor(ctx.principal, ctx.audience)) });
    return new DailyUseApplication(store, failure ? { dispatch: (...args) => {
      if (args[1].operation === failure) throw new Error(`synthetic ${failure} fault`);
      return dispatcher.dispatch(...args);
    } } : dispatcher);
  };
  store.insertGrant({ id: 'management-grant', principal: local.principal, audience: local.audience,
    workspaceId: 'management', recipient: local.recipient, permissions: ['admin.workspace', 'admin.grant'],
    expiresAt: null, revokedAt: null });
  const app = make();
  const repo = (name: string) => {
    const root = join(dir, name); mkdirSync(root);
    writeFileSync(join(root, 'README.md'), `# ${name}\n`);
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('add', 'README.md'); git('commit', '-qm', 'initial');
    return root;
  };
  return { app, repo, broken: (operation = 'snapshot.capture') => make(operation), get store() { return store; }, reopen() { contexts.close(); store.close();
    store = new SqliteStore(file); contexts = new ContextDecisionSqlite(file); return make(); },
    close() { contexts.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('two projects and topics persist with fixed snapshot and accepted context bindings', async () => {
  const f = fixture();
  try {
    const a = f.repo('a'); const b = f.repo('b');
    const p1 = await f.app.prepareProject(local, { root: a, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } });
    const p2 = await f.app.prepareProject(local, { root: b, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } });
    const t1 = await f.app.openTopic(local, { root: a, topic: 'review', question: 'First question?' });
    const t2 = await f.app.openTopic(local, { root: a, topic: 'design', question: 'Second question?' });
    const t3 = await f.app.openTopic(local, { root: b, topic: 'review', question: 'Other project?' });
    assert.notEqual(t1.topicHandle, t2.topicHandle); assert.notEqual(t1.topicHandle, t3.topicHandle);
    assert.notEqual((await f.app.resolveTopic(external, { topicHandle: t1.topicHandle })).collaborationId,
      (await f.app.resolveTopic(external, { topicHandle: t2.topicHandle })).collaborationId);
    assert.deepEqual(f.app.listProjects(external).map((p) => p.id).sort(), [p1.id, p2.id].sort());
    assert.equal((await f.app.listTopics(external, { projectId: p1.id })).length, 2);
    const reopened = f.reopen();
    assert.equal((await reopened.openTopic(local, { root: a, topic: 'review', question: 'Changed?' })).question, 'First question?');
    assert.equal((await reopened.openTopic(local, { root: a, topic: 'review', question: 'First question?' })).topicHandle, t1.topicHandle);
    assert.equal((await reopened.prepareProject(local, { root: a, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } })).id, p1.id);
  } finally { f.close(); }
});

test('accept failure resumes persisted proposal without rewriting the original question', async () => {
  const f = fixture();
  try {
    const root = f.repo('proposal');
    await f.app.prepareProject(local, { root, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } });
    await assert.rejects(f.broken('context.accept').openTopic(local,
      { root, topic: 'one', question: 'Original?' }), /synthetic context.accept fault/);
    const working = f.reopen();
    const topic = await working.openTopic(local, { root, topic: 'one', question: 'Different?' });
    assert.equal(topic.question, 'Original?');
    const binding = await working.resolveTopic(external, { topicHandle: topic.topicHandle });
    assert.equal(binding.question, 'Original?');
    assert.equal(f.store.getCollaborationById(topic.topicHandle)?.workspaceId, topic.projectId);
    assert.equal(await f.store.getSnapshot(binding.snapshotId, 'ws_other', binding.collaborationId), null);
    assert.equal(await f.store.getSnapshot(binding.snapshotId, binding.workspaceId, 'col_other'), null);
  } finally { f.close(); }
});

test('capture failure reopens the same topic and explicit sharing preserves its original baseline', async () => {
  const f = fixture();
  try {
    const root = f.repo('fault');
    const args = { root, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } };
    const project = await f.app.prepareProject(local, args);
    await assert.rejects(f.broken().openTopic(local, { root, topic: 'recover', question: 'Keep this?' }),
      /synthetic snapshot.capture fault/);
    const pending = f.store.listCollaborations(project.id);
    assert.equal(pending.length, 1);
    const working = f.reopen();
    const resumed = await working.openTopic(local, { root, topic: 'recover', question: 'Keep this?' });
    assert.equal(resumed.topicHandle, pending[0]!.id);
    assert.equal((await working.resolveTopic(external, { topicHandle: resumed.topicHandle })).question, 'Keep this?');
    const original = await working.resolveTopic(external, { topicHandle: resumed.topicHandle });
    await working.prepareProject(local, { ...args, dataPaths: ['README.md', 'extra.md'] });
    assert.deepEqual(await working.resolveTopic(external, { topicHandle: resumed.topicHandle }), original);
    const grants = f.store.grantsFor(external.principal, external.audience).filter(g => g.workspaceId === project.id);
    assert.equal(grants.filter(g => g.revokedAt !== null).length, 1, 'the old narrower grant remains as history');
    const active = grants.filter(g => g.revokedAt === null);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0]!.dataPaths, ['README.md', 'extra.md']);
  } finally { f.close(); }
});

test('current grants filter project discovery and deny revoked topic handles', async () => {
  const f = fixture();
  try {
    const a = f.repo('a'); const b = f.repo('b');
    const p1 = await f.app.prepareProject(local, { root: a, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } });
    const p2 = await f.app.prepareProject(local, { root: b, dataPaths: ['README.md'], external: {
      principal: 'another', audience: external.audience, recipient: 'another' } });
    const topic = await f.app.openTopic(local, { root: a, topic: 'one', question: 'Question?' });
    assert.deepEqual(f.app.listProjects(external), [p1]);
    assert.deepEqual(await f.app.listTopics(external, { projectId: p2.id }), []);
    const grant = f.store.grantsFor(external.principal, external.audience).find((g) => g.workspaceId === p1.id);
    assert.ok(grant); f.store.revokeGrant(grant.id, new Date().toISOString());
    assert.deepEqual(f.app.listProjects(external), []);
    await assert.rejects(f.app.resolveTopic(external, { topicHandle: topic.topicHandle }), /NOT_AVAILABLE|not available/i);
    await assert.rejects(f.app.prepareProject(local, { root: a, dataPaths: ['README.md'], external: {
      principal: external.principal, audience: external.audience, recipient: external.recipient } }), /NOT_AVAILABLE|not available/i);
  } finally { f.close(); }
});

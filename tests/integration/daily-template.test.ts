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
import { authorize, type RequestContext } from '../../src/core/policy/authorize.js';
import { inspectInstallationReferenceDatabase } from '../../src/runtime/installation-reference-preflight.js';
import type { ReferenceLimits } from '../../src/adapters/storage/reference-budget.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createDailyMcpServer } from '../../src/adapters/mcp/daily-server.js';

const local: RequestContext = { principal: 'owner', audience: 'local-os', recipient: 'owner', surface: 'local_admin', now: new Date() };
const external: RequestContext = { principal: 'visitor', audience: 'chat', recipient: 'approved', surface: 'external_mcp', now: new Date() };
const recipient = { principal: external.principal, audience: external.audience, recipient: external.recipient };

function fixture(limits?: Partial<ReferenceLimits>) {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-template-'));
  const file = join(dir, 'state.sqlite');
  const store = new SqliteStore(file, limits); const contexts = new ContextDecisionSqlite(file);
  store.insertGrant({ id: 'admin', ...local, workspaceId: 'management', permissions: ['admin.workspace', 'admin.grant', 'admin.revoke'], expiresAt: null, revokedAt: null });
  const repository = new RepositoryApplication({
    authorize: ({ context, operation, workspaceId, collaborationId }) => authorize({ ...context, now: new Date() }, operation,
      { workspaceId, collaborationId }, store.grantsFor(context.principal, context.audience)),
    getWorkingCopy: (ws, wc) => store.getWorkingCopy(ws, wc),
    collaborationBelongsToWorkspace: (ws, col) => store.collaborationBelongsToWorkspace(ws, col),
    lookupCapture: (...args) => store.lookupCapture(...args), saveSnapshot: (...args) => store.saveSnapshot(...args),
    getSnapshot: (...args) => store.getSnapshot(...args),
  });
  const dispatcher = new DispatchService(store, undefined, undefined, { repository,
    contextDecision: new ContextDecisionApplication(contexts, ctx => store.grantsFor(ctx.principal, ctx.audience)) });
  const daily = new DailyUseApplication(store, dispatcher);
  const repo = (name: string) => {
    const root = join(dir, name); mkdirSync(root); writeFileSync(join(root, 'README.md'), `Frozen ${name}`);
    writeFileSync(join(root, 'private.md'), 'Not shared');
    for (const args of [['init', '-q'], ['add', 'README.md', 'private.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    }
    return root;
  };
  const prepare = async (root: string, name?: string) => {
    const project = await daily.prepareProject(local, { root, dataPaths: ['README.md'], external: recipient,
      ...(name === undefined ? {} : { name }) });
    const source = await daily.openTopic(local, { root, topic: 'Project materials', question: 'Locally accepted project background' });
    const material = await daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient });
    return { project, source, material };
  };
  return { dir, file, store, contexts, daily, dispatcher, repo, prepare,
    close() { contexts.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function withDailyClient(f: ReturnType<typeof fixture>, run: (client: Client) => Promise<void>,
  context: RequestContext = external): Promise<void> {
  const server = createDailyMcpServer({ daily: f.daily, dispatcher: f.dispatcher, context });
  const client = new Client({ name: 'daily-project-reference', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); await run(client); }
  finally { await client.close(); await server.close(); }
}

test('daily project name lists the already prepared topic without human-entered internal IDs', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(f.repo('D240-Daily-A'));
    await withDailyClient(f, async client => {
      const result = await client.callTool({ name: 'topics', arguments: { project: prepared.project.name } });
      assert.notEqual(result.isError, true);
      const topics = JSON.parse((result.content as { text: string }[])[0]!.text) as { topicHandle: string }[];
      assert.deepEqual(topics.map(topic => topic.topicHandle), [prepared.source.topicHandle]);
    });
  } finally { f.close(); }
});

test('daily project name opens a scoped web topic and the returned project ID replays the same topic', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(f.repo('D240-Daily-A'));
    await withDailyClient(f, async client => {
      const input = { title: 'Web merged A', question: 'Check the frozen material' };
      const byName = await client.callTool({ name: 'open_topic', arguments: { ...input, project: prepared.project.name } });
      assert.notEqual(byName.isError, true, JSON.stringify(byName));
      const topic = JSON.parse((byName.content as { text: string }[])[0]!.text) as { topicHandle: string; projectId: string };
      assert.equal(topic.projectId, prepared.project.id);
      const byId = await client.callTool({ name: 'open_topic', arguments: { ...input, project: prepared.project.id } });
      assert.notEqual(byId.isError, true);
      assert.deepEqual(JSON.parse((byId.content as { text: string }[])[0]!.text), topic);
      const resolved = await f.daily.resolveTopic(external, { topicHandle: topic.topicHandle });
      assert.equal(resolved.workspaceId, prepared.project.id);
      assert.notEqual(resolved.collaborationId, prepared.source.topicHandle);
    });
  } finally { f.close(); }
});

test('daily project reference rejects visible duplicate names even when only one permits creation', async () => {
  const f = fixture(); try {
    const a = await f.prepare(f.repo('A'), 'Shared'); const b = await f.prepare(f.repo('B'), 'Shared');
    const createB = f.store.grantsFor(external.principal, external.audience).find(grant =>
      grant.workspaceId === b.project.id && grant.permissions.length === 1 && grant.permissions.includes('collab.create'))!;
    f.store.revokeGrant(createB.id, new Date().toISOString());
    await withDailyClient(f, async client => {
      for (const name of ['topics', 'open_topic']) {
        const result = await client.callTool({ name, arguments: { project: 'Shared',
          ...(name === 'open_topic' ? { title: 'Must not choose A', question: 'Ambiguous' } : {}) } });
        assert.equal(result.isError, true);
      }
      const exact = await client.callTool({ name: 'topics', arguments: { project: a.project.id } });
      assert.notEqual(exact.isError, true);
    });
    assert.equal(f.store.listCollaborations(a.project.id).length, 1);
    assert.equal(f.store.listCollaborations(b.project.id).length, 1);
  } finally { f.close(); }
});

test('daily project reference resolves a visible name without exposing a hidden same-name project', async () => {
  const f = fixture(); try {
    const a = await f.prepare(f.repo('A'), 'Shared');
    const hidden = await f.daily.prepareProject(local, { root: f.repo('hidden'), name: 'Shared',
      dataPaths: ['README.md'], external: { principal: 'hidden', audience: external.audience, recipient: 'hidden' } });
    await withDailyClient(f, async client => {
      const result = await client.callTool({ name: 'open_topic', arguments: {
        project: 'Shared', title: 'Visible only', question: 'Read A' } });
      assert.notEqual(result.isError, true);
      const topic = JSON.parse((result.content as { text: string }[])[0]!.text) as { projectId: string };
      assert.equal(topic.projectId, a.project.id);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(hidden.id));
    });
    assert.equal(f.store.listCollaborations(hidden.id).length, 0);
  } finally { f.close(); }
});

test('daily project reference rejects ID-name collisions and never redirects a revoked ID to an alias', async () => {
  const f = fixture(); try {
    const a = await f.prepare(f.repo('A'));
    const b = await f.prepare(f.repo('B'), a.project.id);
    await withDailyClient(f, async client => {
      for (const revoke of [false, true]) {
        if (revoke) for (const grant of f.store.grantsFor(external.principal, external.audience)) {
          if (grant.workspaceId === a.project.id) f.store.revokeGrant(grant.id, new Date().toISOString());
        }
        for (const name of ['topics', 'open_topic']) {
          const result = await client.callTool({ name, arguments: { project: a.project.id,
            ...(name === 'open_topic' ? { title: 'Never redirect', question: 'Keep A scope' } : {}) } });
          assert.equal(result.isError, true);
        }
      }
    });
    assert.equal(f.store.listCollaborations(a.project.id).length, 1);
    assert.equal(f.store.listCollaborations(b.project.id).length, 1);
  } finally { f.close(); }
});

test('daily project reference is exact and rejects unknown, wrong-recipient and expired references', async () => {
  const f = fixture(); try {
    const a = await f.prepare(f.repo('A'), 'Exact A');
    await withDailyClient(f, async client => {
      for (const project of ['exact a', ' Exact A', 'Exact A ', 'unknown', ' ']) {
        assert.equal((await client.callTool({ name: 'topics', arguments: { project } })).isError, true);
      }
    });
    await withDailyClient(f, async client => {
      for (const project of [a.project.name, a.project.id]) {
        const result = await client.callTool({ name: 'open_topic', arguments: { project, title: 'Denied', question: 'Denied' } });
        assert.equal(result.isError, true);
        assert.doesNotMatch(JSON.stringify(result), /canonicalRoot|README.md|Frozen/);
      }
    }, { ...external, recipient: 'different' });
    const read = f.store.grantsFor(external.principal, external.audience).find(grant =>
      grant.workspaceId === a.project.id && grant.permissions.includes('collab.read'))!;
    f.store.revokeGrant(read.id, new Date().toISOString());
    f.store.insertGrant({ ...read, id: 'expired-read', revokedAt: null, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await withDailyClient(f, async client => {
      for (const project of [a.project.name, a.project.id]) {
        assert.equal((await client.callTool({ name: 'topics', arguments: { project } })).isError, true);
      }
    });
    assert.equal(f.store.listCollaborations(a.project.id).length, 1);
  } finally { f.close(); }
});

test('daily project reference stays on its selected ID when permission changes during web creation', async () => {
  const f = fixture(); try {
    const a = await f.prepare(f.repo('A'), 'Shared'); const b = await f.prepare(f.repo('B'), 'Shared');
    const readB = f.store.grantsFor(external.principal, external.audience).find(grant =>
      grant.workspaceId === b.project.id && grant.permissions.includes('collab.read'))!;
    f.store.revokeGrant(readB.id, new Date().toISOString());
    let switched = false;
    const daily = new DailyUseApplication(f.store, { dispatch: async (context, command) => {
      if (command.operation === 'collab.open_from_template' && !switched) {
        switched = true;
        for (const grant of f.store.grantsFor(external.principal, external.audience)) {
          if (grant.workspaceId === a.project.id) f.store.revokeGrant(grant.id, new Date().toISOString());
        }
        f.store.insertGrant({ ...readB, id: 'new-B-read', revokedAt: null });
      }
      return f.dispatcher.dispatch(context, command);
    } });
    await withDailyClient({ ...f, daily }, async client => {
      const result = await client.callTool({ name: 'open_topic', arguments: {
        project: 'Shared', title: 'Stay on A', question: 'Do not choose B after revocation' } });
      assert.equal(result.isError, true);
    });
    assert.equal(switched, true);
    assert.deepEqual(f.daily.listProjects(external).map(project => project.id), [b.project.id]);
    assert.equal(f.store.listCollaborations(a.project.id).length, 1);
    assert.equal(f.store.listCollaborations(b.project.id).length, 1);
  } finally { f.close(); }
});

test('daily project reference descriptions expose the same exact-name and ID contract over the SDK', async () => {
  const f = fixture(); try {
    await withDailyClient(f, async client => {
      const tools = await client.listTools();
      const descriptions = ['topics', 'open_topic'].map(name => {
        const tool = tools.tools.find(tool => tool.name === name)!;
        const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
        return properties.project!.description;
      });
      assert.equal(descriptions[0], descriptions[1]);
      assert.match(descriptions[0]!, /unique authorized name/);
      assert.match(descriptions[0]!, /Ambiguous names/);
    });
  } finally { f.close(); }
});

test('web topic inherits only approved frozen material and keeps its question unaccepted', async () => {
  const f = fixture(); try {
    const root = f.repo('A'); const prepared = await f.prepare(root);
    writeFileSync(join(root, 'README.md'), 'Changed live source');
    const topic = await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Web question', question: 'Can you change the design?' });
    assert.equal(topic.question, 'Can you change the design?');
    const binding = await f.daily.resolveTopic(external, { topicHandle: topic.topicHandle });
    const revision = f.contexts.getRevision(binding.workspaceId, binding.collaborationId, binding.contextRevisionId)!;
    assert.equal(revision.content.goal, 'Locally accepted project background');
    assert.equal(revision.acceptedBy, local.principal);
    assert.equal(revision.inheritedFrom?.requestedQuestion.status, 'unaccepted');
    assert.equal(revision.inheritedFrom?.requestedQuestion.proposedBy, external.principal);
    assert.equal(revision.inheritedFrom?.sourceCollaborationId, prepared.source.topicHandle);
    const frozen = await f.store.getSnapshot(binding.snapshotId, binding.workspaceId, binding.collaborationId);
    assert.deepEqual(Object.keys(frozen!.snapshot.files), ['README.md']);
    assert.equal(Buffer.from(frozen!.snapshot.files['README.md']!, 'base64').toString(), 'Frozen A');
    const read = await f.dispatcher.dispatch(external, { operation: 'repo.read', scope: { workspaceId: binding.workspaceId, collaborationId: binding.collaborationId },
      payload: { workingCopyId: binding.workingCopyId, snapshotId: binding.snapshotId, path: 'README.md' } }) as { content: string };
    assert.equal(read.content, 'Frozen A');
    assert.deepEqual(await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Web question', question: 'Different?' }), topic);
    const next = await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Another question', question: 'Another?' });
    assert.notEqual(next.topicHandle, topic.topicHandle);
  } finally { f.close(); }
});

test('web creation rejects other recipients, source projects, privilege fields and revoked grants', async () => {
  const f = fixture(); try {
    const a = await f.prepare(f.repo('A')); const b = await f.prepare(f.repo('B'));
    await assert.rejects(f.daily.openExternalTopic({ ...external, recipient: 'other' }, { projectId: a.project.id, title: 'X', question: 'X?' }));
    await assert.rejects(f.dispatcher.dispatch(external, { operation: 'collab.open_from_template', scope: { workspaceId: b.project.id }, idempotencyKey: 'cross',
      payload: { materialId: a.material.materialId, title: 'X', question: 'X?' } }));
    await assert.rejects(f.dispatcher.dispatch(external, { operation: 'collab.open_from_template', scope: { workspaceId: a.project.id }, idempotencyKey: 'fields',
      payload: { materialId: a.material.materialId, title: 'X', question: 'X?', acceptedBy: 'owner' } }));
    await assert.rejects(f.daily.publishProjectMaterial(external, { root: f.dir, sourceTopicHandle: a.source.topicHandle, external: recipient }));
    const prior = await f.daily.openExternalTopic(external, { projectId: a.project.id, title: 'Old', question: 'Old?' });
    for (const grant of f.store.grantsFor(external.principal, external.audience)) if (grant.workspaceId === a.project.id) f.store.revokeGrant(grant.id, new Date().toISOString());
    await assert.rejects(f.daily.openExternalTopic(external, { projectId: a.project.id, title: 'Old', question: 'Old?' }));
    await assert.rejects(f.daily.resolveTopic(external, { topicHandle: prior.topicHandle }));
    await assert.rejects(f.daily.publishProjectMaterial(local, { root: f.repo('C'), sourceTopicHandle: a.source.topicHandle, external: recipient }));
  } finally { f.close(); }
});

test('a material update cannot silently replace an existing web topic baseline', async () => {
  const f = fixture(); try {
    const root = f.repo('A'); const first = await f.prepare(root);
    const opened = await f.daily.openExternalTopic(external, { projectId: first.project.id, title: 'Stable', question: 'Original question?' });
    const oldBinding = await f.daily.resolveTopic(external, { topicHandle: opened.topicHandle });
    const source = await f.daily.openTopic(local, { root, topic: 'Updated materials', question: 'Updated local background' });
    const next = await f.daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient });
    assert.notEqual(next.materialId, first.material.materialId);
    assert.deepEqual(await f.daily.openExternalTopic(external, { projectId: first.project.id, title: 'Stable', question: 'Original question?' }), opened);
    assert.equal((await f.daily.resolveTopic(external, { topicHandle: opened.topicHandle })).contextRevisionId, oldBinding.contextRevisionId);
    const newTopic = await f.daily.openExternalTopic(external, { projectId: first.project.id, title: 'New', question: 'New?' });
    const newBinding = await f.daily.resolveTopic(external, { topicHandle: newTopic.topicHandle });
    assert.equal(f.contexts.getRevision(newBinding.workspaceId, newBinding.collaborationId, newBinding.contextRevisionId)!.inheritedFrom?.materialId, next.materialId);
  } finally { f.close(); }
});

test('context initialization failure rolls back the entire new topic and permits the same request to resume', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(f.repo('A')); const before = f.store.listCollaborations(prepared.project.id).length;
    const injection = new DatabaseSync(f.file);
    injection.exec("CREATE TRIGGER fail_inherited BEFORE INSERT ON context_revisions WHEN NEW.id LIKE 'ctx_material_%' BEGIN SELECT RAISE(ABORT,'synthetic material failure'); END");
    try {
      await assert.rejects(f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Recover', question: 'Question?' }), /synthetic/);
      assert.equal(f.store.listCollaborations(prepared.project.id).length, before);
    } finally { injection.exec('DROP TRIGGER fail_inherited'); injection.close(); }
    const recovered = await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Recover', question: 'Question?' });
    assert.equal((await f.daily.resolveTopic(external, { topicHandle: recovered.topicHandle })).question, 'Question?');
    assert.equal(f.store.listCollaborations(prepared.project.id).length, before + 1);
  } finally { f.close(); }
});

test('restore preflight validates inherited material provenance without inventing a local proposal', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(f.repo('A'));
    const topic = await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Restore', question: 'Keep provenance?' });
    const binding = await f.daily.resolveTopic(external, { topicHandle: topic.topicHandle });
    const db = new DatabaseSync(f.file);
    try {
      assert.doesNotThrow(() => inspectInstallationReferenceDatabase(db));
      const row = db.prepare('SELECT revision_json FROM context_revisions WHERE id=?').get(binding.contextRevisionId) as { revision_json: string };
      const revision = JSON.parse(row.revision_json) as { inheritedFrom: { sourceCollaborationId: string; requestedQuestion: { status: string } } };
      revision.inheritedFrom.sourceCollaborationId = 'another-collaboration';
      db.prepare('UPDATE context_revisions SET revision_json=? WHERE id=?').run(JSON.stringify(revision), binding.contextRevisionId);
      assert.throws(() => inspectInstallationReferenceDatabase(db), /INSTALLATION_REFERENCES_UNSAFE/);
      db.prepare('UPDATE context_revisions SET revision_json=? WHERE id=?').run(row.revision_json, binding.contextRevisionId);
      revision.inheritedFrom.sourceCollaborationId = prepared.source.topicHandle;
      revision.inheritedFrom.requestedQuestion.status = 'accepted';
      db.prepare('UPDATE context_revisions SET revision_json=? WHERE id=?').run(JSON.stringify(revision), binding.contextRevisionId);
      assert.throws(() => inspectInstallationReferenceDatabase(db), /INSTALLATION_REFERENCES_UNSAFE/);
      db.prepare('UPDATE context_revisions SET revision_json=? WHERE id=?').run(row.revision_json, binding.contextRevisionId);
      assert.doesNotThrow(() => inspectInstallationReferenceDatabase(db));
    } finally { db.close(); }
  } finally { f.close(); }
});

test('explicit republishing after a lawful scope reduction creates narrower frozen material', async () => {
  const f = fixture(); try {
    const root = f.repo('A');
    const project = await f.daily.prepareProject(local, { root, dataPaths: ['README.md', 'private.md'], external: recipient });
    const source = await f.daily.openTopic(local, { root, topic: 'Materials', question: 'Accepted background' });
    const first = await f.daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient });
    const old = await f.daily.openExternalTopic(external, { projectId: project.id, title: 'Old', question: 'Old?' });
    const oldBinding = await f.daily.resolveTopic(external, { topicHandle: old.topicHandle });
    const broad = f.store.grantsFor(external.principal, external.audience).find(grant => grant.permissions.includes('data.read'))!;
    await f.dispatcher.dispatch(local, { operation: 'admin.revoke', scope: { workspaceId: 'management' }, idempotencyKey: 'reduce-revoke', payload: { grantId: broad.id } });
    await f.dispatcher.dispatch(local, { operation: 'admin.grant', scope: { workspaceId: 'management' }, idempotencyKey: 'reduced-policy',
      payload: { ...recipient, workspaceId: project.id, permissions: ['collab.read', 'context.read', 'data.read', 'artifact.submit', 'artifact.read'], dataPaths: ['README.md'], expiresAt: null } });
    const narrowed = await f.daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient });
    assert.notEqual(narrowed.materialId, first.materialId);
    const next = await f.daily.openExternalTopic(external, { projectId: project.id, title: 'Narrow', question: 'New?' });
    const binding = await f.daily.resolveTopic(external, { topicHandle: next.topicHandle });
    assert.notEqual(binding.snapshotId, oldBinding.snapshotId);
    assert.deepEqual(Object.keys((await f.store.getSnapshot(binding.snapshotId, binding.workspaceId, binding.collaborationId))!.snapshot.files), ['README.md']);
    assert.equal((await f.daily.resolveTopic(external, { topicHandle: old.topicHandle })).snapshotId, oldBinding.snapshotId);
    assert.equal((await f.daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient })).materialId, narrowed.materialId);
  } finally { f.close(); }
});

test('web question budget is UTF-8 bytes and rejection creates no partial topic', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(f.repo('A')); const before = f.store.listCollaborations(prepared.project.id).length;
    await assert.rejects(f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'UTF8', question: '界'.repeat(5500) }));
    await assert.rejects(f.dispatcher.dispatch(external, { operation: 'collab.open_from_template', scope: { workspaceId: prepared.project.id }, idempotencyKey: 'too-large',
      payload: { materialId: prepared.material.materialId, title: 'UTF8', question: '界'.repeat(5500) } }));
    assert.equal(f.store.listCollaborations(prepared.project.id).length, before);
  } finally { f.close(); }
});

test('3MiB project material and two web topics remain restorable', async () => {
  const f = fixture(); try {
    const root = f.repo('A'); writeFileSync(join(root, 'README.md'), Buffer.alloc(3 * 1024 * 1024, 65));
    for (const args of [['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', '3MiB source']]) {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    }
    const prepared = await f.prepare(root);
    const a = await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Large A', question: 'First?' });
    const b = await f.daily.openExternalTopic(external, { projectId: prepared.project.id, title: 'Large B', question: 'Second?' });
    assert.notEqual(a.topicHandle, b.topicHandle);
    const db = new DatabaseSync(f.file);
    try { assert.doesNotThrow(() => inspectInstallationReferenceDatabase(db)); }
    finally { db.close(); }
  } finally { f.close(); }
});

test('reduced content budgets roll back material heads, new topics and successful idempotency rows', async () => {
  for (const maxContentWorkBytes of [2000, 4000]) {
    const f = fixture({ maxContentWorkBytes }); try {
      const root = f.repo('A'); writeFileSync(join(root, 'README.md'), Buffer.alloc(512, 65));
      for (const args of [['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'small boundary']]) {
        const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
      }
      const project = await f.daily.prepareProject(local, { root, dataPaths: ['README.md'], external: recipient });
      const source = await f.daily.openTopic(local, { root, topic: 'Materials', question: 'Accepted background' });
      const db = new DatabaseSync(f.file);
      const counts = () => ['collaborations', 'snapshots', 'context_revisions', 'context_heads',
        'daily_project_materials', 'daily_project_material_heads', 'idempotency_records']
        .map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
      try {
        if (maxContentWorkBytes === 2000) {
          const before = counts();
          await assert.rejects(f.daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient }), /REFERENCE_CAPACITY_EXCEEDED/);
          assert.deepEqual(counts(), before);
        } else {
          await f.daily.publishProjectMaterial(local, { root, sourceTopicHandle: source.topicHandle, external: recipient });
          await f.daily.openExternalTopic(external, { projectId: project.id, title: 'Within budget', question: 'First?' });
          const before = counts();
          await assert.rejects(f.daily.openExternalTopic(external, { projectId: project.id, title: 'Over budget', question: 'Second?' }), /REFERENCE_CAPACITY_EXCEEDED/);
          assert.deepEqual(counts(), before);
        }
        assert.doesNotThrow(() => inspectInstallationReferenceDatabase(db, { maxContentWorkBytes }));
        assert.throws(() => inspectInstallationReferenceDatabase(db, { maxMetadataBytes: 100 }), /INSTALLATION_REFERENCES_UNSAFE/);
      } finally { db.close(); }
    } finally { f.close(); }
  }
});

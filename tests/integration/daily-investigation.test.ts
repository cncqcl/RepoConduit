import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import { InvestigationApplication } from '../../src/application/investigations.js';
import { DailyUseApplication } from '../../src/application/daily-use.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { createDailyMcpServer } from '../../src/adapters/mcp/daily-server.js';
import { authorize, type RequestContext } from '../../src/core/policy/authorize.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { acceptContext, proposeContext } from '../../src/core/collaboration/context.js';

const external: RequestContext = { principal: 'daily-visitor', audience: 'daily-test', recipient: 'approved',
  surface: 'external_mcp', now: new Date() };
const names = ['investigate', 'investigation_status', 'investigation_result', 'cancel_investigation'];
const question = { requestName: 'Trace original', question: 'Trace the frozen source',
  scope: { paths: ['src/provenance.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow', 'evidence'] };

async function fixture() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-investigate-'));
  const file = join(dir, 'state.sqlite');
  const store = new SqliteStore(file); const contexts = new ContextDecisionSqlite(file);
  const investigations = new SqliteInvestigationStore(file);
  const scopes: Record<string, { workspaceId: string; collaborationId: string; workingCopyId: string; snapshotId: string; contextRevisionId: string }> = {};
  for (const name of ['A', 'B']) {
    const root = join(dir, name); mkdirSync(root);
    const workspaceId = `ws_${name}`, collaborationId = `col_${name}`, workingCopyId = `wc_${name}`;
    store.insertWorkspace({ id: workspaceId, name, canonicalRoot: root, registeredBy: 'owner' });
    store.insertCollaboration({ id: collaborationId, workspaceId, purpose: `daily: ${name} topic`,
      openedBy: 'owner', hostThreadId: null, state: 'open' });
    store.insertGrant({ id: `read_${name}`, ...external, workspaceId,
      permissions: ['collab.read', 'context.read', 'data.read'], dataPaths: ['src/provenance.ts'], expiresAt: null, revokedAt: null });
    store.insertGrant({ id: `investigate_${name}`, ...external, workspaceId,
      permissions: ['investigation.request', 'investigation.read', 'investigation.cancel'], expiresAt: null, revokedAt: null });
    const contextRevisionId = `ctx_${name}`;
    store.insertWorkingCopy({ id: workingCopyId, workspaceId, canonicalRoot: root });
    const snapshot = createSnapshotFromFiles(workingCopyId, 'daily-fixture',
      { 'src/provenance.ts': Buffer.from(`export const project = '${name}';`) }).toPersisted();
    const snapshotId = snapshot.id;
    await store.saveSnapshot({ workspaceId, collaborationId, workingCopyId, snapshot },
      { workspaceId, collaborationId, workingCopyId, commitRef: 'daily-fixture' }, `capture-${name}`, 'owner', 'local_cli');
    const proposal = proposeContext({ id: `proposal_${name}`, workspaceId, collaborationId, parentRevisionId: null,
      snapshotId, proposedBy: 'owner', sourceRefs: ['fixture'], content: { goal: `Investigate ${name}`, constraints: [],
        acceptedDecisions: [], rejectedDecisions: [], currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [] } });
    contexts.insertProposal(proposal);
    const permit = { grantId: 'fixture', operation: 'context.accept', effect: 'state_write' as const,
      scope: { workspaceId, collaborationId }, principal: 'owner', recipient: 'owner' };
    contexts.insertRevision(acceptContext(proposal, contextRevisionId, permit, 'local_host'), permit, 'local_host');
    store.insertProfileRevision({ workspaceId, expectedRevisionId: null, presetRef: 'static_readonly_v1',
      budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 6 } }, 'owner', new Date());
    scopes[name] = { workspaceId, collaborationId, workingCopyId, snapshotId, contextRevisionId };
  }
  let runtimeAvailable = true;
  // Real handler/storage, inert profile selection only: this fixture has no worker/native/model port.
  const investigation = new InvestigationApplication({
    authorize: ({ context, operation, workspaceId, collaborationId }) => authorize({ ...context, now: new Date() },
      operation, { workspaceId, collaborationId }, store.grantsFor(context.principal, context.audience)),
    resolveBinding: async request => {
      const revision = request.expected ? contexts.getRevision(request.workspaceId, request.collaborationId,
        request.expected.contextRevisionId) : contexts.getCurrentRevision(request.workspaceId, request.collaborationId);
      if (!revision) return null;
      const saved = await store.getSnapshot(revision.snapshotId, request.workspaceId, request.collaborationId);
      if (!saved || saved.workingCopyId !== request.workingCopyId) return null;
      return { workspaceId: request.workspaceId, collaborationId: request.collaborationId, workingCopyId: request.workingCopyId,
        contextRevisionId: revision.id, snapshotRef: revision.snapshotId, recipient: request.context.recipient };
    },
    selectProfile: request => {
      const profile = store.getCurrentProfileRevision(request.workspaceId);
      return runtimeAvailable && profile ? { profileRef: profile.id, budgetRef: profile.id, budget: profile.budget, isolationVerified: true } : null;
    },
    enqueue: (record, key, fingerprint) => investigations.enqueue(record, key, fingerprint),
    get: id => investigations.get(id), requestCancel: (record, key, grantId) => investigations.requestCancel(record, key, grantId),
  });
  const dispatcher = new DispatchService(store, undefined, undefined, { investigation,
    contextDecision: new ContextDecisionApplication(contexts, ctx => store.grantsFor(ctx.principal, ctx.audience)) });
  const daily = new DailyUseApplication(store, dispatcher);
  return { store, contexts, investigations, scopes, dispatcher, daily,
    setRuntimeAvailable(value: boolean) { runtimeAvailable = value; },
    close(passed: boolean) { investigations.close(); contexts.close(); store.close(); if (passed) rmSync(dir, { recursive: true, force: true }); else process.stderr.write(`Preserved failed daily investigation fixture: ${dir}\n`); } };
}

async function withClient(f: Awaited<ReturnType<typeof fixture>>, enabled: boolean,
  run: (client: Client) => Promise<void>, context = external) {
  const server = createDailyMcpServer({ daily: f.daily, dispatcher: f.dispatcher, context, investigationsEnabled: enabled });
  const client = new Client({ name: 'daily-investigation-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); await run(client); }
  finally { await client.close(); await server.close(); }
}
const parsed = (result: Awaited<ReturnType<Client['callTool']>>) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse((result.content as { text: string }[])[0]!.text) as InvestigationRecord;
};

test('daily investigation tools require trusted composition and expose only closed scoped data inputs', async () => {
  const f = await fixture(); let passed = false; try {
    await withClient(f, false, async client => assert.ok((await client.listTools()).tools.every(tool => !names.includes(tool.name))));
    await withClient(f, true, async client => {
      const tools = (await client.listTools()).tools.filter(tool => names.includes(tool.name));
      assert.deepEqual(tools.map(tool => tool.name), names);
      assert.equal(tools[0]!.annotations?.readOnlyHint, false);
      assert.equal(tools[1]!.annotations?.readOnlyHint, true);
      for (const extra of [{ runtime: 'do not accept' }, { budget: { maxTurns: 100 } }, { snapshotId: 'forged' }]) {
        const result = await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A', ...extra } });
        assert.equal(result.isError, true);
      }
      for (const requestName of [' ', '\0', '题'.repeat(64)]) {
        assert.equal((await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A', requestName } })).isError, true);
      }
      assert.equal(f.investigations.listPending().length, 0);
    });
  passed = true; } finally { f.close(passed); }
});

test('daily investigation binds each project baseline and same human request name independently', async () => {
  const f = await fixture(); let passed = false; try {
    await withClient(f, true, async client => {
      const records = [];
      for (const name of ['A', 'B']) {
        const scope = f.scopes[name]!;
        const record = parsed(await client.callTool({ name: 'investigate', arguments: { ...question, topic: scope.collaborationId } }));
        assert.equal(record.workspaceId, scope.workspaceId); assert.equal(record.workingCopyId, scope.workingCopyId);
        assert.equal(record.snapshotRef, scope.snapshotId); assert.equal(record.contextRevisionId, scope.contextRevisionId);
        assert.equal(record.principal, external.principal); assert.equal(record.state, 'queued'); records.push(record);
      }
      assert.notEqual(records[0]!.id, records[1]!.id);
      assert.equal(f.investigations.listPending().length, 2);
      for (const name of ['investigation_status', 'investigation_result', 'cancel_investigation']) {
        assert.equal((await client.callTool({ name, arguments: { topic: 'col_B', investigation: records[0]!.id } })).isError, true);
      }
      assert.equal(f.investigations.get(records[0]!.id)!.cancelRequested, false);
    });
  passed = true; } finally { f.close(passed); }
});

test('daily named investigation replays exact input, rejects conflicts and preserves original request', async () => {
  const f = await fixture(); let passed = false; try {
    await withClient(f, true, async client => {
      const args = { ...question, topic: 'col_A' };
      const original = parsed(await client.callTool({ name: 'investigate', arguments: args }));
      assert.deepEqual(parsed(await client.callTool({ name: 'investigate', arguments: args })), original);
      assert.equal((await client.callTool({ name: 'investigate', arguments: { ...args, question: 'Different input' } })).isError, true);
      assert.equal(f.investigations.listPending().length, 1);
      assert.equal(parsed(await client.callTool({ name: 'investigation_status', arguments: { topic: 'col_A', investigation: original.id } })).question, question.question);
      assert.equal(parsed(await client.callTool({ name: 'investigation_result', arguments: { topic: 'col_A', investigation: original.id } })), null);
      const cancel = { topic: 'col_A', investigation: original.id };
      assert.equal(parsed(await client.callTool({ name: 'cancel_investigation', arguments: cancel })).state, 'cancelled');
      assert.equal(parsed(await client.callTool({ name: 'cancel_investigation', arguments: cancel })).state, 'cancelled');
    });
  passed = true; } finally { f.close(passed); }
});

test('daily investigation rejects unconfigured runtime, absent grants and unshared source paths', async () => {
  const f = await fixture(); let passed = false; try {
    await withClient(f, true, async client => {
      f.setRuntimeAvailable(false);
      assert.equal((await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A' } })).isError, true);
      f.setRuntimeAvailable(true);
      const unshared = { ...question, scope: { ...question.scope, paths: ['private.ts'] }, topic: 'col_A' };
      assert.equal((await client.callTool({ name: 'investigate', arguments: unshared })).isError, true);
      f.store.revokeGrant('investigate_A', new Date().toISOString());
      assert.equal((await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A' } })).isError, true);
      assert.equal(f.investigations.listPending().length, 0);
    });
  passed = true; } finally { f.close(passed); }
});

test('daily investigation supports two scoped followups and refuses cross-project parents', async () => {
  const f = await fixture(); let passed = false; try {
    await withClient(f, true, async client => {
      let parent = parsed(await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A' } }));
      for (const i of [1, 2]) {
        const next = parsed(await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A',
          requestName: `Follow up ${i}`, parentInvestigation: parent.id } }));
        assert.equal(next.parentInvestigationId, parent.id); parent = next;
      }
      assert.equal((await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_B',
        parentInvestigation: parent.id } })).isError, true);
      assert.equal(f.investigations.listPending().length, 3);
      f.store.revokeGrant('read_A', new Date().toISOString());
      f.store.insertGrant({ id: 'read_A_narrow', ...external, workspaceId: 'ws_A',
        permissions: ['collab.read', 'context.read', 'data.read'], dataPaths: ['other.ts'], expiresAt: null, revokedAt: null });
      for (const name of ['investigation_status', 'investigation_result']) {
        assert.equal((await client.callTool({ name, arguments: { topic: 'col_A', investigation: parent.id } })).isError, true);
      }
    });
  passed = true; } finally { f.close(passed); }
});

test('daily investigation rechecks withdrawn authority after asynchronous topic resolution', async () => {
  const f = await fixture(); let passed = false; try {
    let checks = 0;
    await withClient(f, true, async client => {
      assert.equal((await client.callTool({ name: 'investigate', arguments: { ...question, topic: 'col_A' } })).isError, true);
      assert.ok(checks > 0); assert.equal(f.investigations.listPending().length, 0);
    }, { ...external, assertFreshAuthority: async () => { checks++; f.store.revokeGrant('investigate_A', new Date().toISOString()); } });
  passed = true; } finally { f.close(passed); }
});

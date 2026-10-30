import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { ContextDecisionApplication } from '../../src/application/context-decisions.js';
import type { Grant, RequestContext } from '../../src/core/policy/authorize.js';

const local: RequestContext = { principal: 'owner', audience: 'host', surface: 'local_cli',
  recipient: 'local', now: new Date('2026-09-28T00:00:00Z') };
const external: RequestContext = { ...local, surface: 'external_mcp' };
const grant: Grant = { id: 'read', principal: 'owner', audience: 'host', recipient: 'local',
  workspaceId: 'ws-a', collaborationId: 'col-a', permissions: ['context.read'],
  expiresAt: null, revokedAt: null };

test('decision history is scoped, signed, complete under append, and reauthorized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-decision-history-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  let store: ContextDecisionSqlite | undefined;
  let writer: DatabaseSync | undefined;
  try {
    base.insertWorkspace({ id: 'ws-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertWorkspace({ id: 'ws-b', name: 'B', canonicalRoot: join(dir, 'other'), registeredBy: 'owner' });
    base.insertCollaboration({ id: 'col-a', workspaceId: 'ws-a', openedBy: 'owner', purpose: 'A',
      hostThreadId: null, state: 'open' });
    base.insertCollaboration({ id: 'col-b', workspaceId: 'ws-a', openedBy: 'owner', purpose: 'B',
      hostThreadId: null, state: 'open' });
    base.insertCollaboration({ id: 'col-c', workspaceId: 'ws-b', openedBy: 'owner', purpose: 'C',
      hostThreadId: null, state: 'open' });
    store = new ContextDecisionSqlite(file);
    writer = new DatabaseSync(file);
    const insert = (id: string, workspaceId = 'ws-a', collaborationId = 'col-a') => {
      const decision = { id, workspaceId, collaborationId, bundleId: `bundle-${id}`,
        bundleManifestHash: 'a'.repeat(64), snapshotId: `snapshot-${id}`, contextRevisionId: `context-${id}`,
        outcome: 'reject', reason: 'fixture', decidedBy: 'owner', implementationAuthorized: false };
      writer!.prepare('INSERT INTO decisions VALUES (?,?,?,?)')
        .run(id, workspaceId, collaborationId, JSON.stringify(decision));
    };
    insert('a-1'); insert('b-1', 'ws-a', 'col-b'); insert('c-1', 'ws-b', 'col-c'); insert('a-2');
    let grants = [grant, { ...grant, id: 'read-col-b', collaborationId: 'col-b' },
      { ...grant, id: 'read-other', principal: 'other' }];
    const signer = {
      sign: (body: string) => base.signBundleCursor(`decision.list\n${body}`),
      verify: (body: string, signature: string) => base.verifyBundleCursor(`decision.list\n${body}`, signature),
    };
    let app = new ContextDecisionApplication(store, () => grants, () => local.now, signer);
    const binding = { context: local, workspaceId: 'ws-a', collaborationId: 'col-a' };
    const first = app.listDecisions({ ...binding, limit: 1 });
    assert.deepEqual(first.decisions.map((entry) => entry.decisionId), ['a-1']);
    assert.equal(first.decisions[0]?.implementationAuthorized, false);
    assert.ok(first.nextCursor);
    insert('a-3'); // This new record must not enter the first scan.
    store.close();
    store = new ContextDecisionSqlite(file);
    app = new ContextDecisionApplication(store, () => grants, () => local.now, signer);
    const second = app.listDecisions({ ...binding, limit: 1, cursor: first.nextCursor! });
    assert.deepEqual(second.decisions.map((entry) => entry.decisionId), ['a-2']);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(app.listDecisions({ ...binding, limit: 10 }).decisions.map((entry) => entry.decisionId),
      ['a-1', 'a-2', 'a-3']);
    assert.equal(app.readDecision({ ...binding, decisionId: 'a-2' })?.id, 'a-2');
    assert.equal(app.readDecision({ ...binding, decisionId: 'b-1' }), null);
    assert.throws(() => app.listDecisions({ ...binding, limit: 2, cursor: first.nextCursor! }), /INVALID_ARGUMENT/);
    assert.throws(() => app.listDecisions({ ...binding, collaborationId: 'col-b', limit: 1,
      cursor: first.nextCursor! }), /INVALID_ARGUMENT/);
    assert.throws(() => app.listDecisions({ ...binding, context: { ...local, principal: 'other' },
      limit: 1, cursor: first.nextCursor! }), /INVALID_ARGUMENT/);
    assert.throws(() => app.listDecisions({ ...binding, context: external }), /NOT_AVAILABLE/);
    assert.throws(() => app.readDecision({ ...binding, context: external, decisionId: 'a-1' }), /NOT_AVAILABLE/);
    assert.throws(() => app.listDecisions({ ...binding, limit: 0 }), /INVALID_ARGUMENT/);
    assert.throws(() => app.listDecisions({ ...binding, limit: 11 }), /INVALID_ARGUMENT/);
    const corrupted = first.nextCursor!.slice(0, -1) + (first.nextCursor!.at(-1) === 'A' ? 'B' : 'A');
    assert.throws(() => app.listDecisions({ ...binding, limit: 1, cursor: corrupted }), /INVALID_ARGUMENT/);
    grants = [];
    assert.throws(() => app.listDecisions({ ...binding, limit: 1, cursor: first.nextCursor! }), /not available/i);
    assert.throws(() => app.readDecision({ ...binding, decisionId: 'a-1' }), /not available/i);
  } finally {
    writer?.close(); store?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

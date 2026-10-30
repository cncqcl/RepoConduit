import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

test('product dispatch reads and cancels a durable investigation while unverified AI submit stays closed', async () => {
  const root = process.platform === 'win32' ? homedir() : tmpdir();
  const data = mkdtempSync(join(root, 'rcac-investigation-product-'));
  protectNewDataDirectory(data);
  const file = join(data, 'state.sqlite');
  const db = new SqliteStore(file);
  const workspaceId = 'ws_a', collaborationId = 'col_a', workingCopyId = 'wc_a';
  const context = { principal: 'external', audience: 'mcp', recipient: 'external',
    surface: 'external_mcp' as const, now: new Date() };
  const scope = { workspaceId, collaborationId };
  db.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: data, registeredBy: 'owner' });
  db.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner', purpose: 'investigate', hostThreadId: null, state: 'open' });
  db.insertGrant({ id: 'grant-investigate', principal: context.principal, audience: context.audience,
    recipient: context.recipient, workspaceId, collaborationId,
    permissions: ['investigation.request', 'investigation.read', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  db.insertGrant({ id: 'grant-data', principal: context.principal, audience: context.audience,
    recipient: context.recipient, workspaceId, collaborationId, permissions: ['data.read'],
    dataPaths: ['src/provenance.ts'], expiresAt: null, revokedAt: null });
  const { snapshotId } = await seedBundleProvenance(db, file, { workspaceId, collaborationId,
    workingCopyId, root: data, revisionIds: ['ctx_a', 'ctx_b'] });
  const investigations = new SqliteInvestigationStore(file);
  const record: InvestigationRecord = { id: 'inv_existing', workspaceId, collaborationId, workingCopyId,
    principal: context.principal, audience: context.audience, recipient: context.recipient,
    grantId: 'grant-investigate', profileRef: 'historical-profile', budgetRef: 'historical-budget',
    budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 }, contextRevisionId: 'ctx_a',
    snapshotRef: snapshotId, question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] },
    requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued', cancelRequested: false,
    attempts: [], result: null, createdAt: new Date().toISOString() };
  investigations.enqueue(record, 'seed-only', 'seed-only');
  investigations.close();
  db.close();
  let app = openApplication(data);
  try {
    const get = () => app.dispatch.dispatch(context, { operation: 'investigate.get', scope,
      payload: { workingCopyId, requestId: record.id } });
    assert.equal((await get() as InvestigationRecord).id, record.id);
    await assert.rejects(app.dispatch.dispatch(context, { operation: 'investigate.submit', scope,
      idempotencyKey: 'submit', payload: { workingCopyId, input: { contextRevisionId: 'ctx_a',
        snapshotRef: snapshotId, question: 'Trace flow', scope: { paths: [], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'], parentInvestigationId: null } } }), /NOT_AVAILABLE/);
    const cancelled = await app.dispatch.dispatch(context, { operation: 'investigate.cancel', scope,
      idempotencyKey: 'cancel', payload: { workingCopyId, requestId: record.id } }) as InvestigationRecord;
    assert.equal(cancelled.state, 'cancelled');
    app.close();
    app = openApplication(data);
    assert.equal((await get() as InvestigationRecord).state, 'cancelled');
    const check = new SqliteInvestigationStore(file);
    try { assert.deepEqual(check.listPending(), []); }
    finally { check.close(); }
    const security = new SqliteStore(file);
    let authorityChecks = 0;
    try {
      const racingContext = { ...context, assertFreshAuthority: async () => {
        authorityChecks++;
        if (authorityChecks === 8) security.revokeGrant('grant-data', new Date().toISOString());
      } };
      await assert.rejects(app.dispatch.dispatch(racingContext, { operation: 'investigate.get', scope,
        payload: { workingCopyId, requestId: record.id } }), /NOT_AVAILABLE|Resource or operation/);
      assert.ok(authorityChecks >= 8);
    }
    finally { security.close(); }
    const security2 = new SqliteStore(file);
    try {
      security2.insertGrant({ id: 'grant-data-2', principal: context.principal, audience: context.audience,
        recipient: context.recipient, workspaceId, collaborationId, permissions: ['data.read'],
        dataPaths: ['src/provenance.ts'], expiresAt: null, revokedAt: null });
      let resultChecks = 0;
      const racingContext = { ...context, assertFreshAuthority: async () => {
        resultChecks++;
        if (resultChecks === 8) security2.revokeGrant('grant-data-2', new Date().toISOString());
      } };
      await assert.rejects(app.dispatch.dispatch(racingContext, { operation: 'investigate.result', scope,
        payload: { workingCopyId, requestId: record.id } }), /NOT_AVAILABLE|Resource or operation/);
      assert.ok(resultChecks >= 8);
    } finally { security2.close(); }
    const security3 = new SqliteStore(file);
    try {
      security3.insertGrant({ id: 'grant-data-3', principal: context.principal, audience: context.audience,
        recipient: context.recipient, workspaceId, collaborationId, permissions: ['data.read'],
        dataPaths: ['src/provenance.ts'], expiresAt: null, revokedAt: null });
      let investigationChecks = 0;
      const racingContext = { ...context, assertFreshAuthority: async () => {
        investigationChecks++;
        if (investigationChecks === 8) security3.revokeGrant('grant-investigate', new Date().toISOString());
      } };
      await assert.rejects(app.dispatch.dispatch(racingContext, { operation: 'investigate.get', scope,
        payload: { workingCopyId, requestId: record.id } }), /NOT_AVAILABLE|Resource or operation/);
      assert.ok(investigationChecks >= 8);
    } finally { security3.close(); }
    const security4 = new SqliteStore(file);
    try {
      security4.insertGrant({ id: 'grant-investigate-2', principal: context.principal,
        audience: context.audience, recipient: context.recipient, workspaceId, collaborationId,
        permissions: ['investigation.read'], expiresAt: null, revokedAt: null });
      let resultChecks = 0;
      const racingContext = { ...context, assertFreshAuthority: async () => {
        resultChecks++;
        if (resultChecks === 8) security4.revokeGrant('grant-investigate-2', new Date().toISOString());
      } };
      await assert.rejects(app.dispatch.dispatch(racingContext, { operation: 'investigate.result', scope,
        payload: { workingCopyId, requestId: record.id } }), /NOT_AVAILABLE|Resource or operation/);
      assert.ok(resultChecks >= 8);
    } finally { security4.close(); }
    await assert.rejects(get(), /NOT_AVAILABLE|Resource or operation/);
    await assert.rejects(app.dispatch.dispatch({ ...context, recipient: 'other' },
      { operation: 'investigate.get', scope, payload: { workingCopyId, requestId: record.id } }), /NOT_AVAILABLE|Resource or operation/);
  } finally { app.close(); rmSync(data, { recursive: true, force: true }); }
});

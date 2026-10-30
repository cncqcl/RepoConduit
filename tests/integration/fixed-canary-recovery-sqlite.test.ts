import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { WslLaunchGateDescriptor } from '../../src/adapters/codex/investigator/launch-gate.js';
import { SqliteInvestigationStore, type InvestigationClaim, type WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { createFixedCanaryTerminationTickets } from '../../src/runtime/fixed-canary-termination-tickets.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rcac-canary-sqlite-'));
  const file = join(root, 'state.sqlite');
  const base = new SqliteStore(file);
  const tickets = createFixedCanaryTerminationTickets();
  const verifiedReceipts: string[] = [];
  const authority = { verifyIsolation: (evidence: string) => evidence === 'offline-fixture',
    verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
    verifyWslTerminationReceipt: (claim: InvestigationClaim, resource: WslResource, receipt: string) => {
      const verified = tickets.verify(claim, resource, receipt);
      if (verified) verifiedReceipts.push(receipt);
      return verified;
    } };
  const store = new SqliteInvestigationStore(file, authority);
  const db = new DatabaseSync(file);
  t.after(() => {
    db.close(); store.close(); base.close();
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + '/rcac-canary-sqlite-') ||
      resolve(root).startsWith(resolve(tmpdir()) + '\\rcac-canary-sqlite-'), true);
    rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'synthetic', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'canary', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'grant', principal: 'p', audience: 'external', workspaceId,
    collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId,
    collaborationId: 'col', recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'],
    expiresAt: null, revokedAt: null });
  const now = new Date(Date.now() - 31_000);
  const record: InvestigationRecord = { id: `inv_${randomUUID()}`, workspaceId,
    collaborationId: 'col', workingCopyId: 'copy', principal: 'p', audience: 'external', recipient: 'ext',
    grantId: 'grant', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'offline recovery wiring', scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  store.enqueue(record, record.id, record.id);
  const claimInput = { workerId: 'original', isolationEvidence: 'offline-fixture', profileRevision: 'fixed',
    permissionEpoch: 0, now, launchProtocol: 'resource_reservation_v1' as const };
  const claimed = store.claimRequest(record.id, claimInput);
  assert.ok(claimed);
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const observation = { invocationId: 'a'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` };
  const reserved = store.reserveWslResource(claimed, { unitName, distro: 'Ubuntu', uid: 1000,
    bootId: '00000000-0000-4000-8000-000000000001', gate: { protocol: 'attempt_gate_v1',
      payloadKind: 'canary_v1', linuxUser: 'fixture', root: '/home/fixture/gates' } }, now);
  const claim = store.observeWslResource(reserved, observation, now);
  const pending = { ...record, id: `inv_${randomUUID()}` };
  store.enqueue(pending, pending.id, pending.id);
  const gates = { close: async (descriptor: WslLaunchGateDescriptor) => ({
    kind: 'closed_consumed' as const, attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
    bootId: descriptor.bootId, uid: descriptor.uid, unitName: descriptor.unitName, ...observation,
  }) };
  return { file, store, db, authority, tickets, verifiedReceipts, now, claim, pending, claimInput, gates };
}

test('real SQLite and one-use tickets settle consumed canary and release its workspace slot', async t => {
  const f = fixture(t);
  let issued: { claim: InvestigationClaim; receipt: string } | undefined;
  let observations = 0;
  await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], f.gates, undefined, undefined, {
    observe: async resource => { observations++; return { kind: 'fixed_canary_terminal', resource }; },
    issue: (claim, observation) => {
      const receipt = f.tickets.issue(claim, observation);
      issued = { claim, receipt };
      return receipt;
    },
    revoke: f.tickets.revoke,
  });
  assert.equal(observations, 1);
  assert.ok(issued);
  assert.deepEqual(f.verifiedReceipts, [issued.receipt]);
  assert.equal(issued.claim.launchProtocol, 'resource_reservation_v1');
  assert.equal(issued.claim.workerEpoch, f.claim.workerEpoch + 1);
  assert.ok(issued.claim.wslResource);
  assert.equal(f.tickets.verify(issued.claim, issued.claim.wslResource, issued.receipt), false);
  const reopened = new SqliteInvestigationStore(f.file, f.authority);
  try {
    const recovered = reopened.get(f.claim.requestId);
    assert.equal(recovered?.state, 'failed');
    assert.equal(recovered.result, null);
    assert.equal(recovered.attempts[0]?.terminationConfirmed, true);
    assert.equal(reopened.listUnsettled().length, 0);
    assert.equal(reopened.claimRequest(f.pending.id, { ...f.claimInput, now: new Date() })?.requestId, f.pending.id);
  } finally { reopened.close(); }
});

test('real SQLite rejects a ticket from a superseded cleanup epoch and accepts fresh observation', t => {
  const f = fixture(t);
  const firstTime = new Date(f.now.getTime() + 31_000);
  const old = f.store.acquireWslCleanupLease(f.claim, 'cleanup-old', firstTime);
  assert.ok(old?.wslResource);
  const receipt = f.tickets.issue(old, { kind: 'fixed_canary_terminal', resource: old.wslResource });
  const nextTime = new Date(firstTime.getTime() + 121_000);
  const current = f.store.acquireWslCleanupLease(old, 'cleanup-new', nextTime);
  assert.ok(current?.wslResource);
  assert.equal(current.workerEpoch, old.workerEpoch + 1);
  assert.throws(() => f.store.finishWslCleanup(old, receipt, nextTime), StoreConflict);
  assert.throws(() => f.store.finishWslCleanup(current, receipt, nextTime), /NOT_AVAILABLE/);
  assert.equal(f.store.listUnsettled()[0]?.workerEpoch, current.workerEpoch);
  assert.equal(f.store.get(f.claim.requestId)?.attempts[0]?.terminationConfirmed, false);
  assert.equal(f.store.claimRequest(f.pending.id, { ...f.claimInput, now: nextTime }), null);
  f.tickets.revoke(receipt);
  const fresh = f.tickets.issue(current, { kind: 'fixed_canary_terminal', resource: current.wslResource });
  assert.equal(f.store.finishWslCleanup(current, fresh, nextTime).state, 'failed');
  assert.equal(f.store.listUnsettled().length, 0);
  assert.equal(f.tickets.verify(current, current.wslResource, fresh), false);
});

test('SQLite failure after receipt consumption rolls back terminal writes and retains the slot', async t => {
  const f = fixture(t);
  // Fail the last statement of the actual terminal transaction, after its record
  // update and outbox deletion. This does not replace finishWslCleanup.
  f.db.exec(`CREATE TRIGGER reject_terminal_delete BEFORE DELETE ON investigation_active_attempts
    BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END`);
  let issued: { claim: InvestigationClaim; receipt: string } | undefined;
  await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], f.gates, undefined, undefined, {
    observe: async resource => ({ kind: 'fixed_canary_terminal', resource }),
    issue: (claim, observation) => {
      const receipt = f.tickets.issue(claim, observation);
      issued = { claim, receipt };
      return receipt;
    },
    revoke: f.tickets.revoke,
  });
  assert.ok(issued?.claim.wslResource);
  assert.deepEqual(f.verifiedReceipts, [issued.receipt]);
  assert.equal(f.tickets.verify(issued.claim, issued.claim.wslResource, issued.receipt), false);
  assert.ok(f.db.prepare('SELECT 1 FROM investigation_outbox WHERE request_id=?').get(f.claim.requestId));
  const reopened = new SqliteInvestigationStore(f.file, f.authority);
  try {
    const retained = reopened.get(f.claim.requestId);
    assert.equal(retained?.state, 'recovery_required');
    assert.equal(retained.result, null);
    assert.equal(retained.attempts[0]?.terminationConfirmed, false);
    assert.equal(retained.attempts[0]?.finishedAt, null);
    assert.equal(reopened.listUnsettled().length, 1);
    assert.equal(reopened.claimRequest(f.pending.id, { ...f.claimInput, now: new Date() }), null);
  } finally { reopened.close(); }
});

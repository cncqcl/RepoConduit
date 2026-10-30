import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../../src/core/investigation/fixed-zero-model-profile.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';
import { createSupervisorV2TerminationTickets } from
  '../../src/runtime/supervisor-v2-termination-tickets.js';

function fixture(observedInitially = false) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-v2-recover-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const tickets = createSupervisorV2TerminationTickets();
  const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => false,
    verifyOutcomeReceipt: () => false,
    verifySupervisorV2TerminalReceipt: tickets.verify };
  const store = new SqliteInvestigationStore(file, authority);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'test', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const at = new Date(Date.now() - 31_000);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'test', scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest('inv', { workerId: 'original', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const launch = { workerEpoch: claim.workerEpoch, sourceDigest: 'a'.repeat(64),
    profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST, action: 'fixed_zero_model_v1' as const };
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
    bootId: randomUUID(), gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: '/home/investigator/private-gate', payloadKind: 'native_supervisor_v2' as const, launch } };
  let current = store.reserveWslResource(claim, reservation, at);
  const descriptor = { distro: 'Ubuntu', linuxUser: 'investigator', uid: 1000,
    attemptId: claim.attemptId, workspaceId, workerEpoch: claim.workerEpoch,
    sourceDigest: launch.sourceDigest, bootId: reservation.bootId };
  current = store.reserveSourceView(current, descriptor,
    '/home/investigator/private-source', at, ['src/main.ts']);
  const observed = { invocationId: 'f'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${reservation.unitName}` };
  if (observedInitially) current = store.observeWslResource(current, observed, at);
  current = store.markRecoveryRequired(current, at);
  const events: string[] = [];
  const source = { close: async (value: typeof descriptor) => {
    events.push('source-close');
    return { kind: 'closed' as const, attemptId: value.attemptId, workspaceId: value.workspaceId,
      uid: value.uid, workerEpoch: value.workerEpoch, bootId: value.bootId, digest: value.sourceDigest };
  } };
  const journal = (phase: NativeSupervisorGateState['phase']): NativeSupervisorGateState => ({
    protocol: 'native_supervisor_v2', phase, closed: true, attemptId: claim.attemptId,
    workspaceId, bootId: reservation.bootId, uid: 1000, unitName: reservation.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest,
    ...(phase === 'prepared' ? {} : { ...observed, enterPid: 123, enterStartTicks: 456 }),
  });
  return { dir, base, store, claim: current, tickets, events, source, journal, observed,
    close() { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('closed prepared journal settles without terminal claim and keeps original epoch binding', async () => {
  const f = fixture();
  try {
    await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], undefined,
      f.source, undefined, undefined, { close: async descriptor => {
        f.events.push('gate-close');
        assert.equal(descriptor.launchWorkerEpoch, f.claim.workerEpoch);
        return f.journal('prepared');
      }, observeTerminal: async () => { throw new Error('unexpected terminal'); }, tickets: f.tickets });
    assert.deepEqual(f.events, ['gate-close', 'source-close']);
    const record = f.store.get('inv');
    assert.equal(record?.state, 'failed');
    assert.equal(record?.attempts[0]?.terminationConfirmed, false);
    assert.equal(record?.failureReason, 'closed_before_native_launch');
    assert.equal(f.store.listUnsettled().length, 0);
  } finally { f.close(); }
});

test('closed consumed journal persists original unit, closes source, then settles only with ticket', async () => {
  const f = fixture();
  try {
    await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], undefined,
      f.source, undefined, undefined, { close: async descriptor => {
        f.events.push('gate-close');
        assert.equal(descriptor.launchWorkerEpoch, f.claim.workerEpoch);
        return f.journal('consumed');
      }, observeTerminal: async (resource, journal) => {
        f.events.push('terminal');
        assert.deepEqual({ invocationId: resource.invocationId, controlGroup: resource.controlGroup }, f.observed);
        assert.equal(journal.phase, 'consumed');
        return { kind: 'fixed_zero_model_terminal' as const, resource, journal };
      }, tickets: f.tickets });
    assert.deepEqual(f.events, ['gate-close', 'source-close', 'terminal']);
    const record = f.store.get('inv');
    assert.equal(record?.state, 'failed');
    assert.equal(record?.attempts[0]?.terminationConfirmed, true);
    assert.equal(record?.result, null);
    assert.equal(f.store.listUnsettled().length, 0);
  } finally { f.close(); }
});

test('entered or released closed journal stays occupied and recovery never releases', async () => {
  for (const phase of ['entered', 'released'] as const) {
    const f = fixture();
    try {
      await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], undefined,
        f.source, undefined, undefined, { close: async () => { f.events.push('gate-close');
          return f.journal(phase); }, observeTerminal: async () => {
          f.events.push('terminal'); return { kind: 'unconfirmed' as const }; }, tickets: f.tickets });
      assert.deepEqual(f.events, ['gate-close']);
      assert.equal(f.store.get('inv')?.state, 'recovery_required');
      assert.equal(f.store.listUnsettled().length, 1);
    } finally { f.close(); }
  }
});

test('unconfirmed terminal leaves closed source and occupied slot for later recovery', async () => {
  const f = fixture(true);
  try {
    await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], undefined,
      f.source, undefined, undefined, { close: async () => f.journal('consumed'),
        observeTerminal: async () => ({ kind: 'unconfirmed' }), tickets: f.tickets });
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.listUnsettled()[0]?.sourceView?.closedAt !== null, true);
  } finally { f.close(); }
});

test('changed journal binding or unknown source close never reaches terminal settlement', async () => {
  for (const failure of ['journal', 'source'] as const) {
    const f = fixture(true);
    try {
      const source = failure === 'source' ? { close: async () => {
        f.events.push('source-close');
        return null;
      } } : f.source;
      await runInvestigationCleanupTick(f.store, 'cleanup', undefined, [f.claim], undefined,
        source, undefined, undefined, { close: async () => {
          f.events.push('gate-close');
          const closed = f.journal('consumed');
          return failure === 'journal' ? { ...closed,
            launchWorkerEpoch: closed.launchWorkerEpoch + 1 } : closed;
        }, observeTerminal: async () => { f.events.push('terminal');
          return { kind: 'unconfirmed' as const }; }, tickets: f.tickets });
      assert.equal(f.events.includes('terminal'), false);
      assert.equal(f.store.get('inv')?.state, 'recovery_required');
      assert.equal(f.store.listUnsettled().length, 1);
    } finally { f.close(); }
  }
});

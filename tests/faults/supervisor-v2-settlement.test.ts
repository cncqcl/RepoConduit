import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore, type InvestigationClaim, type NativeSupervisorLaunchBinding,
  type WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import type { NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-29T00:00:00.000Z');
const takeoverAt = new Date(at.getTime() + 30_001);
const finishAt = new Date(takeoverAt.getTime() + 1000);
const digest = 'a'.repeat(64);
const profileDigest = createHash('sha256').update('native_supervisor_v2:fixed_zero_model_v1').digest('hex');

function fixture(kind: 'native_supervisor_v2' | 'canary_v1' = 'native_supervisor_v2',
  options: { legacy?: boolean; observe?: boolean; closeSource?: boolean; verifier?: boolean;
    nativeIntent?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-v2-settle-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'test', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId,
    collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'],
    expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId,
    collaborationId: 'col', recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'],
    expiresAt: null, revokedAt: null });
  const tickets = new Set<string>();
  let verified = 0;
  const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => false,
    verifyOutcomeReceipt: () => false, verifyWslTerminationReceipt: () => true,
    ...(options.verifier === false ? {} : {
      verifySupervisorV2TerminalReceipt: (claim: InvestigationClaim, resource: WslResource,
        launch: NativeSupervisorLaunchBinding, journal: NativeSupervisorGateState, receipt: string) => {
        verified++;
        if (claim.requestId !== 'inv' || resource.invocationId !== 'f'.repeat(32) ||
          resource.unitName !== unitName || launch.profileDigest !== profileDigest ||
          journal.phase !== 'consumed' || !journal.closed ||
          !tickets.has(receipt)) return false;
        tickets.delete(receipt);
        return true;
      },
    }) };
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request',
    profileRef: 'fixed', budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'test',
    scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const launch: NativeSupervisorLaunchBinding = { workerEpoch: claim.workerEpoch,
    sourceDigest: digest, profileDigest, action: 'fixed_zero_model_v1' };
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const reservation = { unitName, distro: 'Ubuntu', uid: 1000, bootId: randomUUID(),
    gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: '/home/investigator/private-gate', payloadKind: kind,
      ...(kind === 'native_supervisor_v2' && !options.legacy ? { launch } : {}) } };
  let current = store.reserveWslResource(claim, reservation, at);
  const descriptor = { attemptId: claim.attemptId, workspaceId, workerEpoch: claim.workerEpoch,
    sourceDigest: digest, distro: reservation.distro, linuxUser: 'investigator',
    uid: reservation.uid, bootId: reservation.bootId };
  current = store.reserveSourceView(current, descriptor, '/home/investigator/private-source',
    at, ['src/main.ts']);
  if (options.nativeIntent) store.beginNativeThreadIntent(current, 'col', at);
  if (options.observe !== false) current = store.observeWslResource(current, { invocationId: 'f'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` }, at);
  current = store.markRecoveryRequired(current, at);
  const cleanup = store.acquireWslCleanupLease(current, 'cleanup', takeoverAt)!;
  const settledClaim = options.closeSource === false ? cleanup :
    store.confirmSourceViewClosed(cleanup, { kind: 'closed', attemptId: claim.attemptId,
      workspaceId, uid: 1000, workerEpoch: claim.workerEpoch, bootId: reservation.bootId,
      digest }, takeoverAt);
  const ticket = randomUUID();
  tickets.add(ticket);
  const journal: NativeSupervisorGateState = { protocol: 'native_supervisor_v2',
    phase: 'consumed', closed: true, attemptId: claim.attemptId, workspaceId,
    bootId: reservation.bootId, uid: reservation.uid, unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: digest, profileDigest,
    invocationId: 'f'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`,
    enterPid: 123, enterStartTicks: 456 };
  return { dir, base, store, claim, cleanup: settledClaim, launch, journal, ticket, tickets,
    verified: () => verified, close() {
      store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
    } };
}

function preparedClosedJournal(f: ReturnType<typeof fixture>): NativeSupervisorGateState {
  return { protocol: 'native_supervisor_v2', phase: 'prepared', closed: true,
    attemptId: f.journal.attemptId, workspaceId: f.journal.workspaceId,
    bootId: f.journal.bootId, uid: f.journal.uid, unitName: f.journal.unitName,
    launchWorkerEpoch: f.launch.workerEpoch, sourceDigest: f.launch.sourceDigest,
    profileDigest: f.launch.profileDigest };
}

test('closed prepared v2 releases an unentered reservation without asserting unit termination', () => {
  const f = fixture('native_supervisor_v2', { observe: false });
  try {
    const done = f.store.settleClosedPreparedSupervisorV2Attempt(f.cleanup, f.launch,
      preparedClosedJournal(f), finishAt);
    assert.equal(done.state, 'failed');
    assert.equal(done.result, null);
    assert.equal(done.failureReason, 'closed_before_native_launch');
    assert.equal(done.attempts[0]?.terminationConfirmed, false);
    assert.equal(done.attempts[0]?.state, 'failed');
    assert.equal(f.verified(), 0);
    assert.equal(f.store.listUnsettled().length, 0);
  } finally { f.close(); }
});

test('native thread intent keeps closed prepared v2 slot occupied', () => {
  const f = fixture('native_supervisor_v2', { observe: false, nativeIntent: true });
  try {
    assert.throws(() => f.store.settleClosedPreparedSupervisorV2Attempt(f.cleanup, f.launch,
      preparedClosedJournal(f), finishAt), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.getNativeJournal(f.cleanup, 'col')?.thread.threadId, null);
  } finally { f.close(); }
});

test('native thread intent keeps closed unconsumed canary slot occupied', () => {
  const f = fixture('canary_v1', { observe: false, nativeIntent: true });
  try {
    const resource = f.cleanup.wslResource!;
    assert.throws(() => f.store.settleClosedUnconsumedWslAttempt(f.cleanup, {
      kind: 'closed_unconsumed', attemptId: f.cleanup.attemptId,
      workspaceId: f.cleanup.workspaceId, bootId: resource.bootId,
      uid: resource.uid, unitName: resource.unitName,
    }, finishAt), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('native thread intent is not settled by an unrelated v2 diagnostic ticket', () => {
  const f = fixture('native_supervisor_v2', { nativeIntent: true });
  try {
    assert.throws(() => f.store.settleSupervisorV2Diagnostic(f.cleanup, f.launch,
      f.journal, f.ticket, finishAt), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('native thread intent is not settled by a generic WSL termination receipt', () => {
  const f = fixture('canary_v1', { nativeIntent: true });
  try {
    assert.throws(() => f.store.finishWslCleanup(f.cleanup, 'unit-terminated', finishAt), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('closed prepared v2 cancellation releases without publishing a result', () => {
  const f = fixture('native_supervisor_v2', { observe: false });
  try {
    f.store.requestCancel(f.store.get('inv')!, 'cancel', 'request');
    const done = f.store.settleClosedPreparedSupervisorV2Attempt(f.cleanup, f.launch,
      preparedClosedJournal(f), finishAt);
    assert.equal(done.state, 'cancelled');
    assert.equal(done.result, null);
    assert.equal(done.attempts[0]?.terminationConfirmed, false);
  } finally { f.close(); }
});

test('closed prepared v2 refuses open, entered, wrong identity, stale lease and observed unit', () => {
  const f = fixture('native_supervisor_v2', { observe: false });
  try {
    const journal = preparedClosedJournal(f);
    const settle = (candidate: NativeSupervisorGateState, claim = f.cleanup,
      launch = f.launch, now = finishAt) =>
      f.store.settleClosedPreparedSupervisorV2Attempt(claim, launch, candidate, now);
    for (const candidate of [
      { ...journal, closed: false },
      { ...journal, phase: 'entered' as const },
      { ...journal, phase: 'released' as const },
      { ...journal, phase: 'consumed' as const },
      { ...journal, attemptId: `attempt_${randomUUID()}` },
      { ...journal, workspaceId: `ws_${randomUUID()}` },
      { ...journal, bootId: randomUUID() },
      { ...journal, sourceDigest: 'b'.repeat(64) },
      { ...journal, invocationId: 'f'.repeat(32) },
    ]) assert.throws(() => settle(candidate), StoreConflict);
    assert.throws(() => settle(journal, { ...f.cleanup, workerEpoch: f.cleanup.workerEpoch - 1 }),
      StoreConflict);
    assert.throws(() => settle(journal, f.cleanup, { ...f.launch,
      profileDigest: 'b'.repeat(64) }), StoreConflict);
    assert.throws(() => settle(journal, f.cleanup, f.launch,
      new Date(takeoverAt.getTime() + 120_000)), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.get('inv')?.result, null);
  } finally { f.close(); }
  const observed = fixture();
  try {
    assert.throws(() => observed.store.settleClosedPreparedSupervisorV2Attempt(observed.cleanup,
      observed.launch, preparedClosedJournal(observed), finishAt), StoreConflict);
    assert.equal(observed.store.listUnsettled().length, 1);
  } finally { observed.close(); }
});

for (const scenario of ['source_open', 'legacy_v2', 'canary'] as const) {
  test(`closed prepared v2 keeps slot occupied for ${scenario}`, () => {
    const f = fixture(scenario === 'canary' ? 'canary_v1' : 'native_supervisor_v2', {
      closeSource: scenario !== 'source_open', observe: false, legacy: scenario === 'legacy_v2',
    });
    try {
      assert.throws(() => f.store.settleClosedPreparedSupervisorV2Attempt(f.cleanup,
        f.launch, preparedClosedJournal(f), finishAt), StoreConflict);
      assert.equal(f.store.listUnsettled().length, 1);
    } finally { f.close(); }
  });
}

test('v2 diagnostic settles only exact terminal ticket with closed source and current cleanup epoch', () => {
  const f = fixture();
  try {
    const done = f.store.settleSupervisorV2Diagnostic(f.cleanup, f.launch, f.journal,
      f.ticket, finishAt);
    assert.equal(done.state, 'failed');
    assert.equal(done.result, null);
    assert.equal(done.attempts[0]?.terminationConfirmed, true);
    assert.equal(done.attempts[0]?.state, 'failed');
    assert.equal(f.verified(), 1);
    assert.equal(f.store.listUnsettled().length, 0);
    assert.throws(() => f.store.settleSupervisorV2Diagnostic(f.cleanup,
      f.launch, f.journal, f.ticket, finishAt), StoreConflict);
  } finally { f.close(); }
});

test('v2 diagnostic cancellation settles as cancelled without publishing result', () => {
  const f = fixture();
  try {
    f.store.requestCancel(f.store.get('inv')!, 'cancel', 'request');
    const done = f.store.settleSupervisorV2Diagnostic(f.cleanup, f.launch, f.journal,
      f.ticket, finishAt);
    assert.equal(done.state, 'cancelled');
    assert.equal(done.result, null);
    assert.equal(done.attempts[0]?.terminationConfirmed, true);
  } finally { f.close(); }
});

test('v2 diagnostic refuses wrong ticket, launch, stale worker and expired cleanup lease', () => {
  const f = fixture();
  try {
    const settle = (claim = f.cleanup, launch = f.launch, ticket: string = f.ticket,
      now = finishAt) => f.store.settleSupervisorV2Diagnostic(claim, launch, f.journal,
      ticket, now);
    assert.throws(() => settle(f.cleanup, f.launch, 'arbitrary'), /NOT_AVAILABLE/);
    assert.throws(() => settle(f.cleanup, { ...f.launch, profileDigest: 'c'.repeat(64) }), StoreConflict);
    assert.throws(() => settle({ ...f.cleanup, workerEpoch: f.cleanup.workerEpoch - 1 }), StoreConflict);
    assert.throws(() => settle({ ...f.cleanup, nativeRef: 'forged' }), StoreConflict);
    assert.throws(() => settle({ ...f.cleanup, launchProtocol: null }), StoreConflict);
    assert.throws(() => settle({ ...f.cleanup, sourceView: { ...f.cleanup.sourceView!,
      closedAt: null } }), StoreConflict);
    assert.throws(() => settle(f.cleanup, f.launch, f.ticket,
      new Date(takeoverAt.getTime() + 120_000)), StoreConflict);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.get('inv')?.result, null);
  } finally { f.close(); }
});

test('v2 diagnostic rejects forged true ticket callback for unconsumed or wrong journal', () => {
  const f = fixture();
  try {
    for (const journal of [
      { ...f.journal, closed: false },
      { ...f.journal, phase: 'entered' as const },
      { ...f.journal, phase: 'released' as const },
      { ...f.journal, attemptId: `attempt_${randomUUID()}` },
      { ...f.journal, workspaceId: `ws_${randomUUID()}` },
      { ...f.journal, invocationId: 'e'.repeat(32) },
      { ...f.journal, sourceDigest: 'b'.repeat(64) },
      { ...f.journal, enterPid: 0 },
    ]) assert.throws(() => f.store.settleSupervisorV2Diagnostic(f.cleanup,
      f.launch, journal, f.ticket, finishAt), StoreConflict);
    assert.equal(f.verified(), 0);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

for (const scenario of ['source_open', 'unit_unobserved', 'legacy_v2', 'canary', 'no_verifier'] as const) {
  test(`v2 diagnostic keeps slot occupied for ${scenario}`, () => {
    const f = fixture(scenario === 'canary' ? 'canary_v1' : 'native_supervisor_v2', {
      closeSource: scenario !== 'source_open', observe: scenario !== 'unit_unobserved',
      legacy: scenario === 'legacy_v2', verifier: scenario !== 'no_verifier',
    });
    try {
      assert.throws(() => f.store.settleSupervisorV2Diagnostic(f.cleanup,
        f.launch, f.journal, f.ticket, finishAt));
      assert.equal(f.verified(), 0);
      assert.equal(f.store.listUnsettled().length, 1);
      assert.equal(f.store.get('inv')?.result, null);
    } finally { f.close(); }
  });
}

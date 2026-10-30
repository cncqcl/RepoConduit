import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import { cleanupInvestigationScratch, reconcileCreatedContainer } from '../../src/adapters/investigator/docker-worker.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord, InvestigationResult } from '../../src/core/investigation/request.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';

function item(id: string, workspaceId: string): InvestigationRecord {
  return { id, workspaceId, collaborationId: `col-${workspaceId}`, workingCopyId: `copy-${workspaceId}`,
    principal: 'p', audience: 'external', recipient: 'ext', grantId: `grant-${workspaceId}`,
    profileRef: 'readonly-v1', budgetRef: 'budget', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 10 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'Trace flow',
    scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-27T00:00:00.000Z' };
}

function seed(file: string): SqliteStore {
  const base = new SqliteStore(file);
  for (const workspaceId of ['a', 'b', 'c']) {
    base.insertWorkspace({ id: workspaceId, name: workspaceId, canonicalRoot: `D:/fixture-${workspaceId}`, registeredBy: 'p' });
    base.insertCollaboration({ id: `col-${workspaceId}`, workspaceId, openedBy: 'p', purpose: 'investigate', hostThreadId: null, state: 'open' });
    base.insertWorkingCopy({ id: `copy-${workspaceId}`, workspaceId, canonicalRoot: `D:/fixture-${workspaceId}` });
    base.insertGrant({ id: `grant-${workspaceId}`, principal: 'p', audience: 'external', workspaceId,
      collaborationId: `col-${workspaceId}`, recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
    base.insertGrant({ id: `read-${workspaceId}`, principal: 'p', audience: 'external', workspaceId,
      collaborationId: `col-${workspaceId}`, recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'],
      expiresAt: null, revokedAt: null });
  }
  return base;
}

const now = new Date('2026-09-27T00:00:01.000Z');
const authority = { verifyIsolation: (evidence: string, record: InvestigationRecord, revision: string) =>
  evidence === 'verified-fixture' && record.profileRef === 'readonly-v1' && revision === 'revision-1',
  verifyNativeReceipt: (_claim: unknown, nativeRef: string, receipt: string) =>
    nativeRef.startsWith('native-') && receipt === `receipt:${nativeRef}`,
  verifyOutcomeReceipt: (_claim: unknown, _result: unknown, nativeRef: string, receipt: string) =>
    nativeRef.startsWith('native-') && receipt === 'confirmed-fixture' };
function claimInput(workerId: string) {
  return { workerId, isolationEvidence: 'verified-fixture', profileRevision: 'revision-1', permissionEpoch: 0, now };
}
function result(claim: { requestId: string; attemptId: string }): InvestigationResult {
  return { requestId: claim.requestId, attemptId: claim.attemptId, resultState: 'completed',
    snapshotRef: 'snap', contextRevisionId: 'ctx', findings: [], evidence: [],
    coverage: { searchedScope: [], excludedCategories: [], truncated: false, missingDependencies: [] },
    openQuestions: [], limitsAndWarnings: [] };
}

const wslReservation = { unitName: 'rcac-investigator-00000000-0000-4000-8000-000000000009.service',
  distro: 'Ubuntu', uid: 1000, bootId: '00000000-0000-4000-8000-000000000010' };
const wslObservation = { invocationId: '00000000000040008000000000000011',
  controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${wslReservation.unitName}` };
const wslAuthority = { ...authority, verifyWslTerminationReceipt: (
  _claim: InvestigationClaim, resource: { unitName: string; distro: string; uid: number; bootId: string;
    invocationId: string | null; controlGroup: string | null }, receipt: string) =>
  receipt === `${resource.unitName}:${resource.distro}:${resource.uid}:${resource.bootId}:${resource.invocationId}:${resource.controlGroup}:empty` };
function wslTerminationReceipt(): string {
  return `${wslReservation.unitName}:${wslReservation.distro}:${wslReservation.uid}:${wslReservation.bootId}:` +
    `${wslObservation.invocationId}:${wslObservation.controlGroup}:empty`;
}
function startWsl(store: SqliteInvestigationStore): InvestigationClaim {
  const claim = store.claimNext(claimInput('worker-1'))!;
  const reserved = store.reserveWslResource(claim, wslReservation, now);
  const observed = store.observeWslResource(reserved, wslObservation, now);
  return store.recordNativeStart(observed, 'native-wsl-thread', 'receipt:native-wsl-thread', now);
}

test('claim requires trusted isolation, then enforces global and per-workspace slots across connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const unverified = new SqliteInvestigationStore(file);
  const store = new SqliteInvestigationStore(file, authority);
  const peer = new SqliteInvestigationStore(file, authority);
  try {
    for (const request of [item('inv-a1', 'a'), item('inv-a2', 'a'), item('inv-b1', 'b'), item('inv-c1', 'c')]) {
      store.enqueue(request, request.id, request.id);
    }
    assert.throws(() => unverified.claimNext(claimInput('worker-0')), /NOT_AVAILABLE/);
    const first = store.claimNext(claimInput('worker-1'))!;
    assert.equal(first.requestId, 'inv-a1');
    const second = peer.claimNext(claimInput('worker-2'))!;
    assert.equal(second.requestId, 'inv-b1');
    assert.equal(store.claimNext(claimInput('worker-3')), null);
    assert.equal(store.get('inv-a2')?.state, 'queued');
    assert.equal(store.get('inv-c1')?.state, 'queued');
  } finally { peer.close(); store.close(); unverified.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart retains start intent and slot; recovery fences old epoch without a new attempt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    store.enqueue(item('inv-b1', 'b'), 'create-b', 'b');
    store.enqueue(item('inv-c1', 'c'), 'create-c', 'c');
    const first = store.claimNext(claimInput('worker-1'))!;
    store.claimNext(claimInput('worker-2'))!;
    store.close();
    store = new SqliteInvestigationStore(file, authority);
    assert.equal(store.listUnsettled().length, 2);
    assert.deepEqual(store.listUnsettled().find(active => active.requestId === first.requestId), first);
    assert.equal(store.claimNext({ ...claimInput('worker-3'), now: new Date(now.getTime() + 120_000) }), null);
    const recovered = store.recoverAttempt(first, { ...claimInput('worker-3'), now: new Date(now.getTime() + 120_000) });
    assert.equal(recovered.attemptId, first.attemptId);
    assert.equal(recovered.workerEpoch, first.workerEpoch + 1);
    assert.equal(recovered.nativeRef, null);
    assert.equal(recovered.phase, 'unknown');
    assert.equal(store.get(first.requestId)?.attempts.length, 1);
    assert.throws(() => store.recordNativeStart(first, 'native-old', 'receipt:native-old', now), StoreConflict);
    assert.throws(() => store.completeAttempt(first, result(first), 'confirmed-fixture', now), StoreConflict);
    assert.equal(store.claimNext({ ...claimInput('worker-4'), now: new Date(now.getTime() + 120_000) }), null);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Docker create name is durably bound to one attempt before the native call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    store.enqueue(item('inv-b1', 'b'), 'create-b', 'b');
    const first = store.claimNext(claimInput('worker-1'))!;
    const second = store.claimNext(claimInput('worker-2'))!;
    const name = 'rcac-investigator-00000000-0000-4000-8000-000000000001';
    const scratchRoot = join(dir, name);
    const reserved = store.reserveContainerName(first, name, scratchRoot, now);
    assert.equal(reserved.containerName, name);
    assert.equal(reserved.scratchRoot, scratchRoot);
    assert.throws(() => store.reserveContainerName(second, name, scratchRoot, now), StoreConflict);
    store.close();
    store = new SqliteInvestigationStore(file, authority);
    assert.equal(store.listUnsettled().find(row => row.attemptId === first.attemptId)?.containerName, name);
    assert.equal(store.reserveContainerName(first, name, scratchRoot, now).containerName, name);
    assert.throws(() => store.reserveContainerName(first, name, join(dir, 'other', name), now), StoreConflict);
    assert.throws(() => store.reserveContainerName(first,
      'rcac-investigator-00000000-0000-4000-8000-000000000002',
      join(dir, 'rcac-investigator-00000000-0000-4000-8000-000000000002'), now), StoreConflict);
    const recovered = store.recoverAttempt(reserved,
      { ...claimInput('worker-3'), now: new Date(now.getTime() + 31_000) });
    assert.equal(recovered.containerName, name);
    assert.equal(recovered.scratchRoot, scratchRoot);
    assert.equal(recovered.phase, 'unknown');
    assert.equal(store.get(first.requestId)?.state, 'recovery_required');
    assert.throws(() => store.reserveContainerName(first, name, scratchRoot, now), StoreConflict);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL transient unit reservation survives restart and fences changed identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  const reservation = { unitName: 'rcac-investigator-00000000-0000-4000-8000-000000000001.service',
    distro: 'Ubuntu', uid: 1000, bootId: '00000000-0000-4000-8000-000000000010',
    gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture',
      root: '/home/fixture/.local/state/rcac/gates', payloadKind: 'canary_v1' as const } };
  const observed = { invocationId: '00000000000040008000000000000011',
    controlGroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/rcac-investigator-00000000-0000-4000-8000-000000000001.service' };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    for (const invalidRoot of ['/mnt/c/rcac/gates', '/home/other/gates',
      '/home/fixture/../gates', '/home/fixture/gates/']) {
      assert.throws(() => store.reserveWslResource(claim, { ...reservation,
        gate: { ...reservation.gate, root: invalidRoot } }, now), /INVALID_ARGUMENT/);
    }
    assert.throws(() => store.reserveWslResource(claim, { ...reservation, gate: {
      ...reservation.gate, payloadKind: 'codex_v1' } as never }, now), /INVALID_ARGUMENT/);
    const reserved = store.reserveWslResource(claim, reservation, now);
    assert.deepEqual(reserved.wslResource, { ...reservation, invocationId: null, controlGroup: null });
    assert.equal(reserved.containerName, undefined);
    assert.equal(reserved.nativeRef, null);
    store.close();
    store = new SqliteInvestigationStore(file, authority);
    assert.deepEqual(store.listUnsettled()[0]?.wslResource, reserved.wslResource);
    assert.deepEqual(store.reserveWslResource(claim, { ...reservation, gate: {
      payloadKind: 'canary_v1', root: reservation.gate.root,
      linuxUser: 'fixture', protocol: 'attempt_gate_v1' } }, now).wslResource, reserved.wslResource);
    assert.throws(() => store.reserveWslResource(claim, { ...reservation, bootId: randomUUID() }, now), StoreConflict);
    assert.throws(() => store.reserveWslResource(claim, { ...reservation, gate: {
      ...reservation.gate, root: '/home/fixture/.local/state/rcac/other' } }, now), StoreConflict);
    assert.throws(() => store.reserveWslResource(claim, { unitName: reservation.unitName,
      distro: reservation.distro, uid: reservation.uid, bootId: reservation.bootId }, now), StoreConflict);
    const dockerName = `rcac-investigator-${randomUUID()}`;
    assert.throws(() => store.reserveContainerName(claim,
      dockerName, join(dir, dockerName), now), StoreConflict);
    const bound = store.observeWslResource(reserved, observed, now);
    assert.deepEqual(bound.wslResource, { ...reservation, ...observed });
    assert.deepEqual(store.listUnsettled()[0]?.wslResource, bound.wslResource);
    assert.throws(() => store.observeWslResource(reserved,
      { ...observed, invocationId: '00000000000040008000000000000012' }, now), StoreConflict);
    assert.equal(store.observeWslResource(reserved, observed, now).wslResource?.invocationId, observed.invocationId);
    const recovered = store.recoverAttempt(bound,
      { ...claimInput('worker-2'), now: new Date(now.getTime() + 31_000) });
    assert.equal(recovered.workerEpoch, claim.workerEpoch + 1);
    assert.equal(recovered.phase, 'reconcile');
    assert.deepEqual(recovered.wslResource, bound.wslResource);
    assert.throws(() => store.observeWslResource(bound, observed, new Date(now.getTime() + 32_000)), StoreConflict);
    assert.equal(store.get(claim.requestId)?.attempts.length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
test(`${payloadKind} survives restart and cannot be substituted with canary kind`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-supervisor-gate-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`,
    distro: 'Ubuntu', uid: 1000, bootId: randomUUID(),
    gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture',
      root: '/home/fixture/.local/state/rcac/gates', payloadKind } };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimRequest('inv-a1', { ...claimInput('worker-1'),
      launchProtocol: 'resource_reservation_v1' })!;
    const reserved = store.reserveWslResource(claim, reservation, now);
    assert.equal(reserved.wslResource?.gate?.payloadKind, payloadKind);
    store.close();
    store = new SqliteInvestigationStore(file, authority);
    assert.deepEqual(store.listUnsettled()[0]?.wslResource?.gate, reservation.gate);
    assert.deepEqual(store.reserveWslResource(claim, reservation, now).wslResource,
      reserved.wslResource);
    assert.throws(() => store.reserveWslResource(claim, { ...reservation,
      gate: { ...reservation.gate, payloadKind: 'canary_v1' } }, now), StoreConflict);
    assert.throws(() => store.reserveWslResource(claim, { ...reservation,
      gate: { ...reservation.gate, payloadKind: payloadKind === 'native_supervisor_v1' ?
        'native_supervisor_v2' : 'native_supervisor_v1' } }, now), StoreConflict);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});
}

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
test(`fixed canary recovery leaves ${payloadKind} attempt and workspace slot occupied`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-supervisor-recovery-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a1', 'a1');
    store.enqueue(item('inv-a2', 'a'), 'create-a2', 'a2');
    const claim = store.claimRequest('inv-a1', { ...claimInput('worker-1'),
      launchProtocol: 'resource_reservation_v1' })!;
    const reserved = store.reserveWslResource(claim, {
      unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
      bootId: randomUUID(), gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture',
        root: '/home/fixture/gates', payloadKind } }, now);
    store.markRecoveryRequired(reserved, now);
    let nativeCalls = 0;
    await runInvestigationCleanupTick(store, 'cleanup', undefined, [reserved], {
      close: async () => { nativeCalls++; return null; },
    }, { close: async () => { nativeCalls++; return null; } });
    assert.equal(nativeCalls, 0);
    const reopened = new SqliteInvestigationStore(file, authority);
    try {
      assert.equal(reopened.get('inv-a1')?.state, 'recovery_required');
      assert.equal(reopened.get('inv-a1')?.result, null);
      assert.equal(reopened.listUnsettled().length, 1);
      assert.equal(reopened.listUnsettled()[0]?.wslResource?.gate?.payloadKind,
        payloadKind);
      assert.equal(reopened.claimRequest('inv-a2', { ...claimInput('worker-2'),
        now: new Date(now.getTime() + 120_000) }), null);
    } finally { reopened.close(); }
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});
}

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
test(`fixed canary terminal settlement cannot release ${payloadKind} with a valid unit ticket`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-supervisor-ticket-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, wslAuthority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a1', 'a1');
    const claim = store.claimRequest('inv-a1', { ...claimInput('worker-1'),
      launchProtocol: 'resource_reservation_v1' })!;
    const reserved = store.reserveWslResource(claim, {
      ...wslReservation, gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture',
        root: '/home/fixture/gates', payloadKind } }, now);
    const observed = store.observeWslResource(reserved, wslObservation, now);
    store.markRecoveryRequired(observed, now);
    const takeover = store.acquireWslCleanupLease(observed, 'cleanup',
      new Date(now.getTime() + 30_001))!;
    assert.throws(() => store.finishWslCleanup(takeover, wslTerminationReceipt(),
      new Date(now.getTime() + 30_001)), StoreConflict);
    assert.equal(store.get('inv-a1')?.state, 'recovery_required');
    assert.equal(store.listUnsettled().length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});
}

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
test(`generic WSL outcome receipts cannot publish or release ${payloadKind}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-supervisor-outcome-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, wslAuthority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a1', 'a1');
    const claim = store.claimRequest('inv-a1', { ...claimInput('worker-1'),
      launchProtocol: 'resource_reservation_v1' })!;
    const reserved = store.reserveWslResource(claim, {
      ...wslReservation, gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture',
        root: '/home/fixture/gates', payloadKind } }, now);
    const observed = store.observeWslResource(reserved, wslObservation, now);
    const started = store.recordNativeStart(observed, 'native-supervisor',
      'receipt:native-supervisor', now);
    assert.throws(() => store.completeWslAttempt(started, result(started),
      'confirmed-fixture', wslTerminationReceipt(), now), StoreConflict);
    assert.equal(store.get('inv-a1')?.state, 'running');
    assert.equal(store.get('inv-a1')?.result, null);
    assert.equal(store.listUnsettled().length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});
}

test('v2 close-only tombstone cannot use fixed-canary unconsumed settlement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-supervisor-v2-settle-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a1', 'a1');
    const claim = store.claimRequest('inv-a1', { ...claimInput('worker-1'),
      launchProtocol: 'resource_reservation_v1' })!;
    const reservation = { ...wslReservation, gate: { protocol: 'attempt_gate_v1' as const,
      linuxUser: 'fixture', root: '/home/fixture/gates', payloadKind: 'native_supervisor_v2' as const } };
    const reserved = store.reserveWslResource(claim, reservation, now);
    const expired = new Date(now.getTime() + 30_001);
    const takeover = store.acquireWslCleanupLease(reserved, 'cleanup', expired)!;
    const closure = { kind: 'closed_unconsumed' as const, attemptId: claim.attemptId,
      workspaceId: claim.workspaceId, bootId: reservation.bootId, uid: reservation.uid,
      unitName: reservation.unitName };
    assert.throws(() => store.settleClosedUnconsumedWslAttempt(takeover, closure, expired),
      StoreConflict);
    assert.equal(store.listUnsettled().length, 1);
    assert.equal(store.get('inv-a1')?.result, null);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy WSL reservation remains ungated after schema migration and rejects later gate substitution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-gate-migration-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu',
    uid: 1000, bootId: randomUUID() };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    store.reserveWslResource(claim, reservation, now);
    store.close();
    base.close();
    const legacy = new DatabaseSync(file);
    try { legacy.exec('ALTER TABLE investigation_active_attempts DROP COLUMN wsl_launch_gate_json'); }
    finally { legacy.close(); }
    store = new SqliteInvestigationStore(file, authority);
    assert.equal(store.listUnsettled()[0]?.wslResource?.gate, undefined);
    assert.throws(() => store.reserveWslResource(claim, { ...reservation,
      gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture',
        root: '/home/fixture/.local/state/rcac/gates', payloadKind: 'canary_v1' } }, now), StoreConflict);
    const db = new DatabaseSync(file);
    try {
      assert.equal((db.prepare(`SELECT wsl_launch_gate_json AS gate FROM investigation_active_attempts`)
        .get() as { gate: string | null }).gate, null);
      db.prepare('UPDATE investigation_active_attempts SET wsl_launch_gate_json=? WHERE request_id=?')
        .run('{"protocol":"future"}', claim.requestId);
      assert.throws(() => store.listUnsettled(), StoreConflict);
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('closed unconsumed WSL gate settles only the fenced reservation without claiming termination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-gate-settle-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  const gate = { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture',
    root: '/home/fixture/.local/state/rcac/gates', payloadKind: 'canary_v1' as const };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimRequest('inv-a1', { ...claimInput('worker-1'),
      launchProtocol: 'resource_reservation_v1' })!;
    const unitName = `rcac-investigator-${randomUUID()}.service`;
    const reservation = { unitName, distro: 'Ubuntu', uid: 1000, bootId: randomUUID(), gate };
    const reserved = store.reserveWslResource(claim, reservation, now);
    const closure = { kind: 'closed_unconsumed' as const, attemptId: claim.attemptId,
      workspaceId: claim.workspaceId, bootId: reservation.bootId, uid: 1000, unitName };
    assert.throws(() => store.settleClosedUnconsumedWslAttempt(reserved, closure, now), StoreConflict);
    const expired = new Date(now.getTime() + 30_001);
    const takeover = store.acquireWslCleanupLease(reserved, 'recovery', expired)!;
    assert.equal(takeover.workerEpoch, claim.workerEpoch + 1);
    assert.throws(() => store.settleClosedUnconsumedWslAttempt(reserved, closure, expired), StoreConflict);
    assert.throws(() => store.settleClosedUnconsumedWslAttempt(takeover,
      { ...closure, kind: 'closed_consumed' as 'closed_unconsumed' }, expired), StoreConflict);
    assert.throws(() => store.settleClosedUnconsumedWslAttempt(takeover,
      { ...closure, bootId: randomUUID() }, expired), StoreConflict);
    const settled = store.settleClosedUnconsumedWslAttempt(takeover, closure, expired);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'closed_before_native_launch');
    assert.equal(settled.result, null);
    assert.equal(settled.attempts[0]?.terminationConfirmed, false);
    assert.equal(settled.attempts[0]?.startedAt, null);
    assert.deepEqual(store.listUnsettled(), []);
    assert.throws(() => store.settleClosedUnconsumedWslAttempt(takeover, closure, expired), StoreConflict);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL unit names are unique across live attempts and observations require exact reserved identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  const reservation = { unitName: 'rcac-investigator-00000000-0000-4000-8000-000000000002.service',
    distro: 'Ubuntu', uid: 1000, bootId: '00000000-0000-4000-8000-000000000010' };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    store.enqueue(item('inv-b1', 'b'), 'create-b', 'b');
    const first = store.claimNext(claimInput('worker-1'))!;
    const second = store.claimNext(claimInput('worker-2'))!;
    store.reserveWslResource(first, reservation, now);
    assert.throws(() => store.reserveWslResource(second, reservation, now), StoreConflict);
    assert.throws(() => store.observeWslResource(second, { invocationId: '00000000000040008000000000000011',
      controlGroup: '/system.slice/nope.service' }, now), StoreConflict);
    assert.throws(() => store.observeWslResource(first, { invocationId: '00000000000040008000000000000011',
      controlGroup: '/system.slice/nope.service' }, now), StoreConflict);
    for (const controlGroup of [
      `/user.slice/user-1000.slice/user@1000.service/app.slice/../${reservation.unitName}`,
      `/user.slice/./user-1000.slice/user@1000.service/app.slice/${reservation.unitName}`,
      `/system.slice/${reservation.unitName}`,
      `/user.slice/user-2000.slice/user@2000.service/app.slice/${reservation.unitName}`,
    ]) {
      assert.throws(() => store.observeWslResource(first,
        { invocationId: '00000000000040008000000000000011', controlGroup }, now));
    }
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL cleanup takeover requires an exact verified termination receipt and current epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const verifiedAuthority = { ...authority, verifyWslTerminationReceipt: (
    _claim: unknown, resource: { bootId: string; uid: number; invocationId: string | null; controlGroup: string | null },
    receipt: string) => receipt === `${resource.bootId}:${resource.uid}:${resource.invocationId}:${resource.controlGroup}:empty` };
  const store = new SqliteInvestigationStore(file, verifiedAuthority);
  const reservation = { unitName: 'rcac-investigator-00000000-0000-4000-8000-000000000003.service',
    distro: 'Ubuntu', uid: 1000, bootId: '00000000-0000-4000-8000-000000000010' };
  const observed = { invocationId: '00000000000040008000000000000011',
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${reservation.unitName}` };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    const reserved = store.reserveWslResource(claim, reservation, now);
    assert.throws(() => store.recordNativeStart(reserved, 'native-too-early', 'receipt:native-too-early', now), StoreConflict);
    const bound = store.observeWslResource(reserved, observed, now);
    const started = store.recordNativeStart(bound, 'native-wsl-thread', 'receipt:native-wsl-thread', now);
    assert.equal(started.nativeRef, 'native-wsl-thread');
    assert.throws(() => store.completeAttempt(started, result(started), 'confirmed-fixture', now), StoreConflict);
    assert.equal(store.listUnsettled().length, 1);
    assert.equal(store.acquireWslCleanupLease(bound, 'worker-2', new Date(now.getTime() + 29_000)), null);
    const cleanup = store.acquireWslCleanupLease(started, 'worker-2', new Date(now.getTime() + 31_000))!;
    assert.equal(cleanup.phase, 'reconcile');
    assert.equal(cleanup.nativeRef, 'native-wsl-thread');
    assert.equal(cleanup.workerEpoch, bound.workerEpoch + 1);
    assert.throws(() => store.finishWslCleanup(bound, 'anything', new Date(now.getTime() + 32_000)), StoreConflict);
    assert.throws(() => store.finishWslCleanup(cleanup, 'fake:empty', new Date(now.getTime() + 32_000)), /NOT_AVAILABLE/);
    assert.equal(store.listUnsettled().length, 1);
    const receipt = `${reservation.bootId}:${reservation.uid}:${observed.invocationId}:${observed.controlGroup}:empty`;
    assert.equal(store.finishWslCleanup(cleanup, receipt, new Date(now.getTime() + 32_000)).state, 'failed');
    assert.equal(store.listUnsettled().length, 0);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL reservation-only recovery keeps the slot until an observed identity can be reconciled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  const reservation = { unitName: 'rcac-investigator-00000000-0000-4000-8000-000000000004.service',
    distro: 'Ubuntu', uid: 1000, bootId: '00000000-0000-4000-8000-000000000010' };
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.reserveWslResource(store.claimNext(claimInput('worker-1'))!, reservation, now);
    const recovered = store.recoverAttempt(claim, { ...claimInput('worker-2'), now: new Date(now.getTime() + 31_000) });
    assert.equal(recovered.phase, 'unknown');
    assert.equal(store.acquireWslCleanupLease(recovered, 'worker-3', new Date(now.getTime() + 60_000)), null);
    assert.throws(() => store.finishWslCleanup(recovered, 'true', new Date(now.getTime() + 32_000)), StoreConflict);
    const observed = { invocationId: '00000000000040008000000000000011',
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${reservation.unitName}` };
    const bound = store.observeWslResource(recovered, observed, new Date(now.getTime() + 32_000));
    assert.equal(bound.wslResource?.invocationId, observed.invocationId);
    const cleanup = store.acquireWslCleanupLease(bound, 'worker-3', new Date(now.getTime() + 62_000))!;
    assert.throws(() => store.finishWslCleanup(cleanup, 'true', new Date(now.getTime() + 63_000)), /NOT_AVAILABLE/);
    assert.equal(store.listUnsettled().length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL completion requires both receipts and exact persisted unit identity in one slot release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-complete-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, wslAuthority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    store.enqueue(item('inv-a2', 'a'), 'create-a2', 'a2');
    const started = startWsl(store);
    const outcome = result(started);
    const terminal = wslTerminationReceipt();
    assert.throws(() => store.completeAttempt(started, outcome, 'confirmed-fixture', now), StoreConflict);
    assert.throws(() => store.completeWslAttempt(started, outcome, 'confirmed-fixture', '', now));
    assert.throws(() => store.completeWslAttempt(started, outcome, 'confirmed-fixture', 'wrong-unit:empty', now), /NOT_AVAILABLE/);
    assert.throws(() => store.completeWslAttempt(started, outcome, 'wrong-outcome', terminal, now), /NOT_AVAILABLE/);
    assert.throws(() => store.completeWslAttempt(started, { ...outcome, snapshotRef: 'other-snapshot' },
      'confirmed-fixture', terminal, now), StoreConflict);
    const noTerminationVerifier = new SqliteInvestigationStore(file, authority);
    try {
      assert.throws(() => noTerminationVerifier.completeWslAttempt(started, outcome,
        'confirmed-fixture', terminal, now), /NOT_AVAILABLE/);
    } finally { noTerminationVerifier.close(); }
    assert.throws(() => store.completeWslAttempt({ ...started,
      wslResource: { ...started.wslResource!, bootId: randomUUID() } },
    outcome, 'confirmed-fixture', terminal, now), StoreConflict);
    assert.equal(store.listUnsettled().length, 1);
    assert.equal(store.get(started.requestId)?.result, null);
    assert.equal(store.claimRequest('inv-a2', claimInput('worker-2')), null);
    const completed = store.completeWslAttempt(started, outcome, 'confirmed-fixture', terminal, now);
    assert.equal(completed.state, 'completed');
    assert.deepEqual(completed.result, outcome);
    assert.equal(completed.attempts[0]?.terminationConfirmed, true);
    assert.equal(store.listUnsettled().length, 0);
    assert.equal(store.claimRequest('inv-a2', claimInput('worker-2'))?.requestId, 'inv-a2');
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL completion fences stale epoch and suppresses result after grant revocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-complete-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, wslAuthority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const started = startWsl(store);
    assert.throws(() => store.completeWslAttempt(started, result(started), 'confirmed-fixture',
      wslTerminationReceipt(), new Date(now.getTime() + 30_000)), StoreConflict);
    const recovered = store.recoverAttempt(started,
      { ...claimInput('worker-2'), now: new Date(now.getTime() + 31_000) });
    const afterRecovery = new Date(now.getTime() + 32_000);
    assert.throws(() => store.completeWslAttempt(started, result(started), 'confirmed-fixture',
      wslTerminationReceipt(), afterRecovery), StoreConflict);
    base.revokeGrant('grant-a', new Date().toISOString());
    const privateResult = { ...result(recovered), findings: [{ statement: 'private finding',
      classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = store.completeWslAttempt(recovered, privateResult, 'confirmed-fixture',
      wslTerminationReceipt(), afterRecovery);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'authorization_changed');
    assert.equal(settled.result, null);
    assert.equal(settled.attempts[0]?.terminationConfirmed, true);
    assert.equal(store.listUnsettled().length, 0);
    assert.equal(JSON.stringify(store.get(started.requestId)).includes('private finding'), false);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL verified cancelled outcome preserves cancellation intent and releases its slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-complete-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, wslAuthority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const started = startWsl(store);
    store.requestCancel(store.get(started.requestId)!, 'cancel-a', 'grant-a');
    const cancelled = store.completeWslAttempt(started,
      { ...result(started), resultState: 'cancelled' }, 'confirmed-fixture', wslTerminationReceipt(), now);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.attempts[0]?.terminationConfirmed, true);
    assert.equal(store.listUnsettled().length, 0);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL cancellation wins over late completed or failed outcome after exact terminal proof', () => {
  for (const resultState of ['completed', 'failed'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-cancel-race-'));
    const file = join(dir, 'state.sqlite');
    const base = seed(file);
    const store = new SqliteInvestigationStore(file, wslAuthority);
    try {
      store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
      const started = startWsl(store);
      store.requestCancel(store.get(started.requestId)!, 'cancel-a', 'grant-a');
      const late = { ...result(started), resultState,
        findings: [{ statement: 'late private finding', classification: 'source_confirmed' as const, evidenceRefs: [] }] };
      const settled = store.completeWslAttempt(started, late, 'confirmed-fixture', wslTerminationReceipt(), now);
      assert.equal(settled.state, 'cancelled', resultState);
      assert.equal(settled.result, null, resultState);
      assert.equal(settled.cancelRequested, true, resultState);
      assert.equal(settled.attempts[0]?.state, resultState);
      assert.equal(settled.attempts[0]?.terminationConfirmed, true);
      assert.equal(JSON.stringify(store.get(started.requestId)).includes('late private finding'), false);
      assert.deepEqual(store.listUnsettled(), []);
    } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('WSL completion committed before cancel remains completed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-cancel-race-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, wslAuthority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const started = startWsl(store);
    const completed = store.completeWslAttempt(started, result(started),
      'confirmed-fixture', wslTerminationReceipt(), now);
    const afterCancel = store.requestCancel(completed, 'cancel-a', 'grant-a');
    assert.equal(afterCancel.state, 'completed');
    assert.equal(afterCancel.cancelRequested, false);
    assert.deepEqual(afterCancel.result, result(started));
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WSL verified termination still suppresses results after permission epoch or read-scope changes', () => {
  for (const mode of ['epoch', 'scope'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-wsl-complete-'));
    const file = join(dir, 'state.sqlite');
    const base = seed(file);
    const store = new SqliteInvestigationStore(file, wslAuthority);
    const db = new DatabaseSync(file);
    try {
      store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
      const started = startWsl(store);
      if (mode === 'epoch') db.prepare('INSERT INTO permission_epochs(principal,audience,workspace_id,epoch) VALUES (?,?,?,?)')
        .run('p', 'external', 'a', 1);
      const privateResult = { ...result(started), findings: [{ statement: 'do not disclose',
        classification: 'source_confirmed' as const, evidenceRefs: [] }],
      coverage: { ...result(started).coverage, searchedScope: mode === 'scope' ? ['other/secret.ts'] : [] } };
      const settled = store.completeWslAttempt(started, privateResult, 'confirmed-fixture', wslTerminationReceipt(), now);
      assert.equal(settled.state, 'failed');
      assert.equal(settled.failureReason, 'authorization_changed');
      assert.equal(settled.result, null);
      assert.equal(settled.attempts[0]?.terminationConfirmed, true);
      assert.equal(JSON.stringify(store.get(started.requestId)).includes('do not disclose'), false);
      assert.equal(store.listUnsettled().length, 0);
    } finally { db.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('legacy Docker active-attempt schema migrates without losing Docker recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-legacy-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
  store.enqueue(item('inv-a2', 'a'), 'create-a2', 'a2');
  const claim = store.claimNext(claimInput('worker-1'))!;
  const name = `rcac-investigator-${randomUUID()}`;
  store.reserveContainerName(claim, name, join(dir, name), now);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`ALTER TABLE investigation_active_attempts RENAME TO investigation_active_attempts_new;
    CREATE TABLE investigation_active_attempts (
    request_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
    worker_id TEXT NOT NULL, worker_epoch INTEGER NOT NULL, phase TEXT NOT NULL,
    native_ref TEXT, container_name TEXT, container_id TEXT, scratch_root TEXT,
    lease_until TEXT NOT NULL, profile_revision TEXT NOT NULL,
    permission_epoch INTEGER NOT NULL, isolation_evidence TEXT NOT NULL
  );
    INSERT INTO investigation_active_attempts
      (request_id,attempt_id,workspace_id,worker_id,worker_epoch,phase,native_ref,
       container_name,container_id,scratch_root,lease_until,profile_revision,permission_epoch,isolation_evidence)
    SELECT request_id,attempt_id,workspace_id,worker_id,worker_epoch,phase,native_ref,
       container_name,container_id,scratch_root,lease_until,profile_revision,permission_epoch,isolation_evidence
    FROM investigation_active_attempts_new;
    DROP TABLE investigation_active_attempts_new;`);
  db.close();
  store = new SqliteInvestigationStore(file, authority);
  try {
    assert.equal(store.listUnsettled()[0]?.containerName, name);
    assert.equal(store.listUnsettled()[0]?.wslResource, undefined);
    assert.equal(store.listUnsettled()[0]?.attemptId, claim.attemptId);
    assert.equal(store.claimRequest('inv-a2', claimInput('worker-2')), null);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart uses the persisted scratch root after TEMP changes and preserves other attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  let store = new SqliteInvestigationStore(file, authority);
  const name = `rcac-investigator-${randomUUID()}`;
  const unrelated = `rcac-investigator-${randomUUID()}`;
  const root = join(dir, 'temp-a', name);
  const otherRoot = join(dir, 'temp-a', unrelated);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    store.reserveContainerName(claim, name, root, now);
    for (const scratchRoot of [root, otherRoot]) {
      mkdirSync(join(scratchRoot, 'snapshot'), { recursive: true, mode: 0o700 });
      writeFileSync(join(scratchRoot, 'snapshot', 'source.txt'), 'synthetic snapshot bytes');
    }
    store.close();
    store = new SqliteInvestigationStore(file, authority);
    const saved = store.listUnsettled().find(row => row.attemptId === claim.attemptId)!;
    assert.equal(saved.scratchRoot, root);
    const previousTemp = process.env.TEMP;
    process.env.TEMP = join(dir, 'temp-b');
    try {
      if (process.platform === 'win32') await assert.rejects(
        cleanupInvestigationScratch(saved.containerName!, saved.scratchRoot!), /RECOVERY_REQUIRED/);
      else await cleanupInvestigationScratch(saved.containerName!, saved.scratchRoot!);
    }
    finally { if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp; }
    assert.equal(existsSync(root), process.platform === 'win32');
    assert.equal(existsSync(otherRoot), true);
    assert.equal(store.get(claim.requestId)?.attempts.length, 1);
    await assert.rejects(cleanupInvestigationScratch('../other', root), /INVALID_ARGUMENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('restart reconciles a real Docker container by the persisted exact attempt name',
  async t => {
    let imageId: string;
    try { imageId = execFileSync('docker', ['image', 'inspect', 'alpine:3.20', '--format', '{{.Id}}'],
      { encoding: 'utf8' }).trim(); }
    catch { t.skip('alpine:3.20 image is unavailable'); return; }
    const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
    const file = join(dir, 'state.sqlite');
    const base = seed(file);
    let store = new SqliteInvestigationStore(file, authority);
    const name = `rcac-investigator-${randomUUID()}`;
    const unrelated = `rcac-investigator-${randomUUID()}`;
    try {
      store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
      const claim = store.claimNext(claimInput('worker-1'))!;
      store.reserveContainerName(claim, name, join(dir, name), now);
      for (const containerName of [name, unrelated]) {
        const created = spawnSync('docker', ['create', '--name', containerName, imageId!, '/bin/true'],
          { encoding: 'utf8', timeout: 20_000 });
        assert.equal(created.status, 0, created.stderr || String(created.error));
      }
      store.close();
      store = new SqliteInvestigationStore(file, authority);
      const saved = store.listUnsettled().find(row => row.attemptId === claim.attemptId)!;
      assert.equal(saved.containerName, name);
      await reconcileCreatedContainer(saved.containerName!);
      assert.notEqual(spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8' }).status, 0);
      assert.equal(spawnSync('docker', ['container', 'inspect', unrelated], { encoding: 'utf8' }).status, 0);
      const recovered = store.recoverAttempt(saved,
        { ...claimInput('worker-2'), now: new Date(now.getTime() + 31_000) });
      assert.equal(recovered.phase, 'unknown');
      assert.equal(store.get(claim.requestId)?.state, 'recovery_required');
    } finally {
      spawnSync('docker', ['rm', '-f', name, unrelated], { encoding: 'utf8', timeout: 10_000 });
      store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

test('verified native receipt and fenced completion release one slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    store.enqueue(item('inv-b1', 'b'), 'create-b', 'b');
    store.enqueue(item('inv-c1', 'c'), 'create-c', 'c');
    const first = store.claimNext(claimInput('worker-1'))!;
    store.claimNext(claimInput('worker-2'))!;
    assert.throws(() => store.recordNativeStart(first, 'native-a', 'unverified', now), /NOT_AVAILABLE/);
    const started = store.recordNativeStart(first, 'native-a', 'receipt:native-a', now);
    assert.equal(started.nativeRef, 'native-a');
    store.completeAttempt(started, result(started), 'confirmed-fixture', now);
    assert.equal(store.claimNext(claimInput('worker-3'))?.requestId, 'inv-c1');
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('heartbeat extends only the current unexpired lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claimed = store.claimNext(claimInput('worker-1'))!;
    store.renewLease(claimed, new Date(now.getTime() + 20_000));
    assert.throws(() => store.recoverAttempt(claimed,
      { ...claimInput('worker-2'), now: new Date(now.getTime() + 35_000) }), StoreConflict);
    const recovered = store.recoverAttempt(claimed,
      { ...claimInput('worker-2'), now: new Date(now.getTime() + 55_000) });
    assert.throws(() => store.renewLease(claimed, new Date(now.getTime() + 56_000)), StoreConflict);
    assert.equal(recovered.workerEpoch, 2);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('expired lease cannot start or complete before recovery fences it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const first = store.claimNext(claimInput('worker-1'))!;
    const expired = new Date(now.getTime() + 30_000);
    assert.throws(() => store.recordNativeStart(first, 'native-a', 'receipt:native-a', expired), StoreConflict);
    assert.equal(store.get(first.requestId)?.state, 'queued');
    assert.equal(store.listUnsettled().length, 1);
    const started = store.recordNativeStart(first, 'native-a', 'receipt:native-a', now);
    assert.throws(() => store.completeAttempt(started, result(started), 'confirmed-fixture', expired), StoreConflict);
    assert.equal(store.get(first.requestId)?.result, null);
    assert.equal(store.listUnsettled().length, 1);
    const recovered = store.recoverAttempt(started,
      { ...claimInput('worker-2'), now: new Date(expired.getTime() + 1) });
    assert.equal(recovered.workerEpoch, 2);
    assert.throws(() => store.completeAttempt(started, result(started), 'confirmed-fixture', expired), StoreConflict);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('claimed cancellation remains intent until a verified native terminal receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    const queued = store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    const requested = store.requestCancel(store.get(queued.id)!, 'cancel-a', queued.grantId);
    assert.equal(requested.cancelRequested, true);
    assert.equal(requested.state, 'queued');
    assert.equal(store.listUnsettled().length, 1);
    assert.deepEqual(store.listPending().map(row => row.requestId), [queued.id]);
    assert.deepEqual(store.requestCancel(requested, 'cancel-a', queued.grantId), requested);
    const started = store.recordNativeStart(claim, 'native-a', 'receipt:native-a', now);
    const cancelled = store.completeAttempt(started, { ...result(started), resultState: 'cancelled' }, 'confirmed-fixture', now);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.attempts[0]?.terminationConfirmed, true);
    assert.deepEqual(store.listUnsettled(), []);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy completion after cancellation cannot publish or claim confirmed cancellation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-cancel-race-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const started = store.recordNativeStart(store.claimNext(claimInput('worker-1'))!,
      'native-a', 'receipt:native-a', now);
    store.requestCancel(store.get(started.requestId)!, 'cancel-a', 'grant-a');
    assert.throws(() => store.completeAttempt(started, result(started), 'confirmed-fixture', now), StoreConflict);
    assert.equal(store.get(started.requestId)?.state, 'running');
    assert.equal(store.get(started.requestId)?.result, null);
    assert.equal(store.get(started.requestId)?.attempts[0]?.terminationConfirmed, false);
    assert.equal(store.listUnsettled().length, 1);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('revoked grant accepts terminal receipt and releases slot without disclosing result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    const started = store.recordNativeStart(claim, 'native-a', 'receipt:native-a', now);
    base.revokeGrant('grant-a', new Date().toISOString());
    const secret = { ...result(started), findings: [{ statement: 'hidden source', classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = store.completeAttempt(started, secret, 'confirmed-fixture', now);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'authorization_changed');
    assert.equal(settled.result, null);
    assert.equal(settled.attempts[0]?.state, 'completed');
    assert.deepEqual(store.listUnsettled(), []);
    assert.deepEqual(store.listPending(), []);
    assert.equal(JSON.stringify(store.get(started.requestId)).includes('hidden source'), false);
  } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('terminal receipt suppresses private findings after data.read revocation or coverage expansion', () => {
  for (const mode of ['revoked', 'coverage', 'evidence'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
    const file = join(dir, 'state.sqlite');
    const base = seed(file);
    const store = new SqliteInvestigationStore(file, authority);
    try {
      store.enqueue({ ...item('inv-a1', 'a'), scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] } }, 'create-a', 'a');
      const claim = store.claimNext(claimInput('worker-1'))!;
      const started = store.recordNativeStart(claim, 'native-a', 'receipt:native-a', now);
      if (mode === 'revoked') base.revokeGrant('read-a', new Date().toISOString());
      const secret = { ...result(started),
        findings: [{ statement: 'private finding', classification: 'source_confirmed' as const, evidenceRefs: [] }],
        coverage: { ...result(started).coverage,
          searchedScope: [mode === 'coverage' ? 'private/secret.ts' : 'src/main.ts'] },
        evidence: mode === 'evidence' ? [{ path: 'private/secret.ts', symbol: null,
          lineRange: [1, 1] as [number, number], contentHash: 'hash', excerpt: 'private evidence', toolReceipt: null }] : [] };
      const settled = store.completeAttempt(started, secret, 'confirmed-fixture', now);
      assert.equal(settled.state, 'failed', mode);
      assert.equal(settled.failureReason, 'authorization_changed', mode);
      assert.equal(settled.result, null, mode);
      assert.equal(JSON.stringify(store.get(started.requestId)).includes('private finding'), false, mode);
      assert.deepEqual(store.listUnsettled(), [], mode);
    } finally { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('recovery keeps the attempt original permission epoch when authority epoch advances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  const db = new DatabaseSync(file);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    const started = store.recordNativeStart(claim, 'native-a', 'receipt:native-a', now);
    db.prepare('INSERT INTO permission_epochs(principal,audience,workspace_id,epoch) VALUES (?,?,?,?)')
      .run('p', 'external', 'a', 1);
    const recovered = store.recoverAttempt(started,
      { ...claimInput('worker-2'), permissionEpoch: 1, now: new Date(now.getTime() + 31_000) });
    const saved = db.prepare('SELECT permission_epoch FROM investigation_active_attempts WHERE request_id=?')
      .get(started.requestId) as { permission_epoch: number };
    assert.equal(saved.permission_epoch, 0);
    const settled = store.completeAttempt(recovered, result(recovered), 'confirmed-fixture', new Date(now.getTime() + 31_001));
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'authorization_changed');
    assert.equal(settled.result, null);
    assert.deepEqual(store.listUnsettled(), []);
  } finally { db.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('expired grant suppresses findings while confirmed cancellation remains cancelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-claim-'));
  const file = join(dir, 'state.sqlite');
  const base = seed(file);
  const store = new SqliteInvestigationStore(file, authority);
  const db = new DatabaseSync(file);
  try {
    store.enqueue(item('inv-a1', 'a'), 'create-a', 'a');
    const claim = store.claimNext(claimInput('worker-1'))!;
    const started = store.recordNativeStart(claim, 'native-a', 'receipt:native-a', now);
    store.requestCancel(store.get(started.requestId)!, 'cancel-a', 'grant-a');
    db.prepare('UPDATE grants SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', 'grant-a');
    const outcome = { ...result(started), resultState: 'cancelled' as const,
      findings: [{ statement: 'hidden cancellation detail', classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = store.completeAttempt(started, outcome, 'confirmed-fixture', now);
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.failureReason, 'authorization_changed');
    assert.equal(settled.attempts[0]?.terminationConfirmed, true);
    assert.equal(settled.result, null);
    assert.equal(JSON.stringify(store.get(started.requestId)).includes('hidden cancellation detail'), false);
    assert.deepEqual(store.listUnsettled(), []);
  } finally { db.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
});

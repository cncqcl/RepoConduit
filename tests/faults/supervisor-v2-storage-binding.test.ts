import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore, type NativeSupervisorLaunchBinding } from
  '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { SupervisorV2RunningObservation } from
  '../../src/adapters/secondary-investigator/supervisor-v2-running-observer.js';

const at = new Date('2026-09-29T00:00:00.000Z');
const digest = 'a'.repeat(64);
const profileDigest = createHash('sha256').update('native_supervisor_v2:fixed_zero_model_v1').digest('hex');
const paths = ['src/main.ts'];
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true };

function fixture(kind: 'native_supervisor_v2' | 'native_supervisor_v1' | 'canary_v1' = 'native_supervisor_v2',
  withLaunch = true) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-v2-storage-'));
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
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request',
    profileRef: 'fixed', budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'test',
    scope: { paths, symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const initial = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const launch: NativeSupervisorLaunchBinding = { workerEpoch: initial.workerEpoch,
    sourceDigest: digest, profileDigest, action: 'fixed_zero_model_v1' };
  const gate = { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
    root: '/home/investigator/private-gate', payloadKind: kind,
    ...(kind === 'native_supervisor_v2' && withLaunch ? { launch } : {}) };
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`,
    distro: 'Ubuntu', uid: 1000, bootId: randomUUID(), gate };
  const reserved = store.reserveWslResource(initial, reservation, at);
  const source = { attemptId: initial.attemptId, workspaceId, workerEpoch: initial.workerEpoch,
    distro: reservation.distro, linuxUser: gate.linuxUser, uid: reservation.uid,
    bootId: reservation.bootId, sourceDigest: digest };
  const sourced = store.reserveSourceView(reserved, source,
    '/home/investigator/private-source', at, paths);
  const observed = { invocationId: 'f'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${reservation.unitName}` };
  const claim = store.observeWslResource(sourced, observed, at);
  const running: SupervisorV2RunningObservation = { kind: 'original_unit_running',
    resource: claim.wslResource!, journal: { protocol: 'native_supervisor_v2', phase: 'entered', closed: false,
      attemptId: claim.attemptId, workspaceId, bootId: reservation.bootId, uid: reservation.uid,
      unitName: reservation.unitName, launchWorkerEpoch: launch.workerEpoch,
      sourceDigest: launch.sourceDigest, profileDigest: launch.profileDigest,
      invocationId: observed.invocationId, controlGroup: observed.controlGroup,
      enterPid: 1234, enterStartTicks: 5678 },
    native: { bootId: reservation.bootId, uid: reservation.uid, unitName: reservation.unitName,
      invocationId: observed.invocationId, controlGroup: observed.controlGroup,
      loadState: 'loaded', activeState: 'active', subState: 'running',
      mainPid: 1234, startTicks: 5678, procControlGroup: observed.controlGroup } };
  return { dir, file, base, store, record, initial, reserved, claim, gate, reservation,
    source, launch, observed, running, workspaceId, close() {
      store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
    } };
}

test('v2 launch binding survives reopen and cannot change epoch, digest, profile or action', () => {
  const f = fixture();
  try {
    f.store.recordSupervisorV2RunningFact(f.claim, f.running, paths, at);
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try {
      assert.deepEqual(reopened.listUnsettled()[0]?.wslResource?.gate, f.gate);
      reopened.preflightSupervisorRelease(f.claim, f.observed, f.launch, paths, at);
      for (const launch of [
        { ...f.launch, workerEpoch: 2 }, { ...f.launch, sourceDigest: 'c'.repeat(64) },
        { ...f.launch, profileDigest: 'd'.repeat(64) },
        { ...f.launch, action: 'other' as 'fixed_zero_model_v1' },
      ]) assert.throws(() => reopened.preflightSupervisorRelease(f.claim, f.observed,
        launch, paths, at));
      assert.throws(() => reopened.reserveWslResource(f.initial, { ...f.reservation,
        gate: { ...f.gate, launch: { ...f.launch, profileDigest: 'd'.repeat(64) } } }, at),
      StoreConflict);
      assert.throws(() => reopened.reserveSourceView(f.reserved,
        { ...f.source, sourceDigest: 'd'.repeat(64) },
        '/home/investigator/private-source', at, paths), StoreConflict);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('v2 persisted binding rejects widened fields and unknown fixed action', () => {
  const f = fixture();
  try {
    for (const tampered of [
      { ...f.gate, launch: { ...f.launch, extra: true } },
      { ...f.gate, launch: { ...f.launch, action: 'arbitrary_command' } },
    ]) {
      const db = new DatabaseSync(f.file);
      try { db.prepare('UPDATE investigation_active_attempts SET wsl_launch_gate_json=? WHERE request_id=?')
        .run(JSON.stringify(tampered), 'inv'); }
      finally { db.close(); }
      assert.throws(() => f.store.listUnsettled(), StoreConflict);
    }
  } finally { f.close(); }
});

test('matching but noncanonical fixed profile digest cannot authorize v2 release', () => {
  const f = fixture();
  try {
    const wrong = { ...f.launch, profileDigest: 'd'.repeat(64) };
    const gate = { ...f.gate, launch: wrong };
    const db = new DatabaseSync(f.file);
    try { db.prepare('UPDATE investigation_active_attempts SET wsl_launch_gate_json=? WHERE request_id=?')
      .run(JSON.stringify(gate), 'inv'); }
    finally { db.close(); }
    const claim = { ...f.claim, wslResource: { ...f.claim.wslResource!, gate } };
    assert.throws(() => f.store.preflightSupervisorRelease(claim, f.observed,
      wrong, paths, at));
  } finally { f.close(); }
});

test('v2 release preflight requires exact observed unit, source and current claim', () => {
  const f = fixture();
  try {
    f.store.recordSupervisorV2RunningFact(f.claim, f.running, paths, at);
    const check = (claim = f.claim, observed = f.observed, selected = paths,
      now = at) => f.store.preflightSupervisorRelease(claim, observed, f.launch, selected, now);
    assert.doesNotThrow(() => check());
    assert.throws(() => check(f.claim, { ...f.observed, invocationId: 'e'.repeat(32) }), StoreConflict);
    assert.throws(() => check(f.claim, { ...f.observed, controlGroup: '/other' }), StoreConflict);
    assert.throws(() => check({ ...f.claim, wslResource: { ...f.claim.wslResource!,
      invocationId: 'e'.repeat(32) } }), StoreConflict);
    assert.throws(() => check({ ...f.claim, sourceView: { ...f.claim.sourceView!,
      privateRoot: '/home/investigator/other' } }), StoreConflict);
    assert.throws(() => check(f.claim, f.observed, ['src/other.ts']), StoreConflict);
    assert.throws(() => check(f.claim, f.observed, paths,
      new Date(at.getTime() + 30_000)), StoreConflict);
  } finally { f.close(); }
});

test('v2 release requires durable exact original-running fact', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.preflightSupervisorRelease(f.claim, f.observed,
      f.launch, paths, at), StoreConflict);
    for (const invalid of [
      { ...f.running, native: { ...f.running.native, mainPid: 999 } },
      { ...f.running, native: { ...f.running.native, startTicks: 999 } },
      { ...f.running, native: { ...f.running.native, procControlGroup: '/other' } },
      { ...f.running, journal: { ...f.running.journal, attemptId: 'other' } },
      { ...f.running, journal: { ...f.running.journal, sourceDigest: 'e'.repeat(64) } },
      { ...f.running, resource: { ...f.running.resource, bootId: randomUUID() } },
    ]) assert.throws(() => f.store.recordSupervisorV2RunningFact(f.claim,
      invalid as SupervisorV2RunningObservation, paths, at));
    f.store.recordSupervisorV2RunningFact(f.claim, f.running, paths, at);
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try { reopened.preflightSupervisorRelease(f.claim, f.observed, f.launch, paths, at); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('v2 release rejects a corrupted persisted running fact', () => {
  const f = fixture();
  try {
    f.store.recordSupervisorV2RunningFact(f.claim, f.running, paths, at);
    const db = new DatabaseSync(f.file);
    try {
      const forged = { ...f.running, native: { ...f.running.native, startTicks: 1 } };
      db.prepare(`UPDATE investigation_supervisor_v2_running_facts SET fact_json=? WHERE request_id=?`)
        .run(JSON.stringify(forged), f.claim.requestId);
    } finally { db.close(); }
    assert.throws(() => f.store.preflightSupervisorRelease(f.claim, f.observed,
      f.launch, paths, at), StoreConflict);
  } finally { f.close(); }
});

test('recovery reads only the persisted fact for the exact active claim', () => {
  const f = fixture();
  try {
    assert.equal(f.store.getSupervisorV2RunningFact(f.claim), null);
    f.store.recordSupervisorV2RunningFact(f.claim, f.running, paths, at);
    const reopened = new SqliteInvestigationStore(f.file, authority);
    try {
      assert.deepEqual(reopened.getSupervisorV2RunningFact(f.claim), f.running);
      assert.throws(() => reopened.getSupervisorV2RunningFact({ ...f.claim,
        workspaceId: 'other' }), StoreConflict);
      assert.throws(() => reopened.getSupervisorV2RunningFact({ ...f.claim,
        attemptId: 'other' }), StoreConflict);
      assert.throws(() => reopened.getSupervisorV2RunningFact({ ...f.claim,
        wslResource: { ...f.claim.wslResource!, bootId: randomUUID() } }), StoreConflict);
      assert.throws(() => reopened.getSupervisorV2RunningFact({ ...f.claim,
        sourceView: { ...f.claim.sourceView!, privateRoot: '/wrong' } }), StoreConflict);
      const recovered = reopened.recoverAttempt(f.claim, { workerId: 'recovery',
        isolationEvidence: 'verified', profileRevision: 'fixed', permissionEpoch: 0,
        now: new Date(at.getTime() + 30_001) });
      assert.throws(() => reopened.getSupervisorV2RunningFact(f.claim), StoreConflict);
      assert.deepEqual(reopened.getSupervisorV2RunningFact(recovered), f.running);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

for (const change of ['cancel', 'request', 'read', 'permission_epoch', 'source_closed', 'recovery'] as const) {
  test(`v2 release preflight fails closed after ${change}`, () => {
    const f = fixture();
    try {
      f.store.recordSupervisorV2RunningFact(f.claim, f.running, paths, at);
      assert.doesNotThrow(() => f.store.preflightSupervisorRelease(f.claim,
        f.observed, f.launch, paths, at));
      if (change === 'cancel') f.store.requestCancel(f.store.get('inv')!, 'cancel', 'request');
      else if (change === 'request' || change === 'read') f.base.revokeGrant(change, at.toISOString());
      else if (change === 'permission_epoch') {
        f.base.insertGrant({ id: 'extra', principal: 'p', audience: 'external', workspaceId: f.workspaceId,
          collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request'],
          expiresAt: null, revokedAt: null });
        f.base.revokeGrant('extra', at.toISOString());
      } else if (change === 'source_closed') {
        const db = new DatabaseSync(f.file);
        try { db.prepare('UPDATE investigation_active_attempts SET source_view_closed_at=? WHERE request_id=?')
          .run(at.toISOString(), 'inv'); }
        finally { db.close(); }
      } else f.store.recoverAttempt(f.claim, { workerId: 'recovery', isolationEvidence: 'verified',
        profileRevision: 'fixed', permissionEpoch: 0, now: new Date(at.getTime() + 30_001) });
      assert.throws(() => f.store.preflightSupervisorRelease(f.claim, f.observed,
        f.launch, paths, at));
    } finally { f.close(); }
  });
}

test('legacy v2 without launch binding is readable for recovery but never releasable', () => {
  const f = fixture('native_supervisor_v2', false);
  try {
    assert.equal(f.store.listUnsettled()[0]?.wslResource?.gate?.payloadKind, 'native_supervisor_v2');
    assert.throws(() => f.store.preflightSupervisorRelease(f.claim, f.observed,
      f.launch, paths, at), StoreConflict);
  } finally { f.close(); }
});

for (const kind of ['canary_v1', 'native_supervisor_v1'] as const) {
  test(`${kind} legacy gate is readable and cannot enter v2 release preflight`, () => {
    const f = fixture(kind);
    try {
      assert.equal(f.store.listUnsettled()[0]?.wslResource?.gate?.payloadKind, kind);
      assert.throws(() => f.store.preflightSupervisorRelease(f.claim, f.observed,
        f.launch, paths, at), StoreConflict);
    } finally { f.close(); }
  });
}

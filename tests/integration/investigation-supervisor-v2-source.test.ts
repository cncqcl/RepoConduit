import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { buildInvestigationSourcePlan } from '../../src/application/investigation-source-plan.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST, prepareInvestigationSupervisorV2Source } from
  '../../src/runtime/investigation-supervisor-v2-source.js';

const at = new Date('2026-09-29T00:00:00.000Z');
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-v2-source-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'test', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const snapshot = createSnapshotFromFiles('copy', 'a'.repeat(40), { 'src/main.ts': Buffer.from('fixed source') });
  const snapshotBinding = { workspaceId, collaborationId: 'col', workingCopyId: 'copy' };
  await base.saveSnapshot({ ...snapshotBinding, snapshot: snapshot.toPersisted() },
    { ...snapshotBinding, commitRef: 'a'.repeat(40) }, 'capture', 'p', 'external');
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: snapshot.id,
    question: 'test', scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest(record.id, { workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const expected = { workspaceId, collaborationId: 'col', workingCopyId: 'copy', snapshotRef: snapshot.id,
    contextRevisionId: 'ctx', recipient: 'ext', requestId: 'inv', attemptId: claim.attemptId,
    workerEpoch: claim.workerEpoch };
  const digest = buildInvestigationSourcePlan({ record: store.get(record.id)!, claim,
    snapshot: snapshot.toPersisted(), expected }).digest;
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
    bootId: randomUUID(), gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: '/home/investigator/private-gate', payloadKind: 'native_supervisor_v2' as const,
      launch: { workerEpoch: claim.workerEpoch, sourceDigest: digest,
        profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST, action: 'fixed_zero_model_v1' as const } } };
  const input = { store, snapshots: { getSnapshot: base.getSnapshot.bind(base) }, claim, expected, reservation,
    sourceRoot: '/home/investigator/private-source', now: () => at };
  return { dir, file, base, store, claim, expected, reservation, input,
    close() { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function sourceReady(f: Awaited<ReturnType<typeof fixture>>, digest: string) {
  return { kind: 'ready' as const, attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId,
    uid: 1000, workerEpoch: f.claim.workerEpoch, bootId: f.reservation.bootId, digest };
}

function gatePrepared(f: Awaited<ReturnType<typeof fixture>>, digest: string) {
  return { protocol: 'native_supervisor_v2' as const, phase: 'prepared' as const, closed: false,
    attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId, uid: 1000,
    bootId: f.reservation.bootId, unitName: f.reservation.unitName,
    launchWorkerEpoch: f.claim.workerEpoch, sourceDigest: digest,
    profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST };
}

test('v2 preparation persists exact launch and source before materialization and gate', async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    let digest = '';
    const operations = { materialize: async (descriptor: { sourceDigest: string }) => {
      events.push('materialize');
      digest = descriptor.sourceDigest;
      const reopened = new SqliteInvestigationStore(f.file, authority);
      try {
        const saved = reopened.listUnsettled()[0];
        assert.equal(saved?.wslResource?.gate?.launch?.sourceDigest, digest);
        assert.equal(saved?.wslResource?.gate?.launch?.workerEpoch, f.claim.workerEpoch);
        assert.equal(saved?.sourceView?.descriptor.sourceDigest, digest);
      } finally { reopened.close(); }
      return sourceReady(f, digest);
    }, prepareGate: async (descriptor: { sourceDigest: string; profileDigest: string;
      launchWorkerEpoch: number }) => {
      events.push('gate');
      assert.equal(descriptor.sourceDigest, digest);
      assert.equal(descriptor.profileDigest, FIXED_ZERO_MODEL_PROFILE_DIGEST);
      assert.equal(descriptor.launchWorkerEpoch, f.claim.workerEpoch);
      return gatePrepared(f, digest);
    } };
    const result = await prepareInvestigationSupervisorV2Source({ ...f.input,
      reservation: f.reservation }, operations);
    assert.equal(result.plan.digest, digest);
    assert.deepEqual(events, ['materialize', 'gate']);
  } finally { f.close(); }
});

test('v2 rejects mismatched launch epoch, digest, profile and action before native effects', async () => {
  const f = await fixture();
  try {
    let effects = 0;
    const operations = { materialize: async () => { effects++; return null; },
      prepareGate: async () => { effects++; return null; } };
    const launch = f.reservation.gate.launch;
    for (const changed of [
      { ...launch, workerEpoch: launch.workerEpoch + 1 },
      { ...launch, sourceDigest: 'f'.repeat(64) },
      { ...launch, profileDigest: 'f'.repeat(64) },
      { ...launch, action: 'other' as 'fixed_zero_model_v1' },
    ]) {
      await assert.rejects(prepareInvestigationSupervisorV2Source({ ...f.input,
        reservation: { ...f.reservation, gate: { ...f.reservation.gate, launch: changed } } }, operations));
    }
    assert.equal(effects, 0);
    assert.equal(f.store.listUnsettled()[0]?.wslResource, undefined);
  } finally { f.close(); }
});

test('v2 rechecks current source authority after materialize and gate awaits', async () => {
  for (const revokeAt of ['materialize', 'gate'] as const) {
    const f = await fixture();
    try {
      let gates = 0;
      const revoke = () => {
        const db = new DatabaseSync(f.file);
        try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
        finally { db.close(); }
      };
      const operations = { materialize: async (descriptor: { sourceDigest: string }) => {
        if (revokeAt === 'materialize') revoke();
        return sourceReady(f, descriptor.sourceDigest);
      }, prepareGate: async (descriptor: { sourceDigest: string }) => {
        gates++;
        if (revokeAt === 'gate') revoke();
        return gatePrepared(f, descriptor.sourceDigest);
      } };
      await assert.rejects(prepareInvestigationSupervisorV2Source(f.input, operations));
      assert.equal(gates, revokeAt === 'gate' ? 1 : 0);
    } finally { f.close(); }
  }
});

test('v2 refuses materialization when source read is revoked during snapshot acquisition', async () => {
  const f = await fixture();
  try {
    let materializations = 0;
    const snapshots = { getSnapshot: async (snapshotId: string, workspaceId: string,
      collaborationId: string) => {
      const saved = await f.input.snapshots.getSnapshot(snapshotId, workspaceId, collaborationId);
      const db = new DatabaseSync(f.file);
      try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
      finally { db.close(); }
      return saved;
    } };
    await assert.rejects(prepareInvestigationSupervisorV2Source({ ...f.input, snapshots }, {
      materialize: async () => { materializations++; return null; },
      prepareGate: async () => { throw new Error('unexpected gate'); },
    }));
    assert.equal(materializations, 0);
    assert.equal(f.store.listUnsettled()[0]?.wslResource, undefined);
  } finally { f.close(); }
});

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
import { prepareInvestigationSource } from '../../src/runtime/investigation-source-preparation.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-28T00:00:00.000Z');
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-source-prepare-'));
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
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
    bootId: randomUUID(), gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: '/home/investigator/private-gate', payloadKind: 'canary_v1' as const } };
  const expected = { workspaceId, collaborationId: 'col', workingCopyId: 'copy', snapshotRef: snapshot.id,
    contextRevisionId: 'ctx', recipient: 'ext', requestId: 'inv', attemptId: claim.attemptId,
    workerEpoch: claim.workerEpoch };
  const snapshots = { getSnapshot: base.getSnapshot.bind(base) };
  const input = { store, snapshots, claim, expected, reservation,
    sourceRoot: '/home/investigator/private-source', now: () => at };
  return { dir, file, base, store, snapshot, claim, expected, reservation, input, close() {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('reserves exact source before bytes reach fixed materializer, then rechecks before gate', async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    const operations = { materialize: async (descriptor: { sourceDigest: string }, root: string,
      plan: { files: { path: string; base64: string }[] }) => {
      events.push('materialize');
      const reopened = new SqliteInvestigationStore(f.file, authority);
      try {
        const saved = reopened.listUnsettled()[0];
        assert.equal(saved?.sourceView?.descriptor.sourceDigest, descriptor.sourceDigest);
        assert.equal(saved?.sourceView?.privateRoot, root);
        assert.deepEqual(plan.files.map(file => file.path), ['src/main.ts']);
        assert.equal(Buffer.from(plan.files[0]!.base64, 'base64').toString(), 'fixed source');
      } finally { reopened.close(); }
      return { kind: 'ready' as const, attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId,
        uid: 1000, workerEpoch: f.claim.workerEpoch, bootId: f.reservation.bootId, digest: descriptor.sourceDigest };
    }, prepareGate: async () => { events.push('gate'); return { kind: 'open' as const,
      attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId, uid: 1000,
      bootId: f.reservation.bootId, unitName: f.reservation.unitName }; } };
    const result = await prepareInvestigationSource(f.input, operations);
    assert.deepEqual(events, ['materialize', 'gate']);
    assert.equal(result.claim.sourceView?.descriptor.sourceDigest, result.plan.digest);
  } finally { f.close(); }
});

test('source preparation requires its expected gate kind before snapshot read or materialization', async () => {
  const f = await fixture();
  try {
    let sideEffects = 0;
    const snapshots = { getSnapshot: async () => { sideEffects++; return null; } };
    const operations = { materialize: async () => { sideEffects++; return null; },
      prepareGate: async () => { sideEffects++; return null; } };
    await assert.rejects(prepareInvestigationSource({ ...f.input,
      expectedPayloadKind: 'native_supervisor_v1', snapshots }, operations), /NOT_AVAILABLE/);
    await assert.rejects(prepareInvestigationSource({ ...f.input,
      reservation: { ...f.reservation, gate: { ...f.reservation.gate,
        payloadKind: 'native_supervisor_v1' } } }, operations), /NOT_AVAILABLE/);
    assert.equal(sideEffects, 0);
    assert.equal(f.store.listUnsettled()[0]?.wslResource, undefined);
  } finally { f.close(); }
});

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
  test(`${payloadKind} source preparation refuses canary gate operation before effects`, async () => {
    const f = await fixture();
    try {
      let effects = 0;
      const reservation = { ...f.reservation, gate: { ...f.reservation.gate, payloadKind } };
      const snapshots = { getSnapshot: async () => { effects++; return null; } };
      const operations = { materialize: async () => { effects++; return null; },
        prepareGate: async () => { effects++; return null; } };
      await assert.rejects(prepareInvestigationSource({ ...f.input, reservation,
        snapshots, expectedPayloadKind: payloadKind }, operations), /NOT_AVAILABLE/);
      assert.equal(effects, 0);
      assert.equal(f.store.listUnsettled()[0]?.wslResource, undefined);
      assert.equal(f.store.listUnsettled()[0]?.sourceView, undefined);
    } finally { f.close(); }
  });
}

test('changed binding or snapshot never materializes source', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const operations = { materialize: async () => { calls++; return null; }, prepareGate: async () => { calls++; return null; } };
    await assert.rejects(prepareInvestigationSource({ ...f.input,
      expected: { ...f.expected, collaborationId: 'other' } }, operations));
    await assert.rejects(prepareInvestigationSource({ ...f.input, snapshots: { getSnapshot: async () => ({
      workspaceId: f.expected.workspaceId, collaborationId: f.expected.collaborationId,
      workingCopyId: 'other', snapshot: f.snapshot.toPersisted() }) } }, operations));
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test('revoked read grant during materialize prevents gate prepare', async () => {
  const f = await fixture();
  try {
    let gateCalls = 0;
    const operations = { materialize: async (descriptor: { sourceDigest: string }) => {
      const db = new DatabaseSync(f.file);
      try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
      finally { db.close(); }
      return { kind: 'ready' as const, attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId,
        uid: 1000, workerEpoch: f.claim.workerEpoch, bootId: f.reservation.bootId, digest: descriptor.sourceDigest };
    }, prepareGate: async () => { gateCalls++; return null; } };
    await assert.rejects(prepareInvestigationSource(f.input, operations));
    assert.equal(gateCalls, 0);
  } finally { f.close(); }
});

test('revoked read grant before reservation prevents source byte delivery', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.file);
    try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
    finally { db.close(); }
    let calls = 0;
    const operations = { materialize: async () => { calls++; return null; },
      prepareGate: async () => { calls++; return null; } };
    let snapshotReads = 0;
    await assert.rejects(prepareInvestigationSource({ ...f.input,
      snapshots: { getSnapshot: async (snapshotId: string, workspaceId: string, collaborationId: string) => {
        snapshotReads++;
        return f.input.snapshots.getSnapshot(snapshotId, workspaceId, collaborationId);
      } } }, operations));
    assert.equal(calls, 0);
    assert.equal(snapshotReads, 0);
    assert.equal(f.store.listUnsettled()[0]?.sourceView, undefined);
  } finally { f.close(); }
});

test('expired lease during materialize prevents gate prepare', async () => {
  const f = await fixture();
  try {
    let now = at;
    let gateCalls = 0;
    const operations = { materialize: async (descriptor: { sourceDigest: string }) => {
      now = new Date(at.getTime() + 30_000);
      return { kind: 'ready' as const, attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId,
        uid: 1000, workerEpoch: f.claim.workerEpoch, bootId: f.reservation.bootId, digest: descriptor.sourceDigest };
    }, prepareGate: async () => { gateCalls++; return null; } };
    await assert.rejects(prepareInvestigationSource({ ...f.input, now: () => now }, operations));
    assert.equal(gateCalls, 0);
  } finally { f.close(); }
});

test('cancellation while materializing prevents gate preparation and native launch', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    let gateCalls = 0;
    const operations = { materialize: async (descriptor: { sourceDigest: string }) => {
      controller.abort();
      return { kind: 'ready' as const, attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId,
        uid: 1000, workerEpoch: f.claim.workerEpoch, bootId: f.reservation.bootId,
        digest: descriptor.sourceDigest };
    }, prepareGate: async () => { gateCalls++; return null; } };
    await assert.rejects(prepareInvestigationSource({ ...f.input, signal: controller.signal }, operations));
    assert.equal(gateCalls, 0);
    assert.equal(f.store.listUnsettled()[0]?.sourceView?.closedAt, null);
  } finally { f.close(); }
});

test('revoked grant during gate preparation cannot return a ready claim', async () => {
  const f = await fixture();
  try {
    const operations = { materialize: async (descriptor: { sourceDigest: string }) => ({
      kind: 'ready' as const, attemptId: f.claim.attemptId, workspaceId: f.expected.workspaceId,
      uid: 1000, workerEpoch: f.claim.workerEpoch, bootId: f.reservation.bootId,
      digest: descriptor.sourceDigest }), prepareGate: async () => {
      const db = new DatabaseSync(f.file);
      try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
      finally { db.close(); }
      return { kind: 'open' as const, attemptId: f.claim.attemptId,
        workspaceId: f.expected.workspaceId, uid: 1000, bootId: f.reservation.bootId,
        unitName: f.reservation.unitName };
    } };
    await assert.rejects(prepareInvestigationSource(f.input, operations));
  } finally { f.close(); }
});

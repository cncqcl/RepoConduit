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
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../../src/adapters/secondary-investigator/fixed-zero-model-profile.js';
import type { NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { runClaimedSupervisorV2Diagnostic, type SupervisorV2DiagnosticOperations } from
  '../../src/runtime/investigation-supervisor-v2-diagnostic.js';

const at = new Date('2026-09-29T00:00:00.000Z');
const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-v2-diagnostic-'));
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
  const binding = { workspaceId, collaborationId: 'col', workingCopyId: 'copy' };
  await base.saveSnapshot({ ...binding, snapshot: snapshot.toPersisted() },
    { ...binding, commitRef: 'a'.repeat(40) }, 'capture', 'p', 'external');
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: snapshot.id,
    question: 'test', scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const events: string[] = [];
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
    bootId: randomUUID(), gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: '/home/investigator/private-gate', payloadKind: 'native_supervisor_v2' as const } };
  const input = { requestId: record.id, store, snapshots: { getSnapshot: base.getSnapshot.bind(base) },
    expected: { ...binding, snapshotRef: snapshot.id, contextRevisionId: 'ctx', recipient: 'ext',
      requestId: record.id }, claim: { workerId: 'worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: at }, now: () => at,
    reservationForPlan: (claim: { workerEpoch: number }, plan: { digest: string }) => {
      events.push('reservation');
      return { reservation: { ...reservation, gate: { ...reservation.gate,
        launch: { workerEpoch: claim.workerEpoch, sourceDigest: plan.digest,
          profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST, action: 'fixed_zero_model_v1' as const } } },
      sourceRoot: '/home/investigator/private-source' };
    } };
  return { dir, file, base, store, record, input, events, reservation,
    close() { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function operations(f: Awaited<ReturnType<typeof fixture>>): SupervisorV2DiagnosticOperations {
  let digest = '';
  let epoch = 0;
  let attemptId = '';
  const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.reservation.unitName}`;
  const journal = (phase: NativeSupervisorGateState['phase'], closed = false): NativeSupervisorGateState => ({
    protocol: 'native_supervisor_v2', phase, closed, attemptId,
    workspaceId: f.record.workspaceId, uid: 1000, bootId: f.reservation.bootId,
    unitName: f.reservation.unitName, launchWorkerEpoch: epoch, sourceDigest: digest,
    profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST,
    ...(phase === 'prepared' ? {} : { invocationId: 'a'.repeat(32), controlGroup: group,
      enterPid: 123, enterStartTicks: 456 }),
  });
  return { source: {
    materialize: async (descriptor) => {
      f.events.push('materialize');
      digest = descriptor.sourceDigest;
      epoch = descriptor.workerEpoch;
      attemptId = descriptor.attemptId;
      const saved = f.store.listUnsettled()[0];
      assert.equal(saved?.wslResource?.gate?.launch?.sourceDigest, digest);
      assert.equal(saved?.sourceView?.descriptor.sourceDigest, digest);
      return { kind: 'ready', attemptId, workspaceId: f.record.workspaceId,
        uid: 1000, workerEpoch: epoch, bootId: f.reservation.bootId, digest };
    }, prepareGate: async () => { f.events.push('prepare'); return journal('prepared'); },
  }, launchUnit: async () => { f.events.push('launch'); return 'exited'; },
  status: async () => { f.events.push('status'); return journal(f.events.includes('release') ? 'consumed' : 'entered'); },
  observeRunning: async (resource, entered, expected) => {
    f.events.push('running');
    assert.equal(expected.attemptId, attemptId);
    assert.equal(resource.invocationId, 'a'.repeat(32));
    return { kind: 'original_unit_running', resource, journal: entered,
      native: { bootId: f.reservation.bootId, uid: 1000, unitName: f.reservation.unitName,
        invocationId: 'a'.repeat(32), controlGroup: group, loadState: 'loaded', activeState: 'active',
        subState: 'running', mainPid: 123, startTicks: 456, procControlGroup: group } };
  }, release: async () => { f.events.push('release'); return journal('released'); },
  close: async () => { f.events.push('close'); return journal('consumed', true); } };
}

test('trusted zero-model diagnostic runs exact sequence and retains recovery slot', async () => {
  const f = await fixture();
  try {
    const result = await runClaimedSupervisorV2Diagnostic(f.input, operations(f));
    assert.equal(result.consumed, true);
    assert.equal(result.closed, true);
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.listUnsettled().length, 1);
    assert.deepEqual(f.events, ['reservation', 'materialize', 'prepare', 'launch',
      'status', 'running', 'release', 'status', 'close']);
  } finally { f.close(); }
});

test('unconfirmed running unit never releases and closes without settling', async () => {
  const f = await fixture();
  try {
    const ops = operations(f);
    ops.observeRunning = async () => { f.events.push('running'); return { kind: 'unconfirmed' }; };
    await assert.rejects(runClaimedSupervisorV2Diagnostic(f.input, ops));
    assert.equal(f.events.includes('release'), false);
    assert.equal(f.events.at(-1), 'close');
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('revoked source after launch prevents release but still closes without abort signal', async () => {
  const f = await fixture();
  try {
    const ops = operations(f);
    ops.launchUnit = async () => {
      f.events.push('launch');
      const db = new DatabaseSync(f.file);
      try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
      finally { db.close(); }
      return 'exited';
    };
    await assert.rejects(runClaimedSupervisorV2Diagnostic(f.input, ops));
    assert.equal(f.events.includes('release'), false);
    assert.equal(f.events.at(-1), 'close');
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
  } finally { f.close(); }
});

test('abort after running observation prevents release but cannot suppress close', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const ops = operations(f);
    const original = ops.observeRunning;
    ops.observeRunning = async (resource, journal, expected) => {
      const observed = await original(resource, journal, expected);
      controller.abort();
      return observed;
    };
    await assert.rejects(runClaimedSupervisorV2Diagnostic({ ...f.input,
      signal: controller.signal }, ops));
    assert.equal(f.events.includes('release'), false);
    assert.equal(f.events.at(-1), 'close');
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('unknown close receipt cannot report a completed diagnostic or free its slot', async () => {
  const f = await fixture();
  try {
    const ops = operations(f);
    ops.close = async () => { f.events.push('close'); return null; };
    await assert.rejects(runClaimedSupervisorV2Diagnostic(f.input, ops));
    assert.equal(f.events.includes('release'), true);
    assert.equal(f.events.at(-1), 'close');
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('gate opened before final preparation authority check is still closed', async () => {
  const f = await fixture();
  try {
    const ops = operations(f);
    const prepare = ops.source.prepareGate;
    ops.source.prepareGate = async (descriptor, root, signal) => {
      const state = await prepare(descriptor, root, signal);
      const db = new DatabaseSync(f.file);
      try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
      finally { db.close(); }
      return state;
    };
    await assert.rejects(runClaimedSupervisorV2Diagnostic(f.input, ops));
    assert.deepEqual(f.events.slice(-2), ['prepare', 'close']);
    assert.equal(f.events.includes('launch'), false);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('coordinator refuses a running observation with wrong original process ticks', async () => {
  const f = await fixture();
  try {
    const ops = operations(f);
    const original = ops.observeRunning;
    ops.observeRunning = async (resource, entered, expected) => {
      const result = await original(resource, entered, expected);
      return result.kind === 'original_unit_running' ?
        { ...result, native: { ...result.native, startTicks: 999 } } : result;
    };
    await assert.rejects(runClaimedSupervisorV2Diagnostic(f.input, ops));
    assert.equal(f.events.includes('release'), false);
    assert.equal(f.events.at(-1), 'close');
  } finally { f.close(); }
});

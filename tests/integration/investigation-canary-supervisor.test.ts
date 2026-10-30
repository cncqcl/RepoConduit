import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { createFixedCanaryTerminationTickets } from '../../src/runtime/fixed-canary-termination-tickets.js';
import { runClaimedCanaryInvestigation } from '../../src/runtime/investigation-canary-supervisor.js';

const now = new Date('2026-09-28T00:00:00.000Z');

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-canary-supervisor-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'synthetic', canonicalRoot: 'D:/fixture', registeredBy: 'fixture' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'fixture', purpose: 'canary',
    hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId,
    collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request'],
    expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId,
    collaborationId: 'col', recipient: 'ext', permissions: ['data.read'],
    dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const snapshot = createSnapshotFromFiles('copy', 'a'.repeat(40),
    { 'src/main.ts': Buffer.from('fixed source') });
  await base.saveSnapshot({ workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    snapshot: snapshot.toPersisted() }, { workspaceId, collaborationId: 'col',
    workingCopyId: 'copy', commitRef: 'a'.repeat(40) }, 'capture', 'p', 'external');
  const tickets = createFixedCanaryTerminationTickets();
  const store = new SqliteInvestigationStore(file, {
    verifyIsolation: (evidence: string) => evidence === 'fixed-isolation-canary',
    verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
    verifyWslTerminationReceipt: tickets.verify,
  });
  const record: InvestigationRecord = { id: `inv_${randomUUID()}`, workspaceId,
    collaborationId: 'col', workingCopyId: 'copy', principal: 'p', audience: 'external',
    recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx',
    snapshotRef: snapshot.id, question: 'synthetic only',
    scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  store.enqueue(record, record.id, record.id);
  const descriptor = (attemptId: string) => ({ unitName: `rcac-investigator-${randomUUID()}.service`,
    distro: 'Ubuntu', uid: 1000, bootId: randomUUID(),
    gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: `/home/investigator/gates/${attemptId}`, payloadKind: 'canary_v1' as const } });
  const input = { requestId: record.id, store, snapshots: { getSnapshot: base.getSnapshot.bind(base) },
    expected: { workspaceId, collaborationId: 'col', workingCopyId: 'copy', snapshotRef: snapshot.id,
      contextRevisionId: 'ctx', recipient: 'ext', requestId: record.id },
    claim: { workerId: 'worker', isolationEvidence: 'fixed-isolation-canary',
      profileRevision: 'fixed', permissionEpoch: 0, now },
    reservationForClaim: (claim: { attemptId: string }) => ({ reservation: descriptor(claim.attemptId),
      sourceRoot: `/home/investigator/source/${claim.attemptId}` }), now: () => now,
    termination: { canaries: { observe: async () => ({ kind: 'unconfirmed' as const }),
      issue: tickets.issue, revoke: tickets.revoke } } };
  return { dir, base, store, record, tickets, input, close() {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('queued request claims, reserves exact source, checks launch, and records consumed unit identity', async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const result = await runClaimedCanaryInvestigation(f.input, {
      materialize: async (descriptor) => { calls.push('source'); return { kind: 'ready' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, digest: descriptor.sourceDigest }; },
      prepareGate: async (descriptor) => { calls.push('gate'); return { kind: 'open' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        bootId: descriptor.bootId, unitName: descriptor.unitName }; },
      launchAndClose: async (descriptor) => { calls.push('launch');
        const active = f.store.listUnsettled()[0];
        assert.equal(active?.sourceView?.descriptor.attemptId, descriptor.attemptId);
        assert.equal(active?.wslResource?.unitName, descriptor.unitName);
        return { bridge: 'exited' as const, gate: { kind: 'closed_consumed' as const, attemptId: descriptor.attemptId,
          workspaceId: descriptor.workspaceId, uid: descriptor.uid, bootId: descriptor.bootId,
          unitName: descriptor.unitName, invocationId: 'a'.repeat(32),
          controlGroup: `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}` } };
      },
    });
    assert.deepEqual(calls, ['source', 'gate', 'launch']);
    assert.equal(result.observedUnit.invocationId, 'a'.repeat(32));
    assert.equal(result.claim.phase, 'reconcile');
    assert.equal(f.store.listUnsettled()[0]?.wslResource?.invocationId, 'a'.repeat(32));
    assert.equal(f.store.get(f.record.id)?.result, null);
    assert.equal(f.store.get(f.record.id)?.attempts[0]?.terminationConfirmed, false);
    await assert.rejects(runClaimedCanaryInvestigation(f.input, {
      materialize: async () => null, prepareGate: async () => null,
      launchAndClose: async () => ({ bridge: 'unknown', gate: null }),
    }), /NOT_AVAILABLE/);
  } finally { f.close(); }
});

test('current worker closes the exact fixed canary and frees the slot after verified termination', async () => {
  const f = await fixture();
  let advance: NodeJS.Timeout | undefined;
  let advanceAgain: NodeJS.Timeout | undefined;
  try {
    const calls: string[] = [];
    let clock = now;
    advance = setTimeout(() => { clock = new Date(now.getTime() + 20_000); }, 5);
    advanceAgain = setTimeout(() => { clock = new Date(now.getTime() + 35_000); }, 25);
    const result = await runClaimedCanaryInvestigation({ ...f.input,
      now: () => clock, heartbeatIntervalMs: 10,
      termination: {
        canaries: { observe: async (resource) => {
          calls.push('observe');
          await new Promise(resolve => setTimeout(resolve, 60));
          return { kind: 'fixed_canary_terminal' as const, resource };
        }, issue: f.tickets.issue, revoke: f.tickets.revoke },
        sources: { close: async (descriptor) => {
          calls.push('close-source');
          return { kind: 'closed' as const, attemptId: descriptor.attemptId,
            workspaceId: descriptor.workspaceId, uid: descriptor.uid,
            workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId,
            digest: descriptor.sourceDigest };
        } },
      },
    }, {
      materialize: async (descriptor) => ({ kind: 'ready' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, digest: descriptor.sourceDigest }),
      prepareGate: async (descriptor) => ({ kind: 'open' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        bootId: descriptor.bootId, unitName: descriptor.unitName }),
      launchAndClose: async (descriptor) => ({ bridge: 'exited' as const,
        gate: { kind: 'closed_consumed' as const, attemptId: descriptor.attemptId,
          workspaceId: descriptor.workspaceId, uid: descriptor.uid, bootId: descriptor.bootId,
          unitName: descriptor.unitName, invocationId: 'e'.repeat(32),
          controlGroup: `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}` } }),
    });
    assert.equal(result.settled, true);
    assert.deepEqual(calls, ['observe', 'close-source']);
    assert.equal(f.store.listUnsettled().length, 0);
    assert.equal(f.store.get(f.record.id)?.state, 'failed');
    assert.equal(f.store.get(f.record.id)?.attempts[0]?.terminationConfirmed, true);
    assert.equal(f.store.get(f.record.id)?.result, null);
  } finally {
    clearTimeout(advance);
    clearTimeout(advanceAgain);
    f.close();
  }
});

test('a missing consumed-unit receipt never publishes or releases the attempt', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runClaimedCanaryInvestigation(f.input, {
      materialize: async (descriptor) => ({ kind: 'ready' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, digest: descriptor.sourceDigest }),
      prepareGate: async (descriptor) => ({ kind: 'open' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        bootId: descriptor.bootId, unitName: descriptor.unitName }),
      launchAndClose: async () => ({ bridge: 'unknown', gate: null }),
    }), /NOT_AVAILABLE/);
    assert.equal(f.store.get(f.record.id)?.result, null);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('revocation before native launch stops the unit, while revocation after launch retains identity', async () => {
  const before = await fixture();
  try {
    let launched = 0;
    await assert.rejects(runClaimedCanaryInvestigation(before.input, {
      materialize: async (descriptor) => ({ kind: 'ready' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, digest: descriptor.sourceDigest }),
      prepareGate: async (descriptor) => {
        const db = new DatabaseSync(join(before.dir, 'state.sqlite'));
        try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(now.toISOString(), 'read'); }
        finally { db.close(); }
        return { kind: 'open' as const, attemptId: descriptor.attemptId,
          workspaceId: descriptor.workspaceId, uid: descriptor.uid, bootId: descriptor.bootId,
          unitName: descriptor.unitName };
      },
      launchAndClose: async () => { launched++; return { bridge: 'unknown', gate: null }; },
    }));
    assert.equal(launched, 0);
    assert.equal(before.store.listUnsettled().length, 1);
  } finally { before.close(); }

  const after = await fixture();
  try {
    await assert.rejects(runClaimedCanaryInvestigation(after.input, {
      materialize: async (descriptor) => ({ kind: 'ready' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, digest: descriptor.sourceDigest }),
      prepareGate: async (descriptor) => ({ kind: 'open' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        bootId: descriptor.bootId, unitName: descriptor.unitName }),
      launchAndClose: async (descriptor) => {
        const db = new DatabaseSync(join(after.dir, 'state.sqlite'));
        try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(now.toISOString(), 'read'); }
        finally { db.close(); }
        return { bridge: 'exited' as const, gate: { kind: 'closed_consumed' as const, attemptId: descriptor.attemptId,
          workspaceId: descriptor.workspaceId, uid: descriptor.uid, bootId: descriptor.bootId,
          unitName: descriptor.unitName, invocationId: 'b'.repeat(32),
          controlGroup: `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}` } };
      },
    }));
    assert.equal(after.store.listUnsettled()[0]?.wslResource?.invocationId, 'b'.repeat(32));
    assert.equal(after.store.get(after.record.id)?.result, null);
  } finally { after.close(); }
});

test('unknown Windows bridge still persists a consumed WSL identity and leaves recovery required', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runClaimedCanaryInvestigation(f.input, {
      materialize: async (descriptor) => ({ kind: 'ready' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId, digest: descriptor.sourceDigest }),
      prepareGate: async (descriptor) => ({ kind: 'open' as const,
        attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, uid: descriptor.uid,
        bootId: descriptor.bootId, unitName: descriptor.unitName }),
      launchAndClose: async (descriptor) => ({ bridge: 'unknown' as const,
        gate: { kind: 'closed_consumed' as const, attemptId: descriptor.attemptId,
          workspaceId: descriptor.workspaceId, uid: descriptor.uid, bootId: descriptor.bootId,
          unitName: descriptor.unitName, invocationId: 'c'.repeat(32),
          controlGroup: `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}` } }),
    }), /NOT_AVAILABLE/);
    const active = f.store.listUnsettled()[0];
    assert.equal(active?.wslResource?.invocationId, 'c'.repeat(32));
    assert.equal(active?.phase, 'reconcile');
    assert.equal(f.store.get(f.record.id)?.state, 'recovery_required');
    assert.equal(f.store.get(f.record.id)?.result, null);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('heartbeat renews the claimed lease while asynchronous source materialization is pending', async () => {
  const f = await fixture();
  try {
    let clock = now;
    const advance = setTimeout(() => { clock = new Date(now.getTime() + 20_000); }, 5);
    const advanceAgain = setTimeout(() => { clock = new Date(now.getTime() + 35_000); }, 25);
    try {
      const result = await runClaimedCanaryInvestigation({ ...f.input,
        now: () => clock, heartbeatIntervalMs: 10 }, {
        materialize: async (descriptor) => {
          await new Promise(resolve => setTimeout(resolve, 60));
          return { kind: 'ready' as const, attemptId: descriptor.attemptId,
            workspaceId: descriptor.workspaceId, uid: descriptor.uid,
            workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId,
            digest: descriptor.sourceDigest };
        },
        prepareGate: async (descriptor) => ({ kind: 'open' as const,
          attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
          uid: descriptor.uid, bootId: descriptor.bootId, unitName: descriptor.unitName }),
        launchAndClose: async (descriptor) => ({ bridge: 'exited' as const,
          gate: { kind: 'closed_consumed' as const, attemptId: descriptor.attemptId,
            workspaceId: descriptor.workspaceId, uid: descriptor.uid, bootId: descriptor.bootId,
            unitName: descriptor.unitName, invocationId: 'd'.repeat(32),
            controlGroup: `/user.slice/user-${descriptor.uid}.slice/user@${descriptor.uid}.service/app.slice/${descriptor.unitName}` } }),
      });
      assert.equal(result.observedUnit.invocationId, 'd'.repeat(32));
      assert.equal(f.store.get(f.record.id)?.state, 'recovery_required');
    } finally { clearTimeout(advance); clearTimeout(advanceAgain); }
  } finally { f.close(); }
});

test('abort during source preparation prevents native launch and retains the claimed slot', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    let nativeCalls = 0;
    await assert.rejects(runClaimedCanaryInvestigation({ ...f.input, signal: controller.signal }, {
      materialize: async (descriptor) => {
        controller.abort();
        return { kind: 'ready' as const, attemptId: descriptor.attemptId,
          workspaceId: descriptor.workspaceId, uid: descriptor.uid,
          workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId,
          digest: descriptor.sourceDigest };
      },
      prepareGate: async () => { nativeCalls++; return null; },
      launchAndClose: async () => { nativeCalls++; return { bridge: 'not_started', gate: null }; },
    }));
    assert.equal(nativeCalls, 0);
    assert.equal(f.store.get(f.record.id)?.state, 'recovery_required');
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('failure before resource reservation remains safely settleable after lease expiry', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runClaimedCanaryInvestigation({ ...f.input,
      reservationForClaim: () => { throw new Error('fixture reservation failure'); } }));
    const active = f.store.listUnsettled()[0];
    assert.equal(active?.phase, 'start_intent');
    assert.equal(active?.wslResource, undefined);
    assert.equal(active?.sourceView, undefined);
    assert.equal(f.store.get(f.record.id)?.state, 'queued');
    const settled = f.store.settleExpiredUnreservedAttempt(active!,
      new Date(now.getTime() + 30_001));
    assert.equal(settled?.state, 'failed');
    assert.equal(f.store.listUnsettled().length, 0);
  } finally { f.close(); }
});

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
test(`fixed canary worker refuses ${payloadKind} reservation before source or gate effects`, async () => {
  const f = await fixture();
  try {
    let effects = 0;
    const reservationForClaim = (claim: { attemptId: string }) => {
      const selected = f.input.reservationForClaim(claim);
      return { ...selected, reservation: { ...selected.reservation,
        gate: { ...selected.reservation.gate, payloadKind } } };
    };
    await assert.rejects(runClaimedCanaryInvestigation({ ...f.input, reservationForClaim }, {
      materialize: async () => { effects++; return null; },
      prepareGate: async () => { effects++; return null; },
      launchAndClose: async () => { effects++; return { bridge: 'not_started', gate: null }; },
    }), /NOT_AVAILABLE/);
    assert.equal(effects, 0);
    assert.equal(f.store.listUnsettled()[0]?.wslResource, undefined);
    assert.equal(f.store.get(f.record.id)?.state, 'queued');
  } finally { f.close(); }
});
}

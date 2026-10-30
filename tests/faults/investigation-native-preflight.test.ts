import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord, InvestigationResult } from '../../src/core/investigation/request.js';

const at = new Date();
const authority = { verifyIsolation: () => true,
  verifyNativeReceipt: (_claim: unknown, ref: string, receipt: string) => receipt === `receipt:${ref}`,
  verifyOutcomeReceipt: () => true, verifyWslTerminationReceipt: () => true };

function fixture(native: 'wsl' | 'legacy' | 'legacy-wsl' | 'legacy-docker' = 'wsl') {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-native-preflight-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'test', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const store = new SqliteInvestigationStore(file, authority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap',
    question: 'test', scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const first = store.claimRequest(record.id, { workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0,
    ...(native === 'wsl' ? { launchProtocol: 'resource_reservation_v1' as const } : {}), now: at })!;
  const reservation = { unitName: `rcac-investigator-${randomUUID()}.service`, distro: 'Ubuntu', uid: 1000,
    bootId: randomUUID(), gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'investigator',
      root: '/home/investigator/private-gate', payloadKind: 'canary_v1' as const } };
  const digest = 'a'.repeat(64);
  let claim = first;
  if (native === 'legacy-docker') {
    const name = `rcac-investigator-${randomUUID()}`;
    const reserved = store.reserveContainerName(first, name, resolve(dir, name), at);
    claim = store.recordObservedContainer(reserved, 'c'.repeat(64), at);
  } else if (native !== 'legacy') {
    const reserved = store.reserveWslResource(first, reservation, at);
    if (native === 'wsl') {
      const descriptor = { attemptId: first.attemptId, workspaceId, workerEpoch: first.workerEpoch,
        distro: reservation.distro, uid: reservation.uid, linuxUser: 'investigator', bootId: reservation.bootId,
        sourceDigest: digest };
      claim = store.reserveSourceView(reserved, descriptor, '/home/investigator/private-source', at, ['src/main.ts']);
    } else claim = reserved;
  }
  const args = [claim, ['src/main.ts'], 'fixed', digest, at] as const;
  return { base, store, file, record, claim, args, digest, workspaceId, close() {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

function result(claim: { requestId: string; attemptId: string }): InvestigationResult {
  return { requestId: claim.requestId, attemptId: claim.attemptId, resultState: 'completed',
    snapshotRef: 'snap', contextRevisionId: 'ctx', findings: [], evidence: [],
    coverage: { searchedScope: [], excludedCategories: [], truncated: false, missingDependencies: [] },
    openQuestions: [], limitsAndWarnings: [] };
}

test('native launch storage preflight binds exact persisted WSL and source identities', () => {
  const f = fixture();
  try {
    assert.doesNotThrow(() => f.store.preflightNativeLaunch(...f.args));
    const withoutResource = { ...f.claim };
    const withoutSource = { ...f.claim };
    delete withoutResource.wslResource;
    delete withoutSource.sourceView;
    assert.throws(() => f.store.preflightNativeLaunch(withoutResource,
      ['src/main.ts'], 'fixed', f.digest, at), StoreConflict);
    assert.throws(() => f.store.preflightNativeLaunch(withoutSource,
      ['src/main.ts'], 'fixed', f.digest, at), StoreConflict);
    assert.throws(() => f.store.preflightNativeLaunch(f.claim, ['src/other.ts'], 'fixed', f.digest, at), StoreConflict);
    assert.throws(() => f.store.preflightNativeLaunch(f.claim, ['src/main.ts'], 'other', f.digest, at), StoreConflict);
    assert.throws(() => f.store.preflightNativeLaunch(f.claim, ['src/main.ts'], 'fixed', 'b'.repeat(64), at), StoreConflict);
    assert.throws(() => f.store.preflightNativeLaunch({ ...f.claim, wslResource: {
      ...f.claim.wslResource!, unitName: `rcac-investigator-${randomUUID()}.service` } },
    ['src/main.ts'], 'fixed', f.digest, at), StoreConflict);
  } finally { f.close(); }
});

test('native launch preflight refuses cancellation, revoked grants, permission change, and expired lease', () => {
  for (const change of ['cancel', 'request', 'read', 'epoch', 'lease']) {
    const f = fixture();
    try {
      if (change === 'cancel') f.store.requestCancel(f.store.get('inv')!, 'cancel', 'request');
      else if (change === 'request' || change === 'read') f.base.revokeGrant(change, at.toISOString());
      else if (change === 'epoch') {
        f.base.insertGrant({ id: 'extra', principal: 'p', audience: 'external', workspaceId: f.workspaceId,
          collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
        f.base.revokeGrant('extra', at.toISOString());
      }
      assert.throws(() => f.store.preflightNativeLaunch(f.claim, ['src/main.ts'], 'fixed', f.digest,
        change === 'lease' ? new Date(at.getTime() + 30_000) : at));
    } finally { f.close(); }
  }
});

test('valid late WSL receipt after cancellation is retained only for cleanup', () => {
  const f = fixture();
  try {
    const observation = { invocationId: 'b'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.claim.wslResource!.unitName}` };
    const observed = f.store.observeWslResource(f.claim, observation, at);
    f.store.requestCancel(f.store.get('inv')!, 'cancel', 'request');
    assert.throws(() => f.store.recordNativeStart({ ...observed, wslResource: {
      ...observed.wslResource!, invocationId: 'c'.repeat(32) } },
    'native-wsl', 'receipt:native-wsl', at), StoreConflict);
    assert.throws(() => f.store.recordNativeStart(observed, 'native-wsl', 'bad-receipt', at), /NOT_AVAILABLE/);
    assert.equal(f.store.listUnsettled()[0]?.nativeRef, null);
    const late = f.store.recordNativeStart(observed, 'native-wsl', 'receipt:native-wsl', at);
    assert.equal(late.phase, 'reconcile');
    assert.equal(late.nativeRef, 'native-wsl');
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.store.get('inv')?.result, null);
    assert.equal(f.store.listUnsettled()[0]?.nativeRef, 'native-wsl');
    assert.deepEqual(f.store.listUnsettled()[0]?.wslResource?.invocationId, observation.invocationId);
    assert.throws(() => f.store.recordNativeStart(observed, 'other', 'invalid', at), /NOT_AVAILABLE/);
    const db = new DatabaseSync(f.file);
    try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM investigation_active_attempts').get() as { count: number }).count, 1); }
    finally { db.close(); }
  } finally { f.close(); }
});

test('legacy unknown recovery accepts verified late receipt and completes under unchanged authority', () => {
  const f = fixture('legacy');
  try {
    const resumedAt = new Date(at.getTime() + 31_000);
    const recovered = f.store.recoverAttempt(f.claim, { workerId: 'new-worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
    assert.equal(recovered.phase, 'unknown');
    const started = f.store.recordNativeStart(recovered, 'native-late', 'receipt:native-late', resumedAt);
    assert.equal(started.phase, 'started');
    const completed = f.store.completeAttempt(started, result(started), 'outcome', resumedAt);
    assert.equal(completed.state, 'completed');
    assert.ok(completed.result);
    assert.deepEqual(f.store.listUnsettled(), []);
  } finally { f.close(); }
});

test('legacy late receipt after revoke keeps cleanup identity and suppresses findings', () => {
  const f = fixture('legacy');
  try {
    const resumedAt = new Date(at.getTime() + 31_000);
    const recovered = f.store.recoverAttempt(f.claim, { workerId: 'new-worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
    f.base.revokeGrant('read', at.toISOString());
    const late = f.store.recordNativeStart(recovered, 'native-late', 'receipt:native-late', resumedAt);
    assert.equal(late.phase, 'reconcile');
    const secret = { ...result(late), findings: [{ statement: 'secret',
      classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = f.store.completeAttempt(late, secret, 'outcome', resumedAt);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.result, null);
    assert.equal(JSON.stringify(f.store.get('inv')).includes('secret'), false);
  } finally { f.close(); }
});

test('legacy late receipt after cancellation settles without publishing findings', () => {
  const f = fixture('legacy');
  try {
    const resumedAt = new Date(at.getTime() + 31_000);
    const recovered = f.store.recoverAttempt(f.claim, { workerId: 'new-worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
    f.store.requestCancel(f.store.get('inv')!, 'cancel', 'request');
    const late = f.store.recordNativeStart(recovered, 'native-late', 'receipt:native-late', resumedAt);
    assert.equal(late.phase, 'reconcile');
    const secret = { ...result(late), resultState: 'cancelled' as const,
      findings: [{ statement: 'secret', classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = f.store.completeAttempt(late, secret, 'outcome', resumedAt);
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.result, null);
    assert.equal(JSON.stringify(f.store.get('inv')).includes('secret'), false);
  } finally { f.close(); }
});

test('legacy WSL reconcile recovery completes with unchanged authority', () => {
  const f = fixture('legacy-wsl');
  try {
    const observed = f.store.observeWslResource(f.claim, { invocationId: 'b'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.claim.wslResource!.unitName}` }, at);
    const resumedAt = new Date(at.getTime() + 31_000);
    const recovered = f.store.recoverAttempt(observed, { workerId: 'new-worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
    assert.equal(recovered.phase, 'reconcile');
    const started = f.store.recordNativeStart(recovered, 'native-wsl-late', 'receipt:native-wsl-late', resumedAt);
    assert.equal(started.phase, 'started');
    const completed = f.store.completeWslAttempt(started, result(started), 'outcome', 'terminated', resumedAt);
    assert.equal(completed.state, 'completed');
    assert.ok(completed.result);
    assert.deepEqual(f.store.listUnsettled(), []);
  } finally { f.close(); }
});

test('legacy WSL reconcile receipt after revoke suppresses findings', () => {
  const f = fixture('legacy-wsl');
  try {
    const observed = f.store.observeWslResource(f.claim, { invocationId: 'b'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.claim.wslResource!.unitName}` }, at);
    const resumedAt = new Date(at.getTime() + 31_000);
    const recovered = f.store.recoverAttempt(observed, { workerId: 'new-worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
    f.base.revokeGrant('read', at.toISOString());
    const late = f.store.recordNativeStart(recovered, 'native-wsl-late', 'receipt:native-wsl-late', resumedAt);
    assert.equal(late.phase, 'reconcile');
    const secret = { ...result(late), findings: [{ statement: 'secret',
      classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = f.store.completeWslAttempt(late, secret, 'outcome', 'terminated', resumedAt);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.result, null);
    assert.equal(JSON.stringify(f.store.get('inv')).includes('secret'), false);
  } finally { f.close(); }
});

for (const route of ['legacy', 'legacy-docker', 'legacy-wsl'] as const) {
  test(`${route} recovered same native receipt remains publishable under unchanged authority`, () => {
    const f = fixture(route);
    try {
      let claim = f.claim;
      if (route === 'legacy-wsl') claim = f.store.observeWslResource(claim, { invocationId: 'b'.repeat(32),
        controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${claim.wslResource!.unitName}` }, at);
      const started = f.store.recordNativeStart(claim, 'native-original', 'receipt:native-original', at);
      const resumedAt = new Date(at.getTime() + 31_000);
      const recovered = f.store.recoverAttempt(started, { workerId: 'new-worker', isolationEvidence: 'verified',
        profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
      assert.equal(recovered.phase, 'reconcile');
      const beforeReplay = f.store.get('inv');
      assert.throws(() => f.store.recordNativeStart(recovered, 'native-original', 'invalid', resumedAt), /NOT_AVAILABLE/);
      assert.deepEqual(f.store.get('inv'), beforeReplay);
      const replayed = f.store.recordNativeStart(recovered, 'native-original', 'receipt:native-original', resumedAt);
      assert.equal(replayed.phase, 'reconcile');
      assert.equal(f.store.get('inv')?.failureReason, undefined);
      const completed = route === 'legacy-wsl' ?
        f.store.completeWslAttempt(replayed, result(replayed), 'outcome', 'terminated', resumedAt) :
        f.store.completeAttempt(replayed, result(replayed), 'outcome', resumedAt);
      assert.equal(completed.state, 'completed');
      assert.ok(completed.result);
    } finally { f.close(); }
  });
}

test('recovered persisted native receipt after revoke remains cleanup only', () => {
  const f = fixture('legacy');
  try {
    const started = f.store.recordNativeStart(f.claim, 'native-original', 'receipt:native-original', at);
    const resumedAt = new Date(at.getTime() + 31_000);
    const recovered = f.store.recoverAttempt(started, { workerId: 'new-worker', isolationEvidence: 'verified',
      profileRevision: 'fixed', permissionEpoch: 0, now: resumedAt });
    f.base.revokeGrant('read', at.toISOString());
    const replayed = f.store.recordNativeStart(recovered, 'native-original', 'receipt:native-original', resumedAt);
    assert.equal(replayed.phase, 'reconcile');
    const secret = { ...result(replayed), findings: [{ statement: 'secret',
      classification: 'source_confirmed' as const, evidenceRefs: [] }] };
    const settled = f.store.completeAttempt(replayed, secret, 'outcome', resumedAt);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.result, null);
    assert.equal(JSON.stringify(f.store.get('inv')).includes('secret'), false);
  } finally { f.close(); }
});

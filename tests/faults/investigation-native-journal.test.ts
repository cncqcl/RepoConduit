import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';

const at = new Date('2026-09-27T00:00:00.000Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-native-journal-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'workspace', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'investigate', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'grant', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const store = new SqliteInvestigationStore(file, {
    verifyIsolation: (evidence, record) => evidence === `isolated:${record.id}`,
    verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
  });
  const record: InvestigationRecord = { id: 'inv', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'grant', profileRef: 'readonly',
    budgetRef: 'budget', budget: { maxWallSeconds: 60, maxTurns: 3, maxToolCalls: 10 },
    contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'Trace flow',
    scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: '2026-09-26T00:00:00.000Z' };
  store.enqueue(record, 'one', 'one');
  const claim = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'isolated:inv',
    profileRevision: 'readonly', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  return { dir, file, base, store, claim, close: () => {
    store.close(); base.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('native intent and observed IDs survive reopening; interrupt acknowledgment is not terminal', () => {
  const f = fixture();
  try {
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    assert.deepEqual(f.store.getNativeJournal(f.claim, 'col')?.thread, { state: 'intent', threadId: null });
    assert.throws(() => f.store.beginNativeThreadIntent(f.claim, 'col', at), StoreConflict);
    f.store.observeNativeThread(f.claim, 'col', 'thread-1');
    f.store.beginNativeTurnIntent(f.claim, 'col', 'turn-intent-1', 'thread-1', at);
    assert.throws(() => f.store.beginNativeTurnIntent(f.claim, 'col', 'turn-intent-2', 'thread-1', at), StoreConflict);
    f.store.observeNativeTurn(f.claim, 'col', 'turn-intent-1', 'turn-1');
    assert.doesNotThrow(() => f.store.assertNativeTurnBinding(f.claim, 'col', 'turn-intent-1',
      'thread-1', 'turn-1'));
    assert.throws(() => f.store.assertNativeTurnBinding(f.claim, 'col', 'turn-intent-1',
      'wrong-thread', 'turn-1'), StoreConflict);
    assert.throws(() => f.store.assertNativeTurnBinding(f.claim, 'col', 'turn-intent-1',
      'thread-1', 'wrong-turn'), StoreConflict);
    f.store.acknowledgeNativeTurnInterrupt(f.claim, 'col', 'turn-intent-1', 'turn-1');
    assert.throws(() => f.store.beginNativeTurnIntent(f.claim, 'col', 'turn-intent-2', 'thread-1', at), StoreConflict);
    const peer = new SqliteInvestigationStore(f.file);
    try {
      assert.deepEqual(peer.getNativeJournal(f.claim, 'col')?.turns,
        [{ intentId: 'turn-intent-1', turnId: 'turn-1', state: 'observed', interruptAcknowledged: true }]);
      peer.observeNativeTurnTerminal(f.claim, 'col', 'turn-intent-1', 'turn-1');
      assert.throws(() => peer.assertNativeTurnBinding(f.claim, 'col', 'turn-intent-1',
        'thread-1', 'turn-1'), StoreConflict);
      peer.beginNativeTurnIntent(f.claim, 'col', 'turn-intent-2', 'thread-1', at);
      assert.equal(peer.getNativeJournal(f.claim, 'col')?.turns[1]?.state, 'intent');
    } finally { peer.close(); }
  } finally { f.close(); }
});

test('native journal refuses stale epoch, wrong collaboration and conflicting IDs', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.beginNativeThreadIntent(f.claim, 'other', at), StoreConflict);
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    assert.throws(() => f.store.observeNativeThread({ ...f.claim, workerEpoch: 2 }, 'col', 'thread-1'), StoreConflict);
    f.store.observeNativeThread(f.claim, 'col', 'thread-1');
    f.store.observeNativeThread(f.claim, 'col', 'thread-1');
    assert.throws(() => f.store.observeNativeThread(f.claim, 'col', 'thread-2'), StoreConflict);
    assert.throws(() => f.store.beginNativeTurnIntent(f.claim, 'col', 'intent-1', 'other-thread', at), StoreConflict);
    f.store.beginNativeTurnIntent(f.claim, 'col', 'intent-1', 'thread-1', at);
    f.store.observeNativeTurn(f.claim, 'col', 'intent-1', 'turn-1');
    assert.throws(() => f.store.observeNativeTurn(f.claim, 'col', 'intent-1', 'turn-2'), StoreConflict);
    assert.throws(() => f.store.observeNativeTurnTerminal(f.claim, 'col', 'intent-1', 'turn-2'), StoreConflict);
  } finally { f.close(); }
});

test('reopened unresolved native intents remain fences against duplicate starts', () => {
  const f = fixture();
  try {
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    const afterThreadCrash = new SqliteInvestigationStore(f.file);
    try {
      assert.deepEqual(afterThreadCrash.getNativeJournal(f.claim, 'col')?.thread,
        { state: 'intent', threadId: null });
      assert.throws(() => afterThreadCrash.beginNativeThreadIntent(f.claim, 'col', at), StoreConflict);
      afterThreadCrash.observeNativeThread(f.claim, 'col', 'thread-after-recovery');
      afterThreadCrash.beginNativeTurnIntent(f.claim, 'col', 'intent-after-recovery',
        'thread-after-recovery', at);
    } finally { afterThreadCrash.close(); }
    const afterTurnCrash = new SqliteInvestigationStore(f.file);
    try {
      assert.deepEqual(afterTurnCrash.getNativeJournal(f.claim, 'col')?.turns,
        [{ intentId: 'intent-after-recovery', turnId: null,
          state: 'intent', interruptAcknowledged: false }]);
      assert.throws(() => afterTurnCrash.beginNativeTurnIntent(f.claim, 'col', 'fresh-intent',
        'thread-after-recovery', at), StoreConflict);
      assert.throws(() => afterTurnCrash.acknowledgeNativeTurnInterrupt(f.claim, 'col',
        'intent-after-recovery', 'invented-turn'), StoreConflict);
    } finally { afterTurnCrash.close(); }
  } finally { f.close(); }
});

test('cancellation and expiry deny native thread intent before any journal row is written', () => {
  const cancelled = fixture();
  try {
    cancelled.store.requestCancel(cancelled.store.get('inv')!, 'cancel-1', 'grant');
    assert.throws(() => cancelled.store.beginNativeThreadIntent(cancelled.claim, 'col', at), StoreConflict);
    assert.equal(cancelled.store.getNativeJournal(cancelled.claim, 'col'), null);
  } finally { cancelled.close(); }
  const expired = fixture();
  try {
    assert.throws(() => expired.store.beginNativeThreadIntent(expired.claim, 'col',
      new Date(at.getTime() + 30_000)), StoreConflict);
    assert.equal(expired.store.getNativeJournal(expired.claim, 'col'), null);
  } finally { expired.close(); }
});

test('native ID returned after cancellation is retained for reconciliation', () => {
  const f = fixture();
  try {
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    f.store.requestCancel(f.store.get('inv')!, 'cancel-after-intent', 'grant');
    f.store.observeNativeThread(f.claim, 'col', 'thread-after-cancel');
    assert.equal(f.store.getNativeJournal(f.claim, 'col')?.thread.threadId, 'thread-after-cancel');
    assert.throws(() => f.store.beginNativeTurnIntent(f.claim, 'col', 'new-turn',
      'thread-after-cancel', at), StoreConflict);
  } finally { f.close(); }
});

test('unobserved native thread intent prevents unreserved lease settlement', () => {
  const f = fixture();
  try {
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    const later = new Date(at.getTime() + 30_001);
    assert.equal(f.store.settleExpiredUnreservedAttempt(f.claim, later), null);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.getNativeJournal(f.claim, 'col')?.thread.threadId, null);
  } finally { f.close(); }
});

test('unobserved native thread intent prevents Windows cleanup takeover before source closure', () => {
  const f = fixture();
  try {
    const descriptor = { attemptId: f.claim.attemptId, workspaceId: 'ws',
      workerEpoch: f.claim.workerEpoch, sourceDigest: 'a'.repeat(64) };
    const root = 'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
    const reserved = f.store.reserveWindowsSourceView(f.claim, descriptor, root, ['src/main.ts'], at);
    f.store.beginNativeThreadIntent(reserved, 'col', at);
    const later = new Date(at.getTime() + 30_001);
    assert.throws(() => f.store.acquireWindowsSourceCleanupLease(reserved, 'cleanup', later), StoreConflict);
    assert.deepEqual(f.store.listUnsettled(), [reserved]);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

for (const phase of ['intent', 'thread', 'turn', 'terminal'] as const) {
  test(`Windows recovery preserves ${phase} journal and never calls source close after reopen`, async () => {
    const f=fixture();
    const peer=new SqliteInvestigationStore(f.file);
    try {
      const descriptor={attemptId:f.claim.attemptId,workspaceId:'ws',workerEpoch:f.claim.workerEpoch,
        sourceDigest:'a'.repeat(64)};
      const root='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
      const reserved=f.store.reserveWindowsSourceView(f.claim,descriptor,root,['src/main.ts'],at);
      f.store.beginNativeThreadIntent(reserved,'col',at);
      if(phase!=='intent') f.store.observeNativeThread(reserved,'col','thread');
      if(phase==='turn'||phase==='terminal') {
        f.store.beginNativeTurnIntent(reserved,'col','intent','thread',at);
        f.store.observeNativeTurn(reserved,'col','intent','turn');
      }
      if(phase==='terminal') f.store.observeNativeTurnTerminal(reserved,'col','intent','turn');
      const journal=peer.getNativeJournal(reserved,'col');
      const record=peer.get('inv');
      let closeCalls=0;
      await runInvestigationCleanupTick(peer,'cleanup',undefined,peer.listUnsettled(),undefined,undefined,{
        close:async (observed,privateRoot)=>{
          closeCalls++;
          return {kind:'closed',descriptor:observed,
            viewPath:`${privateRoot}\\${reserved.attemptId}.view`,isolationVerified:false};
        },
      });
      assert.equal(closeCalls,0);
      assert.deepEqual(peer.listUnsettled(),[reserved]);
      assert.deepEqual(peer.getNativeJournal(reserved,'col'),journal);
      assert.deepEqual(peer.get('inv'),record);
    } finally {peer.close();f.close();}
  });
}

test('Windows cleanup lease first fences both old and cleanup owners from new native intents', () => {
  const f=fixture();
  const peer=new SqliteInvestigationStore(f.file);
  try {
    const descriptor={attemptId:f.claim.attemptId,workspaceId:'ws',workerEpoch:f.claim.workerEpoch,
      sourceDigest:'a'.repeat(64)};
    const root='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
    const reserved=f.store.reserveWindowsSourceView(f.claim,descriptor,root,['src/main.ts'],at);
    const later=new Date(at.getTime()+30_001);
    const cleanup=peer.acquireWindowsSourceCleanupLease(reserved,'cleanup',later)!;
    assert.ok(cleanup);
    for(const claim of [reserved,cleanup]) {
      assert.throws(()=>f.store.beginNativeThreadIntent(claim,'col',later),StoreConflict);
      assert.throws(()=>f.store.beginNativeTurnIntent(claim,'col','late','thread',later),StoreConflict);
    }
    assert.equal(peer.getNativeJournal(cleanup,'col'),null);
    assert.deepEqual(peer.listUnsettled(),[cleanup]);
  } finally {peer.close();f.close();}
});

test('every native turn intent consumes the durable maxTurns budget, including terminal turns', () => {
  const f = fixture();
  try {
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    f.store.observeNativeThread(f.claim, 'col', 'thread-budget');
    for (let index = 1; index <= 3; index++) {
      const intent = `intent-${index}`;
      const turn = `turn-${index}`;
      f.store.beginNativeTurnIntent(f.claim, 'col', intent, 'thread-budget', at);
      f.store.observeNativeTurn(f.claim, 'col', intent, turn);
      f.store.observeNativeTurnTerminal(f.claim, 'col', intent, turn);
    }
    assert.throws(() => f.store.beginNativeTurnIntent(f.claim, 'col', 'intent-4',
      'thread-budget', at), StoreConflict);
    assert.equal(f.store.getNativeJournal(f.claim, 'col')?.turns.length, 3);
  } finally { f.close(); }
});

test('two store connections cannot both reserve the final native turn budget slot', () => {
  const f = fixture();
  const peer = new SqliteInvestigationStore(f.file);
  try {
    f.store.beginNativeThreadIntent(f.claim, 'col', at);
    f.store.observeNativeThread(f.claim, 'col', 'thread-budget');
    for (let index = 1; index <= 2; index++) {
      f.store.beginNativeTurnIntent(f.claim, 'col', `intent-${index}`, 'thread-budget', at);
      f.store.observeNativeTurn(f.claim, 'col', `intent-${index}`, `turn-${index}`);
      f.store.observeNativeTurnTerminal(f.claim, 'col', `intent-${index}`, `turn-${index}`);
    }
    f.store.beginNativeTurnIntent(f.claim, 'col', 'contender-a', 'thread-budget', at);
    assert.throws(() => peer.beginNativeTurnIntent(f.claim, 'col', 'contender-b',
      'thread-budget', at), StoreConflict);
    assert.deepEqual(peer.getNativeJournal(f.claim, 'col')?.turns.map(turn => turn.intentId),
      ['intent-1', 'intent-2', 'contender-a']);
  } finally { peer.close(); f.close(); }
});

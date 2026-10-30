import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { prepareWindowsInvestigationSource } from '../../src/runtime/windows-investigation-source-preparation.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const at = new Date('2026-09-28T00:00:00.000Z');
// Synthetic claim authority is limited to this integration test. Production has no Windows profile.
const syntheticAuthority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
  verifyOutcomeReceipt: () => true };

async function fixture() {
  const root = mkdtempSync(join(homedir(), 'rcac-win-prep-'));
  protectNewDataDirectory(root);
  const file = join(root, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  base.insertWorkspace({ id: workspaceId, name: 'synthetic', canonicalRoot: 'D:/synthetic', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId, openedBy: 'p', purpose: 'synthetic', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId, canonicalRoot: 'D:/synthetic' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId, collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const snapshot = createSnapshotFromFiles('copy', 'a'.repeat(40), {
    'src/a.ts': Buffer.from('frozen A\n'), 'src/nested/b.ts': Buffer.from('frozen B\n'),
  });
  const binding = { workspaceId, collaborationId: 'col', workingCopyId: 'copy' };
  await base.saveSnapshot({ ...binding, snapshot: snapshot.toPersisted() },
    { ...binding, commitRef: 'a'.repeat(40) }, 'capture', 'p', 'external');
  const store = new SqliteInvestigationStore(file, syntheticAuthority);
  const record: InvestigationRecord = { id: 'inv', workspaceId, collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: snapshot.id,
    question: 'synthetic', scope: { paths: ['src/a.ts', 'src/nested/b.ts'], symbols: [], relatedTests: [] },
    requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued', cancelRequested: false,
    attempts: [], result: null, createdAt: at.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest(record.id, { workerId: 'synthetic-worker', isolationEvidence: 'test-only',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: at })!;
  const expected = { ...binding, snapshotRef: snapshot.id, contextRevisionId: 'ctx', recipient: 'ext',
    requestId: record.id, attemptId: claim.attemptId, workerEpoch: claim.workerEpoch };
  const input = { store, snapshots: { getSnapshot: base.getSnapshot.bind(base) }, claim, expected,
    privateRoot: root, now: () => at };
  return { root, file, base, store, claim, input, close() {
    store.close(); base.close();
    const child = relative(resolve(homedir()), resolve(root));
    assert.ok(child.startsWith('rcac-win-prep-') && !child.includes('..') && !child.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  } };
}

test('Windows host staging reserves before real bytes, confirms after materialize, and survives restart',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await fixture();
    try {
      const result = await prepareWindowsInvestigationSource(f.input);
      assert.equal(result.view.isolationVerified, false);
      assert.equal(readFileSync(join(result.view.viewPath, 'src', 'a.ts'), 'utf8'), 'frozen A\n');
      assert.equal(readFileSync(join(result.view.viewPath, 'src', 'nested', 'b.ts'), 'utf8'), 'frozen B\n');
      const reopened = new SqliteInvestigationStore(f.file, syntheticAuthority);
      try {
        assert.ok(reopened.listUnsettled()[0]?.windowsSource?.preparedAt);
        assert.equal(reopened.settleExpiredUnreservedAttempt(f.claim, new Date(at.getTime() + 30_001)), null);
      } finally { reopened.close(); }
    } finally { f.close(); }
  });

test('revocation while Windows source is being materialized prevents prepared confirmation',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await fixture();
    try {
      await assert.rejects(prepareWindowsInvestigationSource(f.input, {
        materialize: async (plan, root) => {
          const db = new DatabaseSync(f.file);
          try { db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(at.toISOString(), 'read'); }
          finally { db.close(); }
          const { materializeWindowsFrozenSource } = await import('../../src/adapters/codex/investigator/windows-source-view.js');
          return materializeWindowsFrozenSource(plan, root);
        },
      }));
      assert.equal(f.store.listUnsettled()[0]?.windowsSource?.preparedAt, null);
      assert.equal(existsSync(join(f.root, `${f.claim.attemptId}.view`, 'src', 'a.ts')), true);
    } finally { f.close(); }
  });

test('expired Windows staging closes real frozen files and settles occupied slot',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await fixture();
    try {
      const prepared = await prepareWindowsInvestigationSource(f.input);
      assert.equal(existsSync(prepared.view.viewPath), true);
      await runInvestigationCleanupTick(f.store, 'cleanup-worker');
      assert.equal(existsSync(prepared.view.viewPath), false);
      assert.equal(f.store.listUnsettled().length, 0);
      assert.equal(f.store.get('inv')?.state, 'failed');
      assert.equal(f.store.get('inv')?.failureReason, 'closed_before_native_launch');
    } finally { f.close(); }
  });

test('unknown file in Windows source view prevents cleanup and keeps the slot occupied',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await fixture();
    try {
      const prepared = await prepareWindowsInvestigationSource(f.input);
      writeFileSync(join(prepared.view.viewPath, 'foreign.txt'), 'unknown');
      await runInvestigationCleanupTick(f.store, 'cleanup-worker');
      assert.equal(f.store.listUnsettled().length, 1);
      assert.equal(existsSync(join(prepared.view.viewPath, 'foreign.txt')), true);
      assert.equal(f.store.get('inv')?.state, 'recovery_required');
    } finally { f.close(); }
  });

test('native intent preserves real Windows frozen files and occupied claim through reopened recovery',
  { skip: process.platform !== 'win32' }, async () => {
    const f=await fixture();
    try {
      const prepared=await prepareWindowsInvestigationSource(f.input);
      f.store.beginNativeThreadIntent(prepared.claim,'col',at);
      const peer=new SqliteInvestigationStore(f.file,syntheticAuthority);
      try {
        const journal=peer.getNativeJournal(prepared.claim,'col');
        await runInvestigationCleanupTick(peer,'cleanup-worker');
        assert.deepEqual(peer.listUnsettled(),[prepared.claim]);
        assert.deepEqual(peer.getNativeJournal(prepared.claim,'col'),journal);
        assert.equal(peer.get('inv')?.result,null);
        assert.equal(peer.get('inv')?.attempts[0]?.terminationConfirmed,false);
        assert.equal(readFileSync(join(prepared.view.viewPath,'src','a.ts'),'utf8'),'frozen A\n');
        assert.equal(readFileSync(join(prepared.view.viewPath,'src','nested','b.ts'),'utf8'),'frozen B\n');
      } finally {peer.close();}
    } finally {f.close();}
  });

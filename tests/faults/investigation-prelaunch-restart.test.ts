import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const claimChild = `
import { SqliteInvestigationStore } from './src/adapters/storage/investigation-sqlite.ts';
const store = new SqliteInvestigationStore(process.env.RCAC_TEST_DB,
  { verifyIsolation: () => true, verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true });
const claim = store.claimNext({ workerId: 'crashed-worker', isolationEvidence: 'verified',
  profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: new Date() });
if (!claim) throw new Error('Expected a claim');
process.stdout.write('CLAIMED\\n');
setInterval(() => {}, 1000);
`;

function waitForClaim(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Claim child timed out: ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.includes('CLAIMED\n')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk).slice(0, 2000); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Claim child exited ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('installed app restart settles an expired prelaunch claim after worker death', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-prelaunch-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const store = new SqliteInvestigationStore(file);
  let child: ChildProcessWithoutNullStreams | undefined;
  let app: ReturnType<typeof openApplication> | undefined;
  try {
    base.insertWorkspace({ id: 'a', name: 'a', canonicalRoot: dir, registeredBy: 'p' });
    base.insertCollaboration({ id: 'col-a', workspaceId: 'a', openedBy: 'p', purpose: 'test',
      hostThreadId: null, state: 'open' });
    base.insertWorkingCopy({ id: 'copy-a', workspaceId: 'a', canonicalRoot: dir });
    base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId: 'a',
      collaborationId: 'col-a', recipient: 'ext', permissions: ['investigation.request'],
      expiresAt: null, revokedAt: null });
    base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'a',
      collaborationId: 'col-a', recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'],
      expiresAt: null, revokedAt: null });
    const record: InvestigationRecord = { id: 'inv-a', workspaceId: 'a', collaborationId: 'col-a',
      workingCopyId: 'copy-a', principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request',
      profileRef: 'fixed', budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
      contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'test',
      scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
      parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
      createdAt: new Date().toISOString() };
    store.enqueue(record, 'key', 'fingerprint');
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', claimChild], {
      cwd: process.cwd(), env: { ...process.env, RCAC_TEST_DB: file }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForClaim(child);
    assert.equal(store.get(record.id)?.state, 'queued');
    assert.equal(store.get(record.id)?.attempts[0]?.state, 'claimed');
    assert.equal(store.listUnsettled()[0]?.launchProtocol, 'resource_reservation_v1');
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    assert.notEqual(child.exitCode, 0);
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?')
        .run('2020-01-01T00:00:00.000Z', record.id);
    } finally { db.close(); }
    app = openApplication(dir);
    await app.ready;
    const settled = store.get(record.id)!;
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'abandoned_before_resource_reservation');
    assert.equal(settled.attempts[0]?.startedAt, null);
    assert.equal(settled.attempts[0]?.terminationConfirmed, false);
    assert.deepEqual(store.listUnsettled(), []);
    assert.deepEqual(store.listPending(), []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
    await app?.close();
    store.close();
    base.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

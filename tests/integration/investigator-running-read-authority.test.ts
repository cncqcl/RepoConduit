import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { createPersistedInvestigatorMcpServer } from '../../src/adapters/secondary-investigator/persisted-mcp.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { authorize } from '../../src/core/policy/authorize.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

async function fixture(maxToolCalls = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-running-read-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`;
  const now = new Date();
  base.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'col-a', workspaceId, openedBy: 'owner', purpose: 'read', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'wc-a', workspaceId, canonicalRoot: dir });
  const snapshot = createSnapshotFromFiles('wc-a', 'synthetic-commit',
    { 'src/entry.ts': Buffer.from('export const allowed = "SYNTHETIC_A";\n') }).toPersisted();
  await base.saveSnapshot({ workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', snapshot },
    { workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', commitRef: 'synthetic-commit' },
    'capture', 'owner', 'local_cli');
  base.insertGrant({ id: 'original-request', principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user',
    workspaceId, collaborationId: 'col-a', permissions: ['investigation.request', 'investigation.cancel'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'original-read', principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user',
    workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/entry.ts'],
    expiresAt: null, revokedAt: null });
  const workerId = `worker_${randomUUID()}`;
  base.insertGrant({ id: 'worker-read', principal: workerId, audience: 'investigator-ipc', recipient: 'claude-code-local',
    workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/entry.ts'],
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), revokedAt: null });
  const record: InvestigationRecord = { id: 'inv-a', workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a',
    principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user', grantId: 'original-request',
    profileRef: 'verified-test', budgetRef: 'bounded-test', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls },
    contextRevisionId: 'ctx-a', snapshotRef: snapshot.id, question: 'Trace the entry flow',
    scope: { paths: ['src/entry.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  const store = new SqliteInvestigationStore(file, { verifyIsolation: () => true,
    verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true });
  store.enqueue(record, 'submit', 'fingerprint');
  const claim = store.claimRequest(record.id, { workerId, isolationEvidence: 'test-only',
    profileRevision: 'verified-test', permissionEpoch: 0, now })!;
  const binding = { collaborationId: 'col-a', workingCopyId: 'wc-a', snapshotId: snapshot.id,
    paths: ['src/entry.ts'], workerGrantId: 'worker-read',
    workerAudience: 'investigator-ipc', workerRecipient: 'claude-code-local' };
  const boundRead = { workspaceId, collaborationId: binding.collaborationId,
    workingCopyId: binding.workingCopyId, snapshotId: binding.snapshotId, path: 'src/entry.ts' };
  let storeClosed = false;
  return { base, store, claim, binding, boundRead, now, workspaceId, file,
    closeStore() { store.close(); storeClosed = true; },
    close() { if (!storeClosed) store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('request read budget survives a second connection and rejects stale claims without spending', async () => {
  const f = await fixture(1);
  const second = new SqliteInvestigationStore(f.file);
  try {
    const started = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
    assert.throws(() => second.reserveRunningRead({ ...started, workerEpoch: started.workerEpoch + 1 }, f.binding, f.boundRead, f.now));
    assert.doesNotThrow(() => f.store.assertRunningReadAuthority(started, f.binding, f.now));
    assert.doesNotThrow(() => second.reserveRunningRead(started, f.binding, f.boundRead, f.now));
    assert.throws(() => f.store.reserveRunningRead(started, f.binding, f.boundRead, f.now));
    assert.throws(() => second.reserveRunningRead(started, f.binding, f.boundRead, f.now));
  } finally { second.close(); f.close(); }
});

test('exhaustion survives complete store reopen and valid epoch takeover retains the request counter', async () => {
  const f = await fixture(1);
  let reopened: SqliteInvestigationStore | undefined;
  try {
    const started = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
    f.store.reserveRunningRead(started, f.binding, f.boundRead, f.now);
    f.closeStore();
    reopened = new SqliteInvestigationStore(f.file, { verifyIsolation: () => true,
      verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true });
    assert.throws(() => reopened!.reserveRunningRead(started, f.binding, f.boundRead, f.now));
    const recovered = reopened.recoverAttempt(started, { workerId: started.workerId,
      isolationEvidence: 'test-only', profileRevision: 'verified-test', permissionEpoch: 0,
      now: new Date(f.now.getTime() + 31_000) });
    assert.equal(recovered.attemptId, started.attemptId);
    assert.equal(recovered.workerEpoch, started.workerEpoch + 1);
    const check = new DatabaseSync(f.file);
    assert.equal((check.prepare("SELECT reserved_calls FROM investigation_read_budget WHERE request_id='inv-a'")
      .get() as { reserved_calls: number }).reserved_calls, 1);
    check.close();
  } finally { reopened?.close(); f.close(); }
});

test('persisted MCP discovery is free and success or failed read consumes the sole request slot', async () => {
  for (const cursor of [undefined, 'invalid-cursor']) {
  const f = await fixture(1);
  const claim = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
  const repository = new RepositoryApplication({
    authorize: async ({ context, operation, workspaceId, collaborationId }) => {
      await context.assertFreshAuthority?.();
      return authorize({ ...context, now: new Date() }, operation, { workspaceId, collaborationId },
        f.base.grantsFor(context.principal, context.audience));
    },
    getWorkingCopy: (workspaceId, workingCopyId) => f.base.getWorkingCopy(workspaceId, workingCopyId),
    collaborationBelongsToWorkspace: (workspaceId, collaborationId) => f.base.collaborationBelongsToWorkspace(workspaceId, collaborationId),
    lookupCapture: (input, key, principal, audience) => f.base.lookupCapture(input, key, principal, audience),
    saveSnapshot: (record, input, key, principal, audience) => f.base.saveSnapshot(record, input, key, principal, audience),
    getSnapshot: (id, workspaceId, collaborationId) => f.base.getSnapshot(id, workspaceId, collaborationId),
  });
  const server = createPersistedInvestigatorMcpServer({ claim, store: f.store,
    workerGrantId: f.binding.workerGrantId, workerAudience: f.binding.workerAudience,
    workerRecipient: f.binding.workerRecipient,
    dispatcher: new DispatchService(f.base, undefined, undefined, { repository }) });
  const client = new Client({ name: 'budget-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['repo.read']);
    const read = (cursor?: string) => client.callTool({ name: 'repo.read', arguments: {
      scope: { workspaceId: f.workspaceId, collaborationId: f.binding.collaborationId },
      payload: { workingCopyId: f.binding.workingCopyId, snapshotId: f.binding.snapshotId,
        path: 'src/entry.ts', ...(cursor ? { cursor } : {}) },
    } });
    const first = await read(cursor);
    assert.equal(first.isError, cursor ? true : undefined);
    if (cursor) {
      const check = new DatabaseSync(f.file);
      try {
        const row = check.prepare(`SELECT status,observed_at FROM investigation_read_receipts
          WHERE request_id=?`).get('inv-a') as {status:string;observed_at:string|null};
        assert.equal(row.status,'reserved');
        assert.equal(row.observed_at,null);
      } finally {check.close();}
    }
    if (!cursor) {
      assert.match(JSON.stringify(first), /SYNTHETIC_A/);
      assert.match(JSON.stringify(first), /toolReceipt/);
      const check = new DatabaseSync(f.file);
      try {
        const row = check.prepare(`SELECT status, page_content_hash FROM investigation_read_receipts
          WHERE request_id=?`).get('inv-a') as { status: string; page_content_hash: string };
        assert.equal(row.status, 'succeeded');
        assert.match(row.page_content_hash, /^[0-9a-f]{64}$/);
      } finally { check.close(); }
    }
    const exhausted = await read();
    assert.equal(exhausted.isError, true);
    assert.doesNotMatch(JSON.stringify(exhausted), /SYNTHETIC_A/);
  } finally { await client.close(); await server.close(); f.close(); }
  }
});

test('legacy queued requests get zero; legacy started requests remain unknown across reopen', async () => {
  const f = await fixture(1);
  try {
    const started = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
    const db = new DatabaseSync(f.file);
    db.exec('DROP TABLE investigation_read_budget');
    db.close();
    const first = new SqliteInvestigationStore(f.file);
    const check = new DatabaseSync(f.file);
    const queued = check.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?').get('inv-a') as { reserved_calls: number | null };
    assert.equal(queued.reserved_calls, null); // Claimed attempts make historical use unknowable.
    assert.throws(() => first.reserveRunningRead(started, f.binding, f.boundRead, f.now));
    first.close();
    const reopenedUnknown = new SqliteInvestigationStore(f.file);
    assert.equal((check.prepare("SELECT reserved_calls FROM investigation_read_budget WHERE request_id='inv-a'")
      .get() as { reserved_calls: number | null }).reserved_calls, null);
    assert.throws(() => reopenedUnknown.reserveRunningRead(started, f.binding, f.boundRead, f.now));
    reopenedUnknown.close();
    check.exec('DROP TABLE investigation_read_budget');
    check.prepare("UPDATE investigation_requests SET record_json=json_set(record_json,'$.state','queued','$.attempts',json('[]')) WHERE id='inv-a'").run();
    check.prepare("DELETE FROM investigation_active_attempts WHERE request_id='inv-a'").run();
    check.close();
    const second = new SqliteInvestigationStore(f.file);
    second.close();
    const third = new SqliteInvestigationStore(f.file);
    third.close();
    const final = new DatabaseSync(f.file);
    const row = final.prepare('SELECT reserved_calls FROM investigation_read_budget WHERE request_id=?').get('inv-a') as { reserved_calls: number | null };
    assert.equal(row.reserved_calls, 0);
    final.close();
  } finally { f.close(); }
});

test('completed budget migration never replenishes a missing row on reopen', async () => {
  const f = await fixture(1);
  try {
    const db = new DatabaseSync(f.file);
    db.prepare("DELETE FROM investigation_read_budget WHERE request_id='inv-a'").run();
    db.close();
    const reopened = new SqliteInvestigationStore(f.file);
    const started = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
    assert.throws(() => reopened.reserveRunningRead(started, f.binding, f.boundRead, f.now));
    const check = new DatabaseSync(f.file);
    assert.equal(check.prepare("SELECT reserved_calls FROM investigation_read_budget WHERE request_id='inv-a'").get(), undefined);
    check.close();
    reopened.close();
  } finally { f.close(); }
});

test('repository read reservation validates actual path and snapshot before spending', async () => {
  const f = await fixture(1);
  try {
    const started = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
    const other = createSnapshotFromFiles('wc-a', 'other-commit',
      { 'src/entry.ts': Buffer.from('SECRET_OTHER_SNAPSHOT\n') }).toPersisted();
    await f.base.saveSnapshot({ workspaceId: f.workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', snapshot: other },
      { workspaceId: f.workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', commitRef: 'other-commit' },
      'other-capture', 'owner', 'local_cli');
    const repository = new RepositoryApplication({
      authorize: ({ context, operation, workspaceId, collaborationId }) =>
        authorize({ ...context, now: f.now }, operation, { workspaceId, collaborationId },
          f.base.grantsFor(context.principal, context.audience)),
      getWorkingCopy: (workspaceId, workingCopyId) => f.base.getWorkingCopy(workspaceId, workingCopyId),
      collaborationBelongsToWorkspace: (workspaceId, collaborationId) => f.base.collaborationBelongsToWorkspace(workspaceId, collaborationId),
      lookupCapture: (input, key, principal, audience) => f.base.lookupCapture(input, key, principal, audience),
      saveSnapshot: (record, input, key, principal, audience) => f.base.saveSnapshot(record, input, key, principal, audience),
      getSnapshot: (id, workspaceId, collaborationId) => f.base.getSnapshot(id, workspaceId, collaborationId),
    });
    const context = { principal: started.workerId, audience: f.binding.workerAudience,
      recipient: f.binding.workerRecipient, surface: 'external_mcp' as const, now: f.now,
      delegatedPermissions: ['data.read'],
      reserveRepositoryRead: (read: { workspaceId: string; collaborationId: string; workingCopyId: string; snapshotId: string; path: string }) =>
        f.store.reserveRunningRead(started, f.binding, read, f.now) };
    const request = { context, workspaceId: f.workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a' };
    await assert.rejects(repository.read({ ...request, snapshotId: other.id, path: 'src/entry.ts' }));
    await assert.rejects(repository.read({ ...request, snapshotId: f.binding.snapshotId, path: 'src/other.ts' }));
    assert.match((await repository.read({ ...request, snapshotId: f.binding.snapshotId, path: 'src/entry.ts' })).content, /SYNTHETIC_A/);
    await assert.rejects(repository.read({ ...request, snapshotId: f.binding.snapshotId, path: 'src/entry.ts' }));
  } finally { f.close(); }
});

test('running investigator read requires exact durable attempt and both original and worker grants', async () => {
  for (const change of ['valid', 'prelaunch', 'wrong-snapshot', 'wrong-path', 'wrong-worker',
    'old-epoch', 'wrong-native', 'worker-recipient', 'worker-wider', 'worker-invalid-expiry',
    'worker-null-expiry', 'worker-expired', 'permission-epoch',
    'request-revoked', 'original-read-revoked', 'worker-read-revoked', 'cancel', 'lease-expired']) {
    const f = await fixture();
    try {
      const started = change === 'prelaunch' ? f.claim : f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
      if (change === 'request-revoked') f.base.revokeGrant('original-request', f.now.toISOString());
      if (change === 'original-read-revoked') f.base.revokeGrant('original-read', f.now.toISOString());
      if (change === 'worker-read-revoked') f.base.revokeGrant('worker-read', f.now.toISOString());
      if (['worker-wider', 'worker-invalid-expiry', 'worker-null-expiry', 'worker-expired'].includes(change)) {
        f.base.insertGrant({ id: change, principal: started.workerId,
          audience: 'investigator-ipc', recipient: 'claude-code-local', workspaceId: f.claim.workspaceId,
          collaborationId: 'col-a', permissions: ['data.read'],
          dataPaths: change === 'worker-wider' ? ['src/'] : ['src/entry.ts'],
          expiresAt: change === 'worker-invalid-expiry' ? 'invalid-date' :
            change === 'worker-null-expiry' ? null :
              new Date(f.now.getTime() + (change === 'worker-expired' ? -1 : 60_000)).toISOString(),
          revokedAt: null });
      }
      if (change === 'permission-epoch') {
        f.base.insertGrant({ id: 'extra-request', principal: 'external-a', audience: 'chatgpt',
          recipient: 'chatgpt-user', workspaceId: f.claim.workspaceId, collaborationId: 'col-a',
          permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
        f.base.revokeGrant('extra-request', f.now.toISOString());
      }
      if (change === 'cancel') f.store.requestCancel(f.store.get('inv-a')!, 'cancel', 'original-request');
      const claim = change === 'wrong-worker' ? { ...started, workerId: 'other-worker' } :
        change === 'old-epoch' ? { ...started, workerEpoch: started.workerEpoch + 1 } :
          change === 'wrong-native' ? { ...started, nativeRef: 'other-native' } : started;
      const binding = { ...f.binding,
        snapshotId: change === 'wrong-snapshot' ? 'snp-b' : f.binding.snapshotId,
        paths: change === 'wrong-path' ? ['src/other.ts'] : f.binding.paths,
        workerGrantId: change.startsWith('worker-') && change !== 'worker-recipient' &&
          change !== 'worker-read-revoked' ? change : f.binding.workerGrantId,
        workerRecipient: change === 'worker-recipient' ? 'other-recipient' : f.binding.workerRecipient };
      const at = change === 'lease-expired' ? new Date(f.now.getTime() + 31_000) : f.now;
      if (change === 'valid') assert.doesNotThrow(() => f.store.assertRunningReadAuthority(claim, binding, at));
      else assert.throws(() => f.store.assertRunningReadAuthority(claim, binding, at), change);
    } finally { f.close(); }
  }
});

test('real dispatch and persisted snapshot refuse disclosure after either grant changes', async () => {
  for (const change of ['original-read', 'worker-read', 'during-read', 'during-worker-read']) {
    const f = await fixture();
    const claim = f.store.recordNativeStart(f.claim, 'native-test', 'receipt', f.now);
    let revokeDuringSnapshot = false;
    const authorizeCurrent = async (request: { context: Parameters<typeof authorize>[0]; operation: string;
      workspaceId: string; collaborationId: string }) => {
      await request.context.assertFreshAuthority?.();
      const context = { ...request.context, now: new Date() };
      return authorize(context, request.operation, { workspaceId: request.workspaceId,
        collaborationId: request.collaborationId }, f.base.grantsFor(context.principal, context.audience));
    };
    const repository = new RepositoryApplication({
      authorize: authorizeCurrent,
      getWorkingCopy: (workspaceId, workingCopyId) => f.base.getWorkingCopy(workspaceId, workingCopyId),
      collaborationBelongsToWorkspace: (workspaceId, collaborationId) =>
        f.base.collaborationBelongsToWorkspace(workspaceId, collaborationId),
      lookupCapture: (input, key, principal, audience) => f.base.lookupCapture(input, key, principal, audience),
      saveSnapshot: (record, input, key, principal, audience) => f.base.saveSnapshot(record, input, key, principal, audience),
      getSnapshot: (id, workspaceId, collaborationId) => {
        const snapshot = f.base.getSnapshot(id, workspaceId, collaborationId);
        if (revokeDuringSnapshot) {
          revokeDuringSnapshot = false;
          f.base.revokeGrant(change === 'during-worker-read' ? 'worker-read' : 'original-read',
            new Date().toISOString());
        }
        return snapshot;
      },
    });
    const server = createPersistedInvestigatorMcpServer({
      claim, store: f.store, workerGrantId: f.binding.workerGrantId,
      workerAudience: f.binding.workerAudience, workerRecipient: f.binding.workerRecipient,
      dispatcher: new DispatchService(f.base, undefined, undefined, { repository }),
    });
    const client = new Client({ name: 'real-dispatch-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const read = () => client.callTool({ name: 'repo.read', arguments: {
        scope: { workspaceId: f.workspaceId, collaborationId: f.binding.collaborationId },
        payload: { workingCopyId: f.binding.workingCopyId, snapshotId: f.binding.snapshotId,
          path: 'src/entry.ts' },
      } });
      const allowed = await read();
      assert.equal(allowed.isError, undefined);
      assert.match(JSON.stringify(allowed), /SYNTHETIC_A/);
      if (change === 'during-read' || change === 'during-worker-read') revokeDuringSnapshot = true;
      else f.base.revokeGrant(change, new Date().toISOString());
      const denied = await read();
      assert.equal(denied.isError, true, change);
      assert.doesNotMatch(JSON.stringify(denied), /SYNTHETIC_A/);
    } finally { await client.close(); await server.close(); f.close(); }
  }
});

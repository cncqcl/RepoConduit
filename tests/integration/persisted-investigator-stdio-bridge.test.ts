import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { startPersistedInvestigatorStdioBridge } from '../../src/adapters/secondary-investigator/persisted-stdio-bridge.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { authorize } from '../../src/core/policy/authorize.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

test('child stdio reads only its persisted attempt and exact snapshot until revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-attempt-pipe-'));
  const dbFile = join(dir, 'state.sqlite');
  const base = new SqliteStore(dbFile);
  const workspaceId = `ws_${randomUUID()}`;
  const workerId = `worker_${randomUUID()}`;
  const now = new Date();
  base.insertWorkspace({ id: workspaceId, name: 'Fixture', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'col-a', workspaceId, openedBy: 'owner', purpose: 'read', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'wc-a', workspaceId, canonicalRoot: dir });
  const snapshot = createSnapshotFromFiles('wc-a', 'synthetic-commit', {
    'src/entry.ts': Buffer.from('export const allowed = "PIPE_ALLOWED";\n'),
    'src/hidden.ts': Buffer.from('export const hidden = "PIPE_DENIED";\n'),
  }).toPersisted();
  await base.saveSnapshot({ workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', snapshot },
    { workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', commitRef: 'synthetic-commit' },
    'capture', 'owner', 'local_cli');
  base.insertGrant({ id: 'request', principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user',
    workspaceId, collaborationId: 'col-a', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'original-read', principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user',
    workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/entry.ts'],
    expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'worker-read', principal: workerId, audience: 'investigator-ipc', recipient: 'local-worker',
    workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/entry.ts'],
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), revokedAt: null });
  const record: InvestigationRecord = { id: 'inv-a', workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a',
    principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user', grantId: 'request',
    profileRef: 'verified-test', budgetRef: 'bounded-test', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 5 },
    contextRevisionId: 'ctx-a', snapshotRef: snapshot.id, question: 'Trace entry',
    scope: { paths: ['src/entry.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  const store = new SqliteInvestigationStore(dbFile, { verifyIsolation: () => true,
    verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true });
  let child: ReturnType<typeof spawn> | undefined;
  let oversizeChild: ReturnType<typeof spawn> | undefined;
  let bridge: ReturnType<typeof startPersistedInvestigatorStdioBridge> | undefined;
  let oversizeBridge: ReturnType<typeof startPersistedInvestigatorStdioBridge> | undefined;
  try {
    store.enqueue(record, 'submit', 'fingerprint');
    const claimed = store.claimRequest(record.id, { workerId, isolationEvidence: 'test-only',
      profileRevision: 'verified-test', permissionEpoch: 0, now })!;
    const repository = new RepositoryApplication({
      authorize: async request => {
        await request.context.assertFreshAuthority?.();
        const context = { ...request.context, now: new Date() };
        return authorize(context, request.operation, { workspaceId: request.workspaceId,
          collaborationId: request.collaborationId }, base.grantsFor(context.principal, context.audience));
      },
      getWorkingCopy: (ws, wc) => base.getWorkingCopy(ws, wc),
      collaborationBelongsToWorkspace: (ws, col) => base.collaborationBelongsToWorkspace(ws, col),
      lookupCapture: (input, key, principal, audience) => base.lookupCapture(input, key, principal, audience),
      saveSnapshot: (saved, input, key, principal, audience) => base.saveSnapshot(saved, input, key, principal, audience),
      getSnapshot: (id, ws, col) => base.getSnapshot(id, ws, col),
    });
    const dispatcher = new DispatchService(base, undefined, undefined, { repository });
    assert.throws(() => startPersistedInvestigatorStdioBridge({ claim: claimed, store,
      workerGrantId: 'worker-read', workerAudience: 'investigator-ipc', workerRecipient: 'local-worker',
      dispatcher, input: process.stdin, output: process.stdout }));
    const claim = store.recordNativeStart(claimed, 'native-test', 'receipt', now);
    const options = { claim, store, workerGrantId: 'worker-read', workerAudience: 'investigator-ipc',
      workerRecipient: 'local-worker', dispatcher };
    assert.throws(() => startPersistedInvestigatorStdioBridge({ ...options,
      claim: { ...claim, attemptId: 'wrong' }, input: process.stdin, output: process.stdout }));
    assert.throws(() => startPersistedInvestigatorStdioBridge({ ...options,
      claim: { ...claim, nativeRef: 'wrong' }, input: process.stdin, output: process.stdout }));
    child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/integration/persisted-investigator-stdio-client.ts')],
      { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const pipe = child;
    assert.ok(pipe.stdin && pipe.stdout);
    bridge = startPersistedInvestigatorStdioBridge({ ...options, input: pipe.stdout, output: pipe.stdin });
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('client readiness timeout')), 10_000);
      const listener = (message: unknown) => {
        if ((message as { stage?: string }).stage === 'connecting') return;
        clearTimeout(timer);
        pipe.off('message', listener);
        if ((message as { ready?: boolean }).ready) ok(); else fail(new Error(`client not ready: ${JSON.stringify(message)}`));
      };
      pipe.on('message', listener);
      pipe.once('exit', code => fail(new Error(`client exited ${code}`)));
    });
    let nextId = 0;
    const read = (path: string, override: Record<string, string> = {}) => new Promise<unknown>((ok, fail) => {
      const id = ++nextId;
      const timer = setTimeout(() => fail(new Error('read timeout')), 10_000);
      const listener = (message: unknown) => {
        const value = message as { id?: number; result?: unknown; error?: string };
        if (value.id !== id) return;
        clearTimeout(timer); pipe.off('message', listener);
        if (value.error) fail(new Error(value.error)); else ok(value.result);
      };
      pipe.on('message', listener);
      pipe.send({ id, args: { scope: { workspaceId: override.workspaceId ?? workspaceId,
        collaborationId: 'col-a' }, payload: { workingCopyId: 'wc-a',
        snapshotId: override.snapshotId ?? snapshot.id, path } } });
    });
    const allowed = await read('src/entry.ts');
    assert.match(JSON.stringify(allowed), /PIPE_ALLOWED/);
    oversizeChild = spawn(process.execPath,
      ['--import', 'tsx', resolve('tests/integration/persisted-investigator-stdio-client.ts')],
      { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const oversized = oversizeChild;
    assert.ok(oversized.stdin && oversized.stdout);
    oversizeBridge = startPersistedInvestigatorStdioBridge({ ...options,
      input: oversized.stdout, output: oversized.stdin });
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('oversize client readiness timeout')), 10_000);
      const listener = (message: unknown) => {
        if ((message as { ready?: boolean }).ready !== true) return;
        clearTimeout(timer); oversized.off('message', listener); ok();
      };
      oversized.on('message', listener);
    });
    oversized.send({ id: 0, args: {}, action: 'oversized' });
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('oversize frame was not closed')), 10_000);
      void oversizeBridge!.closed.then(() => { clearTimeout(timer); ok(); }, fail);
    });
    oversized.kill();
    const halfClosedInput = new PassThrough();
    const halfClosedOutput = new PassThrough();
    const halfClosedBridge = startPersistedInvestigatorStdioBridge({ ...options,
      input: halfClosedInput, output: halfClosedOutput });
    halfClosedInput.end();
    await halfClosedBridge.closed;
    assert.equal(halfClosedInput.listenerCount('data'), 0);
    for (const mode of ['finish', 'close', 'already-closed', 'blocked-send'] as const) {
      const input = new PassThrough();
      const output = new PassThrough({ highWaterMark: mode === 'blocked-send' ? 1 : 16 * 1024 });
      if (mode === 'already-closed') output.destroy();
      const lifecycle = startPersistedInvestigatorStdioBridge({ ...options, input, output });
      if (mode === 'blocked-send') {
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'blocked-client', version: '1' },
        } })}\n`);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(output.writableLength > 0);
      }
      if (mode === 'finish') output.end();
      else output.destroy();
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`output ${mode} did not close bridge`)), 1000);
        void lifecycle.closed.then(() => { clearTimeout(timer); ok(); }, fail);
      });
      assert.equal(input.listenerCount('data'), 0, mode);
      assert.equal(output.listenerCount('drain'), 0, mode);
      assert.equal(output.listenerCount('finish'), 0, mode);
      assert.equal(output.listenerCount('close'), 0, mode);
      input.destroy();
    }
    for (const denied of [await read('src/hidden.ts'), await read('src/entry.ts', { workspaceId: 'other' }),
      await read('src/entry.ts', { snapshotId: 'other' })]) {
      assert.equal((denied as { isError?: boolean }).isError, true);
      assert.doesNotMatch(JSON.stringify(denied), /PIPE_ALLOWED|PIPE_DENIED/);
    }
    base.revokeGrant('worker-read', new Date().toISOString());
    const revoked = await read('src/entry.ts');
    assert.equal((revoked as { isError?: boolean }).isError, true);
    assert.doesNotMatch(JSON.stringify(revoked), /PIPE_ALLOWED/);
    pipe.kill();
    await bridge.closed;
  } finally {
    await bridge?.close();
    await oversizeBridge?.close();
    child?.kill();
    oversizeChild?.kill();
    store.close(); base.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

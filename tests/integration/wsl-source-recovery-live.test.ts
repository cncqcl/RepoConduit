import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWslSourceView } from '../../src/adapters/codex/investigator/source-view-runner.js';
import { runWslLaunchGate } from '../../src/adapters/codex/investigator/launch-gate-runner.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { startInvestigationRecovery } from '../../src/runtime/investigation-recovery.js';
import { prepareInvestigationSource } from '../../src/runtime/investigation-source-preparation.js';

const distro = 'Ubuntu-22.04';
const linuxUser = 'fixture';
function wsl(args: string[]) {
  return spawnSync('wsl.exe', ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', ...args],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 });
}

test('real WSL source view closes after database reopen before reserved slot release',
  { skip: process.env.RCAC_WSL_SOURCE_LIVE !== '1' }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'rcac-wsl-source-recovery-'));
    const dbPath = join(fixture, 'state.sqlite');
    const workspaceId = `ws_${randomUUID()}`;
    const collaborationId = `col_${randomUUID()}`;
    const workingCopyId = `copy_${randomUUID()}`;
    const requestId = `inv_${randomUUID()}`;
    const grantId = `grant_${randomUUID()}`;
    const bytes = 'synthetic source bytes\n';
    let base: SqliteStore | undefined;
    let store: SqliteInvestigationStore | undefined;
    let sourceRoot: string | undefined;
    let gateRoot: string | undefined;
    let attemptId: string | undefined;
    try {
      const uidProbe = wsl(['/usr/bin/id', '-u']);
      const bootProbe = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      assert.equal(uidProbe.status, 0, uidProbe.stderr);
      assert.equal(bootProbe.status, 0, bootProbe.stderr);
      const uid = Number(uidProbe.stdout.trim());
      const bootId = bootProbe.stdout.trim();
      assert.ok(Number.isSafeInteger(uid) && uid > 0);

      base = new SqliteStore(dbPath);
      base.insertWorkspace({ id: workspaceId, name: 'synthetic-source-recovery',
        canonicalRoot: fixture, registeredBy: 'fixture-owner' });
      base.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'fixture-owner',
        purpose: 'synthetic source recovery', hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: workingCopyId, workspaceId, canonicalRoot: fixture });
      base.insertGrant({ id: grantId, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient',
        permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
      base.insertGrant({ id: `read_${randomUUID()}`, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient', permissions: ['data.read'],
        dataPaths: ['fixture/'], expiresAt: null, revokedAt: null });
      const snapshot = createSnapshotFromFiles(workingCopyId, 'a'.repeat(40),
        { 'fixture/input.txt': Buffer.from(bytes) });
      await base.saveSnapshot({ workspaceId, collaborationId, workingCopyId,
        snapshot: snapshot.toPersisted() }, { workspaceId, collaborationId, workingCopyId,
        commitRef: 'a'.repeat(40) }, `capture-${randomUUID()}`, 'fixture-principal', 'external');
      const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => false,
        verifyOutcomeReceipt: () => false, verifyWslTerminationReceipt: () => false };
      store = new SqliteInvestigationStore(dbPath, authority);
      const request: InvestigationRecord = { id: requestId, workspaceId, collaborationId,
        workingCopyId, principal: 'fixture-principal', audience: 'external', recipient: 'fixture-recipient',
        grantId, profileRef: 'fixture-profile', budgetRef: 'fixture-budget',
        budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
        contextRevisionId: 'fixture-context', snapshotRef: snapshot.id,
        question: 'synthetic source recovery only',
        scope: { paths: ['fixture/input.txt'], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued',
        cancelRequested: false, attempts: [], result: null, createdAt: new Date().toISOString() };
      store.enqueue(request, requestId, requestId);
      const claimedAt = new Date(Date.now() - 60_000);
      const claim = store.claimRequest(requestId, { workerId: 'fixture-worker', isolationEvidence: 'synthetic',
        profileRevision: 'fixture-profile', permissionEpoch: 0, now: claimedAt,
        launchProtocol: 'resource_reservation_v1' });
      assert.ok(claim);
      attemptId = claim.attemptId;
      const unitName = `rcac-investigator-${randomUUID()}.service`;
      gateRoot = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
      sourceRoot = `/home/${linuxUser}/.local/state/rcac/sources-${attemptId}`;
      for (const root of [gateRoot, sourceRoot])
        assert.equal(wsl(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
      const gateDescriptor = { attemptId, workspaceId, distro, linuxUser, uid, bootId, unitName };
      const binding = { workspaceId, collaborationId, workingCopyId,
        snapshotRef: request.snapshotRef, contextRevisionId: request.contextRevisionId,
        recipient: request.recipient, requestId, attemptId, workerEpoch: claim.workerEpoch };
      const prepared = await prepareInvestigationSource({ store, snapshots: base, claim,
        expected: binding, reservation: { unitName, distro, uid, bootId,
          gate: { protocol: 'attempt_gate_v1', linuxUser, root: gateRoot,
            payloadKind: 'canary_v1' } }, sourceRoot,
        now: () => new Date(claimedAt.getTime() + 1_000) });
      assert.equal(prepared.source.kind, 'ready');
      assert.equal(prepared.gate.kind, 'open');
      const sourceDescriptor = prepared.claim.sourceView!.descriptor;
      store.close();
      store = new SqliteInvestigationStore(dbPath, authority);
      const recovery = startInvestigationRecovery(store);
      try { await recovery.ready; } finally { await recovery.close(); }
      assert.deepEqual(store.listUnsettled(), []);
      assert.equal(store.get(requestId)?.state, 'failed');
      assert.equal((await runWslSourceView('status', sourceDescriptor, sourceRoot))?.kind, 'closed');
      assert.equal((await runWslSourceView('materialize', sourceDescriptor, sourceRoot, prepared.plan)), null);
      assert.equal((await runWslLaunchGate('prepare', gateDescriptor, gateRoot)), null);
    } finally {
      // Exact synthetic paths only, after closure; do not traverse or remove unknown content.
      if (sourceRoot && attemptId) {
        for (const suffix of ['.json', '.lock'])
          wsl(['/usr/bin/unlink', `${sourceRoot}/${attemptId}${suffix}`]);
        wsl(['/usr/bin/rmdir', sourceRoot]);
      }
      if (gateRoot && attemptId) {
        for (const suffix of ['.json', '.lock'])
          wsl(['/usr/bin/unlink', `${gateRoot}/${attemptId}${suffix}`]);
        wsl(['/usr/bin/rmdir', gateRoot]);
      }
      store?.close();
      base?.close();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runWslLaunchGate } from '../../src/adapters/codex/investigator/launch-gate-runner.js';
import { observeFixedCanaryTerminal } from
  '../../src/adapters/codex/investigator/fixed-canary-terminal-observer.js';
import { runWslSourceView } from '../../src/adapters/codex/investigator/source-view-runner.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { runClaimedCanaryInvestigation, runWslCanaryUnit } from
  '../../src/runtime/investigation-canary-supervisor.js';
import { createFixedCanaryTerminationTickets } from
  '../../src/runtime/fixed-canary-termination-tickets.js';

const enabled = process.env.RCAC_WSL_CANARY_SUPERVISOR_LIVE === '1';
const distro = 'Ubuntu-22.04';
const linuxUser = 'fixture';
const wsl = (args: string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
  ['-d', distro, '--user', linuxUser, '--exec', ...args],
  { encoding: 'utf8', timeout: 20_000, maxBuffer: 4096 });

test('real WSL queued canary settles exact fixed exit while the worker still owns the lease',
  { skip: !enabled && 'opt in with RCAC_WSL_CANARY_SUPERVISOR_LIVE=1', timeout: 150_000 }, async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'rcac-canary-live-'));
    assert.ok(resolve(localRoot).startsWith(resolve(tmpdir()) + '\\rcac-canary-live-'));
    const dbPath = join(localRoot, 'state.sqlite');
    const fixtureName = `supervisor-${randomUUID()}`;
    const linuxRoot = `/home/${linuxUser}/.local/state/rcac/${fixtureName}`;
    const gateRoot = `${linuxRoot}/gate`;
    const sourceRoot = `${linuxRoot}/source`;
    const workspaceId = `ws_${randomUUID()}`;
    const requestId = `inv_${randomUUID()}`;
    let attemptId: string | undefined;
    let base: SqliteStore | undefined;
    let store: SqliteInvestigationStore | undefined;
    let rootsCreated = false;
    try {
      for (const root of [linuxRoot, gateRoot, sourceRoot]) {
        const created = wsl(['/usr/bin/install', '-d', '-m', '700', '--', root]);
        assert.equal(created.status, 0, created.stderr);
      }
      rootsCreated = true;
      const uidResult = wsl(['/usr/bin/id', '-u']);
      const bootResult = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      assert.equal(uidResult.status, 0);
      assert.equal(bootResult.status, 0);
      const uid = Number(uidResult.stdout.trim());
      const bootId = bootResult.stdout.trim();
      assert.equal(Number.isSafeInteger(uid) && uid > 0, true);
      assert.match(bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      base = new SqliteStore(dbPath);
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
        { 'src/main.ts': Buffer.from('fixed source for live canary\n') });
      await base.saveSnapshot({ workspaceId, collaborationId: 'col', workingCopyId: 'copy',
        snapshot: snapshot.toPersisted() }, { workspaceId, collaborationId: 'col',
        workingCopyId: 'copy', commitRef: 'a'.repeat(40) }, 'capture', 'p', 'external');
      const tickets = createFixedCanaryTerminationTickets();
      const authority = { verifyIsolation: (evidence: string) => evidence === 'zero-model-fixture',
        verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
        verifyWslTerminationReceipt: tickets.verify };
      store = new SqliteInvestigationStore(dbPath, authority);
      const record: InvestigationRecord = { id: requestId, workspaceId, collaborationId: 'col',
        workingCopyId: 'copy', principal: 'p', audience: 'external', recipient: 'ext',
        grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
        budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx',
        snapshotRef: snapshot.id, question: 'zero-model synthetic canary',
        scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
        parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [],
        result: null, createdAt: new Date().toISOString() };
      store.enqueue(record, requestId, requestId);
      const observed = await runClaimedCanaryInvestigation({ requestId, store,
        snapshots: { getSnapshot: base.getSnapshot.bind(base) },
        expected: { workspaceId, collaborationId: 'col', workingCopyId: 'copy',
          snapshotRef: snapshot.id, contextRevisionId: 'ctx', recipient: 'ext', requestId },
        claim: { workerId: 'fixture-worker', isolationEvidence: 'zero-model-fixture',
          profileRevision: 'fixed', permissionEpoch: 0, now: new Date() },
        reservationForClaim: (claim) => {
          attemptId = claim.attemptId;
          return { sourceRoot, reservation: {
            unitName: `rcac-investigator-${claim.attemptId.slice('attempt_'.length)}.service`,
            distro, uid, bootId, gate: { protocol: 'attempt_gate_v1', linuxUser,
              root: gateRoot, payloadKind: 'canary_v1' } } };
        },
        termination: { canaries: { observe: observeFixedCanaryTerminal,
          issue: tickets.issue, revoke: tickets.revoke } },
      }, {
        materialize: async (descriptor, root, plan, signal) => {
          const state = await runWslSourceView('materialize', descriptor, root, plan, signal);
          if (state?.kind === 'ready') {
            const read = wsl(['/usr/bin/cat', `${root}/${descriptor.attemptId}.view/src/main.ts`]);
            assert.equal(read.status, 0, read.stderr);
            assert.equal(read.stdout, 'fixed source for live canary\n');
          }
          return state;
        },
        prepareGate: (descriptor, root, signal) => runWslLaunchGate('prepare', descriptor, root, signal),
        launchAndClose: (descriptor, root, signal) => runWslCanaryUnit(descriptor, root, signal),
      });
      assert.match(observed.observedUnit.invocationId, /^[0-9a-f]{32}$/);
      assert.equal(store.get(requestId)?.result, null);
      assert.equal(observed.settled, true);
      assert.equal(store.get(requestId)?.state, 'failed');
      assert.equal(store.get(requestId)?.attempts[0]?.terminationConfirmed, true);
      assert.equal(store.listUnsettled().length, 0);
      store.close(); store = undefined;
      store = new SqliteInvestigationStore(dbPath, authority);
      const recovered = store.get(requestId);
      assert.equal(recovered?.state, 'failed');
      assert.equal(recovered?.result, null);
      assert.equal(recovered?.attempts[0]?.terminationConfirmed, true);
      assert.equal(store.listUnsettled().length, 0);
      const gateRead = wsl(['/usr/bin/cat', `${gateRoot}/${attemptId}.json`]);
      assert.equal(gateRead.status, 0);
      assert.match(gateRead.stdout, /"kind":"closed_consumed"/);
      assert.equal(wsl(['/usr/bin/test', '-d', `${sourceRoot}/${attemptId}.view`]).status, 1);
      console.log(`current worker settled fixed canary; fixture=${localRoot}`);
    } finally {
      store?.close(); base?.close();
      // Keep any consumed fixture for inspection, including uncertain failures;
      // deleting only its local records would erase recovery evidence.
      if (rootsCreated && !attemptId) {
        for (const root of [gateRoot, sourceRoot, linuxRoot]) {
          const removed = wsl(['/usr/bin/rmdir', root]);
          assert.equal(removed.status, 0, removed.stderr);
        }
      }
      if (!attemptId) rmSync(localRoot, { recursive: true, force: true });
    }
  });

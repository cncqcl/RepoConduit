import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWslSourceView } from '../../src/adapters/codex/investigator/source-view-runner.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { runNativeSupervisorGate } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor-runner.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../../src/adapters/secondary-investigator/fixed-zero-model-profile.js';
import { observeSupervisorV2Running } from
  '../../src/adapters/secondary-investigator/supervisor-v2-running-observer.js';
import { observeSupervisorV2Terminal } from
  '../../src/adapters/secondary-investigator/supervisor-v2-terminal-observer.js';
import { runWslTerminalProbe } from '../../src/adapters/codex/investigator/terminal-observer.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { runClaimedSupervisorV2Diagnostic, runFixedSupervisorV2Unit,
  type SupervisorV2DiagnosticOperations } from
  '../../src/runtime/investigation-supervisor-v2-diagnostic.js';
import { startInvestigationRecovery } from '../../src/runtime/investigation-recovery.js';
import { createSupervisorV2TerminationTickets } from
  '../../src/runtime/supervisor-v2-termination-tickets.js';

const enabled = process.env.RCAC_WSL_SUPERVISOR_V2_LIVE === '1';
const distro = 'Ubuntu-22.04';
const linuxUser = 'fixture';
const sourceBytes = Buffer.from('export const syntheticSupervisorV2 = "zero-model-only";\n', 'utf8');
const wsl = (args: string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
  ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', ...args],
  { encoding: 'buffer', timeout: 12_000, maxBuffer: 8192 });
const utf8 = (value: Buffer | null) => value?.toString('utf8') ?? '';

test('real WSL v2 zero-model unit consumes exact source and keeps recovery slot until verified cleanup',
  { skip: !enabled && 'opt in with RCAC_WSL_SUPERVISOR_V2_LIVE=1', timeout: 170_000 }, async () => {
    // No model, account, user source, public ingress, or arbitrary executable is involved.
    const fixture = mkdtempSync(join(tmpdir(), 'rcac-v2-live-'));
    const dbPath = join(fixture, 'state.sqlite');
    const fixtureId = randomUUID();
    const linuxRoot = `/home/${linuxUser}/.local/state/rcac/v2-live-${fixtureId}`;
    const gateRoot = `${linuxRoot}/gate`;
    const sourceRoot = `${linuxRoot}/source`;
    const workspaceId = `ws_${randomUUID()}`;
    const collaborationId = `col_${randomUUID()}`;
    const workingCopyId = `copy_${randomUUID()}`;
    const requestId = `inv_${randomUUID()}`;
    const grantId = `grant_${randomUUID()}`;
    const tickets = createSupervisorV2TerminationTickets();
    const authority = { verifyIsolation: (evidence: string) => evidence === 'synthetic-v2-live',
      verifyNativeReceipt: () => false, verifyOutcomeReceipt: () => false,
      verifySupervisorV2TerminalReceipt: tickets.verify };
    let base: SqliteStore | undefined;
    let store: SqliteInvestigationStore | undefined;
    let attemptId: string | undefined;
    let unitName: string | undefined;
    const stages: string[] = [];
    try {
      const uidProbe = wsl(['/usr/bin/id', '-u']);
      const bootProbe = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      const busProbe = wsl(['/usr/bin/systemctl', '--user', 'show-environment']);
      assert.equal(uidProbe.status, 0, utf8(uidProbe.stderr));
      assert.equal(bootProbe.status, 0, utf8(bootProbe.stderr));
      assert.equal(busProbe.status, 0, utf8(busProbe.stderr));
      const uid = Number(utf8(uidProbe.stdout).trim());
      const bootId = utf8(bootProbe.stdout).trim();
      assert.ok(Number.isSafeInteger(uid) && uid > 0);
      assert.match(bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      for (const root of [linuxRoot, gateRoot, sourceRoot]) {
        const created = wsl(['/usr/bin/install', '-d', '-m', '700', '--', root]);
        assert.equal(created.status, 0, utf8(created.stderr));
      }
      console.log(`v2 live preflight passed; synthetic fixture=${fixture}; WSL root=${linuxRoot}`);

      base = new SqliteStore(dbPath);
      base.insertWorkspace({ id: workspaceId, name: 'synthetic-v2-live', canonicalRoot: fixture,
        registeredBy: 'fixture-owner' });
      base.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'fixture-owner',
        purpose: 'zero-model diagnostic', hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: workingCopyId, workspaceId, canonicalRoot: fixture });
      base.insertGrant({ id: grantId, principal: 'fixture-principal', audience: 'external', workspaceId,
        collaborationId, recipient: 'fixture-recipient', permissions: ['investigation.request'],
        expiresAt: null, revokedAt: null });
      base.insertGrant({ id: `read_${randomUUID()}`, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient', permissions: ['data.read'],
        dataPaths: ['src/'], expiresAt: null, revokedAt: null });
      const snapshot = createSnapshotFromFiles(workingCopyId, 'a'.repeat(40),
        { 'src/main.ts': sourceBytes });
      await base.saveSnapshot({ workspaceId, collaborationId, workingCopyId,
        snapshot: snapshot.toPersisted() }, { workspaceId, collaborationId,
        workingCopyId, commitRef: 'a'.repeat(40) }, `capture_${randomUUID()}`,
      'fixture-principal', 'external');
      store = new SqliteInvestigationStore(dbPath, authority);
      const record: InvestigationRecord = { id: requestId, workspaceId, collaborationId,
        workingCopyId, principal: 'fixture-principal', audience: 'external',
        recipient: 'fixture-recipient', grantId, profileRef: 'fixed-zero-model',
        budgetRef: 'synthetic-only', budget: { maxWallSeconds: 90, maxTurns: 1, maxToolCalls: 1 },
        contextRevisionId: 'synthetic-context', snapshotRef: snapshot.id,
        question: 'synthetic zero-model WSL lifecycle',
        scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued',
        cancelRequested: false, attempts: [], result: null, createdAt: new Date().toISOString() };
      store.enqueue(record, requestId, requestId);
      const operations: SupervisorV2DiagnosticOperations = {
        source: {
          materialize: async (descriptor, root, plan, signal) => {
            const state = await runWslSourceView('materialize', descriptor, root, plan, signal);
            assert.equal(state?.kind, 'ready');
            const read = wsl(['/usr/bin/cat', `${root}/${descriptor.attemptId}.view/src/main.ts`]);
            assert.equal(read.status, 0, utf8(read.stderr));
            assert.deepEqual(read.stdout, sourceBytes);
            stages.push('source-exact');
            console.log(`v2 live source materialized; sha256=${createHash('sha256').update(read.stdout!).digest('hex')}`);
            return state;
          },
          prepareGate: async (descriptor, root, signal) => {
            const state = await runNativeSupervisorGate('prepare', descriptor, root, undefined, signal);
            assert.equal(state?.protocol, 'native_supervisor_v2');
            stages.push('prepared');
            return state?.protocol === 'native_supervisor_v2' ? state : null;
          },
        },
        launchUnit: async (descriptor, root, signal) => {
          const result = await runFixedSupervisorV2Unit(descriptor, root, signal);
          stages.push('unit-launched');
          console.log(`v2 live systemd launch bridge=${result}; unit=${descriptor.unitName}`);
          return result;
        },
        status: async (descriptor, root, signal) => {
          const state = await runNativeSupervisorGate('status', descriptor, root, undefined, signal);
          if (state?.protocol === 'native_supervisor_v2' && state.phase === 'entered' &&
            !stages.includes('entered')) stages.push('entered');
          if (state?.protocol === 'native_supervisor_v2' && state.phase === 'consumed' &&
            !stages.includes('consumed')) stages.push('consumed');
          return state?.protocol === 'native_supervisor_v2' ? state : null;
        },
        observeRunning: async (resource, journal, expected) => {
          const state = await observeSupervisorV2Running(resource, journal, expected);
          assert.equal(state.kind, 'original_unit_running');
          stages.push('running-observed');
          return state;
        },
        release: async (descriptor, root, observed, signal) => {
          const state = await runNativeSupervisorGate('release', descriptor, root, observed, signal);
          assert.equal(state?.protocol, 'native_supervisor_v2');
          stages.push('released');
          return state?.protocol === 'native_supervisor_v2' ? state : null;
        },
        close: async (descriptor, root) => {
          const state = await runNativeSupervisorGate('close', descriptor, root);
          assert.equal(state?.protocol, 'native_supervisor_v2');
          stages.push('closed');
          return state?.protocol === 'native_supervisor_v2' ? state : null;
        },
      };
      const result = await runClaimedSupervisorV2Diagnostic({ requestId, store,
        snapshots: { getSnapshot: base.getSnapshot.bind(base) },
        expected: { workspaceId, collaborationId, workingCopyId, snapshotRef: snapshot.id,
          contextRevisionId: record.contextRevisionId, recipient: record.recipient, requestId },
        claim: { workerId: 'synthetic-v2-worker', isolationEvidence: 'synthetic-v2-live',
          profileRevision: record.profileRef, permissionEpoch: 0, now: new Date() },
        reservationForPlan: (claim, plan) => {
          attemptId = claim.attemptId;
          unitName = `rcac-investigator-${claim.attemptId.slice('attempt_'.length)}.service`;
          return { sourceRoot, reservation: { unitName, distro, uid, bootId,
            gate: { protocol: 'attempt_gate_v1', linuxUser, root: gateRoot,
              payloadKind: 'native_supervisor_v2', launch: { workerEpoch: claim.workerEpoch,
                sourceDigest: plan.digest, profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST,
                action: 'fixed_zero_model_v1' } } } };
        },
        heartbeatIntervalMs: 1000,
      }, operations);
      assert.equal(result.consumed, true);
      assert.equal(result.closed, true);
      assert.deepEqual(stages, ['source-exact', 'prepared', 'unit-launched', 'entered',
        'running-observed', 'released', 'consumed', 'closed']);
      assert.equal(store.get(requestId)?.state, 'recovery_required');
      assert.equal(store.get(requestId)?.result, null);
      assert.equal(store.listUnsettled().length, 1);
      const journal = await runNativeSupervisorGate('status', {
        attemptId: result.claim.attemptId, workspaceId, distro, linuxUser, uid, bootId,
        unitName: unitName!, launchWorkerEpoch: result.claim.workerEpoch,
        sourceDigest: result.sourceDigest, profileDigest: FIXED_ZERO_MODEL_PROFILE_DIGEST,
      }, gateRoot);
      assert.equal(journal?.protocol, 'native_supervisor_v2');
      assert.equal(journal?.protocol === 'native_supervisor_v2' && journal.phase, 'consumed');
      assert.equal(journal?.protocol === 'native_supervisor_v2' && journal.closed, true);
      const marker = wsl(['/usr/bin/cat', `${gateRoot}/${attemptId}.supervisor.canary`]);
      assert.equal(marker.status, 0, utf8(marker.stderr));
      assert.equal(utf8(marker.stdout), 'zero-model-consumed\n');
      console.log(`v2 live journal closed and consumed; attempt=${attemptId}`);

      // A fresh SQLite handle must keep the slot occupied until independent terminal,
      // source-closure, and cleanup-epoch evidence becomes available.
      store.close(); store = undefined;
      base.close(); base = undefined;
      store = new SqliteInvestigationStore(dbPath, authority);
      assert.equal(store.get(requestId)?.state, 'recovery_required');
      assert.equal(store.listUnsettled().length, 1);
      const resource = store.listUnsettled()[0]?.wslResource;
      assert.ok(resource);
      assert.ok(journal?.protocol === 'native_supervisor_v2');
      const persistedRunningFact = store.getSupervisorV2RunningFact(store.listUnsettled()[0]!);
      assert.equal(persistedRunningFact?.kind, 'original_unit_running');
      console.log('v2 live waiting for original lease expiry before installed startup recovery');
      await new Promise(resolve => setTimeout(resolve, 31_000));
      const terminal = await observeSupervisorV2Terminal(resource, journal,
        runWslTerminalProbe, persistedRunningFact ?? undefined);
      assert.equal(terminal.kind, 'fixed_zero_model_terminal');
      console.log(`v2 live terminal unit observed; native invocation=${result.observedUnit.invocationId}`);
      const recovery = startInvestigationRecovery(store, undefined, tickets);
      try { await recovery.ready; } finally { await recovery.close(); }
      assert.equal(store.get(requestId)?.state, 'failed');
      assert.equal(store.get(requestId)?.result, null);
      assert.equal(store.get(requestId)?.attempts[0]?.terminationConfirmed, true);
      assert.deepEqual(store.listUnsettled(), []);
      const closedSource = await runWslSourceView('status', {
        distro, linuxUser, uid, attemptId: result.claim.attemptId, workspaceId,
        workerEpoch: result.claim.workerEpoch, sourceDigest: result.sourceDigest, bootId,
      }, sourceRoot);
      assert.equal(closedSource?.kind, 'closed');
      assert.equal(wsl(['/usr/bin/test', '-d', `${sourceRoot}/${attemptId}.view`]).status, 1);
      console.log(`v2 live startup recovery settled slot and closed source; request=${requestId}`);
    } finally {
      store?.close(); base?.close();
      // Preserve uncertain WSL unit/journal/source and local SQLite on every path.
      // They are exact synthetic fixture paths printed above for later inspection.
      console.log(`v2 live fixture retained; Windows=${fixture}; WSL=${linuxRoot}; attempt=${attemptId ?? 'unclaimed'}`);
    }
  });

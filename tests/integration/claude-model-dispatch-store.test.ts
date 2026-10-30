import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { InvestigationClaim, InvestigationClaimAuthority } from '../../src/adapters/storage/investigation-sqlite.js';
import type { ClaudeModelSupervisorState } from '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { createClaudeModelRunningTickets } from '../../src/runtime/claude-model-running-tickets.js';
import { persistClaudeModelRunning } from '../../src/runtime/claude-model-start-observation.js';
import type { ClaudeModelRunningObservation } from '../../src/adapters/secondary-investigator/claude-model-running-observer.js';
import { claudeModelCommandDigest } from '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { runClaudeModelSupervisorOperation, startClaudeModelUnit } from '../../src/adapters/secondary-investigator/claude-model-supervisor-runner.js';

const modelLaunchProfile = { allowedDomains: [] };
import { observeClaudeModelTerminal } from '../../src/adapters/secondary-investigator/claude-model-terminal-observer.js';
import type { ClaudeModelTerminalObservation } from '../../src/adapters/secondary-investigator/claude-model-terminal-observer.js';
import { createClaudeModelPreventionTickets } from '../../src/runtime/claude-model-prevention-tickets.js';
import { recoverClaudeModelAttempt } from '../../src/runtime/claude-model-recovery.js';

function fixture(tickets?: ReturnType<typeof createClaudeModelRunningTickets>,
  prevention?: ReturnType<typeof createClaudeModelPreventionTickets>) {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-model-dispatch-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const now = new Date();
  const workspaceId = `ws_${randomUUID()}`;
  const record: InvestigationRecord = { id: 'inv-model', workspaceId, collaborationId: 'col-a',
    workingCopyId: 'wc-a', principal: 'external', audience: 'chatgpt', recipient: 'web', grantId: 'request',
    profileRef: 'synthetic-model', budgetRef: 'synthetic', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 5 },
    snapshotRef: 'snap-a', contextRevisionId: 'ctx-a', question: 'Trace flow',
    scope: { paths: ['src/a.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  base.insertWorkspace({ id: workspaceId, name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'col-a', workspaceId, purpose: 'model', openedBy: 'owner', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'wc-a', workspaceId, canonicalRoot: dir });
  base.insertGrant({ id: 'request', principal: 'external', audience: 'chatgpt', recipient: 'web',
    workspaceId, collaborationId: 'col-a', permissions: ['investigation.request', 'investigation.cancel'], revokedAt: null, expiresAt: null });
  base.insertGrant({ id: 'read', principal: 'external', audience: 'chatgpt', recipient: 'web',
    workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/a.ts'], revokedAt: null, expiresAt: null });
  base.insertGrant({ id: 'worker-read', principal: 'worker', audience: 'investigator', recipient: 'local',
    workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/a.ts'],
    revokedAt: null, expiresAt: new Date(now.getTime() + 120_000).toISOString() });
  // Explicit synthetic verifiers: these tests prove SQLite sequencing, not native execution.
  const authority: InvestigationClaimAuthority = { verifyIsolation: () => true,
    verifyNativeReceipt: tickets?.verifyNativeStart ?? (() => true),
    verifyOutcomeReceipt: () => true, verifyModelRunningReceipt: tickets?.verifyRunning ?? (() => true),
    verifyModelRunningObservationReceipt: tickets?.verifyRunningObservation ?? (() => true),
    verifyClaudeModelPreventionReceipt: prevention?.verify ?? (() => true) };
  const store = new SqliteInvestigationStore(file, authority);
  let storeClosed = false;
  store.enqueue(record, 'submit', 'fingerprint');
  const claim = store.claimRequest(record.id, { workerId: 'worker', isolationEvidence: 'synthetic',
    profileRevision: record.profileRef, permissionEpoch: 0, now, launchProtocol: 'resource_reservation_v1' })!;
  const launch = { workerEpoch: claim.workerEpoch, sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    action: 'claude_model_v1' as const, commandDigest: 'e'.repeat(64) };
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const reservation = { unitName, distro: 'Ubuntu-22.04', uid: 1000, bootId: randomUUID() as string,
    gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture', root: '/home/fixture/model-gates',
      payloadKind: 'claude_model_v1' as const, launch } };
  const binding = { collaborationId: 'col-a', workingCopyId: 'wc-a', snapshotId: 'snap-a', paths: ['src/a.ts'],
    workerGrantId: 'worker-read', workerAudience: 'investigator', workerRecipient: 'local' };
  return { store, base, now, claim, launch, reservation, binding, file, dir, authority,
    closeStore() { store.close(); storeClosed = true; },
    close(retain = false) { if (!storeClosed) store.close(); base.close();
      if (!retain) rmSync(dir, { recursive: true, force: true }); } };
}

function observationInput(f: ReturnType<typeof fixture>, tickets: ReturnType<typeof createClaudeModelRunningTickets>) {
  const claim = f.store.reserveWslResource(f.claim, f.reservation, f.now);
  const observedResource = { ...claim.wslResource!, invocationId: 'd'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.reservation.unitName}` };
  const journal = fact(f, { ...claim, wslResource: observedResource });
  return { claim, journal, descriptor: { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    distro: f.reservation.distro, linuxUser: 'fixture', uid: f.reservation.uid, bootId: f.reservation.bootId,
    unitName: f.reservation.unitName, launchWorkerEpoch: claim.workerEpoch, sourceDigest: f.launch.sourceDigest,
    profileDigest: f.launch.profileDigest, commandDigest: f.launch.commandDigest },
    store: f.store, tickets, nativeRef: 'owned-native', profileRevision: 'synthetic-model', now: () => f.now };
}

// The following tests use synthetic probe observations with real SQLite and actual receipt verification.
// They do not prove WSL/native isolation or a model call.
const syntheticProbe = async (resource: NonNullable<InvestigationClaim['wslResource']>, journal: ClaudeModelSupervisorState):
Promise<ClaudeModelRunningObservation> => ({ kind: 'claude_model_running', resource, journal,
  native: { bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
    invocationId: resource.invocationId!, controlGroup: resource.controlGroup!, loadState: 'loaded',
    activeState: 'active', subState: 'running', mainPid: journal.enterPid!, startTicks: journal.enterStartTicks!,
    procControlGroup: resource.controlGroup! } });

test('running coordinator persists native identity but still needs an outer fact before prompt intent', async () => {
  const tickets = createClaudeModelRunningTickets();
  const f = fixture(tickets);
  try {
    const input = observationInput(f, tickets);
    const current = await persistClaudeModelRunning(input, syntheticProbe);
    assert.equal(current.phase, 'started');
    assert.equal(current.nativeRef, 'owned-native');
    assert.deepEqual(f.store.getModelRunningFact(current), input.journal);
    assert.equal(f.store.getModelPromptIntent(current), null);
    assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.equal(f.store.getModelPromptIntent(current), null);
  } finally { f.close(); }
});

test('cancel during native observation retains identity for cleanup without running fact or prompt', async () => {
  const tickets = createClaudeModelRunningTickets();
  const f = fixture(tickets);
  try {
    const input = observationInput(f, tickets);
    await assert.rejects(persistClaudeModelRunning(input, async (resource, journal) => {
      f.store.requestCancel(f.store.get(f.claim.requestId)!, 'cancel-during-probe', 'request');
      return syntheticProbe(resource, journal);
    }));
    const current = f.store.listUnsettled()[0]!;
    assert.equal(current.phase, 'reconcile');
    assert.equal(current.nativeRef, 'owned-native');
    assert.throws(() => f.store.getModelRunningFact(current));
    assert.equal(f.store.getModelPromptIntent(current), null);
    assert.equal(f.store.get(current.requestId)!.result, null);
  } finally { f.close(); }
});

test('unconfirmed running probe keeps occupied recovery slot and does not record a native start', async () => {
  const tickets = createClaudeModelRunningTickets();
  const f = fixture(tickets);
  try {
    await assert.rejects(persistClaudeModelRunning(observationInput(f, tickets), async () => ({ kind: 'unconfirmed' })));
    const current = f.store.listUnsettled()[0]!;
    assert.equal(current.nativeRef, null);
    assert.equal(f.store.get(current.requestId)!.state, 'recovery_required');
    assert.throws(() => f.store.getModelRunningFact(current));
    assert.equal(f.store.getModelPromptIntent(current), null);
  } finally { f.close(); }
});

test('real waiting WSL unit persists SQLite native/fact through tickets and closes without model execution',
  { timeout: 30000 }, async t => {
    if (process.platform !== 'win32') { t.skip('private WSL fixture requires Windows'); return; }
    const run = (args: string[]) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec', ...args],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 8192 });
    const uid = run(['/usr/bin/id', '-u']);
    const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (uid.status !== 0 || boot.status !== 0) { t.skip('private WSL user unavailable'); return; }
    const tickets = createClaudeModelRunningTickets();
    const prevention = createClaudeModelPreventionTickets();
    const f = fixture(tickets, prevention); // Isolation verifier is synthetic; only the waiting unit is exercised.
    const root = `/home/fixture/model-persist-${randomUUID()}`;
    const paths = { installRoot: '/home/fixture/runtime', nodeRoot: '/home/fixture/node',
      srtSettingsFile: '/home/fixture/srt.json', mcpConfigFile: '/home/fixture/mcp.json',
      helperFile: '/home/fixture/helper.py', privateAuthHome: '/home/fixture/auth',
      privateFifoDirectory: `${root}/${f.claim.attemptId}-${f.claim.workerEpoch}.mcp` };
    f.reservation.uid = Number(uid.stdout.trim());
    f.reservation.bootId = boot.stdout.trim();
    f.reservation.gate.root = root;
    f.launch.commandDigest = claudeModelCommandDigest(paths, modelLaunchProfile, 2);
    let handle: ReturnType<typeof startClaudeModelUnit> | undefined;
    let safeCleanup = false;
    let input: ReturnType<typeof observationInput> | undefined;
    try {
      assert.equal(run(['/usr/bin/install', '-d', '-m', '700', root]).status, 0);
      input = observationInput(f, tickets);
      assert.ok(await runClaudeModelSupervisorOperation('prepare', input.descriptor, root));
      handle = startClaudeModelUnit(input.descriptor, root, paths,
        { maxWallSeconds: 12, maxTurns: 2 }, modelLaunchProfile);
      let journal: ClaudeModelSupervisorState | null = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        journal = await runClaudeModelSupervisorOperation('status', input.descriptor, root);
        if (journal?.phase === 'entered') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(journal?.phase, 'entered');
      assert.ok(journal);
      const current = await persistClaudeModelRunning({ ...input, journal });
      assert.equal(current.phase, 'started');
      assert.deepEqual(f.store.getModelRunningFact(current), journal);
      const savedObservation = f.store.getModelRunningObservation(current);
      assert.equal(savedObservation?.native.mainPid, journal.enterPid);
      assert.equal(savedObservation?.native.startTicks, journal.enterStartTicks);
      assert.equal(savedObservation?.native.invocationId, current.wslResource!.invocationId);
      assert.equal(f.store.getModelPromptIntent(current), null);
      const closed = await runClaudeModelSupervisorOperation('close', input.descriptor, root);
      assert.equal(closed?.phase, 'entered');
      assert.equal(closed?.closed, true);
      assert.ok(closed);
      const bridgeResult = await handle.closed;
      assert.equal(bridgeResult.uncertain, false);
      assert.notEqual(bridgeResult.bridgeExitCode, null);
      // A closed Windows bridge is not sufficient: observe original PID/cgroup via Linux.
      const terminal = await observeClaudeModelTerminal(current.wslResource!, closed, input.descriptor);
      assert.equal(terminal.kind, 'model_unit_terminal');
      safeCleanup = true;
      assert.equal(f.store.listUnsettled().length, 1); // Unit-only proof never releases the product slot.
      const cleanupTime = new Date(f.now.getTime() + 31_000);
      assert.equal(await recoverClaudeModelAttempt(f.store, current, 'cleanup', prevention,
        { now: () => cleanupTime }), true);
      assert.equal(f.store.listUnsettled().length, 0);
      assert.equal(f.store.get(current.requestId)!.failureReason, 'model_execution_prevented');
      assert.equal(f.store.get(current.requestId)!.attempts[0]!.terminationConfirmed, false);
    } finally {
      if (handle && !safeCleanup) {
        if (input) {
          await runClaudeModelSupervisorOperation('close', input.descriptor, root);
          run(['/usr/bin/systemctl', '--user', 'stop', input.descriptor.unitName]);
        }
        await handle.closeBridge();
      }
      if (safeCleanup) {
        assert.equal(run(['/usr/bin/unlink', `${root}/${f.claim.attemptId}.model-supervisor.json`]).status, 0);
        assert.equal(run(['/usr/bin/unlink', `${root}/${f.claim.attemptId}.model-supervisor.lock`]).status, 0);
        assert.equal(run(['/usr/bin/rmdir', root]).status, 0);
      }
      if (!safeCleanup) t.diagnostic(`Retained unconfirmed fixture: ${f.dir} and ${root}`);
      f.close(!safeCleanup);
    }
  });

test('model launch preflight needs exact gate and excludes source materialization', () => {
  const f = fixture();
  try {
    const reserved = f.store.reserveWslResource(f.claim, f.reservation, f.now);
    assert.doesNotThrow(() => f.store.preflightClaudeModelLaunch(reserved, ['src/a.ts'], 'synthetic-model', f.launch, f.now));
    assert.throws(() => f.store.preflightClaudeModelLaunch(reserved, ['src/a.ts'], 'wrong-profile', f.launch, f.now));
    assert.throws(() => f.store.preflightClaudeModelLaunch({ ...reserved, workerEpoch: 2 }, ['src/a.ts'], 'synthetic-model', f.launch, f.now));
    assert.throws(() => f.store.preflightClaudeModelLaunch(reserved, ['other.ts'], 'synthetic-model', f.launch, f.now));
    assert.throws(() => f.store.reserveWslResource(f.claim, { ...f.reservation,
      gate: { ...f.reservation.gate, payloadKind: 'native_supervisor_v2' } }, f.now));
    assert.throws(() => f.store.preflightNativeLaunch(reserved, ['src/a.ts'], 'synthetic-model', f.launch.sourceDigest, f.now));
  } finally { f.close(); }
});

test('model command is durable before native start and cannot change at preflight or observation', () => {
  const f = fixture();
  let reopened: SqliteInvestigationStore | undefined;
  try {
    const { commandDigest: omitted, ...legacy } = f.launch;
    assert.equal(omitted, 'e'.repeat(64));
    assert.throws(() => f.store.reserveWslResource(f.claim, { ...f.reservation,
      gate: { ...f.reservation.gate, launch: legacy } }, f.now));
    const reserved = f.store.reserveWslResource(f.claim, f.reservation, f.now);
    f.closeStore();
    reopened = new SqliteInvestigationStore(f.file, f.authority);
    assert.equal(reopened.listUnsettled()[0]!.wslResource!.gate!.launch!.commandDigest, f.launch.commandDigest);
    assert.throws(() => reopened!.preflightClaudeModelLaunch(reserved, ['src/a.ts'], 'synthetic-model',
      { ...f.launch, commandDigest: 'f'.repeat(64) }, f.now));
    let current = reopened.observeWslResource(reserved, { invocationId: 'd'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.reservation.unitName}` }, f.now);
    current = reopened.recordNativeStart(current, 'synthetic-native', 'synthetic', f.now);
    assert.throws(() => reopened!.recordModelRunningFact(current,
      { ...fact(f, current), commandDigest: 'f'.repeat(64) }, 'synthetic', f.now));
    reopened.recordModelRunningFact(current, fact(f, current), 'synthetic', f.now);
  } finally { reopened?.close(); f.close(); }
});

test('legacy model row without command digest remains enumerable but cannot resume execution', () => {
  const f = fixture();
  let reopened: SqliteInvestigationStore | undefined;
  try {
    const reserved = f.store.reserveWslResource(f.claim, f.reservation, f.now);
    f.closeStore();
    const db = new DatabaseSync(f.file);
    try {
      const { commandDigest: omitted, ...legacy } = f.launch;
      assert.ok(omitted);
      db.prepare('UPDATE investigation_active_attempts SET wsl_launch_gate_json=? WHERE attempt_id=?')
        .run(JSON.stringify({ ...f.reservation.gate, launch: legacy }), reserved.attemptId);
    } finally { db.close(); }
    reopened = new SqliteInvestigationStore(f.file, f.authority);
    const old = reopened.listUnsettled()[0]!;
    assert.equal(old.attemptId, reserved.attemptId);
    assert.equal(old.wslResource!.gate!.launch!.commandDigest, undefined);
    assert.throws(() => reopened!.preflightClaudeModelLaunch(old, ['src/a.ts'], 'synthetic-model', f.launch, f.now));
    assert.throws(() => reopened!.getModelRunningFact(old));
    assert.throws(() => reopened!.recordModelPromptIntent(old, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.equal(reopened.listUnsettled().length, 1);
  } finally { reopened?.close(); f.close(); }
});

test('prompt cannot dispatch before native start or without persisted original running fact', () => {
  const f = fixture();
  try {
    let current = f.store.reserveWslResource(f.claim, f.reservation, f.now);
    assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    current = f.store.observeWslResource(current, { invocationId: 'd'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.reservation.unitName}` }, f.now);
    current = f.store.recordNativeStart(current, 'synthetic-native', 'synthetic', f.now);
    assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.equal(f.store.getModelPromptIntent(current), null);
  } finally { f.close(); }
});

function start(f: ReturnType<typeof fixture>): InvestigationClaim {
  const reserved = f.store.reserveWslResource(f.claim, f.reservation, f.now);
  const observed = f.store.observeWslResource(reserved, { invocationId: 'd'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${f.reservation.unitName}` }, f.now);
  return f.store.recordNativeStart(observed, 'synthetic-native', 'synthetic', f.now);
}

function fact(f: ReturnType<typeof fixture>, current: InvestigationClaim): ClaudeModelSupervisorState {
  return { protocol: 'claude_model_v1', action: 'claude_model_v1', phase: 'entered', closed: false,
    attemptId: current.attemptId, workspaceId: current.workspaceId, uid: f.reservation.uid,
    bootId: f.reservation.bootId, unitName: f.reservation.unitName,
    launchWorkerEpoch: current.workerEpoch, sourceDigest: f.launch.sourceDigest,
    profileDigest: f.launch.profileDigest, commandDigest: 'e'.repeat(64),
    invocationId: current.wslResource!.invocationId!, controlGroup: current.wslResource!.controlGroup!,
    enterPid: 123, enterStartTicks: 456 };
}

function fullFact(f: ReturnType<typeof fixture>, current: InvestigationClaim):
Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }> {
  const journal = fact(f, current);
  const resource = current.wslResource!;
  return { kind: 'claude_model_running', resource, journal, native: {
    bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
    invocationId: resource.invocationId!, controlGroup: resource.controlGroup!,
    loadState: 'loaded', activeState: 'active', subState: 'running',
    mainPid: journal.enterPid!, startTicks: journal.enterStartTicks!, procControlGroup: resource.controlGroup! } };
}

/** Pre-confinement-schema uncertainty is recovery data, never a new send authorization. */
function insertHistoricalIntent(f: ReturnType<typeof fixture>, current: InvestigationClaim): void {
  const db = new DatabaseSync(f.file);
  try {
    db.prepare('INSERT INTO investigation_model_dispatch VALUES (?,?,?,?,?,?,?,?)')
      .run(current.attemptId, current.requestId, current.workerEpoch, current.nativeRef!,
        f.launch.profileDigest, f.launch.commandDigest!, 'c'.repeat(64), f.now.toISOString());
  } finally { db.close(); }
}

test('native running observation alone cannot authorize a new prompt intent', () => {
  const f = fixture();
  try {
    const current = start(f);
    f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now);
    assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch,
      'c'.repeat(64), f.now));
    assert.equal(f.store.getModelPromptIntent(current), null);
  } finally { f.close(); }
});

function prevented(f: ReturnType<typeof fixture>, current: InvestigationClaim):
Extract<ClaudeModelTerminalObservation, { kind: 'model_unit_terminal' }> {
  const resource = current.wslResource!;
  const journal = { ...fact(f, current), launchWorkerEpoch: f.launch.workerEpoch, closed: true };
  return { kind: 'model_unit_terminal', resource, journal, native: {
    bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
    invocationId: resource.invocationId!, controlGroup: resource.controlGroup!,
    loadState: 'loaded', activeState: 'inactive', subState: 'dead', mainPid: 0,
    originalPid: journal.enterPid!, originalStartTicks: journal.enterStartTicks!,
    processState: 'absent', cgroupState: 'empty' } };
}

test('unconsumed model prevention settles under cleanup fence preserving prompt uncertainty', () => {
  const f = fixture();
  try {
    const current = start(f);
    f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now);
    insertHistoricalIntent(f, current);
    const now = new Date(f.now.getTime() + 31_000);
    const cleanup = f.store.acquireWslCleanupLease(current, 'cleanup', now)!;
    f.store.preflightClaudeModelCleanup(cleanup, now);
    assert.throws(() => f.store.preflightClaudeModelCleanup(current, now));
    const settled = f.store.settleClaudeModelExecutionPrevented(cleanup, prevented(f, cleanup), 'synthetic', now);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.failureReason, 'model_execution_prevented');
    assert.equal(settled.attempts[0]!.terminationConfirmed, false);
    assert.equal(settled.attempts[0]!.nativeRef, current.nativeRef);
    assert.equal(settled.result, null);
    assert.equal(f.store.listUnsettled().length, 0);
    const db = new DatabaseSync(f.file);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM investigation_model_dispatch').get()!.n, 1);
      const saved = db.prepare('SELECT observation_json FROM investigation_model_prevention_facts').get()!;
      assert.deepEqual(JSON.parse(saved.observation_json as string), prevented(f, cleanup));
    }
    finally { db.close(); }
  } finally { f.close(); }
});

test('consumed, unknown identity, expired lease and absent verifier keep model slot', () => {
  for (const mode of ['consumed', 'pid', 'lease', 'receipt'] as const) {
    const f = fixture();
    let other: SqliteInvestigationStore | undefined;
    try {
      const current = start(f);
      const now = new Date(f.now.getTime() + 31_000);
      const cleanup = f.store.acquireWslCleanupLease(current, 'cleanup', now)!;
      const observation = prevented(f, cleanup);
      if (mode === 'consumed') observation.journal.phase = 'consumed';
      if (mode === 'pid') observation.native.originalPid = 999;
      const { verifyClaudeModelPreventionReceipt: omitted, ...authority } = f.authority;
      assert.ok(omitted);
      other = new SqliteInvestigationStore(f.file, mode === 'receipt' ? authority : f.authority);
      assert.throws(() => other!.settleClaudeModelExecutionPrevented(cleanup, observation, 'synthetic',
        mode === 'lease' ? new Date(now.getTime() + 120_000) : now));
      assert.equal(f.store.listUnsettled().length, 1);
    } finally { other?.close(); f.close(); }
  }
});

test('full running observation survives reopen and corrupt native evidence refuses', () => {
  const f = fixture();
  let reopened: SqliteInvestigationStore | undefined;
  try {
    const current = start(f);
    const observation = fullFact(f, current);
    f.store.recordModelRunningObservation(current, observation, 'synthetic', f.now);
    f.closeStore();
    reopened = new SqliteInvestigationStore(f.file, f.authority);
    assert.deepEqual(reopened.getModelRunningObservation(current), observation);
    const db = new DatabaseSync(f.file);
    try { db.prepare('UPDATE investigation_model_running_facts SET native_json=? WHERE attempt_id=?')
      .run(JSON.stringify({ ...observation.native, mainPid: 999 }), current.attemptId); }
    finally { db.close(); }
    assert.throws(() => reopened!.getModelRunningObservation(current));
  } finally { reopened?.close(); f.close(); }
});

test('journal-only evidence cannot authorize prompt or upgrade to native observation', () => {
  const f = fixture();
  try {
    const current = start(f);
    f.store.recordModelRunningFact(current, fact(f, current), 'synthetic', f.now);
    assert.equal(f.store.getModelRunningObservation(current), null);
    assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.throws(() => f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now));
  } finally { f.close(); }
});

test('full evidence requires its dedicated verifier and failed insert leaves no partial evidence', () => {
  const f = fixture();
  let other: SqliteInvestigationStore | undefined;
  try {
    const current = start(f);
    const { verifyModelRunningObservationReceipt: omitted, ...legacyAuthority } = f.authority;
    assert.ok(omitted);
    other = new SqliteInvestigationStore(f.file, legacyAuthority);
    assert.throws(() => other!.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now));
    const db = new DatabaseSync(f.file);
    try {
      db.exec("CREATE TRIGGER fail_native BEFORE INSERT ON investigation_model_running_facts BEGIN SELECT RAISE(ABORT,'injected'); END");
      assert.throws(() => f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now));
      assert.equal(f.store.getModelRunningObservation(current), null);
      db.exec('DROP TRIGGER fail_native');
    } finally { db.close(); }
    f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now);
  } finally { other?.close(); f.close(); }
});

test('legacy table migrates without inventing native evidence or erasing uncertain prompt intent', () => {
  const f = fixture();
  let other: SqliteInvestigationStore | undefined;
  try {
    const current = start(f);
    f.store.recordModelRunningFact(current, fact(f, current), 'synthetic', f.now);
    f.closeStore();
    const db = new DatabaseSync(f.file);
    try {
      db.exec('ALTER TABLE investigation_model_running_facts DROP COLUMN native_json');
      db.prepare('INSERT INTO investigation_model_dispatch VALUES (?,?,?,?,?,?,?,?)').run(current.attemptId,
        current.requestId, current.workerEpoch, current.nativeRef!, f.launch.profileDigest,
        f.launch.commandDigest, 'c'.repeat(64), f.now.toISOString());
    } finally { db.close(); }
    other = new SqliteInvestigationStore(f.file, f.authority);
    assert.equal(other.getModelRunningObservation(current), null);
    assert.equal(other.getModelPromptIntent(current)?.promptHash, 'c'.repeat(64));
    assert.throws(() => other!.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.throws(() => other!.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now));
  } finally { other?.close(); f.close(); }
});

test('historical prompt intent survives connection reopen and matching or changed retries refuse', () => {
  const f = fixture();
  let other: SqliteInvestigationStore | undefined;
  try {
    const current = start(f);
    f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now);
    insertHistoricalIntent(f, current);
    f.closeStore();
    other = new SqliteInvestigationStore(f.file, f.authority);
    assert.equal(other.getModelPromptIntent(current)?.promptHash, 'c'.repeat(64));
    assert.throws(() => other!.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.throws(() => other!.recordModelPromptIntent(current, f.binding, f.launch, 'f'.repeat(64), f.now));
    f.base.revokeGrant('worker-read', f.now.toISOString());
    assert.equal(other.getModelPromptIntent(current)?.nativeRef, 'synthetic-native', 'recovery metadata survives disclosure revocation');
  } finally { other?.close(); f.close(); }
});

test('recovery epoch retains historical original prompt intent but cannot dispatch again', () => {
  const f = fixture();
  try {
    const current = start(f);
    f.store.recordModelRunningObservation(current, fullFact(f, current), 'synthetic', f.now);
    insertHistoricalIntent(f, current);
    const recovered = f.store.recoverAttempt(current, { workerId: current.workerId,
      isolationEvidence: 'synthetic', profileRevision: 'synthetic-model', permissionEpoch: 0,
      now: new Date(f.now.getTime() + 31_000) });
    assert.equal(recovered.workerEpoch, current.workerEpoch + 1);
    assert.equal(f.store.getModelRunningObservation(recovered)?.journal.launchWorkerEpoch, current.workerEpoch);
    assert.throws(() => f.store.getModelRunningObservation(current));
    assert.equal(f.store.getModelPromptIntent(recovered)?.launchEpoch, current.workerEpoch);
    assert.throws(() => f.store.recordModelPromptIntent(recovered, f.binding, f.launch, 'c'.repeat(64),
      new Date(f.now.getTime() + 31_000)));
  } finally { f.close(); }
});

test('cancellation before dispatch leaves no prompt intent', () => {
  const f = fixture();
  try {
    const current = start(f);
    f.store.recordModelRunningFact(current, fact(f, current), 'synthetic', f.now);
    f.store.requestCancel(f.store.get('inv-model')!, 'cancel', 'request');
    assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), f.now));
    assert.equal(f.store.getModelPromptIntent(current), null);
  } finally { f.close(); }
});

test('untrusted or mismatched running fact, worker revocation and wall expiry cannot dispatch', () => {
  for (const mode of ['receipt', 'identity', 'revoked', 'deadline'] as const) {
    const f = fixture();
    let other: SqliteInvestigationStore | undefined;
    try {
      const current = start(f);
      const observed = fact(f, current);
      if (mode === 'receipt') {
        other = new SqliteInvestigationStore(f.file);
        assert.throws(() => other!.recordModelRunningFact(current, observed, 'invented', f.now));
      } else if (mode === 'identity') {
        assert.throws(() => f.store.recordModelRunningFact(current, { ...observed, invocationId: 'f'.repeat(32) }, 'synthetic', f.now));
      } else {
        f.store.recordModelRunningFact(current, observed, 'synthetic', f.now);
        if (mode === 'revoked') f.base.revokeGrant('worker-read', f.now.toISOString());
        if (mode === 'deadline') {
          f.store.renewLease(current, new Date(f.now.getTime() + 20_000));
          f.store.renewLease(current, new Date(f.now.getTime() + 40_000));
        }
        const checked = mode === 'deadline' ? new Date(f.now.getTime() + 60_000) : f.now;
        assert.throws(() => f.store.recordModelPromptIntent(current, f.binding, f.launch, 'c'.repeat(64), checked));
      }
      assert.equal(f.store.getModelPromptIntent(current), null);
    } finally { other?.close(); f.close(); }
  }
});

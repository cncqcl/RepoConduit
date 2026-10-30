import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runWslLaunchGate } from '../../src/adapters/codex/investigator/launch-gate-runner.js';
import { parseWslLaunchGateOutput, wslLaunchGateSpec,
  type WslLaunchGateDescriptor } from '../../src/adapters/codex/investigator/launch-gate.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { startInvestigationRecovery } from '../../src/runtime/investigation-recovery.js';

const distro = 'Ubuntu-22.04';
const linuxUser = 'fixture';
const wslPrefix = ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec'];

function wsl(args: string[]) {
  return spawnSync('wsl.exe', [...wslPrefix, ...args],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 });
}

function fixedGate(operation: 'prepare' | 'enter', descriptor: WslLaunchGateDescriptor, root: string) {
  const spec = wslLaunchGateSpec(operation, descriptor, root);
  return spawnSync(spec.executable, spec.args,
    { env: spec.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 });
}

test('real WSL gate recovery closes an expired reserved attempt before native launch',
  { skip: process.env.RCAC_WSL_GATE_LIVE !== '1' }, async () => {
    // This fixture uses only local synthetic records and the fixed gate helper; no agent or model starts.
    const fixture = mkdtempSync(join(tmpdir(), 'rcac-wsl-gate-recovery-'));
    const dbPath = join(fixture, 'state.sqlite');
    const workspaceId = `ws_${randomUUID()}`;
    const collaborationId = `col_${randomUUID()}`;
    const workingCopyId = `copy_${randomUUID()}`;
    const grantId = `grant_${randomUUID()}`;
    const requestId = `inv_${randomUUID()}`;
    let base: SqliteStore | undefined;
    let store: SqliteInvestigationStore | undefined;
    let gateRoot: string | undefined;
    let attemptId: string | undefined;
    try {
      const uidProbe = wsl(['/usr/bin/id', '-u']);
      const bootProbe = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      assert.equal(uidProbe.status, 0, uidProbe.stderr);
      assert.equal(bootProbe.status, 0, bootProbe.stderr);
      const uid = Number(uidProbe.stdout.trim());
      const bootId = bootProbe.stdout.trim();
      assert.equal(Number.isSafeInteger(uid) && uid > 0, true);
      assert.match(bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      base = new SqliteStore(dbPath);
      base.insertWorkspace({ id: workspaceId, name: 'synthetic-gate-recovery',
        canonicalRoot: fixture, registeredBy: 'fixture-owner' });
      base.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'fixture-owner',
        purpose: 'synthetic gate recovery', hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: workingCopyId, workspaceId, canonicalRoot: fixture });
      base.insertGrant({ id: grantId, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient',
        permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
      base.insertGrant({ id: `read_${randomUUID()}`, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient', permissions: ['data.read'],
        dataPaths: ['fixture/'], expiresAt: null, revokedAt: null });
      const authority = {
        verifyIsolation: (evidence: string, request: InvestigationRecord, revision: string) =>
          evidence === `synthetic-isolation:${requestId}` && request.id === requestId && revision === 'fixture-profile',
        verifyNativeReceipt: () => false,
        verifyOutcomeReceipt: () => false,
      };
      store = new SqliteInvestigationStore(dbPath, authority);
      const request: InvestigationRecord = {
        id: requestId, workspaceId, collaborationId, workingCopyId,
        principal: 'fixture-principal', audience: 'external', recipient: 'fixture-recipient', grantId,
        profileRef: 'fixture-profile', budgetRef: 'fixture-budget',
        budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
        contextRevisionId: 'fixture-context', snapshotRef: 'fixture-snapshot',
        question: 'Synthetic gate recovery only',
        scope: { paths: ['fixture/input.txt'], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued',
        cancelRequested: false, attempts: [], result: null, createdAt: new Date().toISOString(),
      };
      store.enqueue(request, requestId, requestId);
      const claimedAt = new Date(Date.now() - 60_000);
      const claim = store.claimRequest(requestId, {
        workerId: 'fixture-worker', isolationEvidence: `synthetic-isolation:${requestId}`,
        profileRevision: 'fixture-profile', permissionEpoch: 0, now: claimedAt,
        launchProtocol: 'resource_reservation_v1',
      });
      assert.ok(claim);
      attemptId = claim.attemptId;
      gateRoot = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
      const descriptor: WslLaunchGateDescriptor = {
        attemptId, workspaceId, distro, linuxUser, uid, bootId,
        unitName: `rcac-investigator-${randomUUID()}.service`,
      };
      const reserved = store.reserveWslResource(claim, {
        unitName: descriptor.unitName, distro, uid, bootId,
        gate: { protocol: 'attempt_gate_v1', linuxUser, root: gateRoot, payloadKind: 'canary_v1' },
      }, new Date(claimedAt.getTime() + 1_000));
      assert.equal(reserved.launchProtocol, 'resource_reservation_v1');
      assert.equal(wsl(['/usr/bin/install', '-d', '-m', '700', gateRoot]).status, 0);
      assert.equal((await runWslLaunchGate('prepare', descriptor, gateRoot))?.kind, 'open');
      assert.equal(store.listUnsettled().length, 1);

      // Reopen the real database as an installed process would, then use its startup recovery.
      store.close();
      store = new SqliteInvestigationStore(dbPath, authority);
      const recovery = startInvestigationRecovery(store);
      try { await recovery.ready; } finally { await recovery.close(); }

      const observer = new DatabaseSync(dbPath);
      try {
        const row = observer.prepare('SELECT record_json FROM investigation_requests WHERE id=?')
          .get(requestId) as { record_json: string } | undefined;
        assert.ok(row);
        const persisted = JSON.parse(row.record_json) as InvestigationRecord;
        assert.equal(persisted.state, 'failed');
        assert.equal(persisted.failureReason, 'closed_before_native_launch');
        assert.equal(persisted.result, null);
        assert.equal(persisted.attempts.length, 1);
        assert.equal(persisted.attempts[0]?.id, attemptId);
        assert.equal(persisted.attempts[0]?.state, 'failed');
        assert.equal(persisted.attempts[0]?.startedAt, null);
        assert.equal(persisted.attempts[0]?.terminationConfirmed, false);
        const active = observer.prepare('SELECT COUNT(*) AS count FROM investigation_active_attempts WHERE request_id=?')
          .get(requestId) as { count: number };
        assert.equal(active.count, 0);
      } finally { observer.close(); }
      assert.deepEqual(store.listUnsettled(), []);
      const latePrepare = fixedGate('prepare', descriptor, gateRoot);
      assert.equal(latePrepare.status, 1, latePrepare.stderr);
      assert.match(latePrepare.stderr, /ValueError: gate closed or consumed/);
      const lateEnter = fixedGate('enter', descriptor, gateRoot);
      assert.equal(lateEnter.status, 1, lateEnter.stderr);
      assert.match(lateEnter.stderr, /ValueError: gate not open/);
      assert.equal(wsl(['/usr/bin/test', '-e', `${gateRoot}/${attemptId}.canary`]).status, 1);
    } finally {
      // Remove only this test's exact gate files and empty directory after the assertions.
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

test('real startup recovery keeps a consumed WSL gate and its slot pending native reconciliation',
  { skip: process.env.RCAC_WSL_GATE_LIVE !== '1' }, async () => {
    // The systemd unit executes only the fixed synthetic canary; no agent or model starts.
    const fixture = mkdtempSync(join(tmpdir(), 'rcac-wsl-consumed-recovery-'));
    const dbPath = join(fixture, 'state.sqlite');
    const workspaceId = `ws_${randomUUID()}`;
    const collaborationId = `col_${randomUUID()}`;
    const workingCopyId = `copy_${randomUUID()}`;
    const grantId = `grant_${randomUUID()}`;
    const requestId = `inv_${randomUUID()}`;
    let base: SqliteStore | undefined;
    let store: SqliteInvestigationStore | undefined;
    let gateRoot: string | undefined;
    let attemptId: string | undefined;
    let gateRootCreated = false;
    try {
      const uidProbe = wsl(['/usr/bin/id', '-u']);
      const bootProbe = wsl(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      assert.equal(uidProbe.status, 0, uidProbe.stderr);
      assert.equal(bootProbe.status, 0, bootProbe.stderr);
      const uid = Number(uidProbe.stdout.trim());
      const bootId = bootProbe.stdout.trim();
      assert.equal(Number.isSafeInteger(uid) && uid > 0, true);
      assert.match(bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      base = new SqliteStore(dbPath);
      base.insertWorkspace({ id: workspaceId, name: 'synthetic-consumed-recovery',
        canonicalRoot: fixture, registeredBy: 'fixture-owner' });
      base.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'fixture-owner',
        purpose: 'synthetic consumed recovery', hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: workingCopyId, workspaceId, canonicalRoot: fixture });
      base.insertGrant({ id: grantId, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient',
        permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
      base.insertGrant({ id: `read_${randomUUID()}`, principal: 'fixture-principal', audience: 'external',
        workspaceId, collaborationId, recipient: 'fixture-recipient', permissions: ['data.read'],
        dataPaths: ['fixture/'], expiresAt: null, revokedAt: null });
      const authority = {
        verifyIsolation: (evidence: string, request: InvestigationRecord, revision: string) =>
          evidence === `synthetic-isolation:${requestId}` && request.id === requestId && revision === 'fixture-profile',
        verifyNativeReceipt: () => false,
        verifyOutcomeReceipt: () => false,
      };
      store = new SqliteInvestigationStore(dbPath, authority);
      store.enqueue({
        id: requestId, workspaceId, collaborationId, workingCopyId,
        principal: 'fixture-principal', audience: 'external', recipient: 'fixture-recipient', grantId,
        profileRef: 'fixture-profile', budgetRef: 'fixture-budget',
        budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
        contextRevisionId: 'fixture-context', snapshotRef: 'fixture-snapshot',
        question: 'Synthetic consumed recovery only',
        scope: { paths: ['fixture/input.txt'], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued',
        cancelRequested: false, attempts: [], result: null, createdAt: new Date().toISOString(),
      }, requestId, requestId);
      const claimedAt = new Date(Date.now() - 60_000);
      const claim = store.claimRequest(requestId, {
        workerId: 'fixture-worker', isolationEvidence: `synthetic-isolation:${requestId}`,
        profileRevision: 'fixture-profile', permissionEpoch: 0, now: claimedAt,
        launchProtocol: 'resource_reservation_v1',
      });
      assert.ok(claim);
      attemptId = claim.attemptId;
      gateRoot = `/home/${linuxUser}/.local/state/rcac/gates-${attemptId}`;
      const descriptor: WslLaunchGateDescriptor = {
        attemptId, workspaceId, distro, linuxUser, uid, bootId,
        unitName: `rcac-investigator-${randomUUID()}.service`,
      };
      store.reserveWslResource(claim, {
        unitName: descriptor.unitName, distro, uid, bootId,
        gate: { protocol: 'attempt_gate_v1', linuxUser, root: gateRoot, payloadKind: 'canary_v1' },
      }, new Date(claimedAt.getTime() + 1_000));
      assert.equal(wsl(['/usr/bin/install', '-d', '-m', '700', gateRoot]).status, 0);
      gateRootCreated = true;
      assert.equal((await runWslLaunchGate('prepare', descriptor, gateRoot))?.kind, 'open');
      const enter = wslLaunchGateSpec('enter', descriptor, gateRoot);
      const native = wsl(['/usr/bin/systemd-run', '--user', '--wait', '--collect',
        '--unit', descriptor.unitName, '--property=RuntimeMaxSec=10s', '--',
        '/usr/bin/python3', ...enter.args.slice(8)]);
      assert.equal(native.status, 0, native.stderr);
      assert.equal(wsl(['/usr/bin/test', '-f', `${gateRoot}/${attemptId}.canary`]).status, 0);
      const consumedRead = wsl(['/usr/bin/cat', `${gateRoot}/${attemptId}.json`]);
      assert.equal(consumedRead.status, 0, consumedRead.stderr);
      const consumed = parseWslLaunchGateOutput(consumedRead.stdout, descriptor);
      assert.equal(consumed?.kind, 'consumed');
      assert.match(consumed.invocationId ?? '', /^[0-9a-f]{32}$/);
      assert.equal(consumed.controlGroup,
        `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${descriptor.unitName}`);
      assert.equal(store.listUnsettled()[0]?.wslResource?.invocationId, null);

      // Reopen SQLite to model startup after the native unit ran but before its DB observation.
      store.close();
      store = new SqliteInvestigationStore(dbPath, authority);
      const recovery = startInvestigationRecovery(store);
      try { await recovery.ready; } finally { await recovery.close(); }

      const closedRead = wsl(['/usr/bin/cat', `${gateRoot}/${attemptId}.json`]);
      assert.equal(closedRead.status, 0, closedRead.stderr);
      const closed = parseWslLaunchGateOutput(closedRead.stdout, descriptor);
      assert.equal(closed?.kind, 'closed_consumed');
      assert.equal(closed.invocationId, consumed.invocationId);
      assert.equal(closed.controlGroup, consumed.controlGroup);
      const observer = new DatabaseSync(dbPath);
      try {
        const row = observer.prepare('SELECT record_json FROM investigation_requests WHERE id=?')
          .get(requestId) as { record_json: string } | undefined;
        assert.ok(row);
        const persisted = JSON.parse(row.record_json) as InvestigationRecord;
        assert.equal(persisted.state, 'recovery_required');
        assert.equal(persisted.result, null);
        assert.equal(persisted.attempts.length, 1);
        assert.equal(persisted.attempts[0]?.state, 'recovery_required');
        assert.equal(persisted.attempts[0]?.terminationConfirmed, false);
        const active = observer.prepare(`SELECT phase,native_ref,wsl_invocation_id,wsl_control_group
          FROM investigation_active_attempts WHERE request_id=?`).get(requestId) as {
          phase: string; native_ref: string | null; wsl_invocation_id: string | null;
          wsl_control_group: string | null;
        } | undefined;
        assert.ok(active);
        assert.equal(active.phase, 'reconcile');
        assert.equal(active.native_ref, null);
        assert.equal(active.wsl_invocation_id, consumed.invocationId);
        assert.equal(active.wsl_control_group, consumed.controlGroup);
      } finally { observer.close(); }
      assert.equal(store.listUnsettled().length, 1);
      const latePrepare = fixedGate('prepare', descriptor, gateRoot);
      assert.equal(latePrepare.status, 1, latePrepare.stderr);
      assert.match(latePrepare.stderr, /ValueError: gate closed or consumed/);
    } finally {
      // These paths are derived from this test's random attempt only.
      if (gateRootCreated && gateRoot && attemptId) {
        for (const suffix of ['.canary', '.json', '.lock']) {
          const gateFile: string = `${gateRoot}/${attemptId}${suffix}`;
          const exists = wsl(['/usr/bin/test', '-e', gateFile]);
          if (exists.status === 0) assert.equal(wsl(['/usr/bin/unlink', gateFile]).status, 0);
          else assert.equal(exists.status, 1, exists.stderr);
        }
        assert.equal(wsl(['/usr/bin/rmdir', gateRoot]).status, 0);
      }
      store?.close();
      base?.close();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

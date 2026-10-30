import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DockerCommandResult, DockerCommandRunner } from
  '../../src/adapters/investigator/docker-volume-cleanup.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore, StoreConflict } from '../../src/adapters/storage/sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { createDockerVolumeCleanupTickets } from '../../src/runtime/docker-volume-cleanup-tickets.js';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';

const daemonId = 'c20f7230-59a2-4824-a2f4-fda71c982ee6';
const ownerId = 'a'.repeat(64);
const readerId = 'b'.repeat(64);
const volumeName = 'c'.repeat(64);
const ownerName = () => `rcac-investigator-owner-${randomUUID()}`;
const readerName = () => `rcac-investigator-reader-${randomUUID()}`;
const ok = (stdout = ''): DockerCommandResult => ({ exitCode: 0, stdout, stderr: '',
  timedOut: false, truncated: false });
const inspection = (id: string, name: string, rw: boolean, volumesFrom: string[] = []) =>
  JSON.stringify([{ Id: id, Name: `/${name}`, Mounts: [
    { Type: 'volume', Name: volumeName, Destination: '/snapshot', RW: rw },
  ], HostConfig: { VolumesFrom: volumesFrom } }]);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-volume-runtime-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'ws', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'test',
    hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId: 'ws',
    collaborationId: 'col', recipient: 'ext', permissions: ['investigation.request'],
    expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws',
    collaborationId: 'col', recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'],
    expiresAt: null, revokedAt: null });
  const tickets = createDockerVolumeCleanupTickets();
  const authority = { verifyIsolation: () => true, verifyNativeReceipt: () => true,
    verifyOutcomeReceipt: () => true,
    verifyDockerVolumeCleanupReceipt: tickets.verify };
  let store = new SqliteInvestigationStore(file, authority);
  const t0 = new Date(Date.now() - 90_000);
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const record: InvestigationRecord = { id: 'inv', workspaceId: 'ws', collaborationId: 'col',
    workingCopyId: 'copy', principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request',
    profileRef: 'fixed', budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1,
      maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'test',
    scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: t0.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimNext({ workerId: 'worker', isolationEvidence: 'verified',
    profileRevision: 'fixed', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1',
    now: t0 })!;
  const names = { owner: ownerName(), reader: readerName() };
  return { claim, names, tickets, at, get store() { return store; },
    queueSecond() { store.enqueue({ ...record, id: 'next', createdAt: new Date().toISOString() },
      'next-key', 'next-fingerprint'); },
    claimSecond() { return store.claimRequest('next', { workerId: 'next-worker',
      isolationEvidence: 'verified', profileRevision: 'fixed', permissionEpoch: 0,
      launchProtocol: 'resource_reservation_v1', now: new Date() }); },
    reopen() { store.close(); store = new SqliteInvestigationStore(file, authority); },
    expireLease() {
      const db = new DatabaseSync(file);
      try { db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?')
        .run(new Date(Date.now() - 1000).toISOString(), 'inv'); }
      finally { db.close(); }
    },
    close() { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof fixture>;

function reserveReader(f: Fixture) {
  let claim = f.store.reserveDockerVolumeOwner(f.claim, f.names.owner, daemonId, f.at(1));
  claim = f.store.observeDockerVolumeOwner(claim, ownerId, volumeName, f.at(2));
  claim = f.store.reserveDockerVolumeMaterialization(claim, f.at(3));
  claim = f.store.markDockerVolumeMaterialized(claim, f.at(4));
  return f.store.reserveDockerVolumeReader(claim, f.names.reader, f.at(5));
}

async function tick(f: Fixture, runner: DockerCommandRunner): Promise<void> {
  await runInvestigationCleanupTick(f.store, 'cleanup', undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, f.tickets, runner);
}

test('recovery persists observed owner and reader before any Docker deletion, then settles after reopen', async () => {
  const f = fixture();
  try {
    const oldClaim = reserveReader(f);
    f.queueSecond();
    const commands: string[][] = [];
    let ownerPresent = true;
    let readerPresent = true;
    let volumePresent = true;
    const runner: DockerCommandRunner = async args => {
      commands.push(args);
      const key = args.join(' ');
      if (args[0] === 'info') return ok(`${daemonId}\n`);
      if (args[0] === 'ps') return ok([ownerPresent && ownerId, readerPresent && readerId]
        .filter(Boolean).join('\n') + (ownerPresent || readerPresent ? '\n' : ''));
      if (key === `inspect --type container ${ownerId}`) return ownerPresent ?
        ok(inspection(ownerId, f.names.owner, true)) : { ...ok(), exitCode: 1 };
      if (key === `inspect --type container ${readerId}`) return readerPresent ?
        ok(inspection(readerId, f.names.reader, false, [`${ownerId}:ro`])) : { ...ok(), exitCode: 1 };
      if (key === `volume inspect ${volumeName}`) return volumePresent ?
        ok(JSON.stringify([{ Name: volumeName }])) : { ...ok(), exitCode: 1 };
      if (args[0] === 'volume' && args[1] === 'ls') return ok(volumePresent ? `${volumeName}\n` : '');
      if (args[0] === 'rm') {
        assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.readerId, readerId);
        assert.deepEqual(args, readerPresent ? ['rm', '-f', '-v', readerId] : ['rm', '-f', '-v', ownerId]);
        if (readerPresent) readerPresent = false;
        else { ownerPresent = false; volumePresent = false; }
        return ok();
      }
      throw new Error(`Unexpected Docker command: ${key}`);
    };
    await tick(f, runner);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.readerId, readerId);
    assert.equal(commands.some(args => args[0] === 'rm' || args[1] === 'rm'), false);
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.claimSecond(), null);
    assert.throws(() => f.store.observeDockerVolumeReader(oldClaim, readerId, new Date()), StoreConflict);
    f.reopen();
    f.expireLease();
    await tick(f, runner);
    assert.deepEqual(commands.filter(args => args[0] === 'rm' || args[1] === 'rm'), [
      ['rm', '-f', '-v', readerId], ['rm', '-f', '-v', ownerId],
    ]);
    assert.deepEqual(f.store.listUnsettled(), []);
    assert.equal(f.store.get('inv')?.state, 'failed');
    assert.equal(f.store.get('inv')?.attempts[0]?.terminationConfirmed, true);
    assert.equal(f.claimSecond()?.requestId, 'next');
  } finally { f.close(); }
});

test('name-only owner is observed and persisted in one tick without deletion', async () => {
  const f = fixture();
  try {
    f.store.reserveDockerVolumeOwner(f.claim, f.names.owner, daemonId, f.at(1));
    const commands: string[][] = [];
    await tick(f, async args => {
      commands.push(args);
      if (args[0] === 'info') return ok(`${daemonId}\n`);
      if (args[0] === 'ps') return ok(`${ownerId}\n`);
      if (args[0] === 'inspect') return ok(inspection(ownerId, f.names.owner, true));
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    });
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerId, ownerId);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.volumeName, volumeName);
    assert.equal(commands.some(args => args[0] === 'rm' || args[1] === 'rm'), false);
    f.reopen();
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerId, ownerId);
  } finally { f.close(); }
});

test('wrong daemon stops at identity check and keeps the occupied recovery slot', async () => {
  const f = fixture();
  try {
    reserveReader(f);
    f.queueSecond();
    const commands: string[][] = [];
    await tick(f, async args => {
      commands.push(args);
      return ok(`${randomUUID()}\n`);
    });
    assert.deepEqual(commands, [['info', '--format', '{{.ID}}']]);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.readerId, null);
    assert.equal(f.store.get('inv')?.state, 'recovery_required');
    assert.equal(f.claimSecond(), null);
    f.reopen();
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

test('incomplete final listing after removal keeps the attempt occupied across restart', async () => {
  const f = fixture();
  try {
    const reserved = reserveReader(f);
    f.store.observeDockerVolumeReader(reserved, readerId, f.at(6));
    f.queueSecond();
    const commands: string[][] = [];
    await tick(f, async args => {
      commands.push(args);
      const key = args.join(' ');
      if (args[0] === 'info') return ok(`${daemonId}\n`);
      if (key === `inspect --type container ${ownerId}`) return ok(inspection(ownerId, f.names.owner, true));
      if (key === `inspect --type container ${readerId}`) {
        return ok(inspection(readerId, f.names.reader, false, [`${ownerId}:ro`]));
      }
      if (key === `volume inspect ${volumeName}`) return ok(JSON.stringify([{ Name: volumeName }]));
      if (args[0] === 'ps') return ok('partial-id\n');
      return ok();
    });
    assert.deepEqual(commands.filter(args => args[0] === 'rm' || args[1] === 'rm'), [
      ['rm', '-f', '-v', readerId], ['rm', '-f', '-v', ownerId],
    ]);
    assert.equal(f.store.listUnsettled().length, 1);
    assert.equal(f.store.get('inv')?.attempts[0]?.terminationConfirmed, false);
    assert.equal(f.claimSecond(), null);
    f.reopen();
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

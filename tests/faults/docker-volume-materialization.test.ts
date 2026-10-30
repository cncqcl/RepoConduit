import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { buildSnapshotTar, verifySnapshotTarReadback } from '../../src/adapters/investigator/docker-volume.js';
import { prepareDockerVolumeSource } from '../../src/runtime/docker-volume-source-preparation.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const instant = new Date('2026-09-29T00:00:00.000Z');
const daemonId = 'c20f7230-59a2-4824-a2f4-fda71c982ee6';
const ownerId = 'a'.repeat(64);
const volumeName = 'b'.repeat(64);
const imageId = `sha256:${'c'.repeat(64)}`;
const ownerName = () => `rcac-investigator-owner-${randomUUID()}`;

test('readback rejects a complete archive containing an extra file', () => {
  const expected = createSnapshotFromFiles('copy', 'a'.repeat(40),
    { 'src/main.ts': Buffer.from('fixed source') });
  const extra = createSnapshotFromFiles('copy', 'a'.repeat(40),
    { 'src/main.ts': Buffer.from('fixed source'), 'src/secret.ts': Buffer.from('extra') });
  assert.throws(() => verifySnapshotTarReadback(
    buildSnapshotTar(extra, ['src/main.ts', 'src/secret.ts']), expected, ['src/main.ts']));
});

test('readback rejects high-bit USTAR name bytes even with a valid checksum', () => {
  const snapshot = createSnapshotFromFiles('copy', 'a'.repeat(40),
    { 'src/main.ts': Buffer.from('fixed source') });
  const tar = Buffer.from(buildSnapshotTar(snapshot, ['src/main.ts']));
  // First block names the inferred src/ directory. Buffer ASCII decoding masks
  // the high bit, so a checksum-valid mutation must be refused before decoding.
  tar[0] = tar[0]! | 0x80;
  tar.fill(0x20, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  tar[154] = 0;
  tar[155] = 0x20;
  assert.throws(() => verifySnapshotTarReadback(tar, snapshot, ['src/main.ts']));
});

test('re-entry after persisted owner create intent sends no second Docker command', async () => {
  const f = await fixture();
  try {
    const name = ownerName();
    f.store.reserveDockerVolumeOwner(f.claim, name, daemonId, instant);
    let commands = 0;
    await assert.rejects(prepareDockerVolumeSource({ store: f.store, snapshots: f.snapshots, claim: f.claim,
      expected: f.expected, ownerName: name, daemonId, trustedImageId: imageId,
      now: () => instant }, async () => { commands++; return result(''); }));
    assert.equal(commands, 0);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerId, null);
  } finally { f.close(); }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-volume-materialize-'));
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'ws', name: 'ws', canonicalRoot: 'D:/fixture', registeredBy: 'p' });
  base.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'p', purpose: 'test', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'copy', workspaceId: 'ws', canonicalRoot: 'D:/fixture' });
  base.insertGrant({ id: 'request', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
  base.insertGrant({ id: 'read', principal: 'p', audience: 'external', workspaceId: 'ws', collaborationId: 'col',
    recipient: 'ext', permissions: ['data.read'], dataPaths: ['src/'], expiresAt: null, revokedAt: null });
  const snapshot = createSnapshotFromFiles('copy', 'a'.repeat(40), { 'src/main.ts': Buffer.from('fixed source') });
  await base.saveSnapshot({ workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', snapshot: snapshot.toPersisted() },
    { workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', commitRef: 'a'.repeat(40) }, 'capture', 'p', 'external');
  const store = new SqliteInvestigationStore(file, { verifyIsolation: () => true,
    verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true });
  const record: InvestigationRecord = { id: 'inv', workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy',
    principal: 'p', audience: 'external', recipient: 'ext', grantId: 'request', profileRef: 'fixed', budgetRef: 'fixed',
    budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx', snapshotRef: snapshot.id,
    question: 'test', scope: { paths: ['src/main.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: instant.toISOString() };
  store.enqueue(record, 'key', 'fingerprint');
  const claim = store.claimRequest('inv', { workerId: 'worker', isolationEvidence: 'verified', profileRevision: 'fixed',
    permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now: instant })!;
  const expected = { workspaceId: 'ws', collaborationId: 'col', workingCopyId: 'copy', snapshotRef: snapshot.id,
    contextRevisionId: 'ctx', recipient: 'ext', requestId: 'inv', attemptId: claim.attemptId,
    workerEpoch: claim.workerEpoch };
  return { dir, file, base, store, claim, expected, snapshot, snapshots: { getSnapshot: base.getSnapshot.bind(base) },
    close() { store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function result(stdout: Buffer | string, exitCode = 0) {
  return { exitCode, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.alloc(0),
    timedOut: false, truncated: false };
}

test('persists owner identity and one-shot intent before bytes, proves complete readback before materialized', async () => {
  const f = await fixture();
  try {
    const name = ownerName();
    const events: string[] = [];
    const tar = buildSnapshotTar(f.snapshot, ['src/main.ts']);
    const run = async (args: string[], stdin?: Buffer) => {
      events.push(args[0]!);
      if (args[0] === 'info') return result(`${daemonId}\n`);
      if (args[0] === 'create') {
        assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerName, name);
        return result(`${ownerId}\n`);
      }
      if (args[0] === 'inspect') return result(JSON.stringify([{ Id: ownerId, Name: `/${name}`,
        Mounts: [{ Type: 'volume', Name: volumeName, Destination: '/snapshot', RW: true }],
        State: { Running: false, ExitCode: 0, OOMKilled: false, Restarting: false } }]) + '\n');
      if (args[0] === 'start') {
        assert.deepEqual(stdin, tar);
        assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.materializationIntent, true);
        assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerId, ownerId);
        return result('');
      }
      if (args[0] === 'cp') return result(tar);
      throw new Error('unexpected command');
    };
    const prepared = await prepareDockerVolumeSource({ store: f.store, snapshots: f.snapshots, claim: f.claim,
      expected: f.expected, ownerName: name, daemonId, trustedImageId: imageId, now: () => instant }, run);
    assert.equal(prepared.claim.dockerVolume?.materialized, true);
    assert.deepEqual(events, ['info', 'create', 'info', 'inspect', 'info', 'start', 'inspect', 'cp', 'info', 'inspect', 'info']);
  } finally { f.close(); }
});

test('truncated readback retains occupied one-shot intent and refuses materialized', async () => {
  const f = await fixture();
  try {
    const name = ownerName();
    const run = async (args: string[]) => {
      if (args[0] === 'info') return result(`${daemonId}\n`);
      if (args[0] === 'create') return result(`${ownerId}\n`);
      if (args[0] === 'inspect') return result(JSON.stringify([{ Id: ownerId, Name: `/${name}`,
        Mounts: [{ Type: 'volume', Name: volumeName, Destination: '/snapshot', RW: true }],
        State: { Running: false, ExitCode: 0, OOMKilled: false, Restarting: false } }]) + '\n');
      if (args[0] === 'start') return result('');
      if (args[0] === 'cp') return result(buildSnapshotTar(f.snapshot, ['src/main.ts']).subarray(0, 800));
      throw new Error('unexpected command');
    };
    await assert.rejects(prepareDockerVolumeSource({ store: f.store, snapshots: f.snapshots, claim: f.claim,
      expected: f.expected, ownerName: name, daemonId, trustedImageId: imageId, now: () => instant }, run));
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.materializationIntent, true);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.materialized, false);
  } finally { f.close(); }
});

test('revocation during readback prevents materialized state after complete bytes', async () => {
  const f = await fixture();
  try {
    const name = ownerName();
    const run = async (args: string[]) => {
      if (args[0] === 'info') return result(`${daemonId}\n`);
      if (args[0] === 'create') return result(`${ownerId}\n`);
      if (args[0] === 'inspect') return result(JSON.stringify([{ Id: ownerId, Name: `/${name}`,
        Mounts: [{ Type: 'volume', Name: volumeName, Destination: '/snapshot', RW: true }],
        State: { Running: false, ExitCode: 0, OOMKilled: false, Restarting: false } }]) + '\n');
      if (args[0] === 'start') return result('');
      if (args[0] === 'cp') {
        f.base.revokeGrant('read', instant.toISOString());
        return result(buildSnapshotTar(f.snapshot, ['src/main.ts']));
      }
      throw new Error('unexpected command');
    };
    await assert.rejects(prepareDockerVolumeSource({ store: f.store, snapshots: f.snapshots, claim: f.claim,
      expected: f.expected, ownerName: name, daemonId, trustedImageId: imageId, now: () => instant }, run));
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.materializationIntent, true);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.materialized, false);
    assert.throws(() => f.store.markDockerVolumeMaterialized(f.store.listUnsettled()[0]!, instant));
  } finally { f.close(); }
});

test('uncertain owner create retains reservation and sends no source bytes', async () => {
  const f = await fixture();
  try {
    let byteCalls = 0;
    const run = async (args: string[], stdin?: Buffer) => {
      if (stdin) byteCalls++;
      if (args[0] === 'info') return result(`${daemonId}\n`);
      if (args[0] === 'create') return { ...result(`${ownerId}\n`), truncated: true };
      throw new Error('unexpected command');
    };
    await assert.rejects(prepareDockerVolumeSource({ store: f.store, snapshots: f.snapshots, claim: f.claim,
      expected: f.expected, ownerName: ownerName(), daemonId, trustedImageId: imageId,
      now: () => instant }, run));
    assert.equal(byteCalls, 0);
    assert.equal(f.store.listUnsettled()[0]?.dockerVolume?.ownerId, null);
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
});

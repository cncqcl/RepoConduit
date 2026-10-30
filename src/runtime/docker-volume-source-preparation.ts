import { RepositorySnapshot } from '../adapters/repository/snapshots.js';
import { buildSnapshotTar, inspectContainerArgs, ownerCreateArgs, parseOwnerInspection,
  verifySnapshotTarReadback } from '../adapters/investigator/docker-volume.js';
import { runDockerVolumeBinary, type DockerBinaryResult, type DockerBinaryRunner } from
  '../adapters/investigator/docker-volume-binary-runner.js';
import type { InvestigationClaim, SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';
import type { SnapshotRecord } from '../application/repository.js';
import { buildInvestigationSourcePlan, type InvestigationSourceBinding } from
  '../application/investigation-source-plan.js';

type PreparationStore = Pick<SqliteInvestigationStore, 'get' | 'preflightSourceRead' |
  'reserveDockerVolumeOwner' | 'observeDockerVolumeOwner' |
  'reserveDockerVolumeMaterialization' | 'markDockerVolumeMaterialized'>;
type SnapshotStore = { getSnapshot(snapshotId: string, workspaceId: string,
  collaborationId: string): Promise<SnapshotRecord | null> };

export interface DockerVolumePreparationInput {
  store: PreparationStore;
  snapshots: SnapshotStore;
  claim: InvestigationClaim;
  expected: InvestigationSourceBinding;
  ownerName: string;
  daemonId: string;
  trustedImageId: string;
  now?: () => Date;
  signal?: AbortSignal;
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('NOT_AVAILABLE');
}

function complete(result: DockerBinaryResult, maximum: number): Buffer {
  if (!result || !Number.isInteger(result.exitCode) || result.exitCode !== 0 ||
      !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) ||
      result.stdout.length > maximum || result.stderr.length !== 0 ||
      result.timedOut !== false || result.truncated !== false) throw new Error('INCOMPLETE_COMMAND');
  return result.stdout;
}

async function exactDaemon(run: DockerBinaryRunner, expected: string): Promise<void> {
  const output = complete(await run(['info', '--format', '{{.ID}}']), 256);
  if (output.toString('utf8') !== `${expected}\n`) throw new Error('DAEMON_IDENTITY_UNCONFIRMED');
}

async function exactOwner(run: DockerBinaryRunner, name: string, id: string, volume?: string):
  Promise<string> {
  const output = complete(await run(inspectContainerArgs(id)), 64 * 1024);
  const parsed = parseOwnerInspection(output.toString('utf8'), name, id);
  if (volume !== undefined && parsed !== volume) throw new Error('ISOLATION_UNCONFIRMED');
  return parsed;
}

async function stoppedSuccessfully(run: DockerBinaryRunner, id: string, name: string,
  volume: string): Promise<void> {
  const output = complete(await run(inspectContainerArgs(id)), 64 * 1024);
  const json = output.toString('utf8');
  if (parseOwnerInspection(json, name, id) !== volume) throw new Error('ISOLATION_UNCONFIRMED');
  let row: { State?: { Running?: unknown; ExitCode?: unknown; OOMKilled?: unknown;
    Restarting?: unknown } };
  try { row = JSON.parse(json)[0]; } catch { throw new Error('ISOLATION_UNCONFIRMED'); }
  if (row.State?.Running !== false || row.State.ExitCode !== 0 ||
      row.State.OOMKilled !== false || row.State.Restarting !== false) {
    throw new Error('MATERIALIZATION_UNCONFIRMED');
  }
}

/** Prepare one owner volume from selected snapshot bytes. No reader or AI profile is launched. */
export async function prepareDockerVolumeSource(input: DockerVolumePreparationInput,
  run: DockerBinaryRunner = runDockerVolumeBinary): Promise<{ claim: InvestigationClaim; tarBytes: number }> {
  const { store, claim } = input;
  if (claim.phase !== 'start_intent' || claim.launchProtocol !== 'resource_reservation_v1' ||
      claim.nativeRef !== null) throw new Error('NOT_AVAILABLE');
  const now = input.now ?? (() => new Date());
  const record = store.get(claim.requestId);
  if (!record) throw new Error('NOT_AVAILABLE');
  const paths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  const authorize = () => { requireActive(input.signal); store.preflightSourceRead(claim, paths, now()); };
  authorize();
  const saved = await input.snapshots.getSnapshot(record.snapshotRef, record.workspaceId,
    record.collaborationId);
  authorize();
  if (!saved || saved.workspaceId !== record.workspaceId ||
      saved.collaborationId !== record.collaborationId || saved.workingCopyId !== record.workingCopyId ||
      saved.snapshot.id !== record.snapshotRef || saved.snapshot.workingCopyId !== record.workingCopyId) {
    throw new Error('NOT_AVAILABLE');
  }
  const plan = buildInvestigationSourcePlan({ record, claim, snapshot: saved.snapshot,
    expected: input.expected, limits: { maxFiles: 64 } });
  const snapshot = RepositorySnapshot.fromPersisted(saved.snapshot);
  const tar = buildSnapshotTar(snapshot, plan.files.map(file => file.path));
  const createArgs = ownerCreateArgs(input.ownerName, input.trustedImageId);
  let current = store.reserveDockerVolumeOwner(claim, input.ownerName, input.daemonId, now());
  await exactDaemon(run, input.daemonId);
  authorize();
  // The create response is not enough to publish an owner identity: one exact
  // inspection must establish its anonymous volume before any source is sent.
  const created = complete(await run(createArgs), 256).toString('utf8');
  if (!/^[0-9a-f]{64}\n$/.test(created)) throw new Error('OWNER_IDENTITY_UNCONFIRMED');
  const ownerId = created.trim();
  await exactDaemon(run, input.daemonId);
  const volume = await exactOwner(run, input.ownerName, ownerId);
  current = store.observeDockerVolumeOwner(current, ownerId, volume, now());
  authorize();
  await exactDaemon(run, input.daemonId);
  authorize();
  current = store.reserveDockerVolumeMaterialization(current, now());
  const startOutput = complete(await run(['start', '-a', '-i', ownerId], tar), 256);
  if (startOutput.length !== 0) throw new Error('MATERIALIZATION_UNCONFIRMED');
  authorize();
  await stoppedSuccessfully(run, ownerId, input.ownerName, volume);
  authorize();
  const readback = complete(await run(['cp', `${ownerId}:/snapshot/.`, '-']),
    128 * 1024 * 1024);
  authorize();
  verifySnapshotTarReadback(readback, snapshot, plan.files.map(file => file.path));
  await exactDaemon(run, input.daemonId);
  authorize();
  await stoppedSuccessfully(run, ownerId, input.ownerName, volume);
  await exactDaemon(run, input.daemonId);
  authorize();
  current = store.markDockerVolumeMaterialized(current, now());
  return { claim: current, tarBytes: tar.length };
}

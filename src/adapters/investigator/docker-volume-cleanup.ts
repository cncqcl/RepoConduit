import { createHash } from 'node:crypto';
import type { DockerVolumeResource } from '../storage/investigation-sqlite.js';
import { cleanupListingArgs, inspectContainerArgs, parseOwnerInspection,
  parseReaderInspection, verifyCleanupListing } from './docker-volume.js';

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}
export type DockerCommandRunner = (args: string[]) => Promise<DockerCommandResult>;
export type DockerCleanupResult =
  | { kind: 'observed'; ownerId: string; volumeName: string; readerId: string | null }
  | { kind: 'cleaned'; receipt: string; evidence: {
      daemonId: string; ownerId: string; readerId: string | null; volumeName: string;
      containerListingSha256: string; volumeListingSha256: string } }
  | { kind: 'unconfirmed'; reason: string };

const idPattern = /^[0-9a-f]{64}$/;
const daemonIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namePattern = /^rcac-investigator-(owner|reader)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const volumePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/;

function valid(resource: DockerVolumeResource): boolean {
  const daemonId = (resource as DockerVolumeResource & { daemonId?: unknown })?.daemonId;
  return resource?.protocol === 'docker_volume_v1' &&
    typeof daemonId === 'string' && daemonIdPattern.test(daemonId) &&
    namePattern.test(resource.ownerName) && resource.ownerName.startsWith('rcac-investigator-owner-') &&
    (resource.ownerId === null || idPattern.test(resource.ownerId)) &&
    (resource.volumeName === null || volumePattern.test(resource.volumeName)) &&
    (resource.ownerId === null) === (resource.volumeName === null) &&
    (resource.readerName === null || (namePattern.test(resource.readerName) &&
      resource.readerName.startsWith('rcac-investigator-reader-'))) &&
    (resource.readerId === null || idPattern.test(resource.readerId)) &&
    (resource.readerId === null || resource.readerName !== null) &&
    (resource.ownerId === null || resource.readerId === null || resource.ownerId !== resource.readerId);
}

async function call(runner: DockerCommandRunner, args: string[]): Promise<DockerCommandResult> {
  const result = await runner(args);
  if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' || result.timedOut !== false || result.truncated !== false ||
    result.stdout.length > 1_000_000 || result.stderr.length > 16_384) throw new Error('INCOMPLETE_COMMAND');
  return result;
}

function lines(stdout: string, pattern: RegExp): string[] {
  if (stdout === '') return [];
  if (!stdout.endsWith('\n')) throw new Error('INCOMPLETE_LISTING');
  const rows = stdout.trimEnd().split(/\r?\n/);
  if (rows.some(row => !pattern.test(row)) || new Set(rows).size !== rows.length) {
    throw new Error('INCOMPLETE_LISTING');
  }
  return rows;
}

async function containers(runner: DockerCommandRunner): Promise<string[]> {
  const result = await call(runner, cleanupListingArgs()[0]!);
  if (result.exitCode !== 0 || result.stderr !== '') throw new Error('INCOMPLETE_LISTING');
  return lines(result.stdout, idPattern);
}

async function volumes(runner: DockerCommandRunner): Promise<string[]> {
  const result = await call(runner, cleanupListingArgs()[1]!);
  if (result.exitCode !== 0 || result.stderr !== '') throw new Error('INCOMPLETE_LISTING');
  return lines(result.stdout, volumePattern);
}

async function inspect(runner: DockerCommandRunner, id: string): Promise<string | null> {
  const result = await call(runner, inspectContainerArgs(id));
  if (result.exitCode === 0) {
    if (result.stderr !== '') throw new Error('INSPECTION_UNCONFIRMED');
    return result.stdout;
  }
  if (result.exitCode !== 1 || result.stdout !== '') throw new Error('INSPECTION_UNCONFIRMED');
  // Exit 1 alone can mean daemon failure; a complete listing is necessary evidence.
  if ((await containers(runner)).includes(id)) throw new Error('INSPECTION_UNCONFIRMED');
  return null;
}

async function findByName(runner: DockerCommandRunner, name: string): Promise<{ id: string; json: string } | null> {
  let match: { id: string; json: string } | null = null;
  for (const id of await containers(runner)) {
    const json = await inspect(runner, id);
    if (json === null) throw new Error('RECONCILIATION_RACE');
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw new Error('INSPECTION_UNCONFIRMED'); }
    if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' || !value[0]) {
      throw new Error('INSPECTION_UNCONFIRMED');
    }
    if ((value[0] as { Name?: unknown }).Name === `/${name}`) {
      if (match) throw new Error('AMBIGUOUS_IDENTITY');
      match = { id, json };
    }
  }
  return match;
}

function validateVolume(json: string, expected: string): void {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('VOLUME_UNCONFIRMED'); }
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' ||
    value[0] === null || (value[0] as { Name?: unknown }).Name !== expected) {
    throw new Error('VOLUME_UNCONFIRMED');
  }
}

async function verifyDaemon(runner: DockerCommandRunner, daemonId: string): Promise<void> {
  const daemon = await call(runner, ['info', '--format', '{{.ID}}']);
  if (daemon.exitCode !== 0 || daemon.stderr !== '' ||
    daemon.stdout !== `${daemonId}\n`) throw new Error('DAEMON_IDENTITY_UNCONFIRMED');
}

/** Cleanup is caller-authorized only after a durable cleanup lease; observations must be persisted before retry. */
export async function cleanupDockerVolume(resource: DockerVolumeResource,
  runner: DockerCommandRunner): Promise<DockerCleanupResult> {
  if (!valid(resource)) return { kind: 'unconfirmed', reason: 'invalid_resource' };
  try {
    const daemonId = (resource as DockerVolumeResource & { daemonId: string }).daemonId;
    await verifyDaemon(runner, daemonId);
    let ownerId = resource.ownerId;
    let volumeName = resource.volumeName;
    if (!ownerId) {
      const found = await findByName(runner, resource.ownerName);
      if (!found) return { kind: 'unconfirmed', reason: 'owner_identity_unobserved' };
      ownerId = found.id;
      volumeName = parseOwnerInspection(found.json, resource.ownerName, ownerId);
      return { kind: 'observed', ownerId, volumeName, readerId: null };
    }
    const ownerJson = await inspect(runner, ownerId);
    if (ownerJson !== null && parseOwnerInspection(ownerJson, resource.ownerName, ownerId) !== volumeName) {
      throw new Error('OWNER_VOLUME_MISMATCH');
    }
    const readerId = resource.readerId;
    let readerJson: string | null = null;
    if (resource.readerName && !readerId) {
      const found = await findByName(runner, resource.readerName);
      if (!found) return { kind: 'unconfirmed', reason: 'reader_identity_unobserved' };
      parseReaderInspection(found.json, resource.readerName, found.id, ownerId, volumeName!);
      return { kind: 'observed', ownerId, volumeName: volumeName!, readerId: found.id };
    }
    if (readerId) {
      readerJson = await inspect(runner, readerId);
      if (readerJson !== null) parseReaderInspection(readerJson, resource.readerName!, readerId,
        ownerId, volumeName!);
    }
    const volumeResult = await call(runner, ['volume', 'inspect', volumeName!]);
    if (volumeResult.exitCode === 0) {
      if (volumeResult.stderr !== '') throw new Error('VOLUME_UNCONFIRMED');
      validateVolume(volumeResult.stdout, volumeName!);
    }
    else if (volumeResult.exitCode !== 1 || volumeResult.stdout !== '' ||
      (await volumes(runner)).includes(volumeName!)) throw new Error('VOLUME_UNCONFIRMED');
    // With both containers gone, a remaining same-name volume has no live mount proving identity.
    if (volumeResult.exitCode === 0 && ownerJson === null && readerJson === null) {
      throw new Error('ORPHAN_VOLUME_IDENTITY_UNCONFIRMED');
    }
    if (volumeResult.exitCode !== 0 && (ownerJson !== null || readerJson !== null)) {
      throw new Error('MOUNT_VOLUME_CONFLICT');
    }
    if (readerId && readerJson !== null) {
      const removed = await call(runner, ['rm', '-f', '-v', readerId]);
      if (removed.exitCode !== 0 || removed.stderr !== '') throw new Error('READER_REMOVAL_UNCONFIRMED');
    }
    if (ownerJson !== null) {
      // The final owner removal asks Docker to remove its anonymous volume in
      // the same daemon operation. A separate volume rm has a crash window in
      // which no live mount remains to prove the persisted volume's ownership.
      const removed = await call(runner, ['rm', '-f', '-v', ownerId]);
      if (removed.exitCode !== 0 || removed.stderr !== '') throw new Error('OWNER_REMOVAL_UNCONFIRMED');
    }
    const ids = await containers(runner);
    const names = await volumes(runner);
    verifyCleanupListing(ids.length ? `${ids.join('\n')}\n` : '',
      names.length ? `${names.join('\n')}\n` : '', [readerId ?? ownerId, ownerId], volumeName!);
    if (ids.includes(ownerId) || (readerId && ids.includes(readerId)) || names.includes(volumeName!)) {
      throw new Error('ABSENCE_UNCONFIRMED');
    }
    await verifyDaemon(runner, daemonId);
    const evidence = { daemonId, ownerId, readerId, volumeName: volumeName!,
      containerListingSha256: createHash('sha256').update(ids.join('\n')).digest('hex'),
      volumeListingSha256: createHash('sha256').update(names.join('\n')).digest('hex') };
    const receipt = createHash('sha256').update(JSON.stringify({ protocol: resource.protocol,
      daemonId, ownerName: resource.ownerName, ownerId, readerName: resource.readerName, readerId,
      volumeName, absent: true, evidence })).digest('hex');
    return { kind: 'cleaned', receipt, evidence };
  } catch (error) {
    return { kind: 'unconfirmed', reason: error instanceof Error ? error.message : 'UNKNOWN_ERROR' };
  }
}

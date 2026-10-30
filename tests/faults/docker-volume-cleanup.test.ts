import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { DockerVolumeResource } from '../../src/adapters/storage/investigation-sqlite.js';
import { cleanupDockerVolume, type DockerCommandResult } from '../../src/adapters/investigator/docker-volume-cleanup.js';

const ownerId = 'a'.repeat(64);
const readerId = 'b'.repeat(64);
const volume = 'c'.repeat(64);
const daemonId = randomUUID();
const ownerName = `rcac-investigator-owner-${randomUUID()}`;
const readerName = `rcac-investigator-reader-${randomUUID()}`;
const resource = (change: Partial<DockerVolumeResource> = {}): DockerVolumeResource => ({
  protocol: 'docker_volume_v1', daemonId, ownerName, ownerId, volumeName: volume,
  materializationIntent: true, materialized: true, readerName, readerId, ...change,
});
const ok = (stdout = ''): DockerCommandResult => ({ exitCode: 0, stdout, stderr: '',
  timedOut: false, truncated: false });
const withDaemon = (runner: (args: string[]) => Promise<DockerCommandResult>) =>
  async (args: string[]): Promise<DockerCommandResult> => args[0] === 'info' ? ok(`${daemonId}\n`) : runner(args);
const inspection = (id: string, name: string, rw: boolean, volumesFrom: string[] = []) =>
  JSON.stringify([{ Id: id, Name: `/${name}`, Mounts: [
    { Type: 'volume', Name: volume, Destination: '/snapshot', RW: rw },
  ], HostConfig: { VolumesFrom: volumesFrom } }]);

test('cleanup inspects exact IDs, removes reader then owner with anonymous volumes, and verifies complete absence', async () => {
  const commands: string[][] = [];
  const runner = async (args: string[]): Promise<DockerCommandResult> => {
    commands.push(args);
    const key = args.join(' ');
    if (key === `inspect --type container ${readerId}`) return ok(inspection(readerId, readerName, false, [`${ownerId}:ro`]));
    if (key === `inspect --type container ${ownerId}`) return ok(inspection(ownerId, ownerName, true));
    if (key === `volume inspect ${volume}`) return ok(JSON.stringify([{ Name: volume }]));
    return ok();
  };
  const result = await cleanupDockerVolume(resource(), withDaemon(runner));
  assert.equal(result.kind, 'cleaned');
  if (result.kind === 'cleaned') assert.match(result.receipt, /^[a-f0-9]{64}$/);
  assert.deepEqual(commands, [
    ['inspect', '--type', 'container', ownerId],
    ['inspect', '--type', 'container', readerId],
    ['volume', 'inspect', volume],
    ['rm', '-f', '-v', readerId], ['rm', '-f', '-v', ownerId],
    ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'],
    ['volume', 'ls', '--format', '{{.Name}}'],
  ]);
});

test('unknown owner create is only observed from complete list and exact inspection', async () => {
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource({ ownerId: null, volumeName: null,
    materializationIntent: false, materialized: false, readerName: null, readerId: null }),
  withDaemon(async args => {
    commands.push(args);
    if (args[0] === 'ps') return ok(`${ownerId}\n`);
    if (args[0] === 'inspect') return ok(inspection(ownerId, ownerName, true));
    return ok();
  }));
  assert.deepEqual(result, { kind: 'observed', ownerId, volumeName: volume, readerId: null });
  assert.equal(commands.some(args => args[0] === 'rm'), false);
});

test('unknown reader create is observed but never deleted before persistence', async () => {
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource({ readerId: null }), withDaemon(async args => {
    commands.push(args);
    if (args[0] === 'ps') return ok(`${ownerId}\n${readerId}\n`);
    if (args[0] === 'inspect' && args.at(-1) === ownerId) return ok(inspection(ownerId, ownerName, true));
    if (args[0] === 'inspect') return ok(inspection(readerId, readerName, false, [`${ownerId}:ro`]));
    return ok();
  }));
  assert.deepEqual(result, { kind: 'observed', ownerId, volumeName: volume, readerId });
  assert.equal(commands.some(args => args[0] === 'rm'), false);
});

test('mismatched identity and ambiguous observations never remove anything', async () => {
  for (const changed of [
    ok(inspection(readerId, ownerName, false, [`${ownerId}:ro`])),
    ok('[]'),
    { ...ok(inspection(readerId, readerName, false, [`${ownerId}:ro`])), truncated: true },
    { ...ok(inspection(readerId, readerName, false, [`${ownerId}:ro`])), timedOut: true },
  ]) {
    const commands: string[][] = [];
    const result = await cleanupDockerVolume(resource(), withDaemon(async args => {
      commands.push(args);
      return changed;
    }));
    assert.equal(result.kind, 'unconfirmed');
    assert.equal(commands.some(args => args[0] === 'rm'), false);
  }
});

test('cleanup cannot issue receipt when final listing is malformed or still contains a resource', async () => {
  for (const listing of [`${ownerId}\n`, 'short-id\n']) {
    const commands: string[][] = [];
    const result = await cleanupDockerVolume(resource(), withDaemon(async args => {
      commands.push(args);
      const key = args.join(' ');
      if (key === `inspect --type container ${readerId}`) return ok(inspection(readerId, readerName, false, [`${ownerId}:ro`]));
      if (key === `inspect --type container ${ownerId}`) return ok(inspection(ownerId, ownerName, true));
      if (key === `volume inspect ${volume}`) return ok(JSON.stringify([{ Name: volume }]));
      if (args[0] === 'ps') return ok(listing);
      return ok();
    }));
    assert.equal(result.kind, 'unconfirmed');
  assert.equal(commands.filter(args => args[0] === 'rm').length, 2);
  }
});

test('an absent exact reader ID is confirmed by a complete list before owner cleanup', async () => {
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource(), withDaemon(async args => {
    commands.push(args);
    const key = args.join(' ');
    if (key === `inspect --type container ${ownerId}`) return ok(inspection(ownerId, ownerName, true));
    if (key === `inspect --type container ${readerId}`) return { ...ok(), exitCode: 1,
      stderr: 'No such object' };
    if (key === `volume inspect ${volume}`) return ok(JSON.stringify([{ Name: volume }]));
    if (args[0] === 'ps') return ok(`${ownerId}\n`);
    return ok();
  }));
  // Final list still contains owner: no receipt, even after removal reported success.
  assert.equal(result.kind, 'unconfirmed');
  assert.equal(commands.some(args => args[0] === 'rm' && args.at(-1) === readerId), false);
  assert.equal(commands.some(args => args[0] === 'rm' && args.at(-1) === ownerId), true);
});

test('orphan volume cannot be removed without a live mount binding it to persisted identity', async () => {
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource(), withDaemon(async args => {
    commands.push(args);
    if (args[0] === 'inspect') return { ...ok(), exitCode: 1 };
    if (args[0] === 'ps') return ok();
    if (args[0] === 'volume' && args[1] === 'inspect') return ok(JSON.stringify([{ Name: volume }]));
    return ok();
  }));
  assert.deepEqual(result, { kind: 'unconfirmed', reason: 'ORPHAN_VOLUME_IDENTITY_UNCONFIRMED' });
  assert.equal(commands.some(args => args[0] === 'rm' || args[1] === 'rm'), false);
});

test('explicit completeness metadata is required before any removal', async () => {
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource(), withDaemon(async args => {
    commands.push(args);
    return { ...ok(inspection(ownerId, ownerName, true)), truncated: undefined } as unknown as DockerCommandResult;
  }));
  assert.equal(result.kind, 'unconfirmed');
  assert.equal(commands.length, 1);
});

test('wrong daemon identity stops before any inspect, listing or removal', async () => {
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource(), async args => {
    commands.push(args);
    return ok(`${randomUUID()}\n`);
  });
  assert.equal(result.kind, 'unconfirmed');
  assert.deepEqual(commands, [['info', '--format', '{{.ID}}']]);
});

test('ambiguous daemon responses stop before any inspect, listing or removal', async () => {
  for (const response of [
    ok(daemonId), ok(`${daemonId}\n\n`),
    { ...ok(`${daemonId}\n`), exitCode: 1 },
    { ...ok(`${daemonId}\n`), stderr: 'warning' },
    { ...ok(`${daemonId}\n`), timedOut: true },
    { ...ok(`${daemonId}\n`), truncated: true },
  ]) {
    const commands: string[][] = [];
    const result = await cleanupDockerVolume(resource(), async args => {
      commands.push(args);
      return response;
    });
    assert.equal(result.kind, 'unconfirmed');
    assert.deepEqual(commands, [['info', '--format', '{{.ID}}']]);
  }
});

test('daemon context change after removal prevents a cleanup receipt', async () => {
  let infoCalls = 0;
  const commands: string[][] = [];
  const result = await cleanupDockerVolume(resource(), async args => {
    commands.push(args);
    const key = args.join(' ');
    if (args[0] === 'info') return ok(`${++infoCalls === 1 ? daemonId : randomUUID()}\n`);
    if (key === `inspect --type container ${ownerId}`) return ok(inspection(ownerId, ownerName, true));
    if (key === `inspect --type container ${readerId}`) return ok(inspection(readerId, readerName, false, [`${ownerId}:ro`]));
    if (key === `volume inspect ${volume}`) return ok(JSON.stringify([{ Name: volume }]));
    return ok();
  });
  assert.equal(result.kind, 'unconfirmed');
  assert.equal(infoCalls, 2);
  assert.deepEqual(commands.at(-1), ['info', '--format', '{{.ID}}']);
  assert.equal(commands.some(args => args[0] === 'rm'), true);
});

test('lost owner rm -v response can recover only after all three resources are absent', async () => {
  let ownerPresent = true;
  let readerPresent = true;
  let volumePresent = true;
  let loseOwnerResponse = true;
  const runner = withDaemon(async args => {
    const key = args.join(' ');
    if (args[0] === 'ps') {
      const ids = [ownerPresent && ownerId, readerPresent && readerId].filter(Boolean);
      return ok(ids.length ? `${ids.join('\n')}\n` : '');
    }
    if (key === `inspect --type container ${ownerId}`) return ownerPresent ?
      ok(inspection(ownerId, ownerName, true)) : { ...ok(), exitCode: 1 };
    if (key === `inspect --type container ${readerId}`) return readerPresent ?
      ok(inspection(readerId, readerName, false, [`${ownerId}:ro`])) : { ...ok(), exitCode: 1 };
    if (key === `volume inspect ${volume}`) return volumePresent ?
      ok(JSON.stringify([{ Name: volume }])) : { ...ok(), exitCode: 1 };
    if (args[0] === 'volume' && args[1] === 'ls') return ok(volumePresent ? `${volume}\n` : '');
    if (key === `rm -f -v ${readerId}`) { readerPresent = false; return ok(); }
    if (key === `rm -f -v ${ownerId}`) {
      ownerPresent = false;
      volumePresent = false;
      if (loseOwnerResponse) { loseOwnerResponse = false; return { ...ok(), timedOut: true }; }
      return ok();
    }
    throw new Error(`Unexpected command: ${key}`);
  });
  const first = await cleanupDockerVolume(resource(), runner);
  assert.equal(first.kind, 'unconfirmed');
  const second = await cleanupDockerVolume(resource(), runner);
  assert.equal(second.kind, 'cleaned');
  assert.equal(ownerPresent || readerPresent || volumePresent, false);
});

test('lost reader rm -v response keeps owner and volume until a verified retry', async () => {
  let ownerPresent = true;
  let readerPresent = true;
  let volumePresent = true;
  let loseReaderResponse = true;
  const runner = withDaemon(async args => {
    const key = args.join(' ');
    if (args[0] === 'ps') {
      const ids = [ownerPresent && ownerId, readerPresent && readerId].filter(Boolean);
      return ok(ids.length ? `${ids.join('\n')}\n` : '');
    }
    if (key === `inspect --type container ${ownerId}`) return ownerPresent ?
      ok(inspection(ownerId, ownerName, true)) : { ...ok(), exitCode: 1 };
    if (key === `inspect --type container ${readerId}`) return readerPresent ?
      ok(inspection(readerId, readerName, false, [`${ownerId}:ro`])) : { ...ok(), exitCode: 1 };
    if (key === `volume inspect ${volume}`) return volumePresent ?
      ok(JSON.stringify([{ Name: volume }])) : { ...ok(), exitCode: 1 };
    if (args[0] === 'volume' && args[1] === 'ls') return ok(volumePresent ? `${volume}\n` : '');
    if (key === `rm -f -v ${readerId}`) {
      readerPresent = false;
      if (loseReaderResponse) { loseReaderResponse = false; return { ...ok(), timedOut: true }; }
      return ok();
    }
    if (key === `rm -f -v ${ownerId}`) {
      ownerPresent = false;
      volumePresent = false;
      return ok();
    }
    throw new Error(`Unexpected command: ${key}`);
  });
  const first = await cleanupDockerVolume(resource(), runner);
  assert.equal(first.kind, 'unconfirmed');
  assert.equal(ownerPresent, true);
  assert.equal(volumePresent, true);
  const second = await cleanupDockerVolume(resource(), runner);
  assert.equal(second.kind, 'cleaned');
  assert.equal(ownerPresent || readerPresent || volumePresent, false);
});

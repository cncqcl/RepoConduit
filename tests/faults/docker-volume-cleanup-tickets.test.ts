import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { DockerCleanupResult } from '../../src/adapters/investigator/docker-volume-cleanup.js';
import type { DockerVolumeResource, InvestigationClaim } from
  '../../src/adapters/storage/investigation-sqlite.js';
import { createDockerVolumeCleanupTickets } from '../../src/runtime/docker-volume-cleanup-tickets.js';

const daemonId = 'c20f7230-59a2-4824-a2f4-fda71c982ee6';
const ownerId = 'a'.repeat(64);
const readerId = 'b'.repeat(64);
const volumeName = 'vol';
const resource: DockerVolumeResource = { protocol: 'docker_volume_v1', daemonId,
  ownerName: `rcac-investigator-owner-${randomUUID()}`, ownerId, volumeName,
  materializationIntent: true, materialized: true,
  readerName: `rcac-investigator-reader-${randomUUID()}`, readerId };
const claim: InvestigationClaim = { requestId: 'request', attemptId: 'attempt', workspaceId: 'workspace',
  workerId: 'cleanup', workerEpoch: 2, nativeRef: null, launchProtocol: 'resource_reservation_v1',
  phase: 'reconcile', dockerVolume: resource };
const cleaned: Extract<DockerCleanupResult, { kind: 'cleaned' }> = {
  kind: 'cleaned', receipt: 'diagnostic-digest', evidence: { daemonId, ownerId, readerId,
    volumeName, containerListingSha256: 'c'.repeat(64), volumeListingSha256: 'd'.repeat(64) } };

test('Docker cleanup ticket is one-use and bound to exact claim/resource, not adapter digest', () => {
  const tickets = createDockerVolumeCleanupTickets();
  assert.throws(() => tickets.issue({ ...claim, phase: 'start_intent' }, cleaned), /NOT_AVAILABLE/);
  assert.throws(() => tickets.issue(claim, { ...cleaned,
    evidence: { ...cleaned.evidence, daemonId: randomUUID() } }), /NOT_AVAILABLE/);
  const receipt = tickets.issue(claim, cleaned);
  assert.notEqual(receipt, cleaned.receipt);
  assert.equal(tickets.verify({ ...claim, workerEpoch: 3 }, resource, receipt), false);
  assert.equal(tickets.verify({ ...claim, workspaceId: 'other' }, resource, receipt), false);
  assert.equal(tickets.verify(claim, { ...resource, volumeName: 'other' }, receipt), false);
  assert.equal(tickets.verify(claim, resource, receipt), true);
  assert.equal(tickets.verify(claim, resource, receipt), false);
});

test('Docker cleanup ticket binds a copied resource and cannot settle a changed reader', () => {
  const tickets = createDockerVolumeCleanupTickets();
  const mutable = { ...resource };
  const current = { ...claim, dockerVolume: mutable };
  const receipt = tickets.issue(current, cleaned);
  mutable.readerId = 'e'.repeat(64);
  assert.equal(tickets.verify(current, mutable, receipt), false);
  tickets.revoke(receipt);
  assert.equal(tickets.verify(claim, resource, receipt), false);
});

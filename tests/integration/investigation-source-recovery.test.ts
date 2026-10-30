import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInvestigationCleanupTick } from '../../src/runtime/investigation-recovery.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const workspaceId = 'ws_00000000-0000-4000-8000-000000000003';
const attemptId = 'attempt_00000000-0000-4000-8000-000000000002';
const bootId = '00000000-0000-4000-8000-000000000004';
const unitName = 'rcac-investigator-00000000-0000-4000-8000-000000000001.service';
const descriptor = { distro: 'Ubuntu', linuxUser: 'fixture', uid: 1000,
  attemptId, workspaceId, workerEpoch: 1, sourceDigest: 'a'.repeat(64), bootId };
const sourceView = { descriptor, privateRoot: '/home/fixture/private-source', closedAt: null };
const claim = { requestId: 'inv', attemptId, workerId: 'old', workerEpoch: 1,
  workspaceId, nativeRef: null, phase: 'start_intent' as const, sourceView,
  wslResource: { unitName, distro: 'Ubuntu', uid: 1000, bootId,
    invocationId: null, controlGroup: null, gate: { protocol: 'attempt_gate_v1' as const,
      linuxUser: 'fixture', root: '/home/fixture/gates', payloadKind: 'canary_v1' as const } } };
const takeover = { ...claim, workerId: 'new', workerEpoch: 2, phase: 'reconcile' as const };
const closed = { attemptId, workspaceId, uid: 1000, workerEpoch: 1,
  bootId, kind: 'closed' as const, digest: descriptor.sourceDigest };

function recoveryStore(calls: string[]) {
  return {
    listUnsettled: () => [claim], settleExpiredUnreservedAttempt: () => null,
    acquireCleanupLease: () => { throw new Error('unexpected Docker lease'); },
    recordObservedContainer: () => { throw new Error('unexpected Docker observation'); },
    finishCleanup: () => { throw new Error('unexpected Docker cleanup'); },
    acquireWslCleanupLease: () => { calls.push('lease'); return takeover; },
    confirmSourceViewClosed: () => { calls.push('confirm-source'); return takeover; },
    settleClosedUnconsumedWslAttempt: () => { calls.push('settle'); return {} as InvestigationRecord; },
    observeWslResource: () => { calls.push('observe'); return takeover; },
  };
}

test('recovery closes gate then source view, persists exact close before releasing slot', async () => {
  const calls: string[] = [];
  await runInvestigationCleanupTick(recoveryStore(calls), 'new', undefined, [claim], {
    close: async () => { calls.push('close-gate'); return { kind: 'closed_unconsumed' as const,
      attemptId, workspaceId, bootId, uid: 1000, unitName }; },
  }, { close: async (sourceDescriptor, root) => {
    assert.deepEqual(sourceDescriptor, descriptor);
    assert.equal(root, sourceView.privateRoot);
    calls.push('close-source');
    return closed;
  } });
  assert.deepEqual(calls, ['lease', 'close-gate', 'close-source', 'confirm-source', 'settle']);
});

test('unknown source close retains occupied attempt and refuses confirmation', async () => {
  const calls: string[] = [];
  await runInvestigationCleanupTick(recoveryStore(calls), 'new', undefined, [claim], {
    close: async () => { calls.push('close-gate'); return { kind: 'closed_unconsumed' as const,
      attemptId, workspaceId, bootId, uid: 1000, unitName }; },
  }, { close: async () => { calls.push('close-source'); return null; } });
  assert.deepEqual(calls, ['lease', 'close-gate', 'close-source']);
});

test('stale cleanup lease cannot settle after a source close observation', async () => {
  const calls: string[] = [];
  const store = { ...recoveryStore(calls), confirmSourceViewClosed: () => {
    calls.push('confirm-rejected'); throw new Error('STALE_EPOCH');
  } };
  await runInvestigationCleanupTick(store, 'new', undefined, [claim], {
    close: async () => { calls.push('close-gate'); return { kind: 'closed_unconsumed' as const,
      attemptId, workspaceId, bootId, uid: 1000, unitName }; },
  }, { close: async () => { calls.push('close-source'); return closed; } });
  assert.deepEqual(calls, ['lease', 'close-gate', 'close-source', 'confirm-rejected']);
});

test('consumed gate retains source and slot without attempting close', async () => {
  const calls: string[] = [];
  await runInvestigationCleanupTick(recoveryStore(calls), 'new', undefined, [claim], {
    close: async () => { calls.push('close-gate'); return { kind: 'closed_consumed' as const,
      attemptId, workspaceId, bootId, uid: 1000, unitName,
      invocationId: 'a'.repeat(32), controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` }; },
  }, { close: async () => { calls.push('close-source'); return closed; } });
  assert.deepEqual(calls, ['lease', 'close-gate', 'observe']);
});

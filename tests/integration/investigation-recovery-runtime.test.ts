import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInvestigationCleanupTick, settleFixedCanaryClaim } from '../../src/runtime/investigation-recovery.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';

test('shared fixed canary settlement fails closed and revokes tickets after finish attempts', async () => {
  const calls: string[] = [];
  const claim = { requestId: 'inv', attemptId: 'attempt', workspaceId: 'ws',
    workerId: 'worker', workerEpoch: 2, phase: 'reconcile', nativeRef: null,
    wslResource: { unitName: 'unit', distro: 'Ubuntu', uid: 1000, bootId: 'boot',
      invocationId: 'invocation', controlGroup: '/group',
      gate: { protocol: 'attempt_gate_v1', payloadKind: 'canary_v1',
        linuxUser: 'fixture', root: '/gates' } },
  } as InvestigationClaim;
  let terminal = false;
  let finishFails = false;
  const store = {
    confirmSourceViewClosed: (current: InvestigationClaim) => {
      calls.push('persist-close');
      return { ...current, sourceView: { ...current.sourceView!, closedAt: '2026-01-01T00:00:00.000Z' } };
    },
    finishWslCleanup: (current: InvestigationClaim, ticket: string) => {
      if (current.sourceView) assert.ok(current.sourceView.closedAt);
      calls.push(`finish:${ticket}`);
      if (finishFails) throw new Error('stale lease');
      return {} as InvestigationRecord;
    },
  };
  const ops = {
    observe: async () => { calls.push('observe'); return terminal ?
      { kind: 'fixed_canary_terminal' as const, resource: claim.wslResource! } :
      { kind: 'unconfirmed' as const }; },
    issue: () => { calls.push('issue'); return 'ticket'; },
    revoke: () => { calls.push('revoke'); },
  };
  assert.equal(await settleFixedCanaryClaim({ confirmSourceViewClosed: store.confirmSourceViewClosed },
    claim, ops), false);
  assert.equal(calls.length, 0);
  assert.equal(await settleFixedCanaryClaim(store, claim, ops), false);
  assert.deepEqual(calls, ['observe']);
  calls.length = 0;
  terminal = true;
  const sourced = { ...claim, sourceView: { descriptor: {} as never,
    privateRoot: '/source', closedAt: null } } as InvestigationClaim;
  assert.equal(await settleFixedCanaryClaim(store, sourced, ops,
    { close: async () => { calls.push('close'); return null; } }), false);
  assert.deepEqual(calls, ['observe', 'close']);
  calls.length = 0;
  assert.equal(await settleFixedCanaryClaim(store, sourced, ops,
    { close: async () => { calls.push('close'); return { kind: 'closed', attemptId: 'attempt',
      workspaceId: 'ws', uid: 1000, workerEpoch: 2, bootId: 'boot', digest: 'digest' }; } }), true);
  assert.deepEqual(calls, ['observe', 'close', 'persist-close', 'issue', 'finish:ticket', 'revoke']);
  calls.length = 0;
  assert.equal(await settleFixedCanaryClaim(store, claim, ops), true);
  assert.deepEqual(calls, ['observe', 'issue', 'finish:ticket', 'revoke']);
  calls.length = 0;
  finishFails = true;
  await assert.rejects(settleFixedCanaryClaim(store, claim, ops), /stale lease/);
  assert.deepEqual(calls, ['observe', 'issue', 'finish:ticket', 'revoke']);
});

test('cleanup tick fences first and settles only after both cleanup steps', async () => {
  const calls: string[] = [];
  const claim = { requestId: 'inv', attemptId: 'attempt', workerId: 'old', workerEpoch: 1,
    workspaceId: 'a', nativeRef: null, phase: 'start_intent' as const,
    containerName: 'rcac-investigator-00000000-0000-4000-8000-000000000001', scratchRoot: 'D:/temp/rcac-investigator-00000000-0000-4000-8000-000000000001' };
  const recovered = { ...claim, workerId: 'new', workerEpoch: 2, phase: 'reconcile' as const };
  const store = {
    listUnsettled: () => [claim],
    settleExpiredUnreservedAttempt: () => null,
    acquireCleanupLease: () => { calls.push('lease'); return recovered; },
    recordObservedContainer: (_claim: unknown, id: string) => { calls.push(`persist:${id}`); return { ...recovered, containerId: id }; },
    finishCleanup: () => { calls.push('finish'); return {} },
    acquireWslCleanupLease: () => null,
    settleClosedUnconsumedWslAttempt: () => ({} as InvestigationRecord),
    observeWslResource: () => recovered,
    confirmSourceViewClosed: () => { throw new Error('unexpected source closure'); },
  };
  await runInvestigationCleanupTick(store, 'new', {
    removeContainer: async (_name, _id, persist) => { calls.push('inspect'); await persist('a'.repeat(64)); calls.push('rm'); return 'a'.repeat(64); },
    removeScratch: async () => { calls.push('scratch'); },
  });
  assert.deepEqual(calls, ['lease', 'inspect', `persist:${'a'.repeat(64)}`, 'rm', 'scratch', 'finish']);
});

test('cleanup tick retains occupied attempt on unknown removal', async () => {
  const calls: string[] = [];
  const claim = { requestId: 'inv', attemptId: 'attempt', workerId: 'old', workerEpoch: 1,
    workspaceId: 'a', nativeRef: null, phase: 'start_intent' as const,
    containerName: 'rcac-investigator-00000000-0000-4000-8000-000000000001', scratchRoot: 'D:/temp/rcac-investigator-00000000-0000-4000-8000-000000000001' };
  const store = {
    listUnsettled: () => [claim],
    settleExpiredUnreservedAttempt: () => null,
    acquireCleanupLease: () => { calls.push('lease'); return { ...claim, workerId: 'new', workerEpoch: 2 }; },
    recordObservedContainer: () => { calls.push('persist'); return claim; },
    finishCleanup: () => { calls.push('finish'); return {} },
    acquireWslCleanupLease: () => null,
    settleClosedUnconsumedWslAttempt: () => ({} as InvestigationRecord),
    observeWslResource: () => claim,
    confirmSourceViewClosed: () => { throw new Error('unexpected source closure'); },
  };
  await runInvestigationCleanupTick(store, 'new', {
    removeContainer: async () => { calls.push('inspect'); throw new Error('ISOLATION_TERMINATION_UNCONFIRMED'); },
    removeScratch: async () => { calls.push('scratch'); },
  });
  assert.deepEqual(calls, ['lease', 'inspect']);
});

test('cleanup tick settles only a storage-confirmed prelaunch attempt without invoking Docker cleanup', async () => {
  const calls: string[] = [];
  const claim = { requestId: 'inv', attemptId: 'attempt', workerId: 'old', workerEpoch: 1,
    workspaceId: 'a', nativeRef: null, phase: 'start_intent' as const };
  const store = {
    listUnsettled: () => [claim],
    settleExpiredUnreservedAttempt: () => { calls.push('settle'); return { id: 'inv', state: 'failed' } as InvestigationRecord; },
    acquireCleanupLease: () => { calls.push('lease'); return null; },
    recordObservedContainer: () => { calls.push('persist'); return claim; },
    finishCleanup: () => { calls.push('finish'); return {}; },
    acquireWslCleanupLease: () => null,
    settleClosedUnconsumedWslAttempt: () => ({} as InvestigationRecord),
    observeWslResource: () => claim,
    confirmSourceViewClosed: () => { throw new Error('unexpected source closure'); },
  };
  await runInvestigationCleanupTick(store, 'new', {
    removeContainer: async () => { calls.push('docker'); throw new Error('unexpected'); },
    removeScratch: async () => { calls.push('scratch'); },
  });
  assert.deepEqual(calls, ['settle']);
});

test('recovery fences a reserved WSL gate, closes it, and settles only unconsumed payload', async () => {
  const calls: string[] = [];
  const unitName = 'rcac-investigator-00000000-0000-4000-8000-000000000001.service';
  const claim = { requestId: 'inv', attemptId: 'attempt_00000000-0000-4000-8000-000000000002',
    workerId: 'old', workerEpoch: 1, workspaceId: 'ws_00000000-0000-4000-8000-000000000003',
    nativeRef: null, phase: 'start_intent' as const,
    wslResource: { unitName, distro: 'Ubuntu', uid: 1000,
      bootId: '00000000-0000-4000-8000-000000000004', invocationId: null, controlGroup: null,
      gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture',
        root: '/home/fixture/gates', payloadKind: 'canary_v1' as const } } };
  const takeover = { ...claim, workerId: 'new', workerEpoch: 2, phase: 'reconcile' as const };
  const store = {
    listUnsettled: () => [claim], settleExpiredUnreservedAttempt: () => null,
    acquireCleanupLease: () => { throw new Error('unexpected Docker lease'); },
    recordObservedContainer: () => { throw new Error('unexpected Docker observation'); },
    finishCleanup: () => { throw new Error('unexpected Docker cleanup'); },
    acquireWslCleanupLease: () => { calls.push('lease'); return takeover; },
    settleClosedUnconsumedWslAttempt: (_claim: unknown, state: { kind: string }) => {
      calls.push(`settle:${state.kind}`); return {} as InvestigationRecord;
    },
    observeWslResource: () => { throw new Error('unexpected native observation'); },
    confirmSourceViewClosed: () => { throw new Error('unexpected source closure'); },
  };
  await runInvestigationCleanupTick(store, 'new', {
    removeContainer: async () => { throw new Error('unexpected Docker removal'); },
    removeScratch: async () => { throw new Error('unexpected scratch removal'); },
  }, [claim], { close: async (descriptor, root) => {
    calls.push(`close:${descriptor.attemptId}:${root}`);
    return { kind: 'closed_unconsumed', attemptId: descriptor.attemptId,
      workspaceId: descriptor.workspaceId, bootId: descriptor.bootId,
      uid: descriptor.uid, unitName: descriptor.unitName };
  } });
  assert.deepEqual(calls, ['lease', `close:${claim.attemptId}:${claim.wslResource.gate.root}`,
    'settle:closed_unconsumed']);
});

for (const payloadKind of ['native_supervisor_v1', 'native_supervisor_v2'] as const) {
test(`fixed canary recovery leaves ${payloadKind} untouched and occupied`, async () => {
  const calls: string[] = [];
  const claim = { requestId: 'inv', attemptId: 'attempt', workerId: 'old', workerEpoch: 1,
    workspaceId: 'ws', nativeRef: null, phase: 'reconcile' as const,
    wslResource: { unitName: 'unit', distro: 'Ubuntu', uid: 1000, bootId: 'boot',
      invocationId: null, controlGroup: null, gate: { protocol: 'attempt_gate_v1' as const,
        linuxUser: 'fixture', root: '/home/fixture/gates', payloadKind } } };
  const store = { listUnsettled: () => [claim],
    settleExpiredUnreservedAttempt: () => { calls.push('unreserved'); return null; },
    acquireWslCleanupLease: () => { calls.push('lease'); return claim; },
    acquireCleanupLease: () => { calls.push('docker-lease'); return null; },
    recordObservedContainer: () => { throw new Error('unexpected'); },
    finishCleanup: () => { calls.push('finish'); },
    settleClosedUnconsumedWslAttempt: () => { calls.push('settle'); return {} as InvestigationRecord; },
    observeWslResource: () => { calls.push('observe'); return claim; },
    confirmSourceViewClosed: () => { calls.push('source-close'); return claim; } };
  await runInvestigationCleanupTick(store, 'new', undefined, [claim], {
    close: async () => { calls.push('gate-close'); return null; },
  }, { close: async () => { calls.push('source-close-native'); return null; } }, undefined, {
    observe: async () => { calls.push('terminal'); return { kind: 'unconfirmed' as const }; },
    issue: () => { calls.push('ticket'); return 'ticket'; }, revoke: () => { calls.push('revoke'); },
  });
  assert.deepEqual(calls, ['unreserved']);
});
}

test('recovery retains WSL slot after consumed or failed gate close', async () => {
  for (const kind of ['closed_consumed', 'failed'] as const) {
    const calls: string[] = [];
    const unitName = 'rcac-investigator-00000000-0000-4000-8000-000000000001.service';
    const claim = { requestId: 'inv', attemptId: 'attempt_00000000-0000-4000-8000-000000000002',
      workerId: 'old', workerEpoch: 1, workspaceId: 'ws_00000000-0000-4000-8000-000000000003',
      nativeRef: null, phase: 'start_intent' as const,
      wslResource: { unitName, distro: 'Ubuntu', uid: 1000,
        bootId: '00000000-0000-4000-8000-000000000004', invocationId: null, controlGroup: null,
        gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture',
          root: '/home/fixture/gates', payloadKind: 'canary_v1' as const } } };
    const store = {
      listUnsettled: () => [claim], settleExpiredUnreservedAttempt: () => null,
      acquireCleanupLease: () => null, recordObservedContainer: () => claim,
      finishCleanup: () => ({} as InvestigationRecord),
      acquireWslCleanupLease: () => { calls.push('lease'); return claim; },
      settleClosedUnconsumedWslAttempt: () => { calls.push('settle'); return {} as InvestigationRecord; },
      observeWslResource: (_claim: unknown, observation: { invocationId: string }) => {
        calls.push(`observe:${observation.invocationId}`); return claim;
      },
      confirmSourceViewClosed: () => { throw new Error('unexpected source closure'); },
    };
    await runInvestigationCleanupTick(store, 'new', undefined, [claim], { close: async descriptor => {
      calls.push('close');
      return kind === 'failed' ? null : { kind, attemptId: descriptor.attemptId,
        workspaceId: descriptor.workspaceId, bootId: descriptor.bootId, uid: descriptor.uid,
        unitName: descriptor.unitName, invocationId: 'a'.repeat(32),
        controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` };
    } });
    assert.deepEqual(calls, kind === 'closed_consumed' ?
      ['lease', 'close', `observe:${'a'.repeat(32)}`] : ['lease', 'close']);
  }
});

test('fixed canary consumed recovery settles only after native observation and receipt', async () => {
  const calls: string[] = [];
  let failFinish = false;
  const unitName = 'rcac-investigator-00000000-0000-4000-8000-000000000001.service';
  const observation = { invocationId: 'a'.repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` };
  const claim = { requestId: 'inv', attemptId: 'attempt_00000000-0000-4000-8000-000000000002',
    workerId: 'old', workerEpoch: 1, workspaceId: 'ws_00000000-0000-4000-8000-000000000003',
    nativeRef: null, phase: 'start_intent' as const,
    wslResource: { unitName, distro: 'Ubuntu', uid: 1000,
      bootId: '00000000-0000-4000-8000-000000000004', invocationId: null, controlGroup: null,
      gate: { protocol: 'attempt_gate_v1' as const, linuxUser: 'fixture',
        root: '/home/fixture/gates', payloadKind: 'canary_v1' as const } } };
  const takeover = { ...claim, workerId: 'new', workerEpoch: 2, phase: 'reconcile' as const };
  const observed = { ...takeover, wslResource: { ...takeover.wslResource, ...observation } };
  const store = {
    listUnsettled: () => [claim], settleExpiredUnreservedAttempt: () => null,
    acquireCleanupLease: () => null, recordObservedContainer: () => claim,
    finishCleanup: () => ({} as InvestigationRecord),
    acquireWslCleanupLease: () => { calls.push('lease'); return takeover; },
    settleClosedUnconsumedWslAttempt: () => { throw new Error('unconsumed'); },
    observeWslResource: () => { calls.push('persist'); return observed; },
    confirmSourceViewClosed: () => { throw new Error('no source'); },
    finishWslCleanup: (_claim: unknown, ticket: string) => {
      calls.push(`finish:${ticket}`);
      if (failFinish) throw new Error('injected storage failure');
      return {} as InvestigationRecord;
    },
  };
  await runInvestigationCleanupTick(store, 'new', undefined, [claim], {
    close: async descriptor => { calls.push('close'); return { kind: 'closed_consumed',
      attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
      bootId: descriptor.bootId, uid: descriptor.uid, unitName: descriptor.unitName,
      ...observation }; },
  }, undefined, undefined, {
    observe: async () => { calls.push('terminal'); return { kind: 'fixed_canary_terminal',
      resource: observed.wslResource }; },
    issue: () => { calls.push('issue'); return 'ticket'; },
    revoke: () => { calls.push('revoke'); },
  });
  assert.deepEqual(calls, ['lease', 'close', 'persist', 'terminal', 'issue', 'finish:ticket', 'revoke']);
  calls.length = 0;
  failFinish = true;
  await runInvestigationCleanupTick(store, 'new', undefined, [claim], {
    close: async descriptor => { calls.push('close'); return { kind: 'closed_consumed',
      attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
      bootId: descriptor.bootId, uid: descriptor.uid, unitName: descriptor.unitName,
      ...observation }; },
  }, undefined, undefined, {
    observe: async () => { calls.push('terminal'); return { kind: 'fixed_canary_terminal',
      resource: observed.wslResource }; },
    issue: () => { calls.push('issue'); return 'ticket'; },
    revoke: () => { calls.push('revoke'); },
  });
  assert.deepEqual(calls, ['lease', 'close', 'persist', 'terminal', 'issue', 'finish:ticket', 'revoke']);
});

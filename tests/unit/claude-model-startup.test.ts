import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MODEL_BOOTSTRAP_SHA256 } from '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import { parseClaudeModelStartup } from '../../src/adapters/secondary-investigator/claude-model-startup.js';

const id = '11111111-1111-4111-8111-111111111111';
const descriptor = { attemptId: `attempt_${id}`, workspaceId: `ws_${id}`,
  distro: 'Ubuntu-22.04', linuxUser: 'fixture', uid: 1000, bootId: id,
  unitName: `rcac-investigator-${id}.service`, launchWorkerEpoch: 1,
  sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), commandDigest: 'c'.repeat(64) };
function fixture() {
  return { protocol: 'claude_model_startup_v1', kind: 'bootstrap_ready_candidate',
    journal: { protocol: 'claude_model_v1', action: 'claude_model_v1', phase: 'consumed', closed: false,
      attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId, bootId: id,
      uid: 1000, unitName: descriptor.unitName, launchWorkerEpoch: 1,
      sourceDigest: descriptor.sourceDigest, profileDigest: descriptor.profileDigest,
      commandDigest: descriptor.commandDigest, invocationId: 'd'.repeat(32),
      controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${descriptor.unitName}`,
      enterPid: 200, enterStartTicks: 500 },
    bootstrapSha256: CLAUDE_MODEL_BOOTSTRAP_SHA256,
    bwrapInfo: { 'child-pid': 202, 'cgroup-namespace': 1001, 'ipc-namespace': 1002,
      'mnt-namespace': 1003, 'pid-namespace': 1004, 'uts-namespace': 1005 },
    outerCandidate: { hostPid: 202, startTicks: 501, pidNamespace: 'pid:[1004]', nspid: [202, 1] },
    bootstrapReady: { protocol: 'claude_model_bootstrap_v1', kind: 'ready', pid: 2, ppid: 1,
      startTicks: 502, namespaces: { pid: 'pid:[1004]', mnt: 'mnt:[1003]', net: 'net:[1006]',
        user: 'user:[1007]', ipc: 'ipc:[1002]', uts: 'uts:[1005]', cgroup: 'cgroup:[1001]' },
      capEff: '0', noNewPrivs: 1 } };
}
const line = (value: unknown) => JSON.stringify(value) + '\n';

test('startup candidate binds exact original journal and independent outer identity', () => {
  const value = fixture();
  assert.deepEqual(parseClaudeModelStartup(line(value), descriptor), value);
  assert.equal(parseClaudeModelStartup(line(value), { ...descriptor, launchWorkerEpoch: 2 }), null);
});

test('startup rejects extra fields, historical/closed state and inconsistent namespace identities', () => {
  const mutations = [
    (v: ReturnType<typeof fixture>) => { v.journal.closed = true; },
    (v: ReturnType<typeof fixture>) => { v.journal.phase = 'released'; },
    (v: ReturnType<typeof fixture>) => { v.bootstrapSha256 = '0'.repeat(64); },
    (v: ReturnType<typeof fixture>) => { v.outerCandidate.hostPid++; },
    (v: ReturnType<typeof fixture>) => { v.outerCandidate.nspid = [202, 2]; },
    (v: ReturnType<typeof fixture>) => { v.bootstrapReady.namespaces.pid = 'pid:[9999]'; },
    (v: ReturnType<typeof fixture>) => { v.bootstrapReady.capEff = '1'; },
    (v: ReturnType<typeof fixture>) => { v.bootstrapReady.ppid = 9; },
    (v: ReturnType<typeof fixture>) => { Object.assign(v, { authorized: true }); },
    (v: ReturnType<typeof fixture>) => { Object.assign(v.bwrapInfo, { unknown: 1 }); },
    (v: ReturnType<typeof fixture>) => { Object.assign(v.bootstrapReady.namespaces, { time: 'time:[1]' }); },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.equal(parseClaudeModelStartup(line(value), descriptor), null);
  }
  assert.equal(parseClaudeModelStartup(line(fixture()).trim(), descriptor), null);
  assert.equal(parseClaudeModelStartup(line(fixture()) + 'model bytes', descriptor), null);
  assert.equal(parseClaudeModelStartup('x'.repeat(4097) + '\n', descriptor), null);
});

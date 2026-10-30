import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { observeSupervisorV2Terminal } from
  '../../src/adapters/secondary-investigator/supervisor-v2-terminal-observer.js';
import type { SupervisorV2RunningObservation } from
  '../../src/adapters/secondary-investigator/supervisor-v2-running-observer.js';
import type { NativeSupervisorGateState } from
  '../../src/adapters/secondary-investigator/claude-native-supervisor.js';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from
  '../../src/adapters/secondary-investigator/fixed-zero-model-profile.js';

const action = 'fixed_zero_model_v1';
const profileDigest = FIXED_ZERO_MODEL_PROFILE_DIGEST;
const sourceDigest = 'b'.repeat(64);
function fixture() {
  const attemptId = `attempt_${randomUUID()}`;
  const workspaceId = `ws_${randomUUID()}`;
  const unitName = `rcac-investigator-${randomUUID()}.service`;
  const bootId = randomUUID();
  const invocationId = randomUUID().replaceAll('-', '');
  const uid = 1000;
  const controlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unitName}`;
  const resource = { unitName, distro: 'Ubuntu', uid, bootId, invocationId, controlGroup,
    gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture', root: '/home/fixture/gates',
      payloadKind: 'native_supervisor_v2', launch: {
        workerEpoch: 0, sourceDigest, profileDigest, action } } } as WslResource;
  const journal = { protocol: 'native_supervisor_v2', phase: 'consumed', closed: true,
    attemptId, workspaceId, bootId, uid, unitName, launchWorkerEpoch: 0,
    sourceDigest, profileDigest, invocationId, controlGroup,
    enterPid: 123, enterStartTicks: 456 } as NativeSupervisorGateState;
  const native = { bootId, uid, unitName, invocationId, controlGroup: '',
    loadState: 'loaded', activeState: 'active', subState: 'exited', mainPid: 0,
    cgroupState: 'absent' };
  const runner = async () => ({ exitCode: 0, stdout: `${JSON.stringify(native)}\n`, stderr: '' });
  const fact = { kind: 'original_unit_running', resource, journal: {
    ...journal, phase: 'entered', closed: false }, native: { bootId, uid, unitName,
    invocationId, controlGroup, loadState: 'loaded', activeState: 'active',
    subState: 'running', mainPid: 123, startTicks: 456,
    procControlGroup: controlGroup } } as Extract<SupervisorV2RunningObservation,
      { kind: 'original_unit_running' }>;
  const unloaded = { bootId, uid, unitName, invocationId: '', controlGroup: '',
    loadState: 'not-found', activeState: 'inactive', subState: 'dead', mainPid: 0,
    originalPid: 123, originalStartTicks: 456, processState: 'absent',
    cgroupState: 'absent' };
  return { resource, journal, native, runner, fact, unloaded };
}

test('closed consumed fixed v2 journal and exact empty unit prove only zero-model terminal', async () => {
  const f = fixture();
  const result = await observeSupervisorV2Terminal(f.resource, f.journal, f.runner);
  assert.equal(result.kind, 'fixed_zero_model_terminal');
});

test('unconsumed, open, mismatched or live unit never produce terminal proof', async () => {
  const f = fixture();
  assert.equal((await observeSupervisorV2Terminal(f.resource,
    { ...f.journal, phase: 'released' }, f.runner)).kind, 'unconfirmed');
  assert.equal((await observeSupervisorV2Terminal(f.resource,
    { ...f.journal, closed: false }, f.runner)).kind, 'unconfirmed');
  assert.equal((await observeSupervisorV2Terminal(f.resource,
    { ...f.journal, sourceDigest: 'c'.repeat(64) }, f.runner)).kind, 'unconfirmed');
  const live = async () => ({ exitCode: 0,
    stdout: `${JSON.stringify({ ...f.native, activeState: 'active', subState: 'running',
      mainPid: 123, cgroupState: 'empty' })}\n`, stderr: '' });
  assert.equal((await observeSupervisorV2Terminal(f.resource, f.journal, live)).kind, 'unconfirmed');
});

test('unloaded exact unit requires durable running fact and separate original-process/cgroup probe', async () => {
  const f = fixture();
  const output = (value: object) => ({ exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });
  const unloaded = async () => output({ ...f.native, loadState: 'not-found',
    activeState: 'inactive', subState: 'dead', invocationId: '', cgroupState: 'absent' });
  assert.equal((await observeSupervisorV2Terminal(f.resource, f.journal, unloaded)).kind,
    'unconfirmed');
  let calls = 0;
  const result = await observeSupervisorV2Terminal(f.resource, f.journal, async spec => {
    calls++;
    if (calls === 1) return unloaded();
    assert.match(spec.args[11]!, /\/proc\//);
    assert.match(spec.args[11]!, /cgroup\.events/);
    assert.equal(spec.args.includes('/bin/sh'), false);
    return output(f.unloaded);
  }, f.fact);
  assert.equal(result.kind, 'fixed_zero_model_terminal');
  assert.equal(calls, 2);
});

test('unloaded fallback rejects mismatched fact and every uncertain native state', async () => {
  const f = fixture();
  const output = (value: object) => ({ exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });
  const first = output({ ...f.native, loadState: 'not-found', activeState: 'inactive',
    subState: 'dead', invocationId: '', cgroupState: 'absent' });
  const probe = async (value: object, fact: SupervisorV2RunningObservation = f.fact) => {
    let calls = 0;
    const result = await observeSupervisorV2Terminal(f.resource, f.journal,
      async () => ++calls === 1 ? first : output(value), fact);
    return { result, calls };
  };
  for (const fact of [
    { ...f.fact, kind: 'unconfirmed' as const },
    { ...f.fact, native: { ...f.fact.native, startTicks: 457 } },
    { ...f.fact, native: { ...f.fact.native, mainPid: 124 } },
    { ...f.fact, journal: { ...f.fact.journal, closed: true } },
    { ...f.fact, native: { ...f.fact.native, bootId: randomUUID() } },
    { ...f.fact, resource: { ...f.resource, gate: { ...f.resource.gate!, launch: {
      ...f.resource.gate!.launch!, action: 'model_turn_v1' as typeof action } } } },
  ]) assert.equal((await probe(f.unloaded, fact as SupervisorV2RunningObservation)).result.kind,
    'unconfirmed');
  for (const changed of [
    { ...f.unloaded, bootId: randomUUID() },
    { ...f.unloaded, processState: 'alive' },
    { ...f.unloaded, processState: 'reused' },
    { ...f.unloaded, processState: 'error' },
    { ...f.unloaded, cgroupState: 'populated' },
    { ...f.unloaded, cgroupState: 'error' },
    { ...f.unloaded, originalStartTicks: 457 },
    { ...f.unloaded, loadState: 'loaded' },
    { ...f.unloaded, invocationId: f.resource.invocationId },
  ]) assert.equal((await probe(changed)).result.kind, 'unconfirmed');
  assert.equal((await probe({ ...f.unloaded, cgroupState: 'empty' })).result.kind,
    'fixed_zero_model_terminal');
  assert.equal((await observeSupervisorV2Terminal(f.resource, f.journal,
    async () => ({ exitCode: 1, stdout: '', stderr: '' }), f.fact)).kind, 'unconfirmed');
});

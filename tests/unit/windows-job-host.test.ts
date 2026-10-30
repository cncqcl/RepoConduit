import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseWindowsJobObservation, WindowsJobCanarySession } from '../../src/adapters/codex/investigator/windows-job-host.js';

const binding = { scenario: 'tree' as const,
  hostScopeId: '11111111-1111-4111-8111-111111111111',
  executionInstanceId: '22222222-2222-4222-8222-222222222222' };
const root = { pid: 10, creationFiletime: '133900000000000001' };
const running = { protocol: 'windows_job_canary_observation_v1', helperVersion: '2',
  ...binding, sequence: 1, phase: 'running', root, createdSuspended: true,
  jobMemberBeforeResume: true, resumed: true, rootExited: false,
  members: { complete: true, assigned: 4, listed: 4, pids: [10, 11, 12, 13], fixturePids: [10, 11, 12] },
  stopRequested: false, stopCallSucceeded: false };
const closed = { ...running, sequence: 2, phase: 'closed', rootExited: true,
  members: { complete: true, assigned: 0, listed: 0, pids: [], fixturePids: [] },
  stopRequested: true, stopCallSucceeded: true };
const parse = (value: unknown, seq = 1, expectedRoot?: typeof root) =>
  parseWindowsJobObservation(JSON.stringify(value), binding, seq, expectedRoot);

test('full FILETIME and complete exact Job observation survive parsing', () => {
  assert.deepEqual(parse(running), running);
  assert.deepEqual(parse(closed, 2, root), closed);
  assert.equal(Object.isFrozen(parse(running)?.root), true);
  assert.equal(Object.isFrozen(parse(running)?.members.pids), true);
  assert.deepEqual(parse({ ...running, root: { ...root, creationFiletime: '18446744073709551615' } })?.root,
    { ...root, creationFiletime: '18446744073709551615' });
});

test('parent exit and stop ACK cannot substitute for complete Job emptiness', () => {
  assert.ok(parse({ ...running, sequence: 2, rootExited: true,
    members: { complete: true, assigned: 1, listed: 1, pids: [11], fixturePids: [11] } }, 2));
  for (const value of [
    { ...closed, members: running.members }, { ...closed, rootExited: false },
    { ...closed, stopCallSucceeded: false }, { ...closed, stopRequested: false },
    { ...closed, members: { complete: false, assigned: 0, listed: 0, pids: [] } },
    { ...running, phase: 'closed', stopRequested: true, stopCallSucceeded: true },
  ]) assert.equal(parse(value, value.sequence), null);
});

test('truncated, duplicate, invalid or scope-mismatched identity observations refuse', () => {
  for (const value of [
    { ...running, executable: 'cmd.exe' }, { ...running, root: { ...root, creationFiletime: 133900000000000000 } },
    { ...running, root: { ...root, creationFiletime: '18446744073709551616' } },
    { ...running, root: { ...root, creationFiletime: '0133900000000000001' } },
    { ...running, root: { ...root, pid: 0 } }, { ...running, root: { ...root, pid: 4294967296 } },
    { ...running, sequence: 0 }, { ...running, hostScopeId: binding.executionInstanceId },
    { ...running, executionInstanceId: binding.hostScopeId },
    { ...running, members: { complete: true, assigned: 3, listed: 2, pids: [10, 11] } },
    { ...running, members: { complete: true, assigned: 2, listed: 2, pids: [10, 10] } },
    { ...running, members: { complete: true, assigned: 1, listed: 1, pids: [11] } },
    { ...running, jobMemberBeforeResume: false },
  ]) assert.equal(parse(value), null);
  assert.equal(parseWindowsJobObservation('{', binding, 1), null);
  assert.equal(parse(running, 2), null);
  assert.equal(parse(running, 1, { ...root, creationFiletime: '133900000000000002' }), null);
  assert.equal(parse(running, 1, { ...root, pid: 11 }), null);
});

test('system companions do not count as fixture generations', () => {
  assert.ok(parse(running));
  assert.equal(parse({ ...running, members: { ...running.members, fixturePids: [10, 11] } }), null);
  assert.equal(parse({ ...running, members: { ...running.members, fixturePids: [10, 11, 99] } }), null);
  assert.equal(parse({ ...running, members: { ...running.members, fixturePids: [10, 11, 11] } }), null);
  assert.equal(parse({ ...running, rootExited: false, members: { ...running.members, fixturePids: [11, 12, 13] } }), null);
  assert.equal(parse({ ...closed, members: { ...closed.members, fixturePids: [10] } }, 2), null);
});

function channel() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill() { queueMicrotask(() => child.emit('close', null)); return true; } });
  const writes: string[] = [];
  child.stdin.on('data', (data: Buffer) => writes.push(data.toString('utf8')));
  const emit = (v: unknown) => child.stdout.write(JSON.stringify(v) + '\n');
  return { child, writes, emit };
}

test('stop in flight excludes later commands until helper close', async () => {
  const c = channel();
  const opening = WindowsJobCanarySession.attachHelperChannel(c.child, binding);
  c.emit(running);
  const session = await opening;
  const stopping = session.stop();
  c.emit(closed);
  const later = Promise.allSettled([session.observe(), session.stop()]);
  c.child.emit('close', 0);
  assert.deepEqual(await stopping, closed);
  let timer: NodeJS.Timeout | undefined;
  const results = await Promise.race([later, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); })]);
  if (timer) clearTimeout(timer);
  assert.ok(results, 'later commands must not remain pending after normal helper close');
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.deepEqual(c.writes, ['stop\n']);
  await assert.rejects(session.observe(), /WINDOWS_JOB_UNKNOWN/);
});

test('valid initial followed by garbage or abort cannot return a successful session', async () => {
  for (const action of ['garbage', 'abort']) {
    const c = channel();
    const controller = new AbortController();
    const opening = WindowsJobCanarySession.attachHelperChannel(c.child, binding, { signal: controller.signal });
    if (action === 'garbage') c.child.stdout.write(JSON.stringify(running) + '\n{}\n');
    else { c.emit(running); controller.abort(); }
    await assert.rejects(opening, /WINDOWS_JOB_UNKNOWN/);
    assert.deepEqual(c.writes, []);
  }
});

test('helper close while a request is pending rejects it even after prior observations', async () => {
  const c = channel();
  const opening = WindowsJobCanarySession.attachHelperChannel(c.child, binding);
  c.emit(running);
  const session = await opening;
  const observing = session.observe();
  c.child.emit('close', 0);
  await assert.rejects(observing, /WINDOWS_JOB_UNKNOWN/);
  await assert.rejects(session.stop(), /WINDOWS_JOB_UNKNOWN/);
  await session.abort();
  assert.deepEqual(c.writes, ['observe\n']);
});

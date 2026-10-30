import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexJsonlTransport } from '../../src/adapters/codex/protocol/stdio.js';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import { interruptJournaledRestrictedTurn, startJournaledRestrictedThread,
  startJournaledRestrictedTurn, observeJournaledRestrictedTurnTerminal } from '../../src/runtime/codex-investigation-lifecycle.js';

const claim: InvestigationClaim = { requestId: 'request', attemptId: 'attempt', workerId: 'worker',
  workerEpoch: 1, workspaceId: 'workspace', nativeRef: null, phase: 'start_intent' };
const cwd = '/home/fixture/fixture';
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function pair() {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const exited = new EventEmitter();
  const writes: { id: number; method: string }[] = [];
  input.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const parsed = JSON.parse(line) as { id: number; method: string };
      if (parsed.id) writes.push(parsed);
    }
  });
  const transport = new CodexJsonlTransport({ input, output, errors, exited, terminate() {} },
    { maxFrameBytes: 4096, maxTotalBytes: 32768, maxNotifications: 10, requestTimeoutMs: 200 });
  return { transport, output, writes };
}

function threadResponse(profileId = 'investigator') {
  return { thread: { id: threadId, cwd }, cwd, model: 'gpt-6-sol', modelProvider: 'openai',
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' },
    runtimeWorkspaceRoots: [cwd], activePermissionProfile: { id: profileId } };
}

test('native thread response is journaled even when its permission profile is rejected', async () => {
  const p = pair();
  const events: string[] = [];
  const store = {
    beginNativeThreadIntent() { events.push('thread.intent'); },
    observeNativeThread(_claim: InvestigationClaim, _collaboration: string, id: string) {
      assert.equal(id, threadId); events.push('thread.observed');
    },
    beginNativeTurnIntent() { events.push('turn.intent'); },
    observeNativeTurn() { events.push('turn.observed'); },
    assertNativeTurnBinding() { events.push('interrupt.preflight'); },
    acknowledgeNativeTurnInterrupt() { events.push('interrupt.ack'); },
    observeNativeTurnTerminal() { events.push('turn.terminal'); },
  };
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const pending = startJournaledRestrictedThread(store, claim, 'collaboration', p.transport,
    { cwd, profileId: 'investigator', model: 'gpt-6-sol' });
  assert.deepEqual(events, ['thread.intent']);
  assert.equal(p.writes.at(-1)?.method, 'thread/start');
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: threadResponse('danger-full-access') })}\n`);
  await assert.rejects(pending, /PROTOCOL_REJECTED/);
  assert.deepEqual(events, ['thread.intent', 'thread.observed']);
});

test('turn intent precedes native start; interrupt ack never adds terminal evidence', async () => {
  const p = pair();
  const events: string[] = [];
  const store = {
    beginNativeThreadIntent() { events.push('thread.intent'); },
    observeNativeThread() { events.push('thread.observed'); },
    beginNativeTurnIntent() { events.push('turn.intent'); },
    observeNativeTurn(_claim: InvestigationClaim, _collaboration: string, _intent: string, id: string) {
      assert.equal(id, turnId); events.push('turn.observed');
    },
    assertNativeTurnBinding() { events.push('interrupt.preflight'); },
    acknowledgeNativeTurnInterrupt() { events.push('interrupt.ack'); },
    observeNativeTurnTerminal() { events.push('turn.terminal'); },
  };
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const thread = startJournaledRestrictedThread(store, claim, 'collaboration', p.transport,
    { cwd, profileId: 'investigator', model: 'gpt-6-sol' });
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: threadResponse() })}\n`);
  assert.equal(await thread, threadId);
  const turn = startJournaledRestrictedTurn(store, claim, 'collaboration', 'intent-1', p.transport,
    { threadId, profileId: 'investigator', text: 'Inspect fixture.' });
  assert.deepEqual(events, ['thread.intent', 'thread.observed', 'turn.intent']);
  assert.equal(p.writes.at(-1)?.method, 'turn/start');
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id,
    result: { turn: { id: turnId, status: 'inProgress', items: [] } } })}\n`);
  assert.equal(await turn, turnId);
  const interrupt = interruptJournaledRestrictedTurn(store, claim, 'collaboration', 'intent-1',
    p.transport, threadId, turnId);
  assert.equal(p.writes.at(-1)?.method, 'turn/interrupt');
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: {} })}\n`);
  await interrupt;
  assert.deepEqual(events, ['thread.intent', 'thread.observed', 'turn.intent', 'turn.observed',
    'interrupt.preflight', 'interrupt.ack']);
  assert.equal(observeJournaledRestrictedTurnTerminal(store, claim, 'collaboration', 'intent-1',
    p.transport, threadId, turnId), false);
  p.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId,
    turn: { id: turnId, status: 'interrupted', items: [] } } })}\n`);
  assert.equal(observeJournaledRestrictedTurnTerminal(store, claim, 'collaboration', 'intent-1',
    p.transport, threadId, turnId), true);
  assert.equal(events.at(-1), 'turn.terminal');
  p.transport.close();
});

test('wrong native thread or turn binding is refused before any side effect', async () => {
  const p = pair();
  const init = p.transport.initialize();
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: { userAgent: 'Codex' } })}\n`);
  await init;
  const start = p.transport.startRestrictedThread({ cwd, profileId: 'investigator', model: 'gpt-6-sol' });
  p.output.write(`${JSON.stringify({ id: p.writes.at(-1)!.id, result: threadResponse() })}\n`);
  await start;
  const store = {
    beginNativeThreadIntent() {}, observeNativeThread() {},
    beginNativeTurnIntent(_claim: InvestigationClaim, _collaboration: string,
      _intent: string, candidateThreadId: string) {
      if (candidateThreadId !== 'journal-thread') throw new Error('STORE_CONFLICT');
    },
    observeNativeTurn() {},
    assertNativeTurnBinding() { throw new Error('STORE_CONFLICT'); },
    acknowledgeNativeTurnInterrupt() { throw new Error('unexpected'); },
    observeNativeTurnTerminal() { throw new Error('unexpected'); },
  };
  const prior = p.writes.length;
  await assert.rejects(startJournaledRestrictedTurn(store, claim, 'collaboration', 'intent-1',
    p.transport, { threadId, profileId: 'investigator', text: 'Private A question.' }), /STORE_CONFLICT/);
  assert.equal(p.writes.length, prior);
  await assert.rejects(interruptJournaledRestrictedTurn(store, claim, 'collaboration', 'intent-1',
    p.transport, threadId, turnId), /STORE_CONFLICT/);
  assert.equal(p.writes.length, prior);
  p.transport.close();
});

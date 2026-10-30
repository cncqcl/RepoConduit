import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SessionControlSqlite, type SyncCommitInput } from '../../src/adapters/storage/session-control-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import type { Permit } from '../../src/core/policy/authorize.js';

const initial: SessionState = { bindingId: 'binding', workspaceId: 'workspace', collaborationId: 'issue',
  providerId: 'provider', accountId: 'account', nativeSessionId: 'thread', cursor: 'cursor-1',
  control: 'host_controlled', epoch: 0, revision: 0 };
const sendScope = { principal: 'owner', audience: 'host', workspaceId: 'workspace',
  operation: 'conversation.send', idempotencyKey: 'send-key' };
const resumeScope = { ...sendScope, operation: 'conversation.resume', idempotencyKey: 'resume-key' };
const sendPermit: Permit = { grantId: 'send-grant', principal: 'owner', recipient: 'owner',
  operation: 'conversation.send', effect: 'external_send', scope: { workspaceId: 'workspace', collaborationId: 'issue' } };
const resumePermit: Permit = { ...sendPermit, grantId: 'resume-grant', operation: 'conversation.resume', effect: 'state_write' };

function fixture(outcome: 'unknown' | 'submitted' | 'sending' = 'unknown') {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-unknown-history-'));
  const file = join(dir, 'case.sqlite');
  const base = new SqliteStore(file);
  base.insertWorkspace({ id: 'workspace', name: 'test', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'issue', workspaceId: 'workspace', openedBy: 'owner',
    purpose: 'test', hostThreadId: null, state: 'open' });
  for (const id of ['send-grant', 'resume-grant']) base.insertGrant({ id, principal: 'owner', audience: 'host',
    workspaceId: 'workspace', collaborationId: 'issue', recipient: 'owner', permissions: ['conversation.control'],
    expiresAt: null, revokedAt: null });
  const store = new SessionControlSqlite(file);
  store.create(initial);
  store.claimCommand({ commandId: 'send-1', scope: sendScope, payload: { text: 'original question' },
    permit: sendPermit, bindingId: 'binding', expectedRevision: 0, expectedEpoch: 0 });
  store.markSending('send-1', sendPermit, 0, 0);
  if (outcome !== 'sending') store.finishSend('send-1', 1, 0, outcome);
  const state = store.get('binding')!;
  const messages = [
    { nativeMessageId: 'user-2', version: 'v1', text: 'original question' },
    { nativeMessageId: 'reply-3', version: 'v1', text: 'answer' },
  ];
  const nextState: SessionState = { ...state, control: 'host_controlled', cursor: 'cursor-3',
    revision: state.revision + 1, epoch: state.epoch + 1, sendIntent: undefined };
  const cleanNext = { ...nextState } as { -readonly [K in keyof SessionState]: SessionState[K] };
  delete cleanNext.sendIntent;
  const disposition = { kind: 'accepted_observed_history' as const, sendIntent: state.sendIntent,
    fromCursor: state.cursor, nextCursor: cleanNext.cursor,
    nativeMessageIds: messages.map((message) => message.nativeMessageId) };
  const input: SyncCommitInput = { commandId: 'resume-1', scope: resumeScope,
    payload: { bindingId: 'binding', expectedEpoch: state.epoch, acceptUnknownSendIntentId: 'send-1' },
    permit: resumePermit, bindingId: 'binding', expectedRevision: state.revision, expectedEpoch: state.epoch,
    nextState: cleanNext, messages, acceptedUnknownSendIntentId: 'send-1',
    receipt: { commandId: 'resume-1', bindingId: 'binding', state: cleanNext, messages,
      complete: true, unknownSendDisposition: disposition } };
  const inspect = new DatabaseSync(file);
  function oldRow() { return { ...(inspect.prepare(`SELECT status,outcome,send_text,payload_hash,result_json
    FROM conversation_commands WHERE command_id='send-1'`).get() as Record<string, unknown>) }; }
  function close() { inspect.close(); store.close(); base.close(); rmSync(dir, { recursive: true, force: true }); }
  return { base, store, file, input, state, messages, oldRow, close };
}

test('explicit resume accepts observed history atomically, preserving unknown receipt and idempotent replay', () => {
  const f = fixture();
  try {
    const before = f.oldRow();
    assert.deepEqual(f.store.commitSync(f.input), f.input.receipt);
    assert.equal(f.store.getCommand('send-1')?.status, 'completed');
    assert.deepEqual(f.oldRow(), { ...before, status: 'completed' });
    assert.deepEqual(f.store.listMessages('binding'), f.messages);
    assert.equal(f.store.get('binding')?.control, 'host_controlled');
    assert.equal(f.store.get('binding')?.sendIntent, undefined);
    assert.deepEqual(f.store.commitSync(f.input), f.input.receipt);
    assert.deepEqual(f.oldRow(), { ...before, status: 'completed' });
    assert.equal(f.store.listMessages('binding').length, 2);
  } finally { f.close(); }
});

test('unknown history resume requires explicit matching input, payload, and canonical receipt', () => {
  const f = fixture();
  try {
    const omittedAccepted = { ...f.input };
    delete omittedAccepted.acceptedUnknownSendIntentId;
    const cases: SyncCommitInput[] = [
      omittedAccepted,
      { ...f.input, payload: { bindingId: 'binding', expectedEpoch: 0 } },
      { ...omittedAccepted, payload: { bindingId: 'binding', expectedEpoch: 0,
        acceptUnknownSendIntentId: undefined } },
      { ...f.input, acceptedUnknownSendIntentId: 'wrong' },
      { ...f.input, payload: { ...(f.input.payload as object), acceptUnknownSendIntentId: 'wrong' } },
      { ...f.input, scope: { ...resumeScope, operation: 'conversation.sync' } },
      { ...omittedAccepted, payload: { bindingId: 'binding', expectedEpoch: 0 },
        receipt: f.input.receipt },
      { ...f.input, completesCommandId: 'send-1', completedSend: {
        sendIntentId: 'send-1', nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' } },
      { ...f.input, receipt: { ...(f.input.receipt as object), unknownSendDisposition: {
        kind: 'accepted_observed_history', sendIntent: f.state.sendIntent,
        fromCursor: 'forged', nextCursor: 'cursor-3', nativeMessageIds: ['user-2', 'reply-3'] } } },
      { ...f.input, receipt: { ...(f.input.receipt as object), unknownSendDisposition: {
        kind: 'accepted_observed_history', sendIntent: { ...f.state.sendIntent, text: 'forged' },
        fromCursor: 'cursor-1', nextCursor: 'cursor-3', nativeMessageIds: ['user-2', 'reply-3'] } } },
    ];
    const before = f.oldRow();
    for (const input of cases) {
      assert.throws(() => f.store.commitSync(input));
      assert.deepEqual(f.oldRow(), before);
      assert.deepEqual(f.store.listMessages('binding'), []);
      assert.deepEqual(f.store.get('binding'), f.state);
    }
  } finally { f.close(); }
});

test('unknown history resume rejects weak history, stale state, and submitted send', () => {
  const f = fixture();
  try {
    const bad: SyncCommitInput[] = [
      { ...f.input, messages: [] },
      { ...f.input, messages: [f.messages[0]!] },
      { ...f.input, messages: [f.messages[0]!, { ...f.messages[1]!, nativeMessageId: 'user-2' }] },
      { ...f.input, messages: [f.messages[0]!, { ...f.messages[1]!, version: '' }] },
      { ...f.input, nextState: { ...f.input.nextState, cursor: f.state.cursor } },
      { ...f.input, nextState: { ...f.input.nextState, epoch: f.state.epoch } },
      { ...f.input, nextState: { ...f.input.nextState, sendIntent: f.state.sendIntent } },
      { ...f.input, nextState: { ...f.input.nextState, pendingSyncReceipt: {
        receiptId: 'fake', fromEpoch: 0, fromCursor: 'cursor-1', nextCursor: 'cursor-3', messages: f.messages } } },
    ];
    for (const input of bad) assert.throws(() => f.store.commitSync(input));
    assert.equal(f.store.getCommand('send-1')?.status, 'reconcile_required');
    assert.deepEqual(f.store.listMessages('binding'), []);
  } finally { f.close(); }
  const g = fixture('submitted');
  try { assert.throws(() => g.store.commitSync(g.input)); }
  finally { g.close(); }
  const h = fixture('sending');
  try { assert.throws(() => h.store.commitSync(h.input)); }
  finally { h.close(); }
});

test('unknown history resume rejects revoked grant and rolls back old send on message conflict', () => {
  const f = fixture();
  try {
    const prior = f.oldRow();
    f.base.revokeGrant('resume-grant', new Date().toISOString());
    assert.throws(() => f.store.commitSync(f.input), /NOT_AVAILABLE/);
    assert.deepEqual(f.oldRow(), prior);
  } finally { f.close(); }
  const g = fixture();
  try {
    const prior = g.oldRow();
    // A previously observed version with different bytes forces the whole transaction to roll back.
    const raw = new DatabaseSync(g.file);
    try { raw.prepare(`INSERT INTO conversation_messages
      (binding_id,native_message_id,version,text) VALUES (?,?,?,?)`)
      .run('binding', 'user-2', 'v1', 'conflicting previous text'); }
    finally { raw.close(); }
    assert.throws(() => g.store.commitSync(g.input), /CONFLICT/);
    assert.deepEqual(g.oldRow(), prior);
    assert.equal(g.store.get('binding')?.cursor, 'cursor-1');
    assert.deepEqual(g.store.listMessages('binding'), [
      { nativeMessageId: 'user-2', version: 'v1', text: 'conflicting previous text' },
    ]);
  } finally { g.close(); }
});

test('unknown history resume rejects an existing pending sync receipt', () => {
  const f = fixture();
  try {
    const prior = f.oldRow();
    const pending = { receiptId: 'pending', fromEpoch: 0, fromCursor: 'cursor-1',
      nextCursor: 'cursor-2', messages: f.messages };
    const raw = new DatabaseSync(f.file);
    try { raw.prepare(`UPDATE session_control SET state_json=? WHERE binding_id='binding'`)
      .run(JSON.stringify({ ...f.state, pendingSyncReceipt: pending })); }
    finally { raw.close(); }
    assert.throws(() => f.store.commitSync(f.input), /CONFLICT/);
    assert.deepEqual(f.oldRow(), prior);
    assert.deepEqual(f.store.listMessages('binding'), []);
  } finally { f.close(); }
});

for (const [name, change] of [
  ['command id', { commandId: 'forged' }],
  ['binding id', { bindingId: 'other' }],
  ['next state', { state: { ...initial, cursor: 'forged' } }],
  ['observed messages', { messages: [{ nativeMessageId: 'forged', version: 'v1', text: 'forged' }] }],
  ['complete flag', { complete: false }],
  ['extra completed send', { completedSend: { sendIntentId: 'send-1',
    nativeUserMessageId: 'user-2', nativeReplyMessageId: 'reply-3' } }],
  ['extra field', { extra: 'forged' }],
] as const) {
  test(`unknown history resume rejects receipt mismatch: ${name}`, () => {
    const f = fixture();
    try {
      const prior = f.oldRow();
      assert.throws(() => f.store.commitSync({ ...f.input,
        receipt: { ...(f.input.receipt as object), ...change } }), /CONFLICT/);
      assert.deepEqual(f.oldRow(), prior);
      assert.deepEqual(f.store.listMessages('binding'), []);
      assert.deepEqual(f.store.get('binding'), f.state);
    } finally { f.close(); }
  });
}

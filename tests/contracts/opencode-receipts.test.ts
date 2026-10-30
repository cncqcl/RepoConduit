import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { collectOpenCodeInvestigationTranscript, collectOpenCodeTurn } from '../../src/adapters/secondary-investigator/opencode-receipts.js';

const sessionId = 'ses_probe_1';
const userMessageId = 'msg_user_1';
const assistantMessageId = 'msg_assistant_1';

function response(parts: unknown[]) {
  return { info: { id: assistantMessageId, sessionID: sessionId, role: 'assistant',
    parentID: userMessageId, providerID: 'openai', modelID: 'observed-model',
    finish: 'stop', time: { created: 100, completed: 300 }, cost: 0, tokens: { input: 1, output: 1,
      reasoning: 0, cache: { read: 0, write: 0 } } }, parts };
}

function completedTool(overrides: Record<string, unknown> = {}) {
  return { id: 'part_tool_1', sessionID: sessionId, messageID: assistantMessageId,
    type: 'tool', callID: 'call_1', tool: 'read', state: { status: 'completed',
      input: { filePath: 'source/entry.ts' }, output: 'export const value = 1;',
      title: 'Read source/entry.ts', metadata: {}, time: { start: 120, end: 140 } }, ...overrides };
}

test('OpenCode SDK response yields adapter-owned tool hashes and observed model identity', () => {
  const result = collectOpenCodeTurn(response([completedTool(), { id: 'part_text_1', sessionID: sessionId,
    messageID: assistantMessageId, type: 'text', text: 'Finding with source evidence.' }]),
  { sessionId, userMessageId, allowedTools: ['read'] });
  assert.equal(result.nativeMessageId, assistantMessageId);
  assert.deepEqual(result.observedModel, { providerId: 'openai', modelId: 'observed-model' });
  assert.equal(result.text, 'Finding with source evidence.');
  assert.equal(result.toolReceipts.length, 1);
  assert.equal(result.toolReceipts[0]?.callId, 'call_1');
  assert.match(result.toolReceipts[0]?.inputSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.match(result.toolReceipts[0]?.outputSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(result).includes('export const value'));
});

test('OpenCode SDK response rejects wrong ancestry, incomplete tools and write-capable parts', () => {
  const expected = { sessionId, userMessageId, allowedTools: ['read'] };
  for (const bad of [
    { ...response([completedTool()]), info: { ...response([]).info, parentID: 'other' } },
    response([completedTool({ sessionID: 'other' })]),
    response([completedTool({ state: { status: 'running', input: {}, time: { start: 1 } } })]),
    response([completedTool({ tool: 'bash' })]),
    response([completedTool({ state: { status: 'error', input: {}, error: 'failed', time: { start: 1, end: 2 } } })]),
    response([{ id: 'part_patch', sessionID: sessionId, messageID: assistantMessageId, type: 'patch', hash: 'x', files: [] }]),
    response([{ id: 'part_subtask', sessionID: sessionId, messageID: assistantMessageId, type: 'subtask', prompt: 'x' }]),
  ]) assert.throws(() => collectOpenCodeTurn(bad, expected), /OPENCODE_RECEIPT_UNVERIFIED/);
});

test('OpenCode SDK response rejects duplicated tool calls, missing completion and untrusted text flags', () => {
  const expected = { sessionId, userMessageId, allowedTools: ['read'] };
  for (const bad of [
    response([completedTool(), completedTool({ id: 'other_part' })]),
    response([completedTool({ state: { ...completedTool().state as object,
      time: { start: 200, end: 100 } } })]),
    response([{ id: 'part_text', sessionID: sessionId, messageID: assistantMessageId,
      type: 'text', text: 'fake', synthetic: true }]),
    { ...response([completedTool()]), info: { ...response([]).info, time: { created: 100 } } },
  ]) assert.throws(() => collectOpenCodeTurn(bad, expected), /OPENCODE_RECEIPT_UNVERIFIED/);
});

test('OpenCode SDK receipt budget is aggregate across all tool output and text parts', () => {
  const expected = { sessionId, userMessageId, allowedTools: ['read'] };
  const largeOutput = 'x'.repeat(600 * 1024);
  const second = completedTool({ id: 'part_tool_2', callID: 'call_2',
    state: { ...completedTool().state, output: largeOutput } });
  const first = completedTool({ state: { ...completedTool().state, output: largeOutput } });
  assert.throws(() => collectOpenCodeTurn(response([first, second]), expected), /OPENCODE_RECEIPT_UNVERIFIED/);
  assert.throws(() => collectOpenCodeTurn(response([completedTool(), {
    id: 'part_text_1', sessionID: sessionId, messageID: assistantMessageId, type: 'text',
    text: 'y'.repeat(1024 * 1024),
  }]), expected), /OPENCODE_RECEIPT_UNVERIFIED/);
  assert.throws(() => collectOpenCodeTurn(response([completedTool({
    metadata: { ignored: 'z'.repeat(2 * 1024 * 1024) },
  })]), expected), /OPENCODE_RECEIPT_UNVERIFIED/);
});

function userMessage(id = userMessageId) {
  return { info: { id, sessionID: sessionId, role: 'user', time: { created: 90 } },
    parts: [{ id: `part_${id}`, sessionID: sessionId, messageID: id, type: 'text',
      text: 'Investigate source/entry.ts' }] };
}
const userTextSha256 = createHash('sha256').update('Investigate source/entry.ts').digest('hex');

function assistantMessage(id: string, parentID: string, created: number, parts: unknown[], finish = 'stop') {
  return { info: { ...response([]).info, id, parentID, finish,
    time: { created, completed: created + 10 } },
    parts: parts.map(part => ({ ...(part as object), messageID: id })) };
}

test('OpenCode transcript collects tools from every assistant message in one native request chain', () => {
  const first = assistantMessage('msg_assistant_a', userMessageId, 100,
    [completedTool({ callID: 'call_a', id: 'part_a' })], 'tool-calls');
  const last = assistantMessage('msg_assistant_b', userMessageId, 200,
    [completedTool({ callID: 'call_b', id: 'part_b' }),
      { id: 'part_text', sessionID: sessionId, type: 'text', text: 'Final answer.' }]);
  const observed = collectOpenCodeInvestigationTranscript([userMessage('earlier'),
    assistantMessage('earlier_answer', 'earlier', 91, []), userMessage(), first, last],
  { sessionId, userMessageId, userTextSha256,
    terminalAssistantMessageId: 'msg_assistant_b', allowedTools: ['read'] });
  assert.deepEqual(observed.nativeMessageIds, ['msg_assistant_a', 'msg_assistant_b']);
  assert.deepEqual(observed.toolReceipts.map(item => item.callId), ['call_a', 'call_b']);
  assert.equal(observed.text, 'Final answer.');
});

test('OpenCode transcript refuses incomplete ancestry, a later user, duplicate calls and no tool receipt', () => {
  const first = assistantMessage('msg_assistant_a', userMessageId, 100,
    [completedTool({ callID: 'call_a', id: 'part_a' })], 'tool-calls');
  const last = assistantMessage('msg_assistant_b', userMessageId, 200,
    [completedTool({ callID: 'call_b', id: 'part_b' }),
      { id: 'part_text', sessionID: sessionId, type: 'text', text: 'Final answer.' }]);
  const expected = { sessionId, userMessageId, userTextSha256,
    terminalAssistantMessageId: 'msg_assistant_b', allowedTools: ['read'] };
  for (const bad of [
    [userMessage(), first, { ...last, info: { ...last.info, parentID: 'outside' } }],
    [userMessage(), first, userMessage('new-user'), last],
    [userMessage(), first, assistantMessage('msg_assistant_b', userMessageId, 200,
      [completedTool({ callID: 'call_a', id: 'part_b' })])],
    [userMessage(), assistantMessage('only_text', userMessageId, 100,
      [{ id: 'text', sessionID: sessionId, type: 'text', text: 'Claimed tool run' }])],
    [userMessage(), { ...first, info: { ...first.info, time: { created: 100 } } }],
    [userMessage(), first],
    [{ ...userMessage(), parts: [{ ...userMessage().parts[0], text: 'Different input' }] }, first, last],
    [userMessage(), first, { ...last, info: { ...last.info, finish: 'tool-calls' } }],
    [userMessage(), { ...first, info: { ...first.info, finish: 'stop' } }, last],
    [userMessage(), { ...first, info: { ...first.info, finish: 'length' } }, last],
    [userMessage(), first, { ...last, info: { ...last.info, parentID: 'msg_assistant_a' } }],
  ]) assert.throws(() => collectOpenCodeInvestigationTranscript(bad, expected), /OPENCODE_RECEIPT_UNVERIFIED/);
});

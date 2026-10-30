import { createHash } from 'node:crypto';

/** The v1.18.9 `session.prompt` response shape is checked at the adapter boundary. */
export interface OpenCodeToolReceipt {
  partId: string;
  nativeMessageId: string;
  callId: string;
  tool: string;
  inputSha256: string;
  outputSha256: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface OpenCodeTurnObservation {
  nativeSessionId: string;
  nativeMessageId: string;
  observedModel: { providerId: string; modelId: string };
  text: string;
  toolReceipts: OpenCodeToolReceipt[];
}

export interface OpenCodeTranscriptObservation {
  nativeSessionId: string;
  nativeMessageIds: string[];
  observedModel: { providerId: string; modelId: string };
  text: string;
  toolReceipts: OpenCodeToolReceipt[];
}

type RecordValue = Record<string, unknown>;
function invalid(): never { throw new Error('OPENCODE_RECEIPT_UNVERIFIED'); }
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as RecordValue;
}
function name(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > max || value.includes('\0')) invalid();
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/**
 * Parse only an SDK-owned assistant response. Model prose never becomes a tool receipt.
 * This function does not attest process isolation, source scope, or account identity.
 */
export function collectOpenCodeTurn(response: unknown, expected: {
  sessionId: string; userMessageId: string; allowedTools: readonly string[];
}): OpenCodeTurnObservation {
  let serializedResponse: string | undefined;
  try { serializedResponse = JSON.stringify(response); } catch { invalid(); }
  if (!serializedResponse || Buffer.byteLength(serializedResponse, 'utf8') > 2 * 1024 * 1024) invalid();
  const sessionId = name(expected.sessionId);
  const userMessageId = name(expected.userMessageId);
  const allowed = new Set(expected.allowedTools);
  if (!allowed.size || [...allowed].some(tool => !['read', 'grep', 'glob'].includes(tool))) invalid();
  const envelope = object(response);
  const info = object(envelope.info);
  if (info.role !== 'assistant' || info.sessionID !== sessionId ||
    info.parentID !== userMessageId || info.error !== undefined) invalid();
  const nativeMessageId = name(info.id);
  const observedModel = { providerId: name(info.providerID), modelId: name(info.modelID) };
  const infoTime = object(info.time);
  if (timestamp(infoTime.completed) < timestamp(infoTime.created)) invalid();
  if (!Array.isArray(envelope.parts) || envelope.parts.length > 512) invalid();
  const seenParts = new Set<string>();
  const seenCalls = new Set<string>();
  const textParts: string[] = [];
  const toolReceipts: OpenCodeToolReceipt[] = [];
  let aggregateBytes = 0;
  const account = (bytes: number) => {
    aggregateBytes += bytes;
    if (aggregateBytes > 1024 * 1024) invalid();
  };
  for (const raw of envelope.parts) {
    const part = object(raw);
    const partId = name(part.id);
    if (seenParts.has(partId) || part.sessionID !== sessionId || part.messageID !== nativeMessageId) invalid();
    seenParts.add(partId);
    if (part.type === 'text') {
      if (part.synthetic === true || part.ignored === true || typeof part.text !== 'string' ||
        Buffer.byteLength(part.text, 'utf8') > 1024 * 1024) invalid();
      account(Buffer.byteLength(part.text, 'utf8'));
      textParts.push(part.text);
      continue;
    }
    if (part.type === 'step-start' || part.type === 'step-finish' || part.type === 'reasoning') continue;
    if (part.type !== 'tool') invalid();
    const callId = name(part.callID);
    const tool = name(part.tool, 64);
    if (!allowed.has(tool) || seenCalls.has(callId)) invalid();
    seenCalls.add(callId);
    const state = object(part.state);
    if (state.status !== 'completed' || state.attachments !== undefined ||
      typeof state.output !== 'string' || Buffer.byteLength(state.output, 'utf8') > 1024 * 1024) invalid();
    const input = object(state.input);
    let serialized: string | undefined;
    try { serialized = JSON.stringify(input); } catch { invalid(); }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > 16 * 1024) invalid();
    account(Buffer.byteLength(serialized, 'utf8') + Buffer.byteLength(state.output, 'utf8'));
    const time = object(state.time);
    const startedAtMs = timestamp(time.start);
    const endedAtMs = timestamp(time.end);
    if (endedAtMs < startedAtMs) invalid();
    toolReceipts.push({ partId, nativeMessageId, callId, tool,
      inputSha256: digest(serialized), outputSha256: digest(state.output), startedAtMs, endedAtMs });
  }
  const text = textParts.join('');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) invalid();
  return { nativeSessionId: sessionId, nativeMessageId, observedModel, text, toolReceipts };
}

/**
 * The SDK `session.messages` response is authoritative for the complete request chain.
 * Its caller must fetch after native completion and verify the trusted SDK connection.
 */
export function collectOpenCodeInvestigationTranscript(messages: unknown, expected: {
  sessionId: string; userMessageId: string; userTextSha256: string;
  terminalAssistantMessageId: string; allowedTools: readonly string[];
}): OpenCodeTranscriptObservation {
  if (!Array.isArray(messages) || messages.length > 512) invalid();
  const sessionId = name(expected.sessionId);
  const userMessageId = name(expected.userMessageId);
  const terminalId = name(expected.terminalAssistantMessageId);
  if (!/^[0-9a-f]{64}$/.test(expected.userTextSha256) || terminalId === userMessageId) invalid();
  const starts = messages.flatMap((entry, index) => {
    const envelope = object(entry);
    const info = object(envelope.info);
    return info.id === userMessageId ? [index] : [];
  });
  if (starts.length !== 1) invalid();
  const first = object(messages[starts[0]!]);
  const user = object(first.info);
  if (user.role !== 'user' || user.sessionID !== sessionId) invalid();
  if (!Array.isArray(first.parts) || first.parts.length !== 1) invalid();
  const promptPart = object(first.parts[0]);
  if (promptPart.type !== 'text' || promptPart.sessionID !== sessionId ||
    promptPart.messageID !== userMessageId || promptPart.synthetic === true ||
    promptPart.ignored === true || typeof promptPart.text !== 'string' ||
    Buffer.byteLength(promptPart.text, 'utf8') > 64 * 1024 ||
    digest(promptPart.text) !== expected.userTextSha256) invalid();
  let lastId = userMessageId;
  let lastCreated = timestamp(object(user.time).created);
  let lastFinish: unknown;
  let observedModel: OpenCodeTurnObservation['observedModel'] | undefined;
  const nativeMessageIds: string[] = [];
  const toolReceipts: OpenCodeToolReceipt[] = [];
  const seenParts = new Set<string>();
  const seenCalls = new Set<string>();
  let text = '';
  let bytes = 0;
  for (const entry of messages.slice(starts[0]! + 1)) {
    const envelope = object(entry);
    const info = object(envelope.info);
    const created = timestamp(object(info.time).created);
    if (info.role !== 'assistant' || info.sessionID !== sessionId || created < lastCreated) invalid();
    if (nativeMessageIds.length === 0) {
      if (info.parentID !== userMessageId) invalid();
    } else {
      if (lastFinish !== 'tool-calls') invalid();
      if (info.parentID !== userMessageId) invalid();
    }
    const messageId = name(info.id);
    if (nativeMessageIds.includes(messageId)) invalid();
    const turn = collectOpenCodeTurn(envelope,
      { sessionId, userMessageId: info.parentID as string, allowedTools: expected.allowedTools });
    if (observedModel && (turn.observedModel.providerId !== observedModel.providerId ||
      turn.observedModel.modelId !== observedModel.modelId)) invalid();
    observedModel = turn.observedModel;
    for (const receipt of turn.toolReceipts) {
      if (seenParts.has(receipt.partId) || seenCalls.has(receipt.callId)) invalid();
      seenParts.add(receipt.partId);
      seenCalls.add(receipt.callId);
      toolReceipts.push(receipt);
    }
    bytes += Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (bytes > 2 * 1024 * 1024) invalid();
    text = turn.text;
    nativeMessageIds.push(messageId);
    lastId = messageId;
    lastCreated = created;
    lastFinish = info.finish;
  }
  if (!nativeMessageIds.length || lastId !== terminalId || lastFinish !== 'stop' ||
    !toolReceipts.length || !text.trim() || !observedModel) invalid();
  return { nativeSessionId: sessionId, nativeMessageIds, observedModel, text, toolReceipts };
}

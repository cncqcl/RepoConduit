import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

const MAX_LINE = 1024 * 1024;
const MAX_RPC = 128;
const MAX_EVENTS = 256;
const MAX_FRAMES = 256;
const OBSERVED_TOOLS = new Set(['repo.read', 'repo.inspect', 'repo.list', 'repo.search',
  'investigate.submit', 'investigate.get', 'investigate.result', 'investigate.cancel',
  'collab.get', 'context.read']);
const safeId = value => (typeof value === 'string' && value.length > 0 && value.length <= 256) ||
  (Number.isSafeInteger(value) && value >= 0) ? value : undefined;
const recordedRpcId = id => typeof id === 'number' ? id :
  `rpc_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
const safeRequestId = value => typeof value === 'string' &&
  /^inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : undefined;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const range = value => object(value) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
  value.start >= 0 && value.end >= value.start ? { start: value.start, end: value.end } : null;

/** Passive, bounded projection of observed MCP JSONL. Never emits source text or unknown fields. */
export function createStdioObservation(scope, emit) {
  const files = new Map(scope.files.map(file => [file.path, file]));
  const pending = new Map();
  const duplicateIds = new Set();
  const buffers = { input: '', output: '' };
  const decoders = { input: new StringDecoder('utf8'), output: new StringDecoder('utf8') };
  const dropping = { input: false, output: false };
  const counts = { incomingRpc: 0, outgoingRpc: 0, toolCalls: 0, repoReads: 0, observationErrors: 0 };
  let finished = false, eventCount = 0, frameCount = 0, eventLimitReached = false;
  const event = value => {
    if (value.kind === 'transport_summary') { emit(value); return; }
    if (eventLimitReached) return;
    if (eventCount >= MAX_EVENTS - 2) {
      eventLimitReached = true;
      counts.observationErrors++;
      emit({ kind: 'observation_error', category: 'event_limit' });
      return;
    }
    eventCount++;
    emit(value);
  };
  const protocolError = (direction, category) => {
    if (counts.observationErrors < MAX_EVENTS) counts.observationErrors++;
    event({ kind: 'observation_error', direction, category });
  };
  const inScope = args => {
    const input = object(args), bound = object(input?.scope), payload = object(input?.payload);
    return bound?.workspaceId === scope.workspaceId && bound?.collaborationId === scope.collaborationId &&
      payload?.workingCopyId === scope.workingCopyId;
  };
  const observeRequest = message => {
    if (++counts.incomingRpc > MAX_RPC) { if (counts.incomingRpc === MAX_RPC + 1) protocolError('input', 'rpc_limit'); return; }
    if (message.method !== 'tools/call') return;
    counts.toolCalls++;
    const id = safeId(message.id), params = object(message.params);
    const operation = params?.name;
    if (id === undefined) {
      protocolError('input', 'unclassified_tool_call'); return;
    }
    if (pending.has(id) || duplicateIds.has(id)) {
      pending.delete(id);
      duplicateIds.add(id);
      protocolError('input', 'duplicate_rpc_id');
      return;
    }
    if (!OBSERVED_TOOLS.has(operation)) {
      event({ kind: 'tool_call', category: 'unknown_operation' }); return;
    }
    const args = object(params.arguments);
    const allowed = inScope(args);
    event({ kind: 'tool_call', id: recordedRpcId(id), operation, bound: allowed });
    if (pending.size >= MAX_RPC) { protocolError('input', 'pending_limit'); return; }
    const payload = object(args?.payload);
    const selectedRead = operation === 'repo.read' && allowed && payload?.snapshotId === scope.snapshotId &&
      files.has(payload?.path);
    const selectedInvestigation = operation.startsWith('investigate.') && allowed &&
      (operation !== 'investigate.submit' || object(payload?.input)?.snapshotRef === scope.snapshotId);
    pending.set(id, { operation, selectedRead, selectedInvestigation,
      path: selectedRead ? payload.path : undefined,
      requestId: selectedInvestigation ? safeRequestId(payload?.requestId) : undefined });
  };
  const observeResponse = message => {
    if (++counts.outgoingRpc > MAX_RPC) { if (counts.outgoingRpc === MAX_RPC + 1) protocolError('output', 'rpc_limit'); return; }
    const id = safeId(message.id);
    if (id === undefined || duplicateIds.has(id) || !pending.has(id)) return;
    const call = pending.get(id);
    pending.delete(id);
    const result = object(message.result);
    const outcome = message.error || !result || result.isError === true ? 'error' : 'success';
    event({ kind: 'tool_result', id: recordedRpcId(id), operation: call.operation, outcome });
    if (outcome !== 'success' || (!call.selectedRead && !call.selectedInvestigation)) return;
    const content = Array.isArray(result.content) && result.content.length === 1 ? object(result.content[0]) : null;
    if (content?.type !== 'text' || typeof content.text !== 'string' || content.text.length > MAX_LINE) {
      protocolError('output', 'unreadable_result'); return;
    }
    let value;
    try { value = object(JSON.parse(content.text)); } catch { protocolError('output', 'invalid_result_json'); return; }
    if (!value) { protocolError('output', 'invalid_result_shape'); return; }
    if (call.selectedRead) {
      const file = files.get(call.path), bytes = range(value.byteRange), lines = range(value.lineRange);
      const contentBytes = typeof value.content === 'string' ? Buffer.from(value.content, 'utf8') : null;
      const actualHash = contentBytes && createHash('sha256').update(contentBytes).digest('hex');
      const actualLineEnd = contentBytes ?
        contentBytes.subarray(0, Math.max(0, contentBytes.length - 1)).reduce((n, byte) => n + (byte === 10 ? 1 : 0), 1) : null;
      if (value.snapshotId !== scope.snapshotId || value.path !== call.path ||
          !contentBytes || contentBytes.length !== file.bytes || actualHash !== file.sha256 ||
          value.contentHash !== actualHash || !bytes || bytes.start !== 0 || bytes.end !== file.bytes ||
          !lines || lines.start !== 1 || lines.end !== actualLineEnd ||
          value.completeness !== 'complete' || value.continuation !== undefined) {
        protocolError('output', 'read_evidence_mismatch'); return;
      }
      counts.repoReads++;
      event({ kind: 'repo_read', evidenceKind: 'transport_observed', id: recordedRpcId(id),
        workspaceId: scope.workspaceId, collaborationId: scope.collaborationId,
        snapshotId: scope.snapshotId, path: value.path, byteRange: bytes, lineRange: lines,
        contentHash: actualHash, completeness: 'complete' });
      return;
    }
    const requestId = call.operation === 'investigate.submit' ? safeRequestId(value.id) : call.requestId;
    const state = typeof value.state === 'string' && /^(queued|running|completed|failed|cancelled|recovery_required)$/.test(value.state) ?
      value.state : undefined;
    event({ kind: 'investigation', evidenceKind: 'transport_observed', id: recordedRpcId(id),
      operation: call.operation, ...(requestId === undefined ? {} : { requestId }),
      ...(state === undefined ? {} : { state }), outcome: 'success' });
  };
  const observeLine = (direction, line) => {
    if (++frameCount > MAX_FRAMES) {
      if (frameCount === MAX_FRAMES + 1) protocolError(direction, 'frame_count_limit');
      return;
    }
    let value;
    try { value = object(JSON.parse(line)); } catch { protocolError(direction, 'invalid_jsonl'); return; }
    if (!value) { protocolError(direction, 'invalid_envelope'); return; }
    if (direction === 'input') observeRequest(value);
    else observeResponse(value);
  };
  const feed = (direction, chunk) => {
    const text = Buffer.isBuffer(chunk) ? decoders[direction].write(chunk) : String(chunk);
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) {
        if (!dropping[direction]) buffers[direction] += parts[i];
        if (buffers[direction].length > MAX_LINE) {
          buffers[direction] = ''; dropping[direction] = true;
          protocolError(direction, 'frame_limit');
        }
      } else {
        if (!dropping[direction]) {
          const line = buffers[direction] + parts[i];
          if (line.length <= MAX_LINE && line.trim()) observeLine(direction, line);
          else if (line.length > MAX_LINE) protocolError(direction, 'frame_limit');
        }
        buffers[direction] = ''; dropping[direction] = false;
      }
    }
  };
  return {
    observeInput: chunk => feed('input', chunk),
    observeOutput: chunk => feed('output', chunk),
    finish: () => {
      if (finished) return;
      finished = true;
      event({ kind: 'transport_summary', ...counts,
        complete: counts.observationErrors === 0 && !buffers.input && !buffers.output && pending.size === 0 });
    },
  };
}

export function installedServeMcpArguments(scope) {
  const argv = ['--data-dir', scope.root, 'mcp', '--codex-workspace', scope.workspaceId,
    '--codex-profile', scope.profileRevision];
  if (!Object.hasOwn(scope, 'runtimeSource')) return argv;
  const source = scope.runtimeSource;
  const validName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!object(source) || Object.keys(source).sort().join(',') !== 'dataDirectory,profileRevision,workspaceId' ||
      typeof source.dataDirectory !== 'string' || !isAbsolute(source.dataDirectory) ||
      !validName(source.workspaceId) || !validName(source.profileRevision)) {
    throw new Error('Invalid runtime source');
  }
  return argv.concat('--codex-runtime-data-dir', source.dataDirectory,
    '--codex-runtime-workspace', source.workspaceId,
    '--codex-runtime-profile', source.profileRevision);
}

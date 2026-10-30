import { createHash } from 'node:crypto';

/** A provider-shaped observation. It is not an InvestigationResult or a tool receipt. */
export interface ClaudeModelOutcomeCandidate {
  kind: 'claude_model_outcome_candidate_v1';
  formatContract: 'claude_print_json_sdk_0_3_284';
  result: string;
  numTurns: number;
  rawBytesSha256: string;
}

const MAX_BYTES = 256 * 1024;

/** JSON.parse accepts duplicate keys; reject them at the outer envelope before reading any fields. */
function uniqueTopLevelKeys(source: string): boolean {
  let at = 0;
  const space = () => {while (/\s/.test(source[at] ?? '')) at++;};
  space();
  if (source[at++] !== '{') return false;
  const keys = new Set<string>();
  space();
  if (source[at] === '}') return true;
  while (at < source.length) {
    space();
    if (source[at] !== '"') return false;
    const keyStart = at++;
    let escaped = false;
    while (at < source.length) {
      const ch = source[at++];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
    }
    const key = JSON.parse(source.slice(keyStart, at)) as string;
    if (keys.has(key)) return false;
    keys.add(key);
    space();
    if (source[at++] !== ':') return false;
    space();
    let depth = 0; let quoted = false; escaped = false;
    for (; at < source.length; at++) {
      const ch = source[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
    }
    if (source[at] === '}') return true;
    if (source[at++] !== ',') return false;
  }
  return false;
}

/** Fixed-version, success-only interpretation of bounded native print-json bytes. */
export function parseClaudeModelOutcomeCandidate(raw: Buffer,
  maxTurns: number): ClaudeModelOutcomeCandidate | null {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_BYTES ||
    !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 8) return null;
  try {
    const source = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !uniqueTopLevelKeys(source)) return null;
    const envelope = value as Record<string, unknown>;
    if (envelope.type !== 'result' || envelope.subtype !== 'success' ||
      envelope.is_error !== false || !Number.isSafeInteger(envelope.num_turns) ||
      (envelope.num_turns as number) < 1 || (envelope.num_turns as number) > maxTurns ||
      typeof envelope.result !== 'string' || !envelope.result.trim() ||
      envelope.result.includes('\0')) return null;
    return {kind: 'claude_model_outcome_candidate_v1',
      formatContract: 'claude_print_json_sdk_0_3_284',
      result: envelope.result, numTurns: envelope.num_turns as number,
      rawBytesSha256: createHash('sha256').update(raw).digest('hex')};
  } catch {return null;}
}

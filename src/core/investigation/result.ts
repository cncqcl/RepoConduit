import type { InvestigationResult } from './request.js';

export interface InvestigationResultEvidence extends Omit<InvestigationResult['evidence'][number], 'toolReceipt'> {
  byteRange: [number, number]; toolReceipt: string;
}
export interface ParsedInvestigationResult extends Omit<InvestigationResult, 'resultState' | 'evidence'> {
  resultState: 'completed'; evidence: InvestigationResultEvidence[];
}

function invalid(): never { throw new Error('INVALID_INVESTIGATION_RESULT'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) invalid();
  return item;
}
function str(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > max) invalid();
  return value;
}
function excerpt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 64 * 1024) invalid();
  return value;
}
function arr(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function strings(value: unknown, max = 64): string[] {
  return arr(value, max).map(item => str(item));
}
function range(value: unknown, positive = false): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 ||
    value.some(item => !Number.isSafeInteger(item)) || value[0] < (positive ? 1 : 0) ||
    value[1] < value[0] + (positive ? 0 : 1)) invalid();
  return [value[0], value[1]];
}
function path(value: unknown): string {
  const item = str(value, 512);
  if (item.startsWith('/') || item.includes('\\') || item.includes(':') ||
    item.split('/').some(segment => !segment || segment === '.' || segment === '..')) invalid();
  return item;
}

/** Scan the wire before JSON.parse so duplicate keys cannot disappear. */
function rejectDuplicateKeys(raw: string): void {
  let i = 0;
  const space = () => { while (/\s/.test(raw[i] ?? '')) i++; };
  const quoted = (): string => {
    if (raw[i] !== '"') invalid();
    const start = i++;
    while (i < raw.length) {
      const char = raw[i++];
      if (char === '\\') { i++; continue; }
      if (char === '"') {
        try { return JSON.parse(raw.slice(start, i)) as string; } catch { invalid(); }
      }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 8) invalid();
    space();
    if (raw[i] === '"') { quoted(); return; }
    if (raw[i] === '{') {
      i++; space(); const seen = new Set<string>();
      if (raw[i] === '}') { i++; return; }
      while (true) {
        space(); const key = quoted(); if (seen.has(key)) invalid(); seen.add(key);
        space(); if (raw[i++] !== ':') invalid(); value(depth + 1); space();
        const delimiter = raw[i++]; if (delimiter === '}') return;
        if (delimiter !== ',') invalid();
      }
    }
    if (raw[i] === '[') {
      i++; space(); if (raw[i] === ']') { i++; return; }
      while (true) {
        value(depth + 1); space(); const delimiter = raw[i++];
        if (delimiter === ']') return;
        if (delimiter !== ',') invalid();
      }
    }
    const start = i;
    while (i < raw.length && !/[\s,}\]]/.test(raw[i]!)) i++;
    if (i === start) invalid();
    try { JSON.parse(raw.slice(start, i)); } catch { invalid(); }
  };
  value(0); space(); if (i !== raw.length) invalid();
}

/** Provider wire is only data; durable read receipts and snapshot bytes are checked separately. */
export function parseInvestigationResult(raw: string): ParsedInvestigationResult {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 256 * 1024) invalid();
  rejectDuplicateKeys(raw);
  const root = record(JSON.parse(raw), ['kind', 'requestId', 'attemptId', 'resultState',
    'snapshotRef', 'contextRevisionId', 'findings', 'evidence', 'coverage',
    'openQuestions', 'limitsAndWarnings']);
  if (root.kind !== 'investigation_result_v1' || root.resultState !== 'completed') invalid();
  const evidence = arr(root.evidence, 40).map(item => {
    const e = record(item, ['path', 'symbol', 'lineRange', 'byteRange', 'contentHash', 'excerpt', 'toolReceipt']);
    const symbol = e.symbol === null ? null : str(e.symbol, 256);
    const contentHash = str(e.contentHash, 64);
    if (!/^[0-9a-f]{64}$/.test(contentHash)) invalid();
    return {path: path(e.path), symbol, lineRange: range(e.lineRange, true),
      byteRange: range(e.byteRange), contentHash, excerpt: excerpt(e.excerpt),
      toolReceipt: str(e.toolReceipt, 128)};
  });
  // A read receipt can support several excerpts; each is independently checked
  // against that receipt's page and the exact snapshot bytes before publication.
  if (!evidence.length) invalid();
  const receipts = new Set(evidence.map(item => item.toolReceipt));
  const findings = arr(root.findings, 64).map(item => {
    const f = record(item, ['statement', 'classification', 'evidenceRefs']);
    if (!['source_confirmed', 'inferred', 'unverified'].includes(f.classification as string)) invalid();
    const evidenceRefs = strings(f.evidenceRefs);
    if (f.classification === 'source_confirmed' && !evidenceRefs.length) invalid();
    if (evidenceRefs.some(ref => !receipts.has(ref)) ||
      new Set(evidenceRefs).size !== evidenceRefs.length) invalid();
    return {statement: str(f.statement), classification: f.classification as
      'source_confirmed' | 'inferred' | 'unverified', evidenceRefs};
  });
  const c = record(root.coverage, ['searchedScope', 'excludedCategories', 'truncated', 'missingDependencies']);
  if (typeof c.truncated !== 'boolean') invalid();
  return {requestId: str(root.requestId, 128), attemptId: str(root.attemptId, 128),
    resultState: 'completed', snapshotRef: str(root.snapshotRef, 128),
    contextRevisionId: str(root.contextRevisionId, 128), findings, evidence,
    coverage: {searchedScope: strings(c.searchedScope).map(path),
      excludedCategories: strings(c.excludedCategories), truncated: c.truncated,
      missingDependencies: strings(c.missingDependencies)},
    openQuestions: strings(root.openQuestions), limitsAndWarnings: strings(root.limitsAndWarnings)};
}

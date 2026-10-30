/** Fixed output hint for the native model. parseInvestigationResult remains authoritative. */
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000]+$' });
const list = (items: object, maxItems = 64) => ({ type: 'array', items, maxItems });
const integer = (minimum: number) => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER });
// Strict model output schemas require an object-valued items schema. The local
// result parser still validates both endpoints, order and their evidence binding.
const tuple = (minimum: number) => ({ type: 'array', items: integer(minimum),
  minItems: 2, maxItems: 2 });
const closed = (required: string[], properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, required, properties,
});
function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const path = { ...text(512), pattern: '^[^/\\\\:]+(?:/[^/\\\\:]+)*$' };
const evidence = closed(['path', 'symbol', 'lineRange', 'byteRange', 'contentHash', 'excerpt', 'toolReceipt'], {
  path, symbol: { anyOf: [text(256), { type: 'null' }] }, lineRange: tuple(1),
  byteRange: tuple(0), contentHash: { type: 'string', pattern: '^[0-9a-f]{64}$', minLength: 64, maxLength: 64 },
  excerpt: text(65536), toolReceipt: text(128),
});
const finding = closed(['statement', 'classification', 'evidenceRefs'], {
  statement: text(4096), classification: { enum: ['source_confirmed', 'inferred', 'unverified'] },
  evidenceRefs: list(text(4096)),
});
const coverage = closed(['searchedScope', 'excludedCategories', 'truncated', 'missingDependencies'], {
  searchedScope: list(path), excludedCategories: list(text(4096)), truncated: { type: 'boolean' },
  missingDependencies: list(text(4096)),
});

export const INVESTIGATION_RESULT_OUTPUT_SCHEMA = deepFreeze(closed(
  ['kind', 'requestId', 'attemptId', 'resultState', 'snapshotRef', 'contextRevisionId',
    'findings', 'evidence', 'coverage', 'openQuestions', 'limitsAndWarnings'], {
    kind: { enum: ['investigation_result_v1'] }, requestId: text(128), attemptId: text(128),
    resultState: { enum: ['completed'] }, snapshotRef: text(128), contextRevisionId: text(128),
    findings: list(finding), evidence: { ...list(evidence, 40), minItems: 1 }, coverage,
    openQuestions: list(text(4096)), limitsAndWarnings: list(text(4096)),
  }));

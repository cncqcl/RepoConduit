import { randomUUID } from 'node:crypto';

export type InvestigationState = 'queued' | 'awaiting_authorization' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'recovery_required';
export type AttemptState = 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'recovery_required';
export type RequestedOutput = 'flow' | 'evidence' | 'gaps';

export interface InvestigationInput {
  contextRevisionId: string;
  snapshotRef: string;
  question: string;
  scope: { paths: string[]; symbols: string[]; relatedTests: string[] };
  requestedOutputs: RequestedOutput[];
  parentInvestigationId: string | null;
}

export interface InvestigationBudget { maxWallSeconds: number; maxTurns: number; maxToolCalls: number }
export interface InvestigationAttempt {
  id: string;
  state: AttemptState;
  nativeRef: string | null;
  workerEpoch: number;
  startedAt: string | null;
  finishedAt: string | null;
  terminationConfirmed: boolean;
}
export interface InvestigationEvidence {
  path: string; symbol: string | null; lineRange: [number, number]; contentHash: string;
  excerpt: string; toolReceipt: string | null;
}
export interface InvestigationResult {
  requestId: string; attemptId: string; resultState: 'completed' | 'failed' | 'cancelled';
  snapshotRef: string; contextRevisionId: string;
  findings: { statement: string; classification: 'source_confirmed' | 'tool_observed' | 'inferred' | 'unverified'; evidenceRefs: string[] }[];
  evidence: InvestigationEvidence[];
  coverage: { searchedScope: string[]; excludedCategories: string[]; truncated: boolean; missingDependencies: string[] };
  openQuestions: string[]; limitsAndWarnings: string[];
}
export interface InvestigationRecord extends InvestigationInput {
  id: string; workspaceId: string; collaborationId: string; workingCopyId: string;
  principal: string; audience: string; recipient: string; grantId: string;
  profileRef: string; budgetRef: string; budget: InvestigationBudget;
  state: InvestigationState; cancelRequested: boolean; attempts: InvestigationAttempt[];
  result: InvestigationResult | null;
  failureReason?: 'authorization_changed' | 'abandoned_before_resource_reservation' |
    'closed_before_native_launch' | 'model_execution_prevented' |
    'model_tree_terminated_without_outcome' | 'model_prompt_limit_exceeded' |
    'windows_launch_closed_without_outcome' | 'windows_launch_not_started'; createdAt: string;
}

function invalid(): never { throw new Error('Invalid investigation input'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid();
  return record;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max || value.includes('\0')) invalid();
  return value;
}
function strings(value: unknown, maxItems: number, maxBytes: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  return value.map(item => string(item, maxBytes));
}
function path(value: string): string {
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value) || value.includes('\\') ||
      value.split('/').some(segment => !segment || segment === '.' || segment === '..')) invalid();
  return value;
}

/** External input is a closed data contract; runtime authority comes from local policy. */
export function parseInvestigationInput(value: unknown): InvestigationInput {
  const record = object(value, ['contextRevisionId', 'snapshotRef', 'question', 'scope', 'requestedOutputs', 'parentInvestigationId']);
  const scope = object(record.scope, ['paths', 'symbols', 'relatedTests']);
  const outputs = strings(record.requestedOutputs, 3, 16);
  if (!outputs.length || outputs.some(item => !['flow', 'evidence', 'gaps'].includes(item)) || new Set(outputs).size !== outputs.length) invalid();
  const parent = record.parentInvestigationId;
  if (parent !== null && parent !== undefined) string(parent, 128);
  return {
    contextRevisionId: string(record.contextRevisionId, 128), snapshotRef: string(record.snapshotRef, 128),
    question: string(record.question, 16 * 1024),
    scope: { paths: strings(scope.paths, 64, 512).map(path), symbols: strings(scope.symbols, 64, 256),
      relatedTests: strings(scope.relatedTests, 64, 512).map(path) },
    requestedOutputs: outputs as RequestedOutput[], parentInvestigationId: parent == null ? null : parent as string,
  };
}

export function newInvestigationRecord(input: InvestigationInput, fixed: Omit<InvestigationRecord,
  keyof InvestigationInput | 'id' | 'state' | 'cancelRequested' | 'attempts' | 'result' | 'failureReason' | 'createdAt'>,
  now: Date): InvestigationRecord {
  return { ...input, ...fixed, id: `inv_${randomUUID()}`, state: 'queued', cancelRequested: false,
    attempts: [], result: null, createdAt: now.toISOString() };
}

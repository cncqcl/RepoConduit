import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserDownloadBaseline } from '../transfers/browser-download.js';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INSPECT_ROWS = 512;
const MAX_INSPECT_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_KEY = /^hacc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES = ['prepared', 'capturing', 'verified_candidate', 'reconcile_required', 'aborted_before_capture'] as const;
const INPUT_KEYS = ['accountKey', 'audience', 'baseline', 'bindingFingerprint', 'bundleId', 'collaborationId', 'expectedSha256',
  'expectedSize', 'filename', 'grantId', 'id', 'nativeMessageId', 'nativeSessionId', 'path', 'principal',
  'recipient', 'sourceFingerprint', 'workspaceId'];
const BASELINE_KEYS = ['ancestors', 'entries', 'expectedFilename', 'root'];
const ROOT_KEYS = ['canonical', 'dev', 'ino', 'path'];
const MARK_KEYS = ['ctimeMs', 'ctimeNs', 'dev', 'ino', 'mtimeMs', 'mtimeNs', 'nlink', 'size'];
const LEGACY_SCHEMA_SQL = 'CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))';
const LEGACY_INTENTS_SQL = `CREATE TABLE browser_capture_intents (
  id TEXT PRIMARY KEY, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','capturing','verified_candidate','reconcile_required')),
  candidate_fingerprint TEXT
)`;
const SCHEMA_V2_SQL = 'CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=2))';
const SCHEMA_SQL = 'CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=3))';
const INTENTS_SQL = `CREATE TABLE browser_capture_intents (
  id TEXT PRIMARY KEY, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','capturing','verified_candidate','reconcile_required','aborted_before_capture')),
  candidate_fingerprint TEXT, abort_reason TEXT
)`;
const RETRIES_SQL = `CREATE TABLE browser_capture_retries (
  predecessor_id TEXT PRIMARY KEY, successor_id TEXT NOT NULL UNIQUE,
  browser_id TEXT NOT NULL, original_tab_id TEXT NOT NULL, retry_tab_id TEXT NOT NULL
)`;

type State = typeof STATES[number];
export type BrowserCaptureInput = {
  id: string; workspaceId: string; collaborationId: string; bundleId: string; path: string;
  principal: string; audience: string; recipient: string; grantId: string; accountKey: string;
  nativeSessionId: string; nativeMessageId: string; filename: string; sourceFingerprint: string;
  attachmentIndex?: number;
  expectedSha256: string; expectedSize: number; bindingFingerprint: string | null; baseline: BrowserDownloadBaseline;
};
export type BrowserCaptureRecord = {
  input: BrowserCaptureInput;
  /** verified_candidate means the expected candidate was reconciled; bytes are not stored or received here. */
  state: State; candidateFingerprint: string | null; abortReason: 'source_changed_before_capture' | null;
};
export type BrowserRetryContext = { browserId: string; originalTabId: string; retryTabId: string };
export type BrowserRetryRelation = BrowserRetryContext & { predecessorId: string; successorId: string };
type RetryRow = { predecessor_id: string; successor_id: string; browser_id: string;
  original_tab_id: string; retry_tab_id: string };
type IntentRow = { id: string; input_json: string; input_hash: string; state: string; candidate_fingerprint: string | null; abort_reason: string | null };

function invalid(): never { throw new Error('INVALID_ARGUMENT'); }
function conflict(): never { throw new Error('CONFLICT'); }
function rootBusy(): never { throw new Error('BROWSER_CAPTURE_ROOT_BUSY'); }
function rootLimit(): never { throw new Error('BROWSER_CAPTURE_ROOT_LIMIT'); }
function inspectLimit(): never { throw new Error('BROWSER_CAPTURE_INSPECT_LIMIT'); }
function corrupt(): never { throw new Error('BROWSER_CAPTURE_CORRUPT'); }
function schemaError(): never { throw new Error('BROWSER_CAPTURE_SCHEMA_INCOMPATIBLE'); }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function rootKey(value: string): string { return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value; }
function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).sort().join('\u0000') === [...expected].sort().join('\u0000');
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !Array.from(value).some(char => char.charCodeAt(0) < 32);
}
function hex(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]{0,31})$/u.test(value); }
function safeComponent(value: unknown): value is string {
  return text(value) && value.length <= 255 && value !== '.' && value !== '..' && !/[\\/<>:"|?*]/u.test(value) &&
    !/[. ]$/u.test(value) && !Array.from(value).some(char => char.charCodeAt(0) < 32) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}
function safePath(value: unknown): value is string {
  return text(value) && value.length <= 1024 && !value.startsWith('/') && !value.endsWith('/') &&
    value.split('/').every(safeComponent);
}
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function handle(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validRetryContext(value: BrowserRetryContext): boolean {
  return plain(value) && keys(value, ['browserId', 'originalTabId', 'retryTabId']) &&
    handle(value.browserId) && handle(value.originalTabId) && handle(value.retryTabId) &&
    value.originalTabId !== value.retryTabId;
}
function relation(row: RetryRow): BrowserRetryRelation {
  const context = { browserId: row.browser_id, originalTabId: row.original_tab_id, retryTabId: row.retry_tab_id };
  if (!hex(row.predecessor_id) || !hex(row.successor_id) || row.predecessor_id === row.successor_id ||
      !validRetryContext(context)) corrupt();
  return { predecessorId: row.predecessor_id, successorId: row.successor_id, ...context };
}
function sameRetryTarget(a: BrowserCaptureInput, b: BrowserCaptureInput): boolean {
  return ['workspaceId', 'collaborationId', 'bundleId', 'path', 'principal', 'audience', 'recipient',
    'accountKey', 'nativeSessionId', 'nativeMessageId', 'filename', 'expectedSha256', 'expectedSize',
    'bindingFingerprint', 'attachmentIndex'].every(key => a[key as keyof BrowserCaptureInput] === b[key as keyof BrowserCaptureInput]) &&
    rootKey(a.baseline.root) === rootKey(b.baseline.root);
}
function finiteMs(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function checkBaseline(value: unknown, filename: string): boolean {
  if (!keys(value, BASELINE_KEYS) || !text(value.root) || !isAbsolute(value.root) ||
      value.expectedFilename !== filename || !Array.isArray(value.ancestors) ||
      value.ancestors.length < 1 || value.ancestors.length > 64 || !plain(value.entries) ||
      Object.keys(value.entries).length > 128) return false;
  if (!value.ancestors.every((item: unknown) => keys(item, ROOT_KEYS) && text(item.path) && isAbsolute(item.path) &&
      text(item.canonical) && isAbsolute(item.canonical) && decimal(item.dev) && decimal(item.ino))) return false;
  return Object.entries(value.entries).every(([name, item]) => safeComponent(name) &&
    keys(item, MARK_KEYS) && decimal(item.dev) && decimal(item.ino) && nonnegative(item.size) &&
    item.size <= MAX_FILE_BYTES && finiteMs(item.mtimeMs) && finiteMs(item.ctimeMs) &&
    decimal(item.mtimeNs) && decimal(item.ctimeNs) && item.nlink === 1);
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (!plain(value)) invalid();
  return `{${Object.keys(value).sort().map(key => {
    if (value[key] === undefined) invalid();
    return `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`;
  }).join(',')}}`;
}
function validateInput(input: unknown): asserts input is BrowserCaptureInput {
  if (!keys(input, [...INPUT_KEYS, ...(plain(input) && Object.hasOwn(input, 'attachmentIndex') ? ['attachmentIndex'] : [])]) ||
      (Object.hasOwn(input, 'attachmentIndex') && (!Number.isSafeInteger(input.attachmentIndex) ||
        (input.attachmentIndex as number) < 0 || (input.attachmentIndex as number) > 63)) ||
      !hex(input.id) || !hex(input.sourceFingerprint) ||
      !(input.bindingFingerprint === null || hex(input.bindingFingerprint)) ||
      !hex(input.expectedSha256) || !nonnegative(input.expectedSize) || input.expectedSize > MAX_FILE_BYTES ||
      !safePath(input.path) || !safeComponent(input.filename) ||
      !text(input.accountKey) || !ACCOUNT_KEY.test(input.accountKey) ||
      !text(input.nativeSessionId) || !UUID.test(input.nativeSessionId) ||
      !text(input.nativeMessageId) || !UUID.test(input.nativeMessageId) ||
      !['workspaceId', 'collaborationId', 'bundleId', 'principal', 'audience', 'recipient', 'grantId']
        .every(key => text(input[key])) || !checkBaseline(input.baseline, input.filename)) invalid();
  if (Buffer.byteLength(canonical(input), 'utf8') > MAX_JSON_BYTES) invalid();
}
function validateState(state: unknown, fingerprint: unknown, reason: unknown): state is State {
  return STATES.includes(state as State) &&
    (state === 'verified_candidate' ? typeof fingerprint === 'string' && HASH.test(fingerprint) : fingerprint === null) &&
    (state === 'aborted_before_capture' ? reason === 'source_changed_before_capture' : reason === null);
}
function readRow(db: DatabaseSync, id: string, legacy = false): IntentRow | null {
  const size = db.prepare('SELECT length(CAST(input_json AS BLOB)) AS bytes FROM browser_capture_intents WHERE id=?')
    .get(id) as { bytes: number } | undefined;
  if (!size) return null;
  if (!nonnegative(size.bytes) || size.bytes > MAX_JSON_BYTES) corrupt();
  const row = db.prepare(`SELECT id,input_json,input_hash,state,candidate_fingerprint${legacy ? '' : ',abort_reason'}
    FROM browser_capture_intents WHERE id=? AND length(CAST(input_json AS BLOB))<=?`)
    .get(id, MAX_JSON_BYTES) as IntentRow | undefined;
  return row ? { ...row, abort_reason: legacy ? null : row.abort_reason } : null;
}
function record(row: IntentRow): BrowserCaptureRecord {
  try {
  if (!hex(row.id) || typeof row.input_json !== 'string' || !hex(row.input_hash) ||
      !validateState(row.state, row.candidate_fingerprint, row.abort_reason)) corrupt();
    const input: unknown = JSON.parse(row.input_json);
    validateInput(input);
    if (input.id !== row.id || canonical(input) !== row.input_json || sha(row.input_json) !== row.input_hash) corrupt();
    return { input, state: row.state as State, candidateFingerprint: row.candidate_fingerprint,
      abortReason: row.abort_reason as BrowserCaptureRecord['abortReason'] };
  } catch { return corrupt(); }
}
function verifySchema(db: DatabaseSync, version: 1 | 2 | 3 = 3): void {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'browser_capture_%'")
    .all() as { name: string; sql: string }[];
  if (tables.length !== (version === 3 ? 3 : 2)) schemaError();
  const expected = new Map<string, string>([['browser_capture_schema', version === 1 ? LEGACY_SCHEMA_SQL : version === 2 ? SCHEMA_V2_SQL : SCHEMA_SQL],
    ['browser_capture_intents', version === 1 ? LEGACY_INTENTS_SQL : INTENTS_SQL]]);
  if (version === 3) expected.set('browser_capture_retries', RETRIES_SQL);
  for (const table of tables) if (table.sql !== expected.get(table.name)) schemaError();
  const rows = db.prepare('SELECT id,version FROM browser_capture_schema').all() as { id: number; version: number }[];
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].version !== version) schemaError();
}

function migrateLegacy(db: DatabaseSync): void {
  verifySchema(db, 1);
  const budget = db.prepare(`SELECT count(*) AS rows, coalesce(sum(length(CAST(input_json AS BLOB))),0) AS bytes,
    coalesce(max(length(CAST(id AS BLOB))),0) AS max_id_bytes FROM browser_capture_intents`).get() as
    { rows: number; bytes: number; max_id_bytes: number };
  if (!nonnegative(budget.rows) || !nonnegative(budget.bytes) || budget.rows > MAX_INSPECT_ROWS ||
      budget.bytes > MAX_INSPECT_BYTES) inspectLimit();
  if (!nonnegative(budget.max_id_bytes) || budget.max_id_bytes > 64) corrupt();
  const rows = db.prepare('SELECT id,input_json,input_hash,state,candidate_fingerprint FROM browser_capture_intents ORDER BY id')
    .all() as Omit<IntentRow, 'abort_reason'>[];
  for (const row of rows) {
    if (Buffer.byteLength(row.input_json, 'utf8') > MAX_JSON_BYTES ||
        row.state === 'aborted_before_capture') corrupt();
    record({ ...row, abort_reason: null });
  }
  db.exec('DROP TABLE browser_capture_intents; DROP TABLE browser_capture_schema');
  db.exec(SCHEMA_V2_SQL);
  db.exec(INTENTS_SQL);
  db.exec('INSERT INTO browser_capture_schema VALUES (1,2)');
  const insert = db.prepare(`INSERT INTO browser_capture_intents
    (id,input_json,input_hash,state,candidate_fingerprint,abort_reason) VALUES (?,?,?,?,?,NULL)`);
  for (const row of rows) insert.run(row.id, row.input_json, row.input_hash, row.state, row.candidate_fingerprint);
}

function migrateV2(db: DatabaseSync): void {
  verifySchema(db, 2);
  inspectBrowserCaptureDatabase(db);
  db.exec('DROP TABLE browser_capture_schema');
  db.exec(SCHEMA_SQL);
  db.exec('INSERT INTO browser_capture_schema VALUES (1,3)');
  db.exec(RETRIES_SQL);
}

function inspectRetryRelations(db: DatabaseSync): void {
  const rows = db.prepare('SELECT * FROM browser_capture_retries LIMIT 513').all() as RetryRow[];
  if (rows.length > MAX_INSPECT_ROWS) inspectLimit();
  for (const row of rows) {
    const rel = relation(row);
    const oldRow = readRow(db, rel.predecessorId);
    const nextRow = readRow(db, rel.successorId);
    if (!oldRow || !nextRow) corrupt();
    const old = record(oldRow), next = record(nextRow);
    if (old.state !== 'reconcile_required' || !sameRetryTarget(old.input, next.input)) corrupt();
  }
}

/** Pure inspection of the supplied state database. No table creation, mutation, or state promotion. */
export function inspectBrowserCaptureDatabase(db: DatabaseSync): BrowserCaptureRecord[] {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'browser_capture_%'")
    .all() as { name: string; sql: string }[];
  if (tables.length === 0) return [];
  const version = tables.find(table => table.name === 'browser_capture_schema')?.sql === LEGACY_SCHEMA_SQL ? 1 :
    tables.find(table => table.name === 'browser_capture_schema')?.sql === SCHEMA_V2_SQL ? 2 : 3;
  verifySchema(db, version);
  const budget = db.prepare(`SELECT count(*) AS rows,
    coalesce(sum(length(CAST(input_json AS BLOB))),0) AS bytes,
    coalesce(max(length(CAST(id AS BLOB))),0) AS max_id_bytes FROM browser_capture_intents`).get() as
    { rows: number; bytes: number; max_id_bytes: number };
  if (!nonnegative(budget.rows) || !nonnegative(budget.bytes) ||
      budget.rows > MAX_INSPECT_ROWS || budget.bytes > MAX_INSPECT_BYTES) inspectLimit();
  if (!nonnegative(budget.max_id_bytes) || budget.max_id_bytes > 64) corrupt();
  const ids = db.prepare('SELECT id FROM browser_capture_intents ORDER BY id LIMIT 513').all() as { id: string }[];
  if (ids.length > MAX_INSPECT_ROWS) inspectLimit();
  const records = ids.map(({ id }) => {
    if (!hex(id)) corrupt();
    const row = readRow(db, id, version === 1);
    if (!row) corrupt();
    return record(row);
  });
  if (version === 3) inspectRetryRelations(db);
  return records;
}

/** Dedicated durable intent rows inside the existing state.sqlite. No candidate bytes are stored here.
 * Artifact persistence by the application is required before collection can be called complete. */
export class BrowserCaptureSqlite {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 2000 });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'browser_capture_%'").all();
        if (existing.length === 0) {
          this.db.exec(SCHEMA_SQL);
          this.db.exec(INTENTS_SQL);
          this.db.exec(RETRIES_SQL);
          this.db.exec('INSERT INTO browser_capture_schema VALUES (1,3)');
        } else {
          if (existing.length !== 2 && existing.length !== 3) schemaError();
          if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_capture_schema'").get() ||
              !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_capture_intents'").get()) schemaError();
          const version = this.db.prepare('SELECT version FROM browser_capture_schema WHERE id=1').get() as
            { version: number } | undefined;
          if (version?.version === 1) migrateLegacy(this.db);
          if (version?.version === 1 || version?.version === 2) migrateV2(this.db);
        }
        verifySchema(this.db);
        inspectRetryRelations(this.db);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  get(id: string): BrowserCaptureRecord | null {
    if (!HASH.test(id)) invalid();
    const row = readRow(this.db, id);
    return row ? record(row) : null;
  }
  getRetry(successorId: string): BrowserRetryRelation | null {
    if (!hex(successorId)) invalid();
    const row = this.db.prepare('SELECT * FROM browser_capture_retries WHERE successor_id=?').get(successorId) as RetryRow | undefined;
    return row ? relation(row) : null;
  }
  assertCaptureWritable(id: string): void {
    if (!hex(id)) invalid();
    if (this.db.prepare('SELECT 1 FROM browser_capture_retries WHERE predecessor_id=?').get(id)) conflict();
  }
  private blocksNewCapture(item: BrowserCaptureRecord): boolean {
    const row = this.db.prepare('SELECT successor_id FROM browser_capture_retries WHERE predecessor_id=?')
      .get(item.input.id) as { successor_id: string } | undefined;
    if (!row) return true;
    const successor = this.get(row.successor_id);
    if (!successor) corrupt();
    return successor.state !== 'verified_candidate';
  }
  /** Private recovery inventory for one configured download root; never implies ownership of external writers. */
  unresolvedForRoot(root: string): BrowserCaptureRecord[] {
    if (!text(root) || !isAbsolute(root)) invalid();
    const badState = this.db.prepare(`SELECT 1 FROM browser_capture_intents
      WHERE state NOT IN ('prepared','capturing','verified_candidate','reconcile_required','aborted_before_capture') LIMIT 1`).get();
    if (badState) corrupt();
    const badAbort = this.db.prepare(`SELECT 1 FROM browser_capture_intents WHERE
      (state='aborted_before_capture' AND (abort_reason IS NULL OR abort_reason<>'source_changed_before_capture' OR candidate_fingerprint IS NOT NULL)) OR
      (state<>'aborted_before_capture' AND abort_reason IS NOT NULL) LIMIT 1`).get();
    if (badAbort) corrupt();
    const budget = this.db.prepare(`SELECT count(*) AS rows,
      coalesce(sum(length(CAST(input_json AS BLOB))),0) AS bytes,
      coalesce(max(length(CAST(id AS BLOB))),0) AS max_id_bytes
      FROM browser_capture_intents WHERE state IN ('prepared','capturing','reconcile_required')`).get() as
      { rows: number; bytes: number; max_id_bytes: number };
    if (!nonnegative(budget.rows) || !nonnegative(budget.bytes) ||
        budget.rows > MAX_INSPECT_ROWS || budget.bytes > MAX_INSPECT_BYTES) rootLimit();
    if (!nonnegative(budget.max_id_bytes) || budget.max_id_bytes > 64) corrupt();
    const ids = this.db.prepare(`SELECT id FROM browser_capture_intents
      WHERE state IN ('prepared','capturing','reconcile_required') ORDER BY id LIMIT 513`).all() as { id: string }[];
    if (ids.length > MAX_INSPECT_ROWS) rootLimit();
    const matching: BrowserCaptureRecord[] = [];
    for (const { id } of ids) {
      const item = this.get(id);
      if (!item || item.state === 'verified_candidate') corrupt();
      if (rootKey(item.input.baseline.root) === rootKey(root)) matching.push(item);
      if (matching.length > 128) rootLimit();
    }
    return matching;
  }
  prepare(input: BrowserCaptureInput): BrowserCaptureRecord {
    validateInput(input);
    const json = canonical(input);
    const inputHash = sha(json);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(input.id);
      if (prior) {
        if (prior.state === 'aborted_before_capture') conflict();
        if (sha(canonical(prior.input)) !== inputHash) conflict();
        this.db.exec('COMMIT');
        return prior;
      }
      if (this.unresolvedForRoot(input.baseline.root).some(item => this.blocksNewCapture(item))) rootBusy();
      this.db.prepare(`INSERT INTO browser_capture_intents
        (id,input_json,input_hash,state,candidate_fingerprint) VALUES (?,?,?,'prepared',NULL)`)
        .run(input.id, json, inputHash);
      this.db.exec('COMMIT');
      return { input: JSON.parse(json) as BrowserCaptureInput, state: 'prepared', candidateFingerprint: null,
        abortReason: null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prepareRetry(input: BrowserCaptureInput, predecessorId: string, context: BrowserRetryContext): BrowserCaptureRecord {
    validateInput(input);
    if (!hex(predecessorId) || predecessorId === input.id || !validRetryContext(context)) invalid();
    const json = canonical(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const predecessor = this.get(predecessorId);
      if (!predecessor || predecessor.state !== 'reconcile_required' || !sameRetryTarget(predecessor.input, input)) conflict();
      const existing = this.get(input.id);
      const predecessorRetry = this.db.prepare('SELECT * FROM browser_capture_retries WHERE predecessor_id=?')
        .get(predecessorId) as RetryRow | undefined;
      if (existing || predecessorRetry) {
        const rel = this.getRetry(input.id);
        if (!existing || !rel || rel.predecessorId !== predecessorId ||
            canonical(existing.input) !== json || rel.browserId !== context.browserId ||
            rel.originalTabId !== context.originalTabId || rel.retryTabId !== context.retryTabId) conflict();
        this.db.exec('COMMIT');
        return existing;
      }
      if (this.unresolvedForRoot(input.baseline.root).some(item => item.input.id !== predecessorId && this.blocksNewCapture(item))) rootBusy();
      this.db.prepare(`INSERT INTO browser_capture_intents
        (id,input_json,input_hash,state,candidate_fingerprint) VALUES (?,?,?,'prepared',NULL)`)
        .run(input.id, json, sha(json));
      this.db.prepare(`INSERT INTO browser_capture_retries
        (predecessor_id,successor_id,browser_id,original_tab_id,retry_tab_id) VALUES (?,?,?,?,?)`)
        .run(predecessorId, input.id, context.browserId, context.originalTabId, context.retryTabId);
      this.db.exec('COMMIT');
      return { input: JSON.parse(json) as BrowserCaptureInput, state: 'prepared', candidateFingerprint: null, abortReason: null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transition(id: string, expectedState: State, nextState: State, candidateFingerprint?: string): BrowserCaptureRecord {
    if (!HASH.test(id) || !STATES.includes(expectedState) || !STATES.includes(nextState) ||
        (nextState === 'verified_candidate' ? !candidateFingerprint || !HASH.test(candidateFingerprint) : candidateFingerprint !== undefined)) invalid();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(id);
      if (!prior) conflict();
      this.assertCaptureWritable(id);
      const desired = candidateFingerprint ?? null;
      if (prior.state === 'verified_candidate' && expectedState === 'verified_candidate' && nextState === 'verified_candidate' &&
          prior.candidateFingerprint === desired) {
        this.db.exec('COMMIT'); return prior;
      }
      const allowed = (prior.state === 'prepared' && expectedState === 'prepared' && nextState === 'capturing') ||
        (prior.state === 'capturing' && expectedState === 'capturing' &&
          (nextState === 'verified_candidate' || nextState === 'reconcile_required')) ||
        (prior.state === 'reconcile_required' && expectedState === 'reconcile_required' && nextState === 'verified_candidate');
      if (!allowed) conflict();
      const changed = this.db.prepare(`UPDATE browser_capture_intents SET state=?,candidate_fingerprint=?
        WHERE id=? AND state=? AND candidate_fingerprint IS NULL`).run(nextState, desired, id, expectedState);
      if (changed.changes !== 1) conflict();
      const updated = this.get(id);
      if (!updated) corrupt();
      this.db.exec('COMMIT');
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  abortPreparedForSourceChange(id: string, originalSourceFingerprint: string, changedSourceFingerprint: string): BrowserCaptureRecord {
    if (!hex(id) || !hex(originalSourceFingerprint) || !hex(changedSourceFingerprint) ||
        originalSourceFingerprint === changedSourceFingerprint) invalid();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(id);
      if (!prior || prior.state !== 'prepared' || prior.input.sourceFingerprint !== originalSourceFingerprint) conflict();
      const changed = this.db.prepare(`UPDATE browser_capture_intents
        SET state='aborted_before_capture',abort_reason='source_changed_before_capture'
        WHERE id=? AND state='prepared' AND candidate_fingerprint IS NULL AND abort_reason IS NULL`).run(id);
      if (changed.changes !== 1) conflict();
      const updated = this.get(id);
      if (!updated) corrupt();
      this.db.exec('COMMIT');
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

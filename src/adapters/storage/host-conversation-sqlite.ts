import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivateDataDirectory } from '../../runtime/local-security.js';

export interface HostMessage {
  nativeMessageId: string;
  role: 'user' | 'assistant';
  text: string;
  version: string;
  turnId: string;
}

export interface HostBaselineInput {
  workspaceId: string;
  collaborationId: string;
  providerId: string;
  accountId: string;
  nativeSessionId: string;
  parentCursor: string | null;
  messages: HostMessage[];
  observation: unknown;
}

export interface HostBaseline extends HostBaselineInput {
  cursor: string;
  schemaVersion: 1;
}

const MAX_JSON_BYTES = 1_048_576;
// Two versioned native attachment Copy observations exceed 10,000 nodes within the byte limit.
const MAX_JSON_NODES = 20_000;
const INPUT_KEYS = ['workspaceId', 'collaborationId', 'providerId', 'accountId',
  'nativeSessionId', 'parentCursor', 'messages', 'observation'] as const;
const BASELINE_KEYS = [...INPUT_KEYS, 'cursor', 'schemaVersion'] as const;
const MESSAGE_KEYS = ['nativeMessageId', 'role', 'text', 'version', 'turnId'] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${label} must be bounded nonempty text`);
  }
  return value;
}

/** Canonical JSON rejects undefined, accessors, cycles and non-JSON objects rather than dropping them. */
function canonical(value: unknown): string {
  const stack = new Set<object>();
  let nodes = 0;
  function encode(current: unknown, depth: number): string {
    if (++nodes > MAX_JSON_NODES || depth > 40) throw new TypeError('Host JSON is too complex');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current);
    if (typeof current !== 'object') throw new TypeError('Host JSON contains unsupported value');
    if (stack.has(current)) throw new TypeError('Host JSON is cyclic');
    stack.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.keys(current).length !== current.length || Reflect.ownKeys(current).length !== current.length + 1) {
          throw new TypeError('Host JSON array has holes or extra fields');
        }
        return `[${current.map((part) => encode(part, depth + 1)).join(',')}]`;
      }
      const record = object(current, 'Host JSON');
      const keys = Reflect.ownKeys(record);
      if (keys.some((key) => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(record, key)?.enumerable ||
          !('value' in Object.getOwnPropertyDescriptor(record, key)!))) {
        throw new TypeError('Host JSON has hidden or accessor fields');
      }
      return `{${(keys as string[]).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`).join(',')}}`;
    } finally { stack.delete(current); }
  }
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) throw new TypeError('Host JSON exceeds 1 MiB');
  return encoded;
}

function validateInput(value: unknown): HostBaselineInput {
  const input = object(value, 'baseline');
  exactKeys(input, INPUT_KEYS, 'baseline');
  for (const field of ['workspaceId', 'collaborationId', 'providerId', 'accountId', 'nativeSessionId'] as const) {
    boundedString(input[field], field, field === 'nativeSessionId' ? 512 : 256);
  }
  if (input.parentCursor !== null) boundedString(input.parentCursor, 'parentCursor', 128);
  if (!Array.isArray(input.messages) || input.messages.length > 200) throw new TypeError('Invalid host messages');
  const ids = new Set<string>();
  for (const value of input.messages) {
    const message = object(value, 'host message');
    exactKeys(message, MESSAGE_KEYS, 'host message');
    boundedString(message.nativeMessageId, 'nativeMessageId', 256);
    boundedString(message.version, 'version', 128);
    boundedString(message.turnId, 'turnId', 256);
    if (message.role !== 'user' && message.role !== 'assistant') throw new TypeError('Invalid host role');
    if (typeof message.text !== 'string' || Buffer.byteLength(message.text, 'utf8') > 131_072) {
      throw new TypeError('Invalid host text');
    }
    if (ids.has(message.nativeMessageId as string)) throw new TypeError('Duplicate native message ID');
    ids.add(message.nativeMessageId as string);
  }
  object(input.observation, 'observation');
  canonical(input);
  return input as unknown as HostBaselineInput;
}

function samePrefix(parent: HostBaseline, child: HostBaselineInput): boolean {
  if (child.messages.length < parent.messages.length) return false;
  return parent.messages.every((message, index) => canonical(message) === canonical(child.messages[index]));
}

interface BaselineRow {
  cursor: string;
  workspace_id: string;
  collaboration_id: string;
  provider_id: string;
  account_id: string;
  native_session_id: string;
  parent_cursor: string | null;
  baseline_json: string;
  record_hash: string;
}

const HOST_TABLES = ['host_conversation_schema', 'host_conversation_accounts', 'host_conversation_baselines'];

function existingHostTables(db: DatabaseSync): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name LIKE 'host_conversation_%'`).all() as { name: string }[]).map((row) => row.name));
}

function verifySchema(db: DatabaseSync): void {
  const existing = existingHostTables(db);
  if (existing.size !== HOST_TABLES.length || HOST_TABLES.some((table) => !existing.has(table))) {
    throw new Error('HOST_CONVERSATION_SCHEMA_INCOMPATIBLE');
  }
  const rows = db.prepare('SELECT id,version FROM host_conversation_schema').all() as
    { id: number; version: number }[];
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].version !== 1) {
    throw new Error('HOST_CONVERSATION_SCHEMA_INCOMPATIBLE');
  }
  const shapes: Record<string, [string, string, number, number][]> = {
    host_conversation_schema: [['id', 'INTEGER', 0, 1], ['version', 'INTEGER', 1, 0]],
    host_conversation_accounts: [['account_id', 'TEXT', 0, 1], ['provider_id', 'TEXT', 1, 0],
      ['source_kind', 'TEXT', 1, 0], ['exact_source', 'TEXT', 1, 0]],
    host_conversation_baselines: [['cursor', 'TEXT', 0, 1], ['workspace_id', 'TEXT', 1, 0],
      ['collaboration_id', 'TEXT', 1, 0], ['provider_id', 'TEXT', 1, 0], ['account_id', 'TEXT', 1, 0],
      ['native_session_id', 'TEXT', 1, 0], ['parent_cursor', 'TEXT', 0, 0],
      ['baseline_json', 'TEXT', 1, 0], ['record_hash', 'TEXT', 1, 0]],
  };
  for (const [table, expected] of Object.entries(shapes)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as
      { name: string; type: string; notnull: number; pk: number }[];
    if (columns.length !== expected.length || columns.some((column, index) =>
      column.name !== expected[index]?.[0] || column.type !== expected[index]?.[1] ||
      column.notnull !== expected[index]?.[2] || column.pk !== expected[index]?.[3])) {
      throw new Error('HOST_CONVERSATION_SCHEMA_INCOMPATIBLE');
    }
  }
  const references = (db.prepare('PRAGMA foreign_key_list(host_conversation_baselines)').all() as
    { table: string; from: string; to: string }[]).map((row) => `${row.from}:${row.table}:${row.to}`).sort();
  const requiredReferences = [
    'workspace_id:workspaces:id', 'collaboration_id:collaborations:id',
    'account_id:host_conversation_accounts:account_id',
    'parent_cursor:host_conversation_baselines:cursor',
  ].sort();
  if (references.length !== requiredReferences.length ||
      references.some((reference, index) => reference !== requiredReferences[index])) {
    throw new Error('HOST_CONVERSATION_SCHEMA_INCOMPATIBLE');
  }
  const accountIndexes = db.prepare('PRAGMA index_list(host_conversation_accounts)').all() as
    { name: string; unique: number }[];
  const sourceUnique = accountIndexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = (db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(index.name) as { name: string }[]).map((row) => row.name);
    return columns.length === 3 && columns[0] === 'provider_id' &&
      columns[1] === 'source_kind' && columns[2] === 'exact_source';
  });
  if (!sourceUnique) throw new Error('HOST_CONVERSATION_SCHEMA_INCOMPATIBLE');
}

function readBaseline(db: DatabaseSync, cursor: string, seen: Set<string>): HostBaseline | null {
  if (seen.has(cursor) || seen.size > 100) throw new Error('HOST_BASELINE_PARENT_CYCLE');
  seen.add(cursor);
  const size = db.prepare(`SELECT length(CAST(baseline_json AS BLOB)) AS bytes
    FROM host_conversation_baselines WHERE cursor=?`).get(cursor) as { bytes: number } | undefined;
  if (!size) return null;
  if (!Number.isSafeInteger(size.bytes) || size.bytes > MAX_JSON_BYTES) throw new Error('HOST_BASELINE_CORRUPT');
  const row = db.prepare(`SELECT * FROM host_conversation_baselines WHERE cursor=?
    AND length(CAST(baseline_json AS BLOB))<=?`).get(cursor, MAX_JSON_BYTES) as BaselineRow | undefined;
  if (!row || typeof row.baseline_json !== 'string') throw new Error('HOST_BASELINE_CORRUPT');
  let value: unknown;
  try { value = JSON.parse(row.baseline_json) as unknown; }
  catch { throw new Error('HOST_BASELINE_CORRUPT'); }
  const baseline = object(value, 'stored baseline');
  exactKeys(baseline, BASELINE_KEYS, 'stored baseline');
  if (baseline.schemaVersion !== 1 || baseline.cursor !== row.cursor ||
      baseline.workspaceId !== row.workspace_id || baseline.collaborationId !== row.collaboration_id ||
      baseline.providerId !== row.provider_id || baseline.accountId !== row.account_id ||
      baseline.nativeSessionId !== row.native_session_id || baseline.parentCursor !== row.parent_cursor ||
      createHash('sha256').update(canonical(baseline)).digest('hex') !== row.record_hash) {
    throw new Error('HOST_BASELINE_CORRUPT');
  }
  validateInput(Object.fromEntries(INPUT_KEYS.map((key) => [key, baseline[key]])));
  const account = db.prepare('SELECT provider_id FROM host_conversation_accounts WHERE account_id=?')
    .get(row.account_id) as { provider_id: string } | undefined;
  if (!account || account.provider_id !== row.provider_id) throw new Error('HOST_BASELINE_CORRUPT');
  if (row.parent_cursor !== null) {
    const parent = readBaseline(db, row.parent_cursor, seen);
    if (!parent || parent.workspaceId !== row.workspace_id || parent.collaborationId !== row.collaboration_id ||
        parent.providerId !== row.provider_id || parent.accountId !== row.account_id ||
        parent.nativeSessionId !== row.native_session_id || !samePrefix(parent, baseline as unknown as HostBaselineInput)) {
      throw new Error('HOST_BASELINE_CORRUPT');
    }
  }
  return baseline as unknown as HostBaseline;
}

/** Validate private host candidates and adopted host bindings on an existing read-only connection. */
export function inspectHostConversationDatabase(db: DatabaseSync): void {
  const tables = existingHostTables(db);
  const hasSessionTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_control'").get();
  const hasBindings = hasSessionTable && (db.prepare('PRAGMA table_info(session_control)').all() as
    { name: string }[]).some((column) => column.name === 'provider_id');
  const hostBindingCount = hasBindings ? (db.prepare(`SELECT count(*) AS n FROM session_control
    WHERE provider_id='chatgpt-host-web'`).get() as { n: number }).n : 0;
  if (tables.size === 0) {
    if (hostBindingCount !== 0) throw new Error('HOST_BASELINE_MISSING');
    return;
  }
  verifySchema(db);
  const accountBudget = db.prepare(`SELECT count(*) AS rows,
    coalesce(sum(length(CAST(account_id AS BLOB))+length(CAST(provider_id AS BLOB))+
      length(CAST(source_kind AS BLOB))+length(CAST(exact_source AS BLOB))),0) AS bytes
    FROM host_conversation_accounts`).get() as { rows: number; bytes: number };
  const baselineBudget = db.prepare(`SELECT count(*) AS rows,
    coalesce(sum(length(CAST(baseline_json AS BLOB))+length(CAST(cursor AS BLOB))+
      length(CAST(record_hash AS BLOB))+length(CAST(workspace_id AS BLOB))+
      length(CAST(collaboration_id AS BLOB))+length(CAST(provider_id AS BLOB))+
      length(CAST(account_id AS BLOB))+length(CAST(native_session_id AS BLOB))+
      coalesce(length(CAST(parent_cursor AS BLOB)),0)),0) AS bytes,
    coalesce(max(length(CAST(baseline_json AS BLOB))),0) AS largest
    FROM host_conversation_baselines`).get() as { rows: number; bytes: number; largest: number };
  const bindingBudget = hasBindings ? db.prepare(`SELECT count(*) AS rows,
    coalesce(sum(length(CAST(state_json AS BLOB))+length(CAST(binding_id AS BLOB))+
      length(CAST(workspace_id AS BLOB))+length(CAST(collaboration_id AS BLOB))+
      length(CAST(provider_id AS BLOB))+length(CAST(account_id AS BLOB))+
      length(CAST(native_session_id AS BLOB))),0) AS bytes,
    coalesce(max(length(CAST(state_json AS BLOB))),0) AS largest
    FROM session_control WHERE provider_id='chatgpt-host-web'`).get() as
    { rows: number; bytes: number; largest: number } : { rows: 0, bytes: 0, largest: 0 };
  if (accountBudget.rows + baselineBudget.rows + bindingBudget.rows > 10_000 ||
      accountBudget.bytes + baselineBudget.bytes + bindingBudget.bytes > 16_777_216 ||
      baselineBudget.largest > MAX_JSON_BYTES || bindingBudget.largest > MAX_JSON_BYTES) {
    throw new Error('HOST_CONVERSATION_INSPECTION_BUDGET_EXCEEDED');
  }
  const accounts = db.prepare(`SELECT account_id,provider_id,source_kind,exact_source
    FROM host_conversation_accounts`).all() as { account_id: unknown; provider_id: unknown;
      source_kind: unknown; exact_source: unknown }[];
  for (const account of accounts) {
    boundedString(account.account_id, 'account_id', 256);
    boundedString(account.provider_id, 'provider_id', 256);
    if (account.source_kind !== 'settings-account-email') throw new Error('HOST_ACCOUNT_CORRUPT');
    boundedString(account.exact_source, 'exact_source', 512);
  }
  const badForeignKeys = db.prepare('PRAGMA foreign_key_check(host_conversation_baselines)').all();
  if (badForeignKeys.length) throw new Error('HOST_BASELINE_CORRUPT');
  const cursors = db.prepare('SELECT cursor FROM host_conversation_baselines').all() as { cursor: string }[];
  for (const row of cursors) {
    boundedString(row.cursor, 'cursor', 128);
    const baseline = readBaseline(db, row.cursor, new Set());
    if (!baseline || !db.prepare('SELECT 1 FROM collaborations WHERE id=? AND workspace_id=?')
      .get(baseline.collaborationId, baseline.workspaceId)) throw new Error('HOST_BASELINE_CORRUPT');
  }
  if (hasBindings) {
    const bindings = db.prepare(`SELECT binding_id,workspace_id,collaboration_id,provider_id,
      account_id,native_session_id,state_json FROM session_control
      WHERE provider_id='chatgpt-host-web'`).all() as { binding_id: string; workspace_id: string;
        collaboration_id: string; provider_id: string; account_id: string; native_session_id: string;
        state_json: string }[];
    for (const row of bindings) {
      let state: Record<string, unknown>;
      try { state = object(JSON.parse(row.state_json) as unknown, 'host session state'); }
      catch { throw new Error('HOST_SESSION_BINDING_CORRUPT'); }
      if (state.bindingId !== row.binding_id || state.workspaceId !== row.workspace_id ||
          state.collaborationId !== row.collaboration_id || state.providerId !== row.provider_id ||
          state.accountId !== row.account_id || state.nativeSessionId !== row.native_session_id ||
          typeof state.cursor !== 'string') throw new Error('HOST_SESSION_BINDING_CORRUPT');
      const baseline = readBaseline(db, state.cursor, new Set());
      if (!baseline || baseline.workspaceId !== row.workspace_id || baseline.collaborationId !== row.collaboration_id ||
          baseline.providerId !== row.provider_id || baseline.accountId !== row.account_id ||
          baseline.nativeSessionId !== row.native_session_id) throw new Error('HOST_SESSION_BINDING_CORRUPT');
    }
  }
}

/** Private candidate storage. SessionState.cursor remains the only adopted position. */
export class HostConversationSqlite {
  private readonly db: DatabaseSync;

  constructor(dataDirectory: string) {
    assertPrivateDataDirectory(dataDirectory);
    this.db = new DatabaseSync(join(dataDirectory, 'state.sqlite'));
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.initialize();
    } catch (error) { this.db.close(); throw error; }
  }

  private initialize(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = existingHostTables(this.db);
      if (existing.size > 0 && (existing.size !== HOST_TABLES.length ||
          HOST_TABLES.some((table) => !existing.has(table)))) {
        throw new Error('HOST_CONVERSATION_SCHEMA_INCOMPATIBLE');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS host_conversation_schema (
          id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version>=1)
        );
        CREATE TABLE IF NOT EXISTS host_conversation_accounts (
          account_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind='settings-account-email'),
          exact_source TEXT NOT NULL,
          UNIQUE(provider_id,source_kind,exact_source)
        );
        CREATE TABLE IF NOT EXISTS host_conversation_baselines (
          cursor TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
          collaboration_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE RESTRICT,
          provider_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES host_conversation_accounts(account_id) ON DELETE RESTRICT,
          native_session_id TEXT NOT NULL,
          parent_cursor TEXT REFERENCES host_conversation_baselines(cursor) ON DELETE RESTRICT,
          baseline_json TEXT NOT NULL, record_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS host_conversation_parent ON host_conversation_baselines(parent_cursor);
      `);
      if (existing.size === 0) this.db.prepare('INSERT INTO host_conversation_schema(id,version) VALUES (1,1)').run();
      verifySchema(this.db);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  accountKey(providerId: string, sourceKind: 'settings-account-email', exactSource: string): string {
    boundedString(providerId, 'providerId', 256);
    if (sourceKind !== 'settings-account-email') throw new TypeError('Unsupported account source');
    boundedString(exactSource, 'exactSource', 512);
    return this.transaction(() => {
      const id = `hacc_${randomUUID()}`;
      this.db.prepare(`INSERT OR IGNORE INTO host_conversation_accounts
        (account_id,provider_id,source_kind,exact_source) VALUES (?,?,?,?)`)
        .run(id, providerId, sourceKind, exactSource);
      const row = this.db.prepare(`SELECT account_id FROM host_conversation_accounts
        WHERE provider_id=? AND source_kind=? AND exact_source=?`)
        .get(providerId, sourceKind, exactSource) as { account_id: string } | undefined;
      if (!row) throw new Error('ACCOUNT_MAPPING_UNAVAILABLE');
      return row.account_id;
    });
  }

  putBaseline(value: HostBaselineInput): string {
    const input = validateInput(value);
    return this.transaction(() => {
      const scope = this.db.prepare('SELECT 1 FROM collaborations WHERE id=? AND workspace_id=?')
        .get(input.collaborationId, input.workspaceId);
      if (!scope) throw new Error('HOST_BASELINE_SCOPE_MISMATCH');
      const account = this.db.prepare('SELECT provider_id FROM host_conversation_accounts WHERE account_id=?')
        .get(input.accountId) as { provider_id: string } | undefined;
      if (!account || account.provider_id !== input.providerId) throw new Error('HOST_BASELINE_ACCOUNT_MISMATCH');
      if (input.parentCursor !== null) {
        const parent = readBaseline(this.db, input.parentCursor, new Set());
        if (!parent || parent.workspaceId !== input.workspaceId || parent.collaborationId !== input.collaborationId ||
            parent.providerId !== input.providerId || parent.accountId !== input.accountId ||
            parent.nativeSessionId !== input.nativeSessionId || !samePrefix(parent, input)) {
          throw new Error('HOST_BASELINE_PARENT_MISMATCH');
        }
      }
      const cursor = `hcur_${randomUUID()}`;
      const baseline: HostBaseline = { ...input, cursor, schemaVersion: 1 };
      const json = canonical(baseline);
      const hash = createHash('sha256').update(json).digest('hex');
      this.db.prepare(`INSERT INTO host_conversation_baselines
        (cursor,workspace_id,collaboration_id,provider_id,account_id,native_session_id,parent_cursor,baseline_json,record_hash)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(cursor, input.workspaceId, input.collaborationId, input.providerId,
          input.accountId, input.nativeSessionId, input.parentCursor, json, hash);
      return cursor;
    });
  }

  getBaseline(cursor: string): HostBaseline | null {
    boundedString(cursor, 'cursor', 128);
    return readBaseline(this.db, cursor, new Set());
  }

  close(): void { this.db.close(); }
}

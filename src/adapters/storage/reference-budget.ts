import type { DatabaseSync } from 'node:sqlite';
import type { PersistedSnapshot } from '../repository/snapshots.js';

const MiB = 1024 * 1024;
export interface ReferenceLimits { readonly maxRows: number; readonly maxMetadataBytes: number;
  readonly maxContentWorkBytes: number; readonly maxFileBytes: number; readonly maxSnapshotBytes: number }
export const DEFAULT_REFERENCE_LIMITS: Readonly<ReferenceLimits> = Object.freeze({
  maxRows: 10_000, maxMetadataBytes: 16 * MiB, maxContentWorkBytes: 2 * 1024 * MiB,
  maxFileBytes: 16 * MiB, maxSnapshotBytes: 128 * MiB,
});
export const MAX_REFERENCE_PAYLOAD_BYTES = Math.ceil(DEFAULT_REFERENCE_LIMITS.maxSnapshotBytes / 3) * 4 +
  DEFAULT_REFERENCE_LIMITS.maxMetadataBytes;
export type ReferenceBudget = { limits: ReferenceLimits; rows: number; metadataBytes: number; contentWorkBytes: number };
export type ReferenceRow = Record<string, unknown>;

function limit(): never { throw new Error('REFERENCE_CAPACITY_EXCEEDED'); }
export function createReferenceBudget(overrides: Partial<ReferenceLimits> = {}): ReferenceBudget {
  if (Object.keys(overrides).some(key => !(key in DEFAULT_REFERENCE_LIMITS))) limit();
  const limits = { ...DEFAULT_REFERENCE_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_REFERENCE_LIMITS) as (keyof ReferenceLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_REFERENCE_LIMITS[key]) limit();
  }
  return { limits, rows: 0, metadataBytes: 0, contentWorkBytes: 0 };
}

function payload(table: string): { column: string; files: string; manifest: string } | undefined {
  if (table === 'snapshots') return { column: 'snapshot_json', files: '$.files', manifest: '$.manifest' };
  if (table === 'daily_project_materials') return { column: 'material_json', files: '$.snapshot.files', manifest: '$.snapshot.manifest' };
  return undefined;
}
export function referenceCellByteLimit(table: string, column: string): number {
  return payload(table)?.column === column ? MAX_REFERENCE_PAYLOAD_BYTES : DEFAULT_REFERENCE_LIMITS.maxMetadataBytes;
}

/** SQL aggregate only: bound UTF-8 bytes and maximum row before loading any payload into JavaScript. */
function reserveRows(db: DatabaseSync, table: string, columns: readonly string[], budget: ReferenceBudget): number {
  if (!/^[a-z_]+$/.test(table) || columns.some(column => !/^[a-z_]+$/.test(column))) limit();
  const rowBytes = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
  const base = db.prepare(`SELECT count(*) AS n,COALESCE(sum(${rowBytes}),0) AS bytes,COALESCE(max(${rowBytes}),0) AS max_row FROM ${table}`)
    .get() as { n: number; bytes: number; max_row: number };
  const unit = payload(table);
  const maxRow = unit ? Math.ceil(budget.limits.maxSnapshotBytes / 3) * 4 + budget.limits.maxMetadataBytes : budget.limits.maxMetadataBytes;
  if (![base.n, base.bytes, base.max_row].every(value => Number.isSafeInteger(value) && value >= 0) ||
      base.n > budget.limits.maxRows - budget.rows || base.max_row > maxRow) limit();
  let encodedBytes = 0, decodedBytes = 0, manifestRows = 0;
  if (unit && base.n) {
    const c = unit.column;
    if (!columns.includes(c) || db.prepare(`SELECT 1 FROM ${table} WHERE json_valid(${c})!=1 LIMIT 1`).get()) limit();
    if (db.prepare(`SELECT 1 FROM ${table} WHERE json_type(${c},'${unit.files}') IS NOT 'object' OR
      json_type(${c},'${unit.manifest}') IS NOT 'array' OR json_array_length(${c},'${unit.manifest}')!=
      (SELECT count(*) FROM json_each(${c},'${unit.files}')) LIMIT 1`).get()) limit();
    const encoded = `(SELECT COALESCE(sum(length(CAST(f.value AS BLOB))),0) FROM json_each(${c},'${unit.files}') f)`;
    const decoded = `(SELECT COALESCE(sum(json_extract(m.value,'$.sizeBytes')),0) FROM json_each(${c},'${unit.manifest}') m)`;
    const entries = `json_array_length(${c},'${unit.manifest}')`;
    const sizes = db.prepare(`SELECT COALESCE(sum(${encoded}),0) AS encoded,COALESCE(sum(${decoded}),0) AS decoded,
      COALESCE(sum(${entries}),0) AS entries,COALESCE(max(${decoded}),0) AS largest FROM ${table}`)
      .get() as { encoded: number; decoded: number; entries: number; largest: number };
    if (![sizes.encoded, sizes.decoded, sizes.entries, sizes.largest].every(value => Number.isSafeInteger(value) && value >= 0) ||
        sizes.largest > budget.limits.maxSnapshotBytes) limit();
    if (db.prepare(`WITH file_metadata AS MATERIALIZED (
      SELECT t.rowid AS record_id,f.key AS path,f.type AS type,length(CAST(f.value AS BLOB)) AS encoded_length
      FROM ${table} t,json_each(t.${c},'${unit.files}') f
    ), manifest_metadata AS MATERIALIZED (
      SELECT t.rowid AS record_id,json_extract(m.value,'$.path') AS path,m.type AS type,
        json_type(m.value,'$.sizeBytes') AS size_type,json_extract(m.value,'$.sizeBytes') AS size_bytes
      FROM ${table} t,json_each(t.${c},'${unit.manifest}') m
    ) SELECT 1 FROM manifest_metadata m
      LEFT JOIN file_metadata f ON f.record_id=m.record_id AND f.path=m.path
      WHERE m.type!='object' OR m.size_type IS NOT 'integer' OR m.size_bytes<0 OR
      m.size_bytes>? OR f.type IS NOT 'text' OR
      f.encoded_length!=4*CAST((m.size_bytes+2)/3 AS INTEGER) LIMIT 1`)
      .get(budget.limits.maxFileBytes)) limit();
    encodedBytes = sizes.encoded; decodedBytes = sizes.decoded; manifestRows = sizes.entries;
  }
  // Base64 values are content; their keys/JSON syntax and all other fields remain metadata.
  const metadata = base.bytes - encodedBytes;
  if (metadata < 0 || metadata > budget.limits.maxMetadataBytes - budget.metadataBytes ||
      manifestRows > budget.limits.maxRows - budget.rows - base.n ||
      encodedBytes + decodedBytes > budget.limits.maxContentWorkBytes - budget.contentWorkBytes) limit();
  budget.rows += base.n + manifestRows; budget.metadataBytes += metadata;
  budget.contentWorkBytes += encodedBytes + decodedBytes;
  return encodedBytes;
}

export function boundedReferenceRows(db: DatabaseSync, table: string, columns: readonly string[], budget: ReferenceBudget): Iterable<ReferenceRow> {
  reserveRows(db, table, columns, budget);
  return db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).iterate() as Iterable<ReferenceRow>;
}

const referenceTables: [string, string[]][] = [
  ['workspaces', ['id']], ['collaborations', ['id', 'workspace_id', 'opened_by']], ['working_copies', ['id', 'workspace_id']],
  ['snapshots', ['id', 'workspace_id', 'collaboration_id', 'working_copy_id', 'snapshot_json']],
  ['daily_project_materials', ['id', 'workspace_id', 'material_json']],
  ['daily_project_material_heads', ['workspace_id', 'principal', 'audience', 'recipient', 'material_id']],
  ['context_proposals', ['id', 'workspace_id', 'collaboration_id', 'proposal_json']],
  ['context_revisions', ['id', 'workspace_id', 'collaboration_id', 'revision_json']], ['context_heads', ['workspace_id', 'collaboration_id', 'revision_id']],
  ['bundles', ['id', 'workspace_id', 'collaboration_id', 'parent_id', 'input_json', 'manifest_json']],
  ['bundle_context_refs', ['bundle_id', 'workspace_id', 'collaboration_id', 'revision_id']],
  ['bundle_snapshot_refs', ['bundle_id', 'workspace_id', 'collaboration_id', 'snapshot_id']],
  ['decision_proposals', ['id', 'workspace_id', 'collaboration_id', 'proposal_json']],
  ['baseline_reviews', ['id', 'workspace_id', 'collaboration_id', 'review_json']], ['decisions', ['id', 'workspace_id', 'collaboration_id', 'decision_json']],
];

/** Reserve the same reference columns as restoration; extra logical columns remain migration metadata. */
export function reserveReferenceTableCapacity(db: DatabaseSync, table: string, availableColumns: readonly string[],
  budget: ReferenceBudget): number {
  const known = referenceTables.find(([name]) => name === table);
  if (!known) return 0;
  const columns = known[1].filter(column => availableColumns.includes(column));
  return columns.length ? reserveRows(db, table, columns, budget) : 0;
}

/** Mutation-time capacity guard, not the restoration integrity audit. Only SQL size/count aggregates are performed. */
export function assertReferenceCapacity(db: DatabaseSync, overrides: Partial<ReferenceLimits> = {}): void {
  const budget = createReferenceBudget(overrides);
  for (const [table, columns] of referenceTables) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) reserveRows(db, table, columns, budget);
  }
}

/** Validate declared lengths and Base64 shape before allocating decoded file buffers. Hash/path/ID checks still follow. */
export function assertSnapshotCapacityHeader(value: PersistedSnapshot, limits: ReferenceLimits = DEFAULT_REFERENCE_LIMITS): void {
  if (!value || !value.files || typeof value.files !== 'object' || Array.isArray(value.files) || !Array.isArray(value.manifest) ||
      value.manifest.length !== Object.keys(value.files).length || value.manifest.length > limits.maxRows) limit();
  let decoded = 0;
  for (const file of value.manifest) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > limits.maxFileBytes) limit();
    const bytes = value.files[file.path];
    const padding = (3 - file.sizeBytes % 3) % 3;
    if (typeof bytes !== 'string' || bytes.length !== Math.ceil(file.sizeBytes / 3) * 4 || /[^A-Za-z0-9+/=]/u.test(bytes) ||
        (padding === 0 ? bytes.includes('=') : bytes.indexOf('=') !== bytes.length - padding || !bytes.endsWith('='.repeat(padding)))) limit();
    decoded += file.sizeBytes;
    if (decoded > limits.maxSnapshotBytes) limit();
  }
}

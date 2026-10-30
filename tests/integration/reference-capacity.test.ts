import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, mock } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { assertReferenceCapacity, assertSnapshotCapacityHeader, createReferenceBudget,
  DEFAULT_REFERENCE_LIMITS, referenceCellByteLimit, boundedReferenceRows } from '../../src/adapters/storage/reference-budget.js';
import { inspectLogicalMigrationRows } from '../../src/cli/migrate-installation.js';

test('migration aggregate separates frozen content from logical metadata with shared reference limits', () => {
  const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'original.bin': Buffer.alloc(4096, 37) }).toPersisted();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE snapshots(id TEXT,snapshot_json TEXT); CREATE TABLE daily_project_materials(id TEXT,material_json TEXT)');
    db.prepare('INSERT INTO snapshots VALUES (?,?)').run('snapshot', JSON.stringify(snapshot));
    db.prepare('INSERT INTO daily_project_materials VALUES (?,?)').run('material', JSON.stringify({ snapshot }));
    const limits = { maxLogicalBytes: 4096, referenceLimits: { maxMetadataBytes: 4096, maxContentWorkBytes: 20_000 } };
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) * 2 > limits.maxLogicalBytes);
    const rows = inspectLogicalMigrationRows(db, limits);
    assert.equal(rows.get('snapshots')?.rowHashes.size, 1);
    assert.equal(rows.get('daily_project_materials')?.rowHashes.size, 1);
    assert.throws(() => inspectLogicalMigrationRows(db, { ...limits,
      referenceLimits: { ...limits.referenceLimits, maxContentWorkBytes: 19_000 } }), /REFERENCE_CAPACITY_EXCEEDED/);
    assert.throws(() => inspectLogicalMigrationRows(db, { ...limits,
      referenceLimits: { ...limits.referenceLimits, maxMetadataBytes: 512 } }), /REFERENCE_CAPACITY_EXCEEDED/);
  } finally { db.close(); }
});

test('migration aggregate keeps ordinary metadata bounded and test limits cannot expand production bounds', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE ordinary(note TEXT)');
    const insert = db.prepare('INSERT INTO ordinary VALUES (?)');
    insert.run('x'.repeat(2500)); insert.run('y'.repeat(2500));
    assert.throws(() => inspectLogicalMigrationRows(db, { maxLogicalBytes: 4096 }), /INSTALLATION_MIGRATION_UNSAFE/);
    assert.throws(() => inspectLogicalMigrationRows(db, { maxLogicalBytes: 256 * 1024 * 1024 + 1 }), /INSTALLATION_MIGRATION_UNSAFE/);
    assert.throws(() => inspectLogicalMigrationRows(db, { referenceLimits: {
      maxContentWorkBytes: DEFAULT_REFERENCE_LIMITS.maxContentWorkBytes + 1 } }), /REFERENCE_CAPACITY_EXCEEDED/);
  } finally { db.close(); }
});

test('migration aggregate keeps reference extra columns in ordinary logical metadata', () => {
  const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'original.bin': Buffer.alloc(4096, 37) }).toPersisted();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE snapshots(id TEXT,snapshot_json TEXT,extra TEXT)');
    db.prepare('INSERT INTO snapshots VALUES (?,?,?)').run('snapshot', JSON.stringify(snapshot), 'x'.repeat(5000));
    const referenceLimits = { maxMetadataBytes: 4096, maxContentWorkBytes: 20_000 };
    assert.throws(() => inspectLogicalMigrationRows(db, { maxLogicalBytes: 4096, referenceLimits }), /INSTALLATION_MIGRATION_UNSAFE/);
    assert.equal(inspectLogicalMigrationRows(db, { maxLogicalBytes: 8192, referenceLimits }).get('snapshots')?.rowHashes.size, 1);
  } finally { db.close(); }
});

test('logical migration accepts a 13MiB original in snapshot/material payload cells while ordinary cells stay bounded', () => {
  const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'original.bin': Buffer.alloc(13 * 1024 * 1024, 37) }).toPersisted();
  const encoded = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(encoded) > 16 * 1024 * 1024);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE snapshots(id TEXT,snapshot_json TEXT); CREATE TABLE daily_project_materials(id TEXT,material_json TEXT)');
    db.prepare('INSERT INTO snapshots VALUES (?,?)').run('snapshot', encoded);
    db.prepare('INSERT INTO daily_project_materials VALUES (?,?)').run('material', JSON.stringify({ snapshot }));
    const rows = inspectLogicalMigrationRows(db);
    assert.equal(rows.get('snapshots')?.rowHashes.size, 1);
    assert.equal(rows.get('daily_project_materials')?.rowHashes.size, 1);
    assert.ok(referenceCellByteLimit('snapshots', 'snapshot_json') > 16 * 1024 * 1024);
    assert.equal(referenceCellByteLimit('snapshots', 'id'), 16 * 1024 * 1024);
  } finally { db.close(); }
  const ordinary = new DatabaseSync(':memory:');
  try {
    ordinary.exec('CREATE TABLE ordinary(note TEXT)');
    ordinary.prepare('INSERT INTO ordinary VALUES (?)').run('x'.repeat(16 * 1024 * 1024 + 1));
    assert.throws(() => inspectLogicalMigrationRows(ordinary), /INSTALLATION_MIGRATION_UNSAFE/);
  } finally { ordinary.close(); }
});

test('capacity overrides only reduce bounds and SQL rejects oversized metadata before payload iteration', () => {
  assert.throws(() => createReferenceBudget({ maxContentWorkBytes: DEFAULT_REFERENCE_LIMITS.maxContentWorkBytes + 1 }));
  assert.throws(() => createReferenceBudget({ maxRows: 0 }));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE context_proposals(id TEXT,workspace_id TEXT,collaboration_id TEXT,proposal_json TEXT)');
    db.prepare('INSERT INTO context_proposals VALUES (?,?,?,?)').run('p', 'w', 'c', JSON.stringify({ goal: 'x'.repeat(2048) }));
    assert.throws(() => assertReferenceCapacity(db, { maxMetadataBytes: 1024 }), /REFERENCE_CAPACITY_EXCEEDED/);
  } finally { db.close(); }
});

test('snapshot headers bound encoded lengths and declared bytes before decoding', () => {
  const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'a.bin': Buffer.from([0, 1]) }).toPersisted();
  assert.doesNotThrow(() => assertSnapshotCapacityHeader(snapshot));
  assert.throws(() => assertSnapshotCapacityHeader({ ...snapshot, files: { 'a.bin': 'AAAA' } }), /REFERENCE_CAPACITY_EXCEEDED/);
  assert.throws(() => assertSnapshotCapacityHeader({ ...snapshot, manifest: [{ ...snapshot.manifest[0]!, sizeBytes: 17 * 1024 * 1024 }] }), /REFERENCE_CAPACITY_EXCEEDED/);
});

test('SQL reference metadata is materialized once and isolated by physical snapshot record', () => {
  const db = new DatabaseSync(':memory:');
  const prepare = db.prepare.bind(db);
  const validationQueries: string[] = [];
  try {
    db.exec('CREATE TABLE snapshots(id TEXT,collaboration_id TEXT,snapshot_json TEXT)');
    const insert = prepare('INSERT INTO snapshots VALUES (?,?,?)');
    for (const [collaboration, size] of [['first', 1], ['second', 4]] as const) {
      const snapshot = createSnapshotFromFiles('copy', 'fixed', { 'same.bin': Buffer.alloc(size) }).toPersisted();
      insert.run('same-id', collaboration, JSON.stringify(snapshot));
    }
    mock.method(db, 'prepare', (sql: string) => {
      if (sql.includes('LEFT JOIN')) validationQueries.push(sql);
      return prepare(sql);
    });
    const budget = createReferenceBudget();
    assert.equal([...boundedReferenceRows(db, 'snapshots', ['id', 'collaboration_id', 'snapshot_json'], budget)].length, 2);
    assert.equal(budget.rows, 4);
    assert.equal(validationQueries.length, 1);
    const plan = prepare(`EXPLAIN QUERY PLAN ${validationQueries[0]}`).all(DEFAULT_REFERENCE_LIMITS.maxFileBytes);
    const details = plan.map(row => String(row.detail));
    assert.ok(details.some(detail => detail === 'MATERIALIZE file_metadata'), JSON.stringify(details));
    assert.equal(details.filter(detail => /SCAN f VIRTUAL TABLE/.test(detail)).length, 1);
  } finally { mock.restoreAll(); db.close(); }
});

test('SQL reference metadata preserves malformed entry rejection for snapshots and materials', () => {
  const valid = createSnapshotFromFiles('copy', 'fixed', { 'a.bin': Buffer.from([1]) }).toPersisted();
  const mutations = [
    { ...valid, files: { 'other.bin': 'AQ==' } },
    { ...valid, files: { 'a.bin': 1234 } },
    { ...valid, files: { 'a.bin': 'AQ==AQ==' } },
    ...[-1, 0.5, 17 * 1024 * 1024].map(sizeBytes => ({ ...valid, manifest: [{ ...valid.manifest[0]!, sizeBytes }] })),
  ];
  for (const table of ['snapshots', 'daily_project_materials']) {
    const column = table === 'snapshots' ? 'snapshot_json' : 'material_json';
    for (const snapshot of mutations) {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec(`CREATE TABLE ${table}(id TEXT,${column} TEXT)`);
        db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run('entry', JSON.stringify(table === 'snapshots' ? snapshot : { snapshot }));
        assert.throws(() => boundedReferenceRows(db, table, ['id', column], createReferenceBudget()), /REFERENCE_CAPACITY_EXCEEDED/);
      } finally { db.close(); }
    }
  }
});

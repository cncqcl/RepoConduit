import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { establishBrowserDownloadBaseline } from '../../src/adapters/transfers/browser-download.js';
import { BrowserCaptureSqlite, inspectBrowserCaptureDatabase, type BrowserCaptureInput } from '../../src/adapters/storage/browser-capture-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
function fixture(run: (file: string, input: BrowserCaptureInput) => void): void {
  const parent = resolve(process.cwd(), '.local', 'browser-capture-store-fixtures');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'rcac-browser-store-'));
  assert.equal(dirname(root), parent);
  let passed = false;
  try {
    const input: BrowserCaptureInput = {
      id: hash('intent-1'), workspaceId: 'ws-1', collaborationId: 'col-1', bundleId: 'bundle-1', path: 'files/report.bin',
      principal: 'local', audience: 'local-os', recipient: 'local@host', grantId: 'grant-1', accountKey: 'hacc_11111111-1111-4111-8111-111111111111',
      nativeSessionId: '22222222-2222-4222-8222-222222222222', nativeMessageId: '33333333-3333-4333-8333-333333333333', filename: 'report.bin',
      sourceFingerprint: hash('source-1'), expectedSha256: hash('expected'), expectedSize: 8,
      bindingFingerprint: null,
      baseline: establishBrowserDownloadBaseline(root, 'report.bin', []),
    };
    run(join(root, 'state.sqlite'), input);
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test('intent survives restart, exact replay is idempotent and changed replay conflicts', () => fixture((file, input) => {
  let store = new BrowserCaptureSqlite(file);
  try {
    assert.equal(store.get(input.id), null);
    const prepared = store.prepare(input);
    assert.equal(prepared.state, 'prepared');
    assert.equal(prepared.candidateFingerprint, null);
    assert.deepEqual(store.prepare({ ...input, baseline: structuredClone(input.baseline) }), prepared);
    assert.throws(() => store.prepare({ ...input, expectedSize: 7 }), /CONFLICT/);
    assert.throws(() => store.prepare({ ...input, baseline: { ...input.baseline,
      root: join(dirname(file), 'different-download-root') } }), /CONFLICT/);
  } finally { store.close(); }
  store = new BrowserCaptureSqlite(file);
  try { assert.deepEqual(store.get(input.id)?.input, structuredClone(input)); }
  finally { store.close(); }
}));

test('indexed input survives restart while old missing-index inputs remain distinct', () => fixture((file, input) => {
  let store = new BrowserCaptureSqlite(file);
  const indexed = { ...input, attachmentIndex: 7 };
  store.prepare(indexed); store.close();
  store = new BrowserCaptureSqlite(file);
  try {
    assert.deepEqual(store.get(input.id)?.input, structuredClone(indexed));
    assert.throws(() => store.prepare(input), /CONFLICT/);
    assert.throws(() => store.prepare({ ...indexed, attachmentIndex: 2 }), /CONFLICT/);
  } finally { store.close(); }
}));

test('retry claim atomically fences one unresolved predecessor and preserves its bytes', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  const context = { browserId: 'browser-2', originalTabId: 'tab-10', retryTabId: 'tab-12' };
  const next = { ...input, id: hash('retry-1'), grantId: 'replacement', baseline: structuredClone(input.baseline) };
  try {
    store.prepare(input);
    store.transition(input.id, 'prepared', 'capturing');
    store.transition(input.id, 'capturing', 'reconcile_required');
    const db = new DatabaseSync(file, { readOnly: true });
    const before = db.prepare('SELECT input_json,input_hash,state FROM browser_capture_intents WHERE id=?').get(input.id);
    db.close();
    for (const changed of [
      { ...next, workspaceId: 'other-workspace' },
      { ...next, accountKey: 'hacc_44444444-4444-4444-8444-444444444444' },
      { ...next, path: 'files/other.bin' },
    ]) assert.throws(() => store.prepareRetry(changed, input.id, context), /CONFLICT/);
    const claimed = store.prepareRetry(next, input.id, context);
    assert.equal(claimed.state, 'prepared');
    assert.deepEqual(store.prepareRetry(next, input.id, context), claimed);
    assert.deepEqual(store.getRetry(next.id), { predecessorId: input.id, successorId: next.id, ...context });
    assert.throws(() => store.assertCaptureWritable(input.id), /CONFLICT/);
    assert.doesNotThrow(() => store.assertCaptureWritable(next.id));
    const afterDb = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(afterDb.prepare('SELECT input_json,input_hash,state FROM browser_capture_intents WHERE id=?').get(input.id), before);
    afterDb.close();
    assert.throws(() => store.prepareRetry({ ...next, id: hash('retry-2') }, input.id, context), /CONFLICT/);
    assert.throws(() => store.prepareRetry(next, next.id, context), /CONFLICT|INVALID_ARGUMENT/);
  } finally { store.close(); }
}));

test('verified retry releases root admission while original unknown remains inventoried', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  try {
    store.prepare(input);
    store.transition(input.id, 'prepared', 'capturing');
    store.transition(input.id, 'capturing', 'reconcile_required');
    const next = { ...input, id: hash('retry-complete') };
    store.prepareRetry(next, input.id, { browserId: 'browser2', originalTabId: 'tab10', retryTabId: 'tab12' });
    assert.throws(() => store.prepare({ ...input, id: hash('other-pending') }), /BROWSER_CAPTURE_ROOT_BUSY/);
    store.transition(next.id, 'prepared', 'capturing');
    store.transition(next.id, 'capturing', 'verified_candidate', hash('candidate'));
    assert.equal(store.unresolvedForRoot(input.baseline.root).length, 1);
    const later = { ...input, id: hash('later-file'), path: 'files/later.bin', filename: 'later.bin',
      baseline: { ...input.baseline, expectedFilename: 'later.bin' } };
    assert.equal(store.prepare(later).state, 'prepared');
  } finally { store.close(); }
}));

test('prepared source change retires the exact intent and releases only its root admission', () => fixture((file, input) => {
  const a = new BrowserCaptureSqlite(file), b = new BrowserCaptureSqlite(file);
  const next = { ...input, id: hash('next-intent') };
  try {
    a.prepare(input);
    assert.throws(() => b.prepare(next), /BROWSER_CAPTURE_ROOT_BUSY/);
    const retired = a.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('source-2'));
    assert.equal(retired.state, 'aborted_before_capture');
    assert.equal(retired.abortReason, 'source_changed_before_capture');
    assert.deepEqual(retired.input, structuredClone(input));
    assert.equal(b.unresolvedForRoot(input.baseline.root).length, 0);
    assert.equal(b.prepare(next).state, 'prepared');
    assert.throws(() => a.transition(input.id, 'prepared', 'capturing'), /CONFLICT/);
    assert.throws(() => a.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('source-3')), /CONFLICT/);
  } finally { a.close(); b.close(); }
}));

test('prepared abort and capturing transition are mutually exclusive across stores', () => fixture((file, input) => {
  const a = new BrowserCaptureSqlite(file), b = new BrowserCaptureSqlite(file);
  try {
    a.prepare(input);
    a.transition(input.id, 'prepared', 'capturing');
    assert.throws(() => b.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('new')), /CONFLICT/);
    a.transition(input.id, 'capturing', 'reconcile_required');
    assert.throws(() => b.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('new')), /CONFLICT/);
  } finally { a.close(); b.close(); }
  const c = new BrowserCaptureSqlite(file);
  try {
    assert.equal(c.get(input.id)?.state, 'reconcile_required');
  } finally { c.close(); }
}));

test('aborting first wins CAS and rejects invalid source changes', () => fixture((file, input) => {
  const a = new BrowserCaptureSqlite(file), b = new BrowserCaptureSqlite(file);
  try {
    a.prepare(input);
    assert.throws(() => a.abortPreparedForSourceChange(input.id, hash('wrong'), hash('new')), /CONFLICT/);
    assert.throws(() => a.abortPreparedForSourceChange(input.id, input.sourceFingerprint, input.sourceFingerprint), /INVALID_ARGUMENT/);
    assert.throws(() => a.abortPreparedForSourceChange(input.id, input.sourceFingerprint, 'bad'), /INVALID_ARGUMENT/);
    a.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('new'));
    assert.throws(() => b.transition(input.id, 'prepared', 'capturing'), /CONFLICT/);
    assert.throws(() => b.prepare(input), /CONFLICT/);
  } finally { a.close(); b.close(); }
}));

test('retirement metadata corruption is rejected by get and read-only inspection', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  store.prepare(input); store.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('new')); store.close();
  const db = new DatabaseSync(file);
  try {
    db.prepare('UPDATE browser_capture_intents SET abort_reason=? WHERE id=?').run('unknown_reason', input.id);
    assert.throws(() => inspectBrowserCaptureDatabase(db), /CORRUPT/);
  } finally { db.close(); }
  const reopened = new BrowserCaptureSqlite(file);
  try { assert.throws(() => reopened.get(input.id), /CORRUPT/); }
  finally { reopened.close(); }
}));

test('version-one intent migrates with byte-identical canonical input and hash', () => fixture((file, input) => {
  const json = canonical(input), inputHash = hash(json);
  const priorVerified = { ...input, id: hash('legacy-verified') };
  const verifiedJson = canonical(priorVerified), verifiedHash = hash(verifiedJson);
  const old = new DatabaseSync(file);
  try {
    old.exec('CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))');
    old.exec(`CREATE TABLE browser_capture_intents (
  id TEXT PRIMARY KEY, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','capturing','verified_candidate','reconcile_required')),
  candidate_fingerprint TEXT
)`);
    old.exec('INSERT INTO browser_capture_schema VALUES (1,1)');
    old.prepare("INSERT INTO browser_capture_intents VALUES (?,?,?,'prepared',NULL)").run(input.id, json, inputHash);
    old.prepare("INSERT INTO browser_capture_intents VALUES (?,?,?,'verified_candidate',?)")
      .run(priorVerified.id, verifiedJson, verifiedHash, hash('candidate'));
  } finally { old.close(); }
  const legacyReadOnly = new DatabaseSync(file, { readOnly: true });
  try {
    const records = inspectBrowserCaptureDatabase(legacyReadOnly);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(row => row.state).sort(), ['prepared', 'verified_candidate']);
    assert.ok(records.every(row => row.abortReason === null));
    assert.equal(legacyReadOnly.prepare('SELECT version FROM browser_capture_schema WHERE id=1').get()?.version, 1);
  } finally { legacyReadOnly.close(); }
  const upgraded = new BrowserCaptureSqlite(file);
  try { assert.equal(upgraded.get(input.id)?.state, 'prepared'); } finally { upgraded.close(); }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT input_json,input_hash,abort_reason FROM browser_capture_intents WHERE id=?')
      .get(input.id) as { input_json: string; input_hash: string; abort_reason: string | null };
    assert.equal(row.input_json, json); assert.equal(row.input_hash, inputHash); assert.equal(row.abort_reason, null);
    assert.equal(db.prepare('SELECT version FROM browser_capture_schema WHERE id=1').get()?.version, 3);
  } finally { db.close(); }
}));

test('version-two unknown migrates without changing intent bytes or state', () => fixture((file, input) => {
  const db = new DatabaseSync(file);
  const json = canonical(input);
  try {
    db.exec('CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=2))');
    db.exec(`CREATE TABLE browser_capture_intents (
  id TEXT PRIMARY KEY, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','capturing','verified_candidate','reconcile_required','aborted_before_capture')),
  candidate_fingerprint TEXT, abort_reason TEXT
)`);
    db.exec('INSERT INTO browser_capture_schema VALUES (1,2)');
    db.prepare("INSERT INTO browser_capture_intents VALUES (?,?,?,'reconcile_required',NULL,NULL)")
      .run(input.id, json, hash(json));
  } finally { db.close(); }
  const store = new BrowserCaptureSqlite(file);
  try { assert.equal(store.get(input.id)?.state, 'reconcile_required'); } finally { store.close(); }
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    const row = after.prepare('SELECT input_json,input_hash,state FROM browser_capture_intents WHERE id=?')
      .get(input.id) as { input_json: string; input_hash: string; state: string };
    assert.equal(row.input_json, json);
    assert.equal(row.input_hash, hash(json));
    assert.equal(row.state, 'reconcile_required');
    assert.equal(after.prepare('SELECT version FROM browser_capture_schema WHERE id=1').get()?.version, 3);
  } finally { after.close(); }
}));

test('invalid retry relation refuses reopen and read-only inspection', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  try {
    store.prepare(input);
    store.transition(input.id, 'prepared', 'capturing');
    store.transition(input.id, 'capturing', 'reconcile_required');
    store.prepareRetry({ ...input, id: hash('retry') }, input.id,
      { browserId: 'browser2', originalTabId: 'tab10', retryTabId: 'tab12' });
  } finally { store.close(); }
  const db = new DatabaseSync(file);
  try { db.exec("UPDATE browser_capture_retries SET retry_tab_id='tab10'"); }
  finally { db.close(); }
  const read = new DatabaseSync(file, { readOnly: true });
  try { assert.throws(() => inspectBrowserCaptureDatabase(read), /CORRUPT/); }
  finally { read.close(); }
  assert.throws(() => new BrowserCaptureSqlite(file), /CORRUPT/);
}));

test('corrupt version-one row refuses migration and leaves legacy schema unchanged', () => fixture((file, input) => {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))');
    db.exec(`CREATE TABLE browser_capture_intents (
  id TEXT PRIMARY KEY, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','capturing','verified_candidate','reconcile_required')),
  candidate_fingerprint TEXT
)`);
    db.exec('INSERT INTO browser_capture_schema VALUES (1,1)');
    db.prepare("INSERT INTO browser_capture_intents VALUES (?,?,?,'prepared',NULL)")
      .run(input.id, canonical(input), hash('wrong-hash'));
  } finally { db.close(); }
  assert.throws(() => new BrowserCaptureSqlite(file), /CORRUPT/);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(after.prepare('SELECT version FROM browser_capture_schema WHERE id=1').get()?.version, 1);
    assert.equal(after.prepare("SELECT count(*) AS n FROM pragma_table_info('browser_capture_intents') WHERE name='abort_reason'").get()?.n, 0);
    assert.throws(() => inspectBrowserCaptureDatabase(after), /CORRUPT/);
  } finally { after.close(); }
}));

test('two connections enforce CAS and monotonic capture states', () => fixture((file, input) => {
  const a = new BrowserCaptureSqlite(file), b = new BrowserCaptureSqlite(file);
  const fingerprint = hash('candidate');
  try {
    a.prepare(input);
    assert.equal(a.transition(input.id, 'prepared', 'capturing').state, 'capturing');
    assert.throws(() => b.transition(input.id, 'prepared', 'capturing'), /CONFLICT/);
    assert.equal(b.transition(input.id, 'capturing', 'reconcile_required').state, 'reconcile_required');
    assert.throws(() => a.transition(input.id, 'reconcile_required', 'prepared'), /CONFLICT/);
    assert.throws(() => a.transition(input.id, 'reconcile_required', 'verified_candidate'), /INVALID_ARGUMENT/);
    const verifiedCandidate = a.transition(input.id, 'reconcile_required', 'verified_candidate', fingerprint);
    assert.equal(verifiedCandidate.candidateFingerprint, fingerprint);
    assert.throws(() => b.abortPreparedForSourceChange(input.id, input.sourceFingerprint, hash('new')), /CONFLICT/);
    assert.deepEqual(b.transition(input.id, 'verified_candidate', 'verified_candidate', fingerprint), verifiedCandidate);
    assert.throws(() => b.transition(input.id, 'verified_candidate', 'verified_candidate', hash('different')), /CONFLICT/);
    assert.throws(() => b.transition(input.id, 'verified_candidate', 'capturing'), /CONFLICT/);
  } finally { a.close(); b.close(); }
}));

test('prepared and capturing remain durable after reopen and never auto-succeed', () => fixture((file, input) => {
  const a = new BrowserCaptureSqlite(file);
  a.prepare(input); a.transition(input.id, 'prepared', 'capturing'); a.close();
  const b = new BrowserCaptureSqlite(file);
  try { assert.equal(b.get(input.id)?.state, 'capturing'); assert.equal(b.get(input.id)?.candidateFingerprint, null); }
  finally { b.close(); }
}));

test('strict input rejects unsafe paths, raw account identity, size and malformed baseline', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  try {
    for (const invalid of [
      { ...input, id: hash('invalid'), path: '../escape' },
      { ...input, id: hash('invalid'), filename: '../report.bin' },
      { ...input, id: hash('invalid'), accountKey: 'user@example.com' },
      { ...input, id: hash('invalid'), expectedSize: 32 * 1024 * 1024 + 1 },
      { ...input, id: hash('invalid'), expectedSha256: 'not-a-hash' },
      { ...input, id: hash('invalid'), bindingFingerprint: 'not-a-hash' },
      { ...input, id: hash('invalid'), baseline: { ...input.baseline, entries: { 'report.bin': { size: -1 } } } },
      { ...input, id: hash('invalid'), baseline: { ...input.baseline,
        ancestors: [{ ...input.baseline.ancestors[0], ino: Number.MAX_SAFE_INTEGER + 1 }] } },
      { ...input, id: hash('invalid'), baseline: { ...input.baseline,
        ancestors: [{ ...input.baseline.ancestors[0], ino: '001' }] } },
      { ...input, id: hash('invalid'), extra: 'unapproved' },
    ]) assert.throws(() => store.prepare(invalid as BrowserCaptureInput), /INVALID_ARGUMENT/);
    assert.equal(store.get(hash('invalid')), null);
  } finally { store.close(); }
}));

test('tampered stored hash and malformed row fail closed', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file); store.prepare(input); store.close();
  const db = new DatabaseSync(file);
  db.prepare('UPDATE browser_capture_intents SET input_hash=? WHERE id=?').run('0'.repeat(64), input.id);
  db.close();
  const reopened = new BrowserCaptureSqlite(file);
  try { assert.throws(() => reopened.get(input.id), /CORRUPT/); }
  finally { reopened.close(); }
}));

test('partial or incompatible dedicated schema rejects without repair', () => fixture((file) => {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  db.exec('INSERT INTO browser_capture_schema VALUES (1,1)');
  db.close();
  assert.throws(() => new BrowserCaptureSqlite(file), /SCHEMA_INCOMPATIBLE/);
  const inspect = new DatabaseSync(file);
  try { assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='browser_capture_intents'").get()?.n, 0); }
  finally { inspect.close(); }
}));

test('same state database coexists with unrelated table and stores no candidate bytes', () => fixture((file, input) => {
  const state = new SqliteStore(file); state.close();
  const db = new DatabaseSync(file); db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'preserve\')'); db.close();
  const store = new BrowserCaptureSqlite(file);
  try { store.prepare(input); assert.equal(store.get(input.id)?.state, 'prepared'); }
  finally { store.close(); }
  const inspect = new DatabaseSync(file);
  try {
    assert.equal(inspect.prepare('SELECT value FROM unrelated').get()?.value, 'preserve');
    const columns = inspect.prepare('PRAGMA table_info(browser_capture_intents)').all() as { name: string }[];
    assert.deepEqual(columns.map(column => column.name), ['id', 'input_json', 'input_hash', 'state', 'candidate_fingerprint', 'abort_reason']);
  } finally { inspect.close(); }
}));



test('stored invalid candidate fingerprint and oversized JSON fail closed without promotion', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file); store.prepare(input); store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE browser_capture_intents SET state=? WHERE id=?').run('verified_candidate', input.id);
  } finally { db.close(); }
  const reopened = new BrowserCaptureSqlite(file);
  try { assert.throws(() => reopened.get(input.id), /CORRUPT/); }
  finally { reopened.close(); }
  const db2 = new DatabaseSync(file);
  try { db2.prepare('UPDATE browser_capture_intents SET input_json=? WHERE id=?').run('x'.repeat(1024 * 1024 + 1), input.id); }
  finally { db2.close(); }
  const again = new BrowserCaptureSqlite(file);
  try { assert.throws(() => again.get(input.id), /CORRUPT/); }
  finally { again.close(); }
}));

test('version mismatch of dedicated schema fails closed', () => fixture((file) => {
  const store = new BrowserCaptureSqlite(file); store.close();
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA ignore_check_constraints=ON; UPDATE browser_capture_schema SET version=4'); }
  finally { db.close(); }
  assert.throws(() => new BrowserCaptureSqlite(file), /SCHEMA_INCOMPATIBLE/);
}));

test('same-root unresolved intent excludes another id across connections and restart, then verified candidate releases it', () => fixture((file, input) => {
  const a = new BrowserCaptureSqlite(file);
  const b = new BrowserCaptureSqlite(file);
  const another = { ...input, id: hash('intent-2') };
  try {
    const prepared = a.prepare(input);
    assert.deepEqual(b.unresolvedForRoot(input.baseline.root), [prepared]);
    assert.deepEqual(b.prepare(input), prepared);
    assert.throws(() => b.prepare(another), /BROWSER_CAPTURE_ROOT_BUSY/);
    a.transition(input.id, 'prepared', 'capturing');
    assert.throws(() => b.prepare(another), /BROWSER_CAPTURE_ROOT_BUSY/);
  } finally { a.close(); b.close(); }
  const resumed = new BrowserCaptureSqlite(file);
  try {
    assert.throws(() => resumed.prepare(another), /BROWSER_CAPTURE_ROOT_BUSY/);
    resumed.transition(input.id, 'capturing', 'reconcile_required');
    assert.throws(() => resumed.prepare(another), /BROWSER_CAPTURE_ROOT_BUSY/);
    resumed.transition(input.id, 'reconcile_required', 'verified_candidate', hash('candidate'));
    assert.equal(resumed.unresolvedForRoot(input.baseline.root).length, 0);
    assert.equal(resumed.prepare(another).state, 'prepared');
  } finally { resumed.close(); }
}));

test('root comparison is Windows case-insensitive and unresolved listing fails above 128', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  try {
    store.prepare(input);
    const alias = { ...input, id: hash('alias'), baseline: { ...input.baseline,
      root: process.platform === 'win32' ? input.baseline.root.toUpperCase() : input.baseline.root } };
    assert.throws(() => store.prepare(alias), /BROWSER_CAPTURE_ROOT_BUSY/);
    const otherRoot = join(dirname(file), 'other'); mkdirSync(otherRoot);
    assert.deepEqual(store.unresolvedForRoot(otherRoot), []);
  } finally { store.close(); }
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT input_json FROM browser_capture_intents WHERE id=?').get(input.id) as { input_json: string };
    for (let i = 0; i < 128; i++) {
      const id = hash(`extra-${i}`);
      const json = row.input_json.replace(input.id, id);
      db.prepare("INSERT INTO browser_capture_intents (id,input_json,input_hash,state,candidate_fingerprint) VALUES (?,?,?,'prepared',NULL)").run(id, json, hash(json));
    }
  } finally { db.close(); }
  const reopened = new BrowserCaptureSqlite(file);
  try { assert.throws(() => reopened.unresolvedForRoot(input.baseline.root), /BROWSER_CAPTURE_ROOT_LIMIT/); }
  finally { reopened.close(); }
}));

test('Windows root exclusion includes Unicode case aliases', () => fixture((file, input) => {
  if (process.platform !== 'win32') return;
  const store = new BrowserCaptureSqlite(file);
  try {
    const upper = { ...input, baseline: { ...input.baseline, root: `${input.baseline.root}\\É` } };
    store.prepare(upper);
    const lower = { ...upper, id: hash('unicode-alias'), baseline: { ...upper.baseline,
      root: `${input.baseline.root}\\é` } };
    assert.throws(() => store.prepare(lower), /BROWSER_CAPTURE_ROOT_BUSY/);
  } finally { store.close(); }
}));

test('read-only inspector leaves absent dedicated schema absent', () => fixture((file) => {
  const db = new DatabaseSync(file);
  try {
    assert.deepEqual(inspectBrowserCaptureDatabase(db), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'browser_capture_%'").get()?.n, 0);
  } finally { db.close(); }
}));

test('read-only inspector returns verified candidate and unresolved rows without changing them', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  const verifiedCandidate = { ...input, id: hash('verified-candidate-intent') };
  store.prepare(input);
  store.transition(input.id, 'prepared', 'capturing');
  store.transition(input.id, 'capturing', 'verified_candidate', hash('candidate'));
  store.prepare(verifiedCandidate);
  store.close();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = inspectBrowserCaptureDatabase(db);
    assert.deepEqual(rows.map(row => row.state).sort(), ['prepared', 'verified_candidate']);
    assert.deepEqual(rows.map(row => row.input.id).sort(), [input.id, verifiedCandidate.id].sort());
  } finally { db.close(); }
}));

test('read-only inspector rejects partial schema and tampered row', () => fixture((file, input) => {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE browser_capture_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  db.close();
  const partial = new DatabaseSync(file, { readOnly: true });
  try { assert.throws(() => inspectBrowserCaptureDatabase(partial), /SCHEMA_INCOMPATIBLE/); }
  finally { partial.close(); }
  const repair = new DatabaseSync(file); repair.exec('DROP TABLE browser_capture_schema'); repair.close();
  const store = new BrowserCaptureSqlite(file); store.prepare(input); store.close();
  const mutate = new DatabaseSync(file);
  mutate.prepare('UPDATE browser_capture_intents SET input_hash=? WHERE id=?').run('0'.repeat(64), input.id);
  mutate.close();
  const tampered = new DatabaseSync(file, { readOnly: true });
  try { assert.throws(() => inspectBrowserCaptureDatabase(tampered), /CORRUPT/); }
  finally { tampered.close(); }
}));

test('read-only inspector enforces row and aggregate JSON budgets before parsing rows', () => fixture((file) => {
  const store = new BrowserCaptureSqlite(file); store.close();
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT INTO browser_capture_intents (id,input_json,input_hash,state,candidate_fingerprint) VALUES (?,?,?,'prepared',NULL)");
    for (let i = 0; i < 513; i++) insert.run(hash(`row-${i}`), '{}', hash('{}'));
    assert.throws(() => inspectBrowserCaptureDatabase(db), /INSPECT_LIMIT/);
    db.exec('DELETE FROM browser_capture_intents');
    const nearlyOneMiB = 'x'.repeat(1024 * 1024 - 1);
    for (let i = 0; i < 17; i++) insert.run(hash(`large-${i}`), nearlyOneMiB, hash(nearlyOneMiB));
    assert.throws(() => inspectBrowserCaptureDatabase(db), /INSPECT_LIMIT/);
  } finally { db.close(); }
}));

test('bound session fingerprint persists as a 64-hex intent field', () => fixture((file, input) => {
  const store = new BrowserCaptureSqlite(file);
  try {
    const fingerprint = hash('binding-epoch-revision');
    const row = store.prepare({ ...input, bindingFingerprint: fingerprint });
    assert.equal(row.input.bindingFingerprint, fingerprint);
    assert.equal(store.get(input.id)?.input.bindingFingerprint, fingerprint);
  } finally { store.close(); }
}));

test('real filesystem baseline round trips with an exact greater-than-safe inode', () => fixture((file, input) => {
  const large = '19703248369770910';
  const baseline = structuredClone(input.baseline);
  baseline.ancestors[0]!.ino = large;
  const store = new BrowserCaptureSqlite(file);
  try {
    const prepared = store.prepare({ ...input, baseline });
    assert.equal(prepared.input.baseline.ancestors[0]?.ino, large);
    assert.equal(store.get(input.id)?.input.baseline.ancestors[0]?.ino, large);
  } finally { store.close(); }
}));

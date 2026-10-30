import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { HostConversationSqlite, inspectHostConversationDatabase, type HostBaselineInput } from '../../src/adapters/storage/host-conversation-sqlite.js';

function fixture() {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-baseline-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  protectNewDataDirectory(dir);
  base.insertWorkspace({ id: 'workspace-a', name: 'A', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'issue-a', workspaceId: 'workspace-a', openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  base.insertWorkspace({ id: 'workspace-b', name: 'B', canonicalRoot: join(dir, 'project-b'), registeredBy: 'owner' });
  base.insertCollaboration({ id: 'issue-b', workspaceId: 'workspace-b', openedBy: 'owner',
    purpose: 'review', hostThreadId: null, state: 'open' });
  return { dir, file, base, close: () => {
    base.close();
    assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
      /^rcac-host-baseline-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  } };
}

function input(accountId: string): HostBaselineInput {
  return { workspaceId: 'workspace-a', collaborationId: 'issue-a', providerId: 'chatgpt',
    accountId, nativeSessionId: 'chat-a', parentCursor: null,
    messages: [{ nativeMessageId: 'user-1', role: 'user', text: 'question', version: 'v1', turnId: 'turn-1' },
      { nativeMessageId: 'answer-1', role: 'assistant', text: 'answer', version: 'v1', turnId: 'turn-1' }],
    observation: { coverage: 'observed_host_api_page', page: { hasMore: false } } };
}

test('private SQLite account mapping and immutable baseline survive reopen', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    const account = store.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    assert.match(account, /^hacc_/);
    assert.equal(store.accountKey('chatgpt', 'settings-account-email', 'person@example.test'), account);
    assert.notEqual(store.accountKey('chatgpt', 'settings-account-email', 'changed@example.test'), account);
    assert.notEqual(store.accountKey('other', 'settings-account-email', 'person@example.test'), account);
    assert.equal(account.includes('person@example.test'), false);
    const first = input(account);
    const cursor = store.putBaseline(first);
    assert.match(cursor, /^hcur_/);
    assert.deepEqual(store.getBaseline(cursor), { ...first, cursor, schemaVersion: 1 });
    store.close();
    store = new HostConversationSqlite(f.dir);
    assert.equal(store.accountKey('chatgpt', 'settings-account-email', 'person@example.test'), account);
    assert.deepEqual(store.getBaseline(cursor), { ...first, cursor, schemaVersion: 1 });
    assert.equal(store.getBaseline('hcur_missing'), null);
  } finally { store?.close(); f.close(); }
});

test('parent chain requires same scope, account, chat and exact message prefix', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    const account = store.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    const other = store.accountKey('chatgpt', 'settings-account-email', 'other@example.test');
    const first = input(account);
    const parentCursor = store.putBaseline(first);
    const child: HostBaselineInput = { ...first, parentCursor,
      messages: [...first.messages, { nativeMessageId: 'user-2', role: 'user', text: 'follow up',
        version: 'v1', turnId: 'turn-2' }] };
    const childCursor = store.putBaseline(child);
    assert.deepEqual(store.getBaseline(childCursor), { ...child, cursor: childCursor, schemaVersion: 1 });
    assert.throws(() => store!.putBaseline({ ...child, parentCursor: 'missing' }));
    assert.throws(() => store!.putBaseline({ ...child, workspaceId: 'workspace-b', collaborationId: 'issue-b' }));
    assert.throws(() => store!.putBaseline({ ...child, accountId: other }));
    assert.throws(() => store!.putBaseline({ ...child, nativeSessionId: 'forked-chat-a' }));
    assert.throws(() => store!.putBaseline({ ...child, messages: child.messages.slice(1) }));
    assert.throws(() => store!.putBaseline({ ...child,
      messages: [{ ...first.messages[0]!, text: 'edited old text' }, ...child.messages.slice(1)] }));
    assert.throws(() => store!.putBaseline({ ...first, accountId: 'unmapped-account' }));
  } finally { store?.close(); f.close(); }
});

test('candidate baseline does not advance the adopted session cursor', () => {
  const f = fixture();
  let host: HostConversationSqlite | undefined;
  let session: SessionControlSqlite | undefined;
  try {
    host = new HostConversationSqlite(f.dir);
    const account = host.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    session = new SessionControlSqlite(f.file);
    session.create({ bindingId: 'binding-a', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'chatgpt', accountId: account, nativeSessionId: 'chat-a', cursor: 'adopted-old',
      control: 'human_controlled', epoch: 0, revision: 0 });
    const cursor = host.putBaseline(input(account));
    assert.equal(host.getBaseline(cursor)?.cursor, cursor);
    assert.equal(session.get('binding-a')?.cursor, 'adopted-old');
  } finally { session?.close(); host?.close(); f.close(); }
});

test('input rejects unknown fields, undefined JSON, invalid messages and oversized evidence', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    const account = store.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    assert.throws(() => store!.putBaseline({ ...input(account), extra: true } as never));
    assert.throws(() => store!.putBaseline({ ...input(account), observation: { value: undefined } }));
    assert.throws(() => store!.putBaseline({ ...input(account), observation: { value: 'x'.repeat(1_048_577) } }));
    assert.throws(() => store!.putBaseline({ ...input(account), messages: [
      { ...input(account).messages[0]!, role: 'tool' as never }] }));
    assert.throws(() => store!.putBaseline({ ...input(account), messages: [
      input(account).messages[0]!, input(account).messages[0]!] }));
    assert.throws(() => store!.accountKey('', 'settings-account-email', 'person@example.test'));
  } finally { store?.close(); f.close(); }
});

test('two attachment observations fit the bounded baseline and survive reopen', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    const account = store.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    // Two native attachment Copy records exceed 10,000 JSON nodes while remaining below 1 MiB.
    const observation = { firstAttachment: Array(6_000).fill('attribute'),
      secondAttachment: Array(6_000).fill('attribute') };
    const value = { ...input(account), observation };
    const cursor = store.putBaseline(value);
    store.close(); store = new HostConversationSqlite(f.dir);
    assert.deepEqual(store.getBaseline(cursor), { ...value, cursor, schemaVersion: 1 });
    assert.throws(() => store!.putBaseline({ ...value,
      observation: { excessive: Array(20_000).fill('attribute') } }), /too complex/);
  } finally { store?.close(); f.close(); }
});

test('baseline tampering and incompatible adapter schema are rejected without changing other tables', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    const account = store.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    const cursor = store.putBaseline(input(account));
    store.close(); store = undefined;
    const db = new DatabaseSync(f.file);
    try {
      db.prepare('UPDATE host_conversation_baselines SET baseline_json=? WHERE cursor=?')
        .run('{"schemaVersion":1,"cursor":"tampered"}', cursor);
    } finally { db.close(); }
    store = new HostConversationSqlite(f.dir);
    assert.throws(() => store!.getBaseline(cursor));
    store.close(); store = undefined;
    const db2 = new DatabaseSync(f.file);
    try { db2.prepare('UPDATE host_conversation_schema SET version=2 WHERE id=1').run(); }
    finally { db2.close(); }
    assert.throws(() => new HostConversationSqlite(f.dir));
    const db3 = new DatabaseSync(f.file);
    try {
      db3.exec(`UPDATE host_conversation_schema SET version=1 WHERE id=1;
        DROP TABLE host_conversation_baselines;
        CREATE TABLE host_conversation_baselines (
          cursor TEXT PRIMARY KEY, workspace_id TEXT, collaboration_id TEXT,
          provider_id TEXT, account_id TEXT, native_session_id TEXT,
          parent_cursor TEXT, baseline_json TEXT, record_hash TEXT
        );`);
    } finally { db3.close(); }
    assert.throws(() => { const unexpected = new HostConversationSqlite(f.dir); unexpected.close(); });
    assert.ok(f.base.getWorkspace('workspace-a'));
  } finally { store?.close(); f.close(); }
});

test('account mapping table without source uniqueness is incompatible', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    store.close(); store = undefined;
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`PRAGMA foreign_keys=OFF;
        DROP TABLE host_conversation_accounts;
        CREATE TABLE host_conversation_accounts (
          account_id TEXT PRIMARY KEY, provider_id TEXT, source_kind TEXT, exact_source TEXT
        );`);
    } finally { db.close(); }
    assert.throws(() => { const unexpected = new HostConversationSqlite(f.dir); unexpected.close(); });
  } finally { store?.close(); f.close(); }
});

test('account schema rejects nullable source columns even with source uniqueness', () => {
  const f = fixture();
  let store: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    store.close(); store = undefined;
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`PRAGMA foreign_keys=OFF;
        DROP TABLE host_conversation_accounts;
        CREATE TABLE host_conversation_accounts (
          account_id TEXT PRIMARY KEY, provider_id TEXT,
          source_kind TEXT, exact_source TEXT,
          UNIQUE(provider_id,source_kind,exact_source)
        );
        PRAGMA query_only=ON;`);
      assert.throws(() => inspectHostConversationDatabase(db), /SCHEMA_INCOMPATIBLE/);
    } finally { db.close(); }
  } finally { store?.close(); f.close(); }
});

test('SQLite backup and restore preserve account and parent references', () => {
  const f = fixture();
  const restoredOuter = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-restored-'));
  const restored = join(restoredOuter, 'data');
  mkdirSync(restored, { mode: 0o700 });
  let store: HostConversationSqlite | undefined;
  let restoredStore: HostConversationSqlite | undefined;
  try {
    store = new HostConversationSqlite(f.dir);
    const account = store.accountKey('chatgpt', 'settings-account-email', 'person@example.test');
    const first = input(account);
    const parent = store.putBaseline(first);
    const child = { ...first, parentCursor: parent, messages: [...first.messages,
      { nativeMessageId: 'user-2', role: 'user' as const, text: 'follow up', version: 'v1', turnId: 'turn-2' }] };
    const cursor = store.putBaseline(child);
    store.close(); store = undefined;
    const db = new DatabaseSync(f.file);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    protectNewDataDirectory(restored);
    copyFileSync(f.file, join(restored, 'state.sqlite'));
    restoredStore = new HostConversationSqlite(restored);
    assert.equal(restoredStore.accountKey('chatgpt', 'settings-account-email', 'person@example.test'), account);
    assert.deepEqual(restoredStore.getBaseline(parent), { ...first, cursor: parent, schemaVersion: 1 });
    assert.deepEqual(restoredStore.getBaseline(cursor), { ...child, cursor, schemaVersion: 1 });
  } finally {
    restoredStore?.close(); store?.close(); f.close();
    assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(restoredOuter)),
      /^rcac-host-restored-[A-Za-z0-9_-]{6}$/);
    rmSync(restoredOuter, { recursive: true, force: true });
  }
});

test('read only inspection accepts legacy DB and restored host binding with adopted baseline', () => {
  const f = fixture();
  const restored = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-inspect-'));
  let host: HostConversationSqlite | undefined;
  let session: SessionControlSqlite | undefined;
  try {
    const legacy = new DatabaseSync(f.file);
    try {
      legacy.exec('PRAGMA query_only=ON'); inspectHostConversationDatabase(legacy);
      legacy.exec('PRAGMA query_only=OFF; CREATE TABLE session_control(binding_id TEXT, state_json TEXT); PRAGMA query_only=ON');
      inspectHostConversationDatabase(legacy);
      legacy.exec('PRAGMA query_only=OFF; DROP TABLE session_control');
    }
    finally { legacy.close(); }
    host = new HostConversationSqlite(f.dir);
    const account = host.accountKey('chatgpt-host-web', 'settings-account-email', 'person@example.test');
    const baseline = { ...input(account), providerId: 'chatgpt-host-web' };
    const cursor = host.putBaseline(baseline);
    host.putBaseline({ ...baseline, parentCursor: cursor, messages: [...baseline.messages,
      { nativeMessageId: 'user-2', role: 'user', text: 'next', version: 'v1', turnId: 'turn-2' }] });
    session = new SessionControlSqlite(f.file);
    session.create({ bindingId: 'host-binding', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'chatgpt-host-web', accountId: account, nativeSessionId: 'chat-a', cursor,
      control: 'human_controlled', epoch: 0, revision: 0 });
    session.close(); session = undefined;
    host.close(); host = undefined;
    const source = new DatabaseSync(f.file);
    try { source.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { source.close(); }
    copyFileSync(f.file, join(restored, 'state.sqlite'));
    const db = new DatabaseSync(join(restored, 'state.sqlite'));
    try {
      db.exec('PRAGMA query_only=ON');
      inspectHostConversationDatabase(db);
      assert.equal((db.prepare('SELECT count(*) AS n FROM host_conversation_baselines').get() as { n: number }).n, 2);
    } finally { db.close(); }
  } finally { session?.close(); host?.close(); f.close(); rmSync(restored, { recursive: true, force: true }); }
});

test('inspection rejects missing adopted cursor, damaged parent and oversized stored JSON', () => {
  const f = fixture();
  let host: HostConversationSqlite | undefined;
  let session: SessionControlSqlite | undefined;
  try {
    host = new HostConversationSqlite(f.dir);
    const account = host.accountKey('chatgpt-host-web', 'settings-account-email', 'person@example.test');
    const baseline = { ...input(account), providerId: 'chatgpt-host-web' };
    const parent = host.putBaseline(baseline);
    const child = host.putBaseline({ ...baseline, parentCursor: parent });
    session = new SessionControlSqlite(f.file);
    session.create({ bindingId: 'host-binding', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'chatgpt-host-web', accountId: account, nativeSessionId: 'chat-a', cursor: 'missing',
      control: 'human_controlled', epoch: 0, revision: 0 });
    const db = new DatabaseSync(f.file);
    try {
      db.exec('PRAGMA query_only=ON');
      assert.throws(() => inspectHostConversationDatabase(db));
    } finally { db.close(); }
    session.close(); session = undefined;
    const writable = new DatabaseSync(f.file);
    try {
      writable.prepare('DELETE FROM session_control WHERE binding_id=?').run('host-binding');
      writable.exec('PRAGMA foreign_keys=OFF');
      writable.prepare('DELETE FROM host_conversation_baselines WHERE cursor=?').run(parent);
    } finally { writable.close(); }
    const damaged = new DatabaseSync(f.file);
    try { damaged.exec('PRAGMA query_only=ON'); assert.throws(() => inspectHostConversationDatabase(damaged)); }
    finally { damaged.close(); }
    const oversized = new DatabaseSync(f.file);
    try { oversized.prepare('UPDATE host_conversation_baselines SET baseline_json=? WHERE cursor=?')
      .run('x'.repeat(1_048_577), child); } finally { oversized.close(); }
    assert.throws(() => host!.getBaseline(child));
  } finally { session?.close(); host?.close(); f.close(); }
});

test('inspection rejects half schema and excess account rows before reading records', () => {
  const f = fixture();
  let host: HostConversationSqlite | undefined;
  try {
    host = new HostConversationSqlite(f.dir);
    host.close(); host = undefined;
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
        INSERT INTO host_conversation_accounts(account_id,provider_id,source_kind,exact_source)
        SELECT 'row-'||x,'chatgpt-host-web','settings-account-email','source-'||x FROM n`);
      db.exec('PRAGMA query_only=ON');
      assert.throws(() => inspectHostConversationDatabase(db));
    } finally { db.close(); }
    const half = new DatabaseSync(f.file);
    try {
      half.exec('DROP TABLE host_conversation_baselines; PRAGMA query_only=ON');
      assert.throws(() => inspectHostConversationDatabase(half));
    } finally { half.close(); }
  } finally { host?.close(); f.close(); }
});

test('inspection rejects adopted cursor from another chat and aggregate byte overflow', () => {
  const f = fixture();
  let host: HostConversationSqlite | undefined;
  let session: SessionControlSqlite | undefined;
  try {
    host = new HostConversationSqlite(f.dir);
    const account = host.accountKey('chatgpt-host-web', 'settings-account-email', 'person@example.test');
    const cursor = host.putBaseline({ ...input(account), providerId: 'chatgpt-host-web' });
    session = new SessionControlSqlite(f.file);
    session.create({ bindingId: 'host-binding', workspaceId: 'workspace-a', collaborationId: 'issue-a',
      providerId: 'chatgpt-host-web', accountId: account, nativeSessionId: 'different-chat', cursor,
      control: 'human_controlled', epoch: 0, revision: 0 });
    const mismatch = new DatabaseSync(f.file);
    try { mismatch.exec('PRAGMA query_only=ON'); assert.throws(() => inspectHostConversationDatabase(mismatch)); }
    finally { mismatch.close(); }
    session.close(); session = undefined;
    const db = new DatabaseSync(f.file);
    try {
      db.prepare('DELETE FROM session_control WHERE binding_id=?').run('host-binding');
      const payload = 'x'.repeat(1_000_000);
      const insert = db.prepare(`INSERT INTO host_conversation_accounts
        (account_id,provider_id,source_kind,exact_source) VALUES (?,?,?,?)`);
      for (let index = 0; index < 17; index++) {
        insert.run(`large-${index}`, 'chatgpt-host-web', 'settings-account-email', `${index}${payload}`);
      }
      db.exec('PRAGMA query_only=ON');
      assert.throws(() => inspectHostConversationDatabase(db), /BUDGET_EXCEEDED/);
    } finally { db.close(); }
  } finally { session?.close(); host?.close(); f.close(); }
});

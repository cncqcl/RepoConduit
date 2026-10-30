import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { backupInstallation, restoreInstallation } from '../../src/runtime/installation-backup.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { HostConversationSqlite } from '../../src/adapters/storage/host-conversation-sqlite.js';

test('actual managed backup/restore preserves host account and adopted baseline and rejects broken references', async () => {
  const fixtureParent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(fixtureParent, 'rcac-host-backup-'));
  process.stderr.write(JSON.stringify({ case: 'host-backup', stage: 'fixture.created', root: base }) + '\n');
  let completed = false;
  protectNewDataDirectory(base);
  const root = join(base, 'source');
  createManagedInstallation(root);
  let runtime = acquireInstallationRuntime(root);
  let cursor: string, parent: string, account: string;
  try {
    const seed = new SqliteStore(join(runtime.dataDirectory, 'state.sqlite'));
    const sessions = new SessionControlSqlite(join(runtime.dataDirectory, 'state.sqlite'));
    const host = new HostConversationSqlite(runtime.dataDirectory);
    try {
      mkdirSync(join(base, 'fixture'));
      seed.insertWorkspace({ id: 'a', name: 'A', canonicalRoot: join(base, 'fixture'), registeredBy: 'owner' });
      seed.insertCollaboration({ id: 'c', workspaceId: 'a', openedBy: 'owner', purpose: 'synthetic', hostThreadId: null, state: 'open' });
      account = host.accountKey('chatgpt-host-web', 'settings-account-email', 'fixture@example.invalid');
      const input = { workspaceId: 'a', collaborationId: 'c', providerId: 'chatgpt-host-web', accountId: account,
        nativeSessionId: 'synthetic-chat', parentCursor: null, messages: [], observation: {} };
      parent = host.putBaseline(input);
      cursor = host.putBaseline({ ...input, parentCursor: parent });
      sessions.create({ bindingId: 'binding', workspaceId: 'a', collaborationId: 'c', providerId: 'chatgpt-host-web',
        accountId: account, nativeSessionId: 'synthetic-chat', cursor, epoch: 0, revision: 0, control: 'host_controlled' });
    } finally { host.close(); sessions.close(); seed.close(); }
  } finally { runtime.release(); }
  try {
    await backupInstallation(root, join(base, 'backup'));
    await restoreInstallation(join(base, 'backup'), join(base, 'restored'));
    const restored = acquireInstallationRuntime(join(base, 'restored'));
    try {
      const host = new HostConversationSqlite(restored.dataDirectory);
      try {
        assert.equal(host.accountKey('chatgpt-host-web', 'settings-account-email', 'fixture@example.invalid'), account);
        assert.equal(host.getBaseline(cursor)?.parentCursor, parent);
      } finally { host.close(); }
    } finally { restored.release(); }
    runtime = acquireInstallationRuntime(root);
    try {
      const db = new DatabaseSync(join(runtime.dataDirectory, 'state.sqlite'));
      try {
        const row = db.prepare('SELECT state_json FROM session_control WHERE binding_id=?').get('binding')!;
        const state = JSON.parse(String(row.state_json)) as Record<string, unknown>;
        state.cursor = 'missing';
        db.prepare('UPDATE session_control SET state_json=? WHERE binding_id=?').run(JSON.stringify(state), 'binding');
      } finally { db.close(); }
    } finally { runtime.release(); }
    await assert.rejects(backupInstallation(root, join(base, 'missing-cursor')), /INSTALLATION_REFERENCES_UNSAFE/);
    runtime = acquireInstallationRuntime(root);
    try {
      const db = new DatabaseSync(join(runtime.dataDirectory, 'state.sqlite'));
      try {
        const state = JSON.parse(String(db.prepare('SELECT state_json FROM session_control WHERE binding_id=?').get('binding')!.state_json)) as Record<string, unknown>;
        state.cursor = cursor;
        db.prepare('UPDATE session_control SET state_json=? WHERE binding_id=?').run(JSON.stringify(state), 'binding');
        const row = db.prepare('SELECT baseline_json FROM host_conversation_baselines WHERE cursor=?').get(cursor)!;
        const baseline = JSON.parse(String(row.baseline_json)) as Record<string, unknown>;
        baseline.nativeSessionId = 'different-chat';
        const body = JSON.stringify(baseline);
        db.prepare('UPDATE host_conversation_baselines SET native_session_id=?,baseline_json=?,record_hash=? WHERE cursor=?')
          .run('different-chat', body, createHash('sha256').update(body).digest('hex'), cursor);
      } finally { db.close(); }
    } finally { runtime.release(); }
    await assert.rejects(backupInstallation(root, join(base, 'bad-parent')), /INSTALLATION_REFERENCES_UNSAFE/);
    completed = true;
  } finally {
    const child = relative(resolve(fixtureParent), resolve(base));
    assert.match(child, /^rcac-host-backup-[A-Za-z0-9_-]{6}$/);
    if (completed) rmSync(base, { recursive: true, force: true });
    else process.stderr.write(JSON.stringify({ case: 'host-backup', stage: 'fixture.retained', root: base }) + '\n');
  }
});

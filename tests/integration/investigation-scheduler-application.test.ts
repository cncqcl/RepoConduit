import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { openApplication, openApplicationWithinInstallation } from '../../src/runtime/application.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

function fixture() {
  const data = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-scheduler-app-'));
  protectNewDataDirectory(data);
  const file = join(data, 'state.sqlite');
  const security = new SqliteStore(file);
  const workspaceId = `ws_${randomUUID()}`, collaborationId = `col_${randomUUID()}`;
  security.insertWorkspace({ id: workspaceId, name: 'synthetic', canonicalRoot: data, registeredBy: 'owner' });
  security.insertCollaboration({ id: collaborationId, workspaceId, openedBy: 'owner',
    purpose: 'synthetic', hostThreadId: null, state: 'open' });
  security.insertGrant({ id: 'request-grant', principal: 'external', audience: 'mcp',
    recipient: 'external', workspaceId, collaborationId, permissions: ['investigation.request'],
    expiresAt: null, revokedAt: null });
  security.insertGrant({ id: 'read-grant', principal: 'external', audience: 'mcp',
    recipient: 'external', workspaceId, collaborationId, permissions: ['data.read'],
    dataPaths: ['src/a.ts'], expiresAt: null, revokedAt: null });
  const investigations = new SqliteInvestigationStore(file);
  const record: InvestigationRecord = { id: `inv_${randomUUID()}`, workspaceId, collaborationId,
    workingCopyId: 'wc_synthetic', principal: 'external', audience: 'mcp', recipient: 'external',
    grantId: 'request-grant', profileRef: 'unverified-profile', budgetRef: 'unverified-profile',
    budget: { maxWallSeconds: 30, maxTurns: 1, maxToolCalls: 1 }, contextRevisionId: 'ctx_synthetic',
    snapshotRef: 'snp_synthetic', question: 'synthetic', scope: { paths: ['src/a.ts'], symbols: [], relatedTests: [] },
    requestedOutputs: ['evidence'], parentInvestigationId: null, state: 'queued',
    cancelRequested: false, attempts: [], result: null, createdAt: new Date().toISOString() };
  investigations.enqueue(record, 'synthetic', 'synthetic');
  investigations.close();
  return { data, file, security, record, clean() { security.close(); rmSync(data, { recursive: true, force: true }); } };
}

test('application startup runs the queue authority while unavailable requests remain unclaimed', async () => {
  const f = fixture();
  const observed: string[] = [];
  let observe!: () => void;
  const prepared = new Promise<void>(resolve => { observe = resolve; });
  const app = openApplication(f.data, { investigator: {
    selectProfile: () => null, verifyIsolation: () => false,
    prepareForRequest: record => { observed.push(record.id); observe(); return null; },
  } });
  try {
    await app.ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([prepared, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Background admission was not observed')), 2000);
    })]); } finally { clearTimeout(timer); }
    assert.deepEqual(observed, [f.record.id]);
    const check = new SqliteInvestigationStore(f.file);
    try {
      assert.deepEqual(check.get(f.record.id)?.attempts, []);
      assert.deepEqual(check.listUnsettled(), []);
      assert.equal(check.listPending().length, 1);
    } finally { check.close(); }
    assert.equal(f.security.grantsFor('external', 'mcp').length, 2);
  } finally { await app.close(); f.clean(); }
});

async function preparedFixture() {
  const f = fixture();
  const { snapshotId } = await seedBundleProvenance(f.security, f.file, {
    workspaceId: f.record.workspaceId, collaborationId: f.record.collaborationId,
    workingCopyId: f.record.workingCopyId, root: f.data, revisionIds: [f.record.contextRevisionId],
  });
  f.security.insertGrant({ id: 'provenance-read', principal: 'external', audience: 'mcp',
    recipient: 'external', workspaceId: f.record.workspaceId, collaborationId: f.record.collaborationId,
    permissions: ['data.read'], dataPaths: ['src/provenance.ts'], expiresAt: null, revokedAt: null });
  const profile = f.security.insertProfileRevision({ workspaceId: f.record.workspaceId,
    expectedRevisionId: null, presetRef: 'static_readonly_v1', budget: f.record.budget }, 'owner', new Date());
  return { ...f, profile, snapshotId };
}

test('trusted selection must bind the exact persisted budget and unchanged profile head', async () => {
  const f = await preparedFixture();
  let mode: 'wrong-budget' | 'head-race' | 'valid' = 'wrong-budget';
  let profile = f.profile;
  const app = openApplication(f.data, { investigator: {
    prepareForRequest: () => null, verifyIsolation: () => false,
    selectProfile: () => {
      const selected = { profileRef: profile.id, budgetRef: profile.id,
        budget: { ...profile.budget }, isolationVerified: true };
      if (mode === 'wrong-budget') selected.budget.maxTurns++;
      if (mode === 'head-race') profile = f.security.insertProfileRevision({
        workspaceId: f.record.workspaceId, expectedRevisionId: profile.id,
        presetRef: 'static_readonly_v1', budget: profile.budget }, 'owner', new Date());
      return selected;
    },
  } });
  const submit = (key: string) => app.dispatch.dispatch({ principal: 'external', audience: 'mcp',
    recipient: 'external', surface: 'external_mcp', now: new Date() }, {
    operation: 'investigate.submit', scope: { workspaceId: f.record.workspaceId,
      collaborationId: f.record.collaborationId }, idempotencyKey: key,
    payload: { workingCopyId: f.record.workingCopyId, input: {
      contextRevisionId: f.record.contextRevisionId, snapshotRef: f.snapshotId,
      question: 'Trace synthetic fixture', scope: { paths: ['src/provenance.ts'], symbols: [], relatedTests: [] },
      requestedOutputs: ['evidence'], parentInvestigationId: null,
    } },
  });
  try {
    await app.ready;
    await assert.rejects(submit('wrong-budget'), /NOT_AVAILABLE/);
    mode = 'head-race';
    await assert.rejects(submit('head-race'), /NOT_AVAILABLE/);
    mode = 'valid';
    const record = await submit('valid') as InvestigationRecord;
    assert.equal(record.profileRef, profile.id);
    assert.equal(record.budgetRef, profile.id);
    assert.deepEqual(record.budget, profile.budget);
    assert.equal(record.state, 'queued');
    assert.deepEqual(record.attempts, []);
  } finally { await app.close(); f.clean(); }
});

test('synchronous scheduler finalization failure still closes application stores', async () => {
  const f = await preparedFixture();
  const record: InvestigationRecord = { ...f.record, id: `inv_${randomUUID()}`,
    snapshotRef: f.snapshotId, profileRef: f.profile.id, budgetRef: f.profile.id,
    scope: { paths: ['src/provenance.ts'], symbols: [], relatedTests: [] } };
  const check = new SqliteInvestigationStore(f.file);
  check.enqueue(record, 'close-failure', 'close-failure');
  const originalInsert = SqliteStore.prototype.insertGrant;
  const originalClose = SqliteInvestigationStore.prototype.close;
  let applicationCloses = 0;
  SqliteStore.prototype.insertGrant = function (grant) {
    if (grant.id.startsWith('worker-read-')) throw new Error('synthetic insert fault before any native launch');
    return originalInsert.call(this, grant);
  };
  SqliteInvestigationStore.prototype.close = function () {
    applicationCloses++;
    return originalClose.call(this);
  };
  const runtime = acquireInstallationRuntime(f.data);
  const app = openApplicationWithinInstallation(runtime, { investigator: {
    selectProfile: () => null, verifyIsolation: () => true,
    prepareForRequest: pending => pending.id !== record.id ? null : {
      profileRevision: f.profile.id, budgetRef: f.profile.id,
      permissionEpoch: f.security.permissionEpoch('external', 'mcp', record.workspaceId),
      isolationEvidence: 'synthetic-test-only', identity: { uid: 1000, bootId: randomUUID() },
      runtime: { recipe: 'claude_model_bootstrap_config_v3', distro: 'Ubuntu', linuxUser: 'claude',
        relayRoot: '/home/claude/relay', paths: { installRoot: '/home/claude/install',
          nodeRoot: '/home/claude/node', srtSettingsFile: '/home/claude/srt.json',
          mcpConfigFile: '/home/claude/mcp.json', helperFile: '/home/claude/helper.py',
          privateAuthHome: '/home/claude/auth' }, profile: { allowedDomains: [] } },
    },
  } });
  try {
    await app.ready;
    const deadline = Date.now() + 2000;
    while (check.get(record.id)?.state !== 'recovery_required' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(check.get(record.id)?.state, 'recovery_required');
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => app.close(), /Application shutdown failed/);
    assert.equal(applicationCloses, 1);
    assert.throws(() => app.close(), /Application shutdown failed/);
    assert.equal(applicationCloses, 1);
    assert.equal(check.listUnsettled().length, 1);
  } finally {
    SqliteStore.prototype.insertGrant = originalInsert;
    SqliteInvestigationStore.prototype.close = originalClose;
    try { await app.close(); } catch { /* Expected sticky failure; no native process was started. */ }
    check.close(); runtime.release(); f.clean();
  }
});

test('application close aborts preparation before stores close and cannot admit a late claim', async () => {
  const f = fixture();
  let prepared!: () => void;
  const entered = new Promise<void>(resolve => { prepared = resolve; });
  let aborted = false;
  const app = openApplication(f.data, { investigator: {
    selectProfile: () => null, verifyIsolation: () => false,
    prepareForRequest: (_record, signal) => new Promise(resolve => {
      prepared();
      signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
    }),
  } });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Scheduler preparation was not started')), 1000);
    })]); } finally { clearTimeout(timer); }
    await app.close();
    await app.ready;
    assert.equal(aborted, true);
    const check = new SqliteInvestigationStore(f.file);
    try { assert.deepEqual(check.listUnsettled(), []); }
    finally { check.close(); }
  } finally { await app.close(); f.clean(); }
});

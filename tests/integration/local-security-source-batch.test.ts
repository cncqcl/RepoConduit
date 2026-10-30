import { privateFixtureParent } from '../support/private-fixture-parent.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { prepareWindowsInvestigatorRuntime, loadAuthorizedWindowsRuntimeSource } from
  '../../src/runtime/windows-investigation-runtime-config.js';

const identity = { principal: `${hostname()}\\${userInfo().username}`,
  audience: 'local-os', recipient: `${hostname()}\\${userInfo().username}` };
const context = { ...identity, surface: 'local_admin' as const, now: new Date() };
const budget = { maxWallSeconds: 30, maxTurns: 1, maxToolCalls: 2 };
const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const nativeParent = privateFixtureParent();

function mockHelper<T>(run: (calls: Array<{ command: string; args: readonly string[];
  options: { env?: NodeJS.ProcessEnv; timeout?: number } }>) => T): T {
  const original = childProcess.execFileSync;
  const calls: Array<{ command: string; args: readonly string[];
    options: { env?: NodeJS.ProcessEnv; timeout?: number } }> = [];
  childProcess.execFileSync = ((command: string, args: readonly string[], options: {
    env?: NodeJS.ProcessEnv; timeout?: number }) => {
    calls.push({ command, args, options }); return Buffer.alloc(0);
  }) as unknown as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  try { return run(calls); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
}

function fixture() {
  const targetRoot = mkdtempSync(join(tmpdir(), 'rcac-source-batch-target-'));
  const sourceRoot = mkdtempSync(join(tmpdir(), 'rcac-source-batch-source-'));
  const targetStore = new SqliteStore(join(targetRoot, 'state.sqlite'));
  const sourceStore = new SqliteStore(join(sourceRoot, 'state.sqlite'));
  const setup = (store: SqliteStore, root: string, workspaceId: string) => {
    store.insertWorkspace({ id: workspaceId, name: workspaceId, canonicalRoot: root, registeredBy: 'owner' });
    store.insertGrant({ id: 'admin', ...identity, workspaceId: 'management',
      permissions: ['admin.profile'], expiresAt: null, revokedAt: null });
    return store.insertProfileRevision({ workspaceId, expectedRevisionId: null,
      presetRef: 'static_readonly_v1', budget }, 'owner', new Date());
  };
  const targetRevision = setup(targetStore, targetRoot, 'target-ws');
  const sourceRevision = setup(sourceStore, sourceRoot, 'source-ws');
  const runtime = prepareWindowsInvestigatorRuntime(sourceRoot, sourceStore, context,
    { workspaceId: 'source-ws', profileRevision: sourceRevision.id, modelRef: 'gpt-6-sol' });
  const target = { workspaceId: 'target-ws', profileRevision: targetRevision.id };
  const source = { dataDirectory: sourceRoot, workspaceId: 'source-ws',
    profileRevision: sourceRevision.id };
  return { targetRoot, sourceRoot, targetStore, sourceStore, runtime, target, source,
    close() { targetStore.close(); sourceStore.close();
      rmSync(targetRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true }); } };
}

test('sourced load verifies two data roots and eleven runtime entries in one fixed helper',
  { skip: process.platform !== 'win32' }, () => mockHelper(calls => {
    const f = fixture();
    try {
      calls.length = 0;
      const loaded = loadAuthorizedWindowsRuntimeSource(f.targetRoot, f.target, f.source, identity);
      assert.equal(loaded.runtimeId, f.runtime.runtimeId);
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.command, trustedPowerShell);
      assert.equal(call.options.timeout, 15_000);
      const entries = JSON.parse(call.options.env!.RCAC_SECURITY_BATCH!) as Array<{
        directory: string; file?: string; includeState: boolean }>;
      assert.equal(entries.length, 13);
      assert.deepEqual(entries.slice(0, 2), [
        { directory: f.targetRoot, includeState: true },
        { directory: f.sourceRoot, includeState: true },
      ]);
      assert.ok(entries.slice(2).every(entry => entry.includeState === false));
      assert.deepEqual(entries.map(entry => Object.keys(entry).sort()), entries.map(entry =>
        (entry.file ? ['directory', 'file', 'includeState'] : ['directory', 'includeState']).sort()));
      assert.equal(entries.filter(entry => entry.file).length, 2);
      assert.ok(entries.slice(2).every(entry => entry.directory.startsWith(f.sourceRoot)));
      const script = call.args[3]!;
      assert.equal(script.includes(f.targetRoot), false);
      assert.equal(script.includes(f.sourceRoot), false);
    } finally { f.close(); }
  }));

test('sourced ACL failure occurs before either database query or runtime content read',
  { skip: process.platform !== 'win32' }, () => mockHelper(calls => {
    const f = fixture();
    const originalExec = childProcess.execFileSync;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalRead = fs.readFileSync;
    let queries = 0, runtimeReads = 0;
    try {
      calls.length = 0;
      DatabaseSync.prototype.prepare = function (...args) { queries++; return originalPrepare.apply(this, args); };
      fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(path).endsWith('runtime.json') || String(path).endsWith('config.toml')) runtimeReads++;
        return (originalRead as unknown as (...inputs: unknown[]) => unknown)(path, ...args);
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      childProcess.execFileSync = (() => { throw Object.assign(new Error('hidden'), { status: 1 }); }) as unknown as typeof childProcess.execFileSync;
      syncBuiltinESMExports();
      assert.throws(() => loadAuthorizedWindowsRuntimeSource(f.targetRoot, f.target, f.source, identity),
        /permissions unavailable or unsafe/);
      assert.equal(queries, 0);
      assert.equal(runtimeReads, 0);
    } finally {
      childProcess.execFileSync = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
      fs.readFileSync = originalRead;
      syncBuiltinESMExports();
      f.close();
    }
  }));

test('sourced load rereads current grants, profile and config on each load',
  { skip: process.platform !== 'win32' }, () => mockHelper(calls => {
    const f = fixture();
    try {
      const load = () => loadAuthorizedWindowsRuntimeSource(f.targetRoot, f.target, f.source, identity);
      const rejectBeforeContent = () => {
        const originalRead = fs.readFileSync;
        let runtimeReads = 0;
        fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
          if (String(path).endsWith('runtime.json') || String(path).endsWith('config.toml')) runtimeReads++;
          return (originalRead as unknown as (...inputs: unknown[]) => unknown)(path, ...args);
        }) as typeof fs.readFileSync;
        syncBuiltinESMExports();
        try { assert.throws(load); assert.equal(runtimeReads, 0); }
        finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
      };
      calls.length = 0;
      load();
      assert.equal(calls.length, 1);
      f.targetStore.revokeGrant('admin', new Date().toISOString());
      rejectBeforeContent();
      assert.equal(calls.length, 2);
      f.targetStore.insertGrant({ id: 'replacement', ...identity, workspaceId: 'management',
        permissions: ['admin.profile'], expiresAt: null, revokedAt: null });
      const sourceDb = new DatabaseSync(join(f.sourceRoot, 'state.sqlite'));
      try { sourceDb.prepare('UPDATE grants SET expires_at=? WHERE id=?')
        .run('2021-01-01T00:00:00.000Z', 'admin'); }
      finally { sourceDb.close(); }
      rejectBeforeContent();
      assert.equal(calls.length, 3);
      f.sourceStore.insertGrant({ id: 'replacement', ...identity, workspaceId: 'management',
        permissions: ['admin.profile'], expiresAt: null, revokedAt: null });
      const originalConfig = readFileSync(join(f.runtime.home, '.codex', 'config.toml'));
      writeFileSync(join(f.runtime.home, '.codex', 'config.toml'), 'model = "drift"\n');
      assert.throws(load);
      assert.equal(calls.length, 4);
      assert.equal(readFileSync(join(f.runtime.home, '.codex', 'config.toml'), 'utf8'), 'model = "drift"\n');
      writeFileSync(join(f.runtime.home, '.codex', 'config.toml'), originalConfig);
      f.sourceStore.insertProfileRevision({ workspaceId: 'source-ws',
        expectedRevisionId: f.source.profileRevision, presetRef: 'static_readonly_v1',
        budget }, 'owner', new Date());
      rejectBeforeContent();
      assert.equal(calls.length, 5);
    } finally { f.close(); }
  }));

test('native sourced load refuses unsafe target and source state.sqlite ACLs',
  { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(nativeParent, 'rcac-source-state-batch-'));
    protectNewDataDirectory(root);
    const targetRoot = join(root, 'target');
    const sourceRoot = join(root, 'source');
    mkdirSync(targetRoot); protectNewDataDirectory(targetRoot);
    mkdirSync(sourceRoot); protectNewDataDirectory(sourceRoot);
    const targetStore = new SqliteStore(join(targetRoot, 'state.sqlite'));
    const sourceStore = new SqliteStore(join(sourceRoot, 'state.sqlite'));
    const icacls = 'C:\\Windows\\System32\\icacls.exe';
    const acl = (file: string, args: string[]) => childProcess.execFileSync(icacls, [file, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    try {
      const setup = (store: SqliteStore, dataRoot: string, workspaceId: string) => {
        store.insertWorkspace({ id: workspaceId, name: workspaceId, canonicalRoot: dataRoot,
          registeredBy: 'owner' });
        store.insertGrant({ id: 'admin', ...identity, workspaceId: 'management',
          permissions: ['admin.profile'], expiresAt: null, revokedAt: null });
        return store.insertProfileRevision({ workspaceId, expectedRevisionId: null,
          presetRef: 'static_readonly_v1', budget }, 'owner', new Date());
      };
      const targetRevision = setup(targetStore, targetRoot, 'target-ws');
      const sourceRevision = setup(sourceStore, sourceRoot, 'source-ws');
      const runtime = prepareWindowsInvestigatorRuntime(sourceRoot, sourceStore, context,
        { workspaceId: 'source-ws', profileRevision: sourceRevision.id, modelRef: 'gpt-6-sol' });
      const target = { workspaceId: 'target-ws', profileRevision: targetRevision.id };
      const source = { dataDirectory: sourceRoot, workspaceId: 'source-ws',
        profileRevision: sourceRevision.id };
      const load = () => loadAuthorizedWindowsRuntimeSource(targetRoot, target, source, identity);
      assert.equal(load().runtimeId, runtime.runtimeId);
      for (const state of [join(targetRoot, 'state.sqlite'), join(sourceRoot, 'state.sqlite')]) {
        acl(state, ['/grant', '*S-1-1-0:R']);
        try { assert.throws(load, /permissions unavailable or unsafe/); }
        finally { acl(state, ['/remove:g', '*S-1-1-0']); }
        assert.equal(load().runtimeId, runtime.runtimeId);
      }
    } finally {
      targetStore.close(); sourceStore.close();
      // This single private candidate remains on disk as native evidence.
    }
  });

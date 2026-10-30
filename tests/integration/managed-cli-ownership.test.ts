import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { currentInstallationPackageVersion } from '../../src/runtime/installation.js';
import { acquireExclusiveMaintenanceGate, initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';

test('managed CLI and actual stdio protect the active generation and release on failure or shutdown', async () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const outer = mkdtempSync(join(base, 'rcac-managed-cli-'));
  const root = join(outer, 'installation');
  mkdirSync(root, { mode: 0o700 });
  const generation = 'gen_01234567-89ab-4cde-8f01-234567890abc';
  let client: Client | undefined;
  let nativeClosed: Promise<void> | undefined;
  let primary: unknown;
  const observe = (stage: string): void => {
    if (process.platform !== 'win32') return;
    const result = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$acl = [System.IO.Directory]::GetAccessControl($env:RCAC_TEST_ACL_ROOT)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$extra = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | Where-Object {
  $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($sid,'S-1-5-18')
})
@{ protected = $acl.AreAccessRulesProtected; unexpectedAllows = $extra.Count } | ConvertTo-Json -Compress
`], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, RCAC_TEST_ACL_ROOT: root } });
    const observation = JSON.parse(result) as { protected: boolean; unexpectedAllows: number };
    console.log(JSON.stringify({ aclStage: stage, ...observation }));
    assert.equal(observation.unexpectedAllows, 0, `Unexpected ACL at ${stage}; fixture retained`);
    assert.equal(observation.protected, true, `Unprotected ACL at ${stage}; fixture retained`);
  };
  try {
    protectNewDataDirectory(root); observe('protected'); initializeMaintenanceGate(root); observe('gate_initialized');
    const dirs = [join(root, 'generations'), join(root, 'generations', generation),
      join(root, 'generations', generation, 'data')];
    for (const dir of dirs) { mkdirSync(dir, { mode: 0o700 }); protectNewDataDirectory(dir); }
    const data = dirs[2]!;
    const principal = `${hostname()}\\${userInfo().username}`;
    const store = new SqliteStore(join(data, 'state.sqlite'));
    try {
      store.insertWorkspace({ id: 'ws_fixture', name: 'fixture', canonicalRoot: base, registeredBy: principal });
      store.insertGrant({ id: 'gr_admin', principal, audience: 'local-os', recipient: principal,
        workspaceId: 'management', permissions: ['admin.grant'], expiresAt: null, revokedAt: null });
      store.insertGrant({ id: 'gr_external', principal: 'external', audience: 'stdio', recipient: 'external',
        workspaceId: 'ws_fixture', permissions: ['collab.read'], expiresAt: null, revokedAt: null });
      store.insertGrant({ id: 'gr_local', principal, audience: 'local-os', recipient: principal,
        workspaceId: 'ws_fixture', permissions: ['collab.read'], expiresAt: null, revokedAt: null });
    } finally { store.close(); }
    writeFileSync(join(root, 'managed.json'), JSON.stringify({ schemaVersion: 1, activeGeneration: generation,
      packageVersion: currentInstallationPackageVersion(), dataFormatVersion: 1 }), { mode: 0o600 });
    const script = resolve('src/cli/main.ts');
    const run = (action: string, input?: unknown) => spawnSync(process.execPath,
      ['--import', 'tsx', script, '--data-dir', root, action], { cwd: resolve('.'), encoding: 'utf8',
        input: input === undefined ? undefined : JSON.stringify(input), timeout: 25_000 });
    const binding = { principal: 'external', audience: 'stdio', recipient: 'external',
      workspaceId: 'ws_fixture', visibleOperations: ['collab.list'] };
    const exclusive = acquireExclusiveMaintenanceGate(root);
    try {
      for (const action of ['configure-mcp', 'request', 'doctor', 'mcp']) {
        assert.equal(run(action, binding).status, 1, action);
      }
      assert.equal(existsSync(join(data, 'mcp-binding.json')), false);
    } finally { exclusive.release(); }
    const configured = run('configure-mcp', binding);
    observe('configure_terminal');
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(existsSync(join(data, 'mcp-binding.json')), true);
    assert.equal(existsSync(join(root, 'state.sqlite')), false);
    assert.equal(run('configure-mcp', binding).status, 1, 'existing binding conflict');
    const available = acquireExclusiveMaintenanceGate(root); available.release();
    const doctor = run('doctor'); assert.equal(doctor.status, 0, doctor.stderr);
    observe('doctor_terminal');
    const listed = run('request', { operation: 'collab.list', scope: { workspaceId: 'ws_fixture' }, payload: {} });
    observe('request_terminal');
    assert.equal(listed.status, 0, listed.stderr);
    writeFileSync(join(data, 'mcp-binding.json'), JSON.stringify({ ...binding, workspaceId: 123 }));
    observe('invalid_binding_written');
    assert.equal(run('mcp').status, 1, 'invalid binding startup');
    observe('invalid_mcp_terminal');
    const failedStartup = acquireExclusiveMaintenanceGate(root); failedStartup.release();
    writeFileSync(join(data, 'mcp-binding.json'), JSON.stringify(binding));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', script, '--data-dir', root, 'mcp'], cwd: resolve('.'), stderr: 'pipe' });
    nativeClosed = new Promise<void>(done => { transport.onclose = done; });
    client = new Client({ name: 'managed-cli-fixture', version: '1.0.0' });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['collab.list']);
    assert.throws(() => acquireExclusiveMaintenanceGate(root), /MAINTENANCE_GATE_BUSY/);
    await client.close();
    await waitForNativeClose(nativeClosed);
    client = undefined;
    const after = acquireExclusiveMaintenanceGate(root); after.release();
  } catch (error) { primary = error; }
  let cleanupFailure: unknown;
  try {
    await client?.close();
    if (nativeClosed) await waitForNativeClose(nativeClosed);
    const exclusive = acquireExclusiveMaintenanceGate(root); exclusive.release();
    const child = relative(resolve(base), resolve(outer));
    assert.match(child, /^rcac-managed-cli-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  } catch (error) { cleanupFailure = error; }
  if (primary && cleanupFailure) throw new AggregateError([primary, cleanupFailure], 'Managed CLI test and cleanup failed');
  if (primary) throw primary;
  if (cleanupFailure) throw cleanupFailure;
});

async function waitForNativeClose(closed: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([closed, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Synthetic stdio child close unconfirmed; fixture retained')), 10_000);
  })]); } finally { clearTimeout(timeout); }
}

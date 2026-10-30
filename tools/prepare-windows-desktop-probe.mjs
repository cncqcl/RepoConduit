#!/usr/bin/env node
// One-off, synthetic fixture for a Windows Codex Desktop MCP host probe.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = realpathSync(homedir());
const rootArg = process.argv[2];

function requireNewHomeChild() {
  if (process.platform !== 'win32' || process.argv.length !== 3 || !rootArg || !isAbsolute(rootArg)) {
    throw new Error('Expected one absolute, new Windows HOME child path');
  }
  const root = resolve(rootArg);
  if (dirname(root).toLowerCase() !== home.toLowerCase() ||
      !basename(root).startsWith('rcac-desktop-probe-')) {
    throw new Error('Target must be a named direct child of the current HOME');
  }
  try { lstatSync(root); throw new Error('Target already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return root;
}

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const step = `${basename(script)} ${args[0] ?? ''}`.trim();
    throw new Error(`Fixture preparation failed at ${step}${result.error?.code === 'ETIMEDOUT' ? ' (timed out)' : ''}`);
  }
  return result.stdout.trim();
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git source identity unavailable');
  return result.stdout.trim();
}

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

async function runStage(script, stage, args, env, root, timeoutMs, input) {
  process.stderr.write(`Desktop probe: ${stage} started\n`);
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...args], { cwd: repo, env,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input !== undefined) {
    child.stdin.on('error', () => { /* child failure is reported by close */ });
    child.stdin.end(input);
  }
  let stdout = '';
  let outputBytes = 0;
  let errorTail = '';
  let timedOut = false;
  let tooLarge = false;
  let treeTerminationConfirmed = true;
  let stopping = false;
  const stopTree = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    const taskkill = 'C:\\Windows\\System32\\taskkill.exe';
    const result = child.pid && existsSync(taskkill) ? spawnSync(taskkill,
      ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 }) : undefined;
    treeTerminationConfirmed = result?.status === 0;
    if (!treeTerminationConfirmed) child.kill();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 1024 * 1024) { tooLarge = true; stopTree(); }
    else stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    outputBytes += chunk.length;
    errorTail = (errorTail + chunk.toString('utf8')).slice(-8192);
    if (outputBytes > 1024 * 1024) { tooLarge = true; stopTree(); }
  });
  const heartbeat = setInterval(() => {
    process.stderr.write(`Desktop probe: ${stage} running ${Math.floor((Date.now() - started) / 1000)}s\n`);
  }, 10_000);
  const deadline = setTimeout(() => { timedOut = true; stopTree(); }, timeoutMs);
  try {
    const result = await new Promise((resolveClose) => {
      child.once('error', () => resolveClose({ code: null, signal: 'spawn_error' }));
      child.once('close', (code, signal) => resolveClose({ code, signal }));
      setTimeout(() => {
        if (timedOut || tooLarge) resolveClose({ code: null, signal: 'termination_unconfirmed' });
      }, timeoutMs + 25_000).unref();
    });
    if (timedOut || tooLarge || result.code !== 0) {
      const npmCode = errorTail.match(/(?:npm error code|npm ERR! code)\s+([A-Z][A-Z0-9_]{1,32})/i)?.[1]?.toUpperCase() ?? null;
      const confirmed = treeTerminationConfirmed && result.signal !== 'termination_unconfirmed';
      const diagnostic = { stage, durationMs: Date.now() - started, exitCode: result.code,
        signal: result.signal, timedOut, outputLimit: tooLarge, npmCode, treeTerminationConfirmed: confirmed };
      writeFileSync(join(root, `${stage}-diagnostic.json`), `${JSON.stringify(diagnostic)}\n`, { flag: 'wx', mode: 0o600 });
      const reason = !confirmed ? 'termination_unconfirmed' : timedOut ? 'timeout' : tooLarge ? 'output limit' : `exit ${result.code ?? result.signal ?? 'unknown'}`;
      throw new Error(`stage ${stage} failed (${reason})`);
    }
    process.stderr.write(`Desktop probe: ${stage} completed\n`);
    return stdout.trim();
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  }
}

function protectRoot(root) {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  if (!existsSync(powershell)) throw new Error('Trusted Windows PowerShell unavailable');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:RCAC_PROBE_ROOT
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
$acl = [System.IO.Directory]::GetAccessControl($target)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$none = [System.Security.AccessControl.PropagationFlags]::None
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $full, $inherit, $none, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $full, $inherit, $none, $allow)))
[System.IO.Directory]::SetAccessControl($target, $acl)
$check = [System.IO.Directory]::GetAccessControl($target)
if (-not $check.AreAccessRulesProtected) { throw 'Root ACL is inherited' }
foreach ($rule in $check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq $allow -and
      $rule.IdentityReference.Value -ne $sid.Value -and
      $rule.IdentityReference.Value -ne $system.Value) { throw 'Root ACL is broad' }
}`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: repo, env: { ...process.env, RCAC_PROBE_ROOT: root },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 8192,
  });
  if (result.error || result.status !== 0) throw new Error('Unable to protect fixture root');
}

async function request(cli, data, operation, scope, payload, idempotencyKey, root, stage) {
  const input = { operation, scope, payload, idempotencyKey };
  return JSON.parse(await runStage(cli, stage, ['--data-dir', data, 'request'], process.env, root, 45_000, JSON.stringify(input)));
}

try {
  assert.equal(resolve('.'), repo, 'Run this script from the repository root');
  const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'repo-conduit');
  const root = requireNewHomeChild();
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('Installed npm unavailable');
  mkdirSync(root, { mode: 0o700 });
  protectRoot(root);
  // Test runs may use an already populated npm cache to avoid an unrelated registry outage.
  // The ordinary operator path retains its private cache and normal install behavior.
  const offlineCache = process.env.RCAC_PROBE_TEST_OFFLINE_CACHE;
  if (offlineCache && (!isAbsolute(offlineCache) || !existsSync(offlineCache))) {
    throw new Error('Invalid offline test cache');
  }
  const npmEnv = { ...process.env, npm_config_cache: offlineCache ?? join(root, 'npm-cache'),
    npm_config_update_notifier: 'false', ...(offlineCache ? { npm_config_offline: 'true' } : {}) };
  const sourceCommit = runGit(['rev-parse', 'HEAD']);
  const sourceDirty = runGit(['status', '--porcelain', '--untracked-files=normal']).length > 0;
  const sourceLockSha256 = sha256(join(repo, 'package-lock.json'));
  const npmVersion = runNode(npmCli, ['--version'], { env: npmEnv });
  await runStage(npmCli, 'build', ['run', 'build'], npmEnv, root, 60_000);
  const packed = JSON.parse(await runStage(npmCli, 'pack', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], npmEnv, root, 60_000));
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].integrity !== 'string' ||
      typeof packed[0].filename !== 'string') throw new Error('Package metadata unavailable');
  const archive = join(root, basename(packed[0].filename));
  if (!existsSync(archive)) throw new Error('Package archive unavailable');
  const install = join(root, 'installed');
  await runStage(npmCli, 'install', ['install', ...(offlineCache ? ['--offline'] : []),
    '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', archive], npmEnv, root, 300_000);
  const cli = join(install, 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js');
  if (!existsSync(cli)) throw new Error('Installed CLI unavailable');
  const installedLockSha256 = sha256(join(install, 'package-lock.json'));
  const installedCliSha256 = sha256(cli);
  const data = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const init = JSON.parse(await runStage(cli, 'cli-init', ['--data-dir', data, 'init'], process.env, root, 90_000));
  if (init.initialized !== true || init.dataDirectory !== data || !init.principal) throw new Error('CLI init failed');
  const nonce = randomBytes(16).toString('hex');
  const workspaceRecord = await request(cli, data, 'admin.register_workspace', { workspaceId: 'management' },
    { name: `Synthetic Desktop probe ${nonce}`, root: workspace }, `probe-workspace-${nonce}`, root, 'cli-register-workspace');
  if (typeof workspaceRecord.id !== 'string' || !workspaceRecord.id.startsWith('ws_')) throw new Error('Workspace registration failed');
  await request(cli, data, 'admin.grant', { workspaceId: 'management' }, {
    principal: init.principal, audience: 'local-os', recipient: init.principal,
    workspaceId: workspaceRecord.id, permissions: ['collab.create'], expiresAt: null,
  }, `probe-local-grant-${nonce}`, root, 'cli-local-grant');
  const collaboration = await request(cli, data, 'collab.open', { workspaceId: workspaceRecord.id },
    { purpose: `Synthetic Windows Desktop MCP host probe ${nonce}` }, `probe-collaboration-${nonce}`, root, 'cli-open');
  if (typeof collaboration.id !== 'string' || !collaboration.id.startsWith('col_')) throw new Error('Collaboration creation failed');
  const external = { principal: `desktop-probe-external-${nonce}`, audience: 'desktop-probe-local',
    recipient: `desktop-probe-client-${nonce}` };
  const externalGrant = await request(cli, data, 'admin.grant', { workspaceId: 'management' }, {
    ...external, workspaceId: workspaceRecord.id, collaborationId: collaboration.id,
    permissions: ['collab.read'], expiresAt: null,
  }, `probe-external-grant-${nonce}`, root, 'cli-external-grant');
  if (externalGrant.collaborationId !== collaboration.id ||
      JSON.stringify(externalGrant.permissions) !== JSON.stringify(['collab.read'])) throw new Error('External grant mismatch');
  const configured = JSON.parse(await runStage(cli, 'cli-configure-mcp', ['--data-dir', data, 'configure-mcp'],
    process.env, root, 45_000, JSON.stringify({ ...external, workspaceId: workspaceRecord.id,
      collaborationId: collaboration.id, visibleOperations: ['collab.get'] })));
  if (configured.configured !== true ||
      JSON.stringify(configured.visibleOperations) !== JSON.stringify(['collab.get'])) throw new Error('MCP binding mismatch');
  const manifest = { kind: 'windows-desktop-mcp-probe', root, node: process.execPath, cli, data, workspace,
    workspaceId: workspaceRecord.id, collaborationId: collaboration.id, nonce,
    external, packageIntegrity: packed[0].integrity, packageFilename: packed[0].filename,
    npmVersion, productVersion: packageJson.version, nodeVersion: process.version,
    sourceCommit, sourceDirty, sourceLockSha256, installedLockSha256, installedCliSha256,
    mcpArguments: [cli, '--data-dir', data, 'mcp'] };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${join(root, 'manifest.json')}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(?:stage (?:build|pack|install|cli-init|cli-register-workspace|cli-local-grant|cli-open|cli-external-grant|cli-configure-mcp) failed \((?:timeout|output limit|termination_unconfirmed|exit [A-Za-z0-9_]+)\)|Target already exists|Target must be a named direct child of the current HOME|Expected one absolute, new Windows HOME child path|Git source identity unavailable|Installed npm unavailable|Unable to protect fixture root)$/.test(message);
  process.stderr.write(`Desktop probe preparation failed: ${safe ? message : 'fixture unavailable; inspect private diagnostic in the new root'}\n`);
  process.exitCode = 1;
}

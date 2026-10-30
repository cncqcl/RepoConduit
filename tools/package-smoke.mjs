import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { inspectInstallationPackageArchive } from '../dist/src/runtime/installation-package-preflight.js';
import { observeSmokeTransportClosure } from './package-smoke-lifecycle.mjs';

const retentionUnsafe = () => { throw new Error('PACKAGE_SMOKE_RETENTION_UNSAFE'); };
const assertRetentionDestination = target => {
  const parent = dirname(target);
  if (!isAbsolute(target) || resolve(target) !== target) retentionUnsafe();
  try {
    if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent ||
        lstatSync(target, { throwIfNoEntry: false })) retentionUnsafe();
  } catch { retentionUnsafe(); }
};
const args = process.argv.slice(2);
let retainedArchive;
if (args.length !== 0) {
  if (args.length !== 2 || args[0] !== '--retain-archive') retentionUnsafe();
  retainedArchive = args[1];
  assertRetentionDestination(retainedArchive);
}
const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'package smoke must run through npm');
const temporary = mkdtempSync(join(fixtureRoot, 'rcac-package-smoke-'));
let httpChild;
let mcpClient;
let confirmMcpClosure;
let smokeResult;
let smokeFailure;
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { cwd: resolve('.'), encoding: 'utf8', timeout: 60_000, ...options });
  assert.equal(result.status, 0, `${program} failed: ${result.error?.code ?? 'no_spawn_error'} ` +
    `signal=${result.signal ?? 'none'} ${result.stderr || result.stdout}`);
  return result.stdout;
};
const exitedWithin = (child, timeoutMs) => new Promise(done => {
  if (child.exitCode !== null || child.signalCode !== null) { done(true); return; }
  const onExit = () => { clearTimeout(timer); done(true); };
  const timer = setTimeout(() => { child.off('exit', onExit); done(false); }, timeoutMs);
  child.once('exit', onExit);
});
const stopOwnedChild = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await exitedWithin(child, 2_000)) return;
  child.kill('SIGKILL');
  if (!await exitedWithin(child, 2_000)) throw new Error('Installed HTTP child exit unconfirmed');
};
try {
  console.log('package smoke: checking publication lock');
  run(process.execPath, [resolve('tools/prepare-installation-package.mjs'), '--check', resolve('.')]);
  console.log('package smoke: packing offline');
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts',
    '--json', '--pack-destination', temporary]));
  assert.equal(packed.length, 1);
  const archive = join(temporary, packed[0].filename);
  const inspected = inspectInstallationPackageArchive(readFileSync(archive));
  assert.equal(inspected.packageVersion, JSON.parse(readFileSync('package.json', 'utf8')).version);
  console.log('package smoke: archive preflight passed; installing offline');
  const install = join(temporary, 'installed');
  run(process.execPath, [npmCli, 'install', '--offline', '--prefix', install,
    '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const cli = join(install, 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js');
  const installedRoot = join(install, 'node_modules', 'repo-conduit');
  const installedHostSkillFiles = ['skills/consult-external-agent/SKILL.md',
    'skills/consult-external-agent/agents/openai.yaml',
    'skills/consult-external-agent/references/commands.md'].map(path => {
    const bytes = readFileSync(join(installedRoot, path));
    assert.deepEqual(bytes, readFileSync(resolve(path)),
      `installed Host Skill must retain source bytes: ${path}`);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const installedNoticeFiles = [
    'docs/DEPENDENCIES_AND_LICENSES.md',
    'docs/THIRD_PARTY_NOTICES.md',
    'docs/PRODUCTION_LICENSE_INVENTORY.json',
    'docs/licenses/koa-compose/903480c/LICENSE',
    'docs/licenses/koa-compose/903480c/PROVENANCE.md',
  ].map(path => {
    const bytes = readFileSync(join(installedRoot, path));
    assert.deepEqual(bytes, readFileSync(resolve(path)),
      `installed notice file must retain source bytes: ${path}`);
    return { path, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  assert.deepEqual(readFileSync(join(installedRoot, 'npm-shrinkwrap.json')),
    readFileSync('package-lock.json'), 'installed publication lock must match source lock bytes');
  assert.ok(existsSync(join(install, 'node_modules', 'repo-conduit', 'docs', 'operations.md')));
  assert.ok(existsSync(join(install, 'node_modules', 'repo-conduit', 'docs', 'DEPENDENCIES_AND_LICENSES.md')));
  assert.ok(existsSync(join(installedRoot, 'tools', 'prepare-wsl-private-home.sh')),
    'private WSL login preparation helper must ship with the installed package');
  assert.equal(readFileSync(join(installedRoot, 'tools', 'prepare-wsl-private-home.sh')).includes(13), false,
    'installed POSIX helper must retain LF newlines for shell execution');
  assert.equal(existsSync(join(installedRoot, 'verification', 'RUNTIME_ACCEPTANCE.json')), false,
    'mutable acceptance ledger must stay outside the installed package');
  assert.equal(existsSync(join(installedRoot, 'work', 'GOAL_STATE.json')), false,
    'mutable goal ledger must stay outside the installed package');
  const data = join(temporary, 'data');
  const workspace = join(temporary, 'workspace');
  mkdirSync(workspace);
  const initialized = JSON.parse(run(process.execPath, [cli, '--data-dir', data, 'init']));
  assert.equal(initialized.initialized, true);
  const registered = JSON.parse(run(process.execPath, [cli, '--data-dir', data, 'request'], {
    input: JSON.stringify({ operation: 'admin.register_workspace', scope: { workspaceId: 'management' },
      idempotencyKey: 'package-smoke-workspace', payload: { name: 'Packaged fixture', root: workspace } }),
  }));
  assert.ok(registered.id);
  const profileCommand = { operation: 'admin.configure_profile',
    scope: { workspaceId: 'management' }, idempotencyKey: 'package-smoke-profile',
    payload: { workspaceId: registered.id, expectedRevisionId: null,
      presetRef: 'static_readonly_v1',
      budget: { maxWallSeconds: 600, maxTurns: 8, maxToolCalls: 40 } } };
  const configureProfile = command => JSON.parse(run(process.execPath,
    [cli, '--data-dir', data, 'request'], { input: JSON.stringify(command) }));
  const profile = configureProfile(profileCommand);
  assert.equal(profile.workspaceId, registered.id);
  assert.equal(profile.runtimeAvailability, 'unavailable');
  assert.ok(profile.id);
  assert.deepEqual(configureProfile(profileCommand), profile,
    'a separate installed CLI process must replay the persisted profile revision');
  const narrowedProfile = configureProfile({ ...profileCommand,
    idempotencyKey: 'package-smoke-profile-narrow', payload: {
      ...profileCommand.payload, expectedRevisionId: profile.id,
      budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 2 } } });
  assert.notEqual(narrowedProfile.id, profile.id);
  assert.equal(narrowedProfile.runtimeAvailability, 'unavailable');
  const staleProfile = spawnSync(process.execPath, [cli, '--data-dir', data, 'request'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 60_000,
    input: JSON.stringify({ ...profileCommand,
      idempotencyKey: 'package-smoke-profile-stale',
      payload: { ...profileCommand.payload, expectedRevisionId: profile.id } }),
  });
  assert.equal(staleProfile.error, undefined);
  assert.equal(staleProfile.status, 1);
  assert.match(staleProfile.stderr, /CONFLICT|Profile revision changed/,
    'a new operation cannot overwrite a revision using a stale expected ID');
  assert.deepEqual(configureProfile(profileCommand), profile,
    'completed receipt retains its original revision after a later policy revision');
  const external = { principal: 'package-external', audience: 'https://mcp.example.test',
    recipient: 'package-client', workspaceId: registered.id,
    permissions: ['collab.create', 'artifact.submit', 'artifact.read'],
    expiresAt: null };
  run(process.execPath, [cli, '--data-dir', data, 'request'], { input: JSON.stringify({
    operation: 'admin.grant', scope: { workspaceId: 'management' },
    idempotencyKey: 'package-smoke-external-grant', payload: external,
  }) });
  run(process.execPath, [cli, '--data-dir', data, 'configure-mcp'], { input: JSON.stringify({
    principal: external.principal, audience: external.audience, recipient: external.recipient,
    workspaceId: registered.id, visibleOperations: ['collab.open', 'artifact.begin',
      'artifact.put_text', 'artifact.status', 'artifact.finalize', 'artifact.abort'],
  }) });
  const beforeDoctorFiles = readdirSync(data).sort();
  const beforeDoctorDatabase = createHash('sha256').update(readFileSync(join(data, 'state.sqlite'))).digest('hex');
  const beforeDoctorBinding = readFileSync(join(data, 'mcp-binding.json'));
  const doctor = JSON.parse(run(process.execPath, [cli, '--data-dir', data, 'doctor']));
  assert.equal(doctor.schemaVersion, 1);
  assert.equal(doctor.installation.status, 'readable');
  assert.equal(doctor.mcp.status, 'configured_authorized');
  assert.equal(doctor.mcp.authorizedOperations, 6);
  assert.equal(doctor.sessions.status, 'foreground_adapter_installed');
  for (const field of ['account', 'binding', 'history', 'humanHandoff'])
    assert.equal(doctor.sessions[field], 'not_checked');
  assert.equal(doctor.sessions.unresolvedSends, 'none');
  assert.equal(doctor.investigator.profileConfigured, true);
  assert.equal(doctor.investigator.status, 'runtime_unavailable');
  assert.equal(doctor.files.status, 'local_implemented');
  for (const capability of ['service', 'tools', 'identity']) {
    assert.equal(doctor[capability].status, 'not_checked');
  }
  assert.deepEqual(readdirSync(data).sort(), beforeDoctorFiles,
    'installed doctor must not create data files or start recovery');
  assert.equal(createHash('sha256').update(readFileSync(join(data, 'state.sqlite'))).digest('hex'),
    beforeDoctorDatabase, 'installed doctor must not rewrite the database');
  assert.deepEqual(readFileSync(join(data, 'mcp-binding.json')), beforeDoctorBinding);
  assert.equal(JSON.stringify(doctor).includes(external.principal), false,
    'installed diagnostics must not disclose binding identities');
  mcpClient = new Client({ name: 'installed-package-smoke', version: '0.1.0' });
  const mcpTransport = new StdioClientTransport({ command: process.execPath,
    args: [cli, '--data-dir', data, 'mcp'], cwd: resolve('.'), stderr: 'pipe' });
  confirmMcpClosure = observeSmokeTransportClosure(mcpTransport);
  await mcpClient.connect(mcpTransport);
  const listedTools = new Map((await mcpClient.listTools()).tools.map(tool => [tool.name, tool]));
  assert.deepEqual([...listedTools.keys()], ['collab.open', 'artifact.begin', 'artifact.put_text',
    'artifact.status', 'artifact.finalize', 'artifact.abort']);
  const artifactPayloads = {
    'artifact.begin': ['bundleId', 'contextRevision', 'snapshotRefs'],
    'artifact.put_text': ['bundleId', 'path', 'text', 'mediaType'],
    'artifact.status': ['bundleId'],
    'artifact.finalize': ['bundleId'],
    'artifact.abort': ['bundleId'],
  };
  for (const [name, required] of Object.entries(artifactPayloads)) {
    const payload = listedTools.get(name)?.inputSchema.properties?.payload;
    assert.ok(payload, `${name} payload schema must be advertised by installed MCP`);
    assert.deepEqual(payload.required, required, `${name} required payload fields`);
    assert.equal(payload.additionalProperties, false, `${name} payload must be closed`);
  }
  const opened = await mcpClient.callTool({ name: 'collab.open', arguments: {
    scope: { workspaceId: registered.id }, payload: { purpose: 'Installed Windows host smoke' },
    idempotencyKey: 'package-smoke-mcp-collaboration',
  } });
  assert.equal(opened.isError, undefined);
  assert.match(JSON.parse(opened.content[0].text).id, /^col_/);
  const password = 'synthetic-local-password-12345';
  run(process.execPath, [cli, '--data-dir', data, 'configure-oauth'], { input: JSON.stringify({
    issuer: 'https://issuer.example.test', resource: external.audience, clientId: external.recipient,
    redirectUris: ['https://chatgpt.example.test/callback'], scopes: ['collab.create', 'artifact.submit'],
    operator: { subject: 'package-operator', password },
    binding: { issuer: 'https://issuer.example.test', clientId: external.recipient,
      subject: 'package-operator', principal: external.principal, recipient: external.recipient,
      workspaceId: registered.id, scopes: { 'collab.create': {
        delegatedPermissions: ['collab.create'], visibleOperations: ['collab.open'],
      }, 'artifact.submit': { delegatedPermissions: ['artifact.submit'],
        visibleOperations: ['artifact.import_reference'] } },
    },
  }) });
  const configPath = join(data, 'oauth-config.json');
  const beforeOrigins = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(beforeOrigins.allowedFileOrigins, []);
  const originUpdate = JSON.parse(run(process.execPath, [cli, '--data-dir', data,
    'configure-file-origins'], { input: JSON.stringify({
      allowedFileOrigins: ['https://files.example.test'], expectedAllowedFileOrigins: [],
    }) }));
  assert.equal(originUpdate.restartRequired, true);
  const afterOrigins = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(afterOrigins.allowedFileOrigins, ['https://files.example.test']);
  assert.deepEqual(afterOrigins.issuer, beforeOrigins.issuer);
  assert.deepEqual(afterOrigins.bindings, beforeOrigins.bindings);
  httpChild = spawn(process.execPath, [cli, '--data-dir', data, 'serve-http'],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await new Promise((resolveReady, reject) => {
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => reject(new Error('Installed HTTP startup timeout')), 15_000);
    httpChild.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('\n')) {
        clearTimeout(timer);
        try { resolveReady(JSON.parse(output.split('\n')[0])); }
        catch { reject(new Error('Invalid installed HTTP readiness')); }
      }
    });
    httpChild.stderr.on('data', chunk => { errorOutput += chunk.toString().slice(0, 1024); });
    httpChild.once('exit', code => { clearTimeout(timer);
      reject(new Error(`Installed HTTP exited ${code}: ${errorOutput}`)); });
  });
  assert.match(ready.issuerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(ready.mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const metadata = await fetch(`${ready.issuerUrl}/.well-known/oauth-authorization-server`,
    { signal: AbortSignal.timeout(5_000) });
  assert.equal(metadata.status, 200);
  smokeResult = { status: 'passed', package: packed[0].filename,
    installedCli: true, installedProfileConfiguration: true,
    installedProfileReplayAcrossProcesses: true,
    installedMcpRoundTrip: true, installedMcpArtifactDiscovery: true,
    workspaceRegistered: true, oauthConfigured: true,
    oauthHttpStarted: true, installedDocs: true, installedFileOriginsConfigured: true,
    mutableEvidenceExcluded: true, packageIntegrity: packed[0].integrity };
  smokeResult.installedHostSkillFiles = installedHostSkillFiles;
  smokeResult.installedNoticeFiles = installedNoticeFiles;
  smokeResult.packageSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (retainedArchive) {
    assertRetentionDestination(retainedArchive);
    copyFileSync(archive, retainedArchive, constants.COPYFILE_EXCL);
    assert.equal(createHash('sha256').update(readFileSync(retainedArchive)).digest('hex'),
      smokeResult.packageSha256, 'Retained archive must match the installed package bytes');
    smokeResult.packageArchiveRetained = true;
  }
} catch (error) { smokeFailure = error; }
finally {
  let cleanupFailure;
  try {
    if (mcpClient) await mcpClient.close();
    if (confirmMcpClosure) await confirmMcpClosure(5_000);
  }
  catch (error) { cleanupFailure = error; }
  try { if (httpChild) await stopOwnedChild(httpChild); }
  catch (error) { cleanupFailure ??= error; }
  // Preserve the temporary data if either child shutdown was not confirmed.
  if (!cleanupFailure) {
    try {
      const child = relative(resolve(fixtureRoot), resolve(temporary));
      assert.ok(child.startsWith('rcac-package-smoke-') && !child.includes('..') && !child.includes('\\'));
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) { cleanupFailure = error; }
  }
  if (smokeFailure && cleanupFailure) throw new AggregateError([smokeFailure, cleanupFailure], 'Smoke and cleanup failed');
  if (smokeFailure) throw smokeFailure;
  if (cleanupFailure) throw cleanupFailure;
}
if (smokeResult) process.stdout.write(`${JSON.stringify(smokeResult)}\n`);

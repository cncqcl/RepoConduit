import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { protectNewDataDirectory } from '../dist/src/runtime/local-security.js';

// Bounded installed native-helper check, separate from full package/release acceptance.
assert.equal(process.platform, 'win32');
const retentionUnsafe = () => { throw new Error('WINDOWS_JOB_SMOKE_RETENTION_UNSAFE'); };
const assertRetentionDestination = target => {
  if (typeof target !== 'string' || !isAbsolute(target) || resolve(target) !== target ||
    !target.endsWith('.tgz')) retentionUnsafe();
  const parent = dirname(target);
  try {
    if (!lstatSync(parent).isDirectory() || realpathSync.native(parent) !== parent ||
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
assert.ok(process.env.npm_execpath);
const root = mkdtempSync(join(homedir(), 'rcac-windows-job-installed-'));
let complete = false;
const run = args => {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `offline npm operation failed (${result.status})`);
  return result.stdout;
};
try {
  protectNewDataDirectory(root);
  process.stdout.write('Windows Job helper: packing and installing offline\n');
  const packed = JSON.parse(run(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root]));
  assert.equal(packed.length, 1);
  assert.equal(basename(packed[0].filename), packed[0].filename);
  assert.ok(packed[0].filename.endsWith('.tgz'));
  const archive = join(root, packed[0].filename);
  const archiveStat = lstatSync(archive);
  assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink() &&
    archiveStat.size > 0 && archiveStat.size <= 32 * 1024 * 1024);
  const archiveBytes = readFileSync(archive);
  assert.equal(archiveBytes.length, archiveStat.size);
  const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  const archiveIntegrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
  assert.equal(packed[0].integrity, archiveIntegrity);
  const install = join(root, 'installed');
  run(['install', '--offline', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const adapter = join(install, 'node_modules/repo-conduit/dist/src/adapters/codex/investigator');
  const manifest = JSON.parse(readFileSync(join(adapter, 'windows-job-helper.manifest.json'), 'utf8'));
  assert.deepEqual(manifest, JSON.parse(readFileSync('dist/src/adapters/codex/investigator/windows-job-helper.manifest.json', 'utf8')));
  const { openWindowsJobCanary } = await import(pathToFileURL(join(adapter, 'windows-job-host.js')).href);
  const { runOwnedWindowsReadiness } = await import(pathToFileURL(join(adapter, 'windows-job-stdio.js')).href);
  const observations = [];
  for (const scenario of ['single', 'tree', 'parent_exits']) {
    const session = await openWindowsJobCanary(scenario);
    try {
      assert.equal(session.initial.phase, 'running');
      assert.ok(session.initial.members.fixturePids.length >= (scenario === 'single' ? 1 : 3));
      let observed = session.initial;
      if (scenario === 'parent_exits') {
        const deadline = Date.now() + 5000;
        while ((!observed.rootExited || observed.members.fixturePids.includes(observed.root.pid)) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 50));
          observed = await session.observe();
        }
        assert.equal(observed.rootExited, true);
        assert.equal(observed.members.fixturePids.includes(observed.root.pid), false);
        assert.ok(observed.members.fixturePids.length >= 2);
      }
      const closed = await session.stop();
      assert.equal(closed.phase, 'closed');
      assert.equal(closed.members.listed, 0);
      observations.push({ scenario, initial: session.initial, beforeStop: observed, closed });
    } finally { await session.abort(); }
  }
  const readinessObservations = [];
  const desktopExe = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.3656.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
  const desktopVersion = spawnSync(desktopExe, ['--version'], { encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' }, timeout: 5000, maxBuffer: 4096 });
  assert.equal(desktopVersion.status, 0);
  assert.equal(desktopVersion.error, undefined);
  assert.equal(desktopVersion.stdout.trim(), 'codex-cli 0.163.0-alpha.10.2');
  for (const recipe of ['stdio_fixture_v1', 'desktop_readiness_v1']) {
    const result = await runOwnedWindowsReadiness(recipe, { assertDiagnosticAuthority: () => true });
    assert.equal(result.isolationVerified, false);
    assert.equal(result.modelTurn, 'not_run');
    assert.equal(result.closure.members.listed, 0);
    readinessObservations.push(result);
  }
  const prepareRoot = join(root, 'prepare-only');
  mkdirSync(prepareRoot);
  protectNewDataDirectory(prepareRoot);
  for (const relativePath of ['runtime', 'runtime/home', 'runtime/home/.codex',
    'runtime/AppDataLocal', 'runtime/AppDataRoaming', 'runtime/temp', 'runtime/check', 'source'])
    mkdirSync(join(prepareRoot, relativePath));
  writeFileSync(join(prepareRoot, 'runtime/home/.codex/config.toml'),
    '# RepoConduit prepare-only synthetic fixture\n');
  writeFileSync(join(prepareRoot, 'source/README.md'),
    'RepoConduit prepare-only synthetic source\n');
  const { observeWindowsPrepareOnly } = await import(pathToFileURL(
    join(adapter, 'windows-prepare-only-observation.js')).href);
  const prepareOnlyObservation = await observeWindowsPrepareOnly({
    fixtureRoot: prepareRoot, maxWallSeconds: 15 });
  assert.equal(prepareOnlyObservation.kind, 'windows_prepare_only_component_v1');
  assert.equal(prepareOnlyObservation.recipe, 'windows_app_server_readonly_v1');
  assert.deepEqual(prepareOnlyObservation.prepared,
    { kind: 'prepared', sequence: 1, childPresent: false });
  assert.deepEqual(prepareOnlyObservation.preparedClosed,
    { kind: 'prepared_closed', sequence: 2, childPresent: false,
      members: { complete: true, assigned: 0, listed: 0, pids: [] } });
  assert.equal(prepareOnlyObservation.helperExitCode, 0);
  for (const key of ['launchId', 'start', 'send', 'writer', 'verified', 'root'])
    assert.equal(key in prepareOnlyObservation, false);
  const cli = join(install, 'node_modules/repo-conduit/dist/src/cli/main.js');
  const data = join(root, 'data');
  const runCli = (args, input) => {
    const result = spawnSync(process.execPath, [cli, '--data-dir', data, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 128 * 1024,
      ...(input===undefined?{}:{input:JSON.stringify(input)}),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `installed CLI failed (${result.status}): ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  assert.equal(runCli(['init']).initialized, true);
  const cliReadiness = runCli(['codex-windows-readiness']);
  assert.equal(cliReadiness.recipe, 'desktop_readiness_v1');
  assert.equal(cliReadiness.isolationVerified, false);
  assert.equal(cliReadiness.modelTurn, 'not_run');
  assert.equal(cliReadiness.closure.kind, 'job_closed');
  assert.deepEqual(cliReadiness.closure.root, cliReadiness.root);
  assert.deepEqual(cliReadiness.closure.members,
    { complete: true, assigned: 0, listed: 0, pids: [] });
  process.stdout.write('Windows runtime configuration: installed CLI prepare and reopen check\n');
  const workspace=join(root,'synthetic-workspace');mkdirSync(workspace);
  const registered=runCli(['request'],{operation:'admin.register_workspace',
    scope:{workspaceId:'management'},idempotencyKey:'windows-runtime-workspace',
    payload:{name:'Windows synthetic runtime',root:workspace}});
  const profile=runCli(['request'],{operation:'admin.configure_profile',
    scope:{workspaceId:'management'},idempotencyKey:'windows-runtime-profile',
    payload:{workspaceId:registered.id,expectedRevisionId:null,presetRef:'static_readonly_v1',
      budget:{maxWallSeconds:60,maxTurns:2,maxToolCalls:4}}});
  const prepared=runCli(['prepare-windows-investigator'],{workspaceId:registered.id,
    profileRevision:profile.id,modelRef:'gpt-6-sol'});
  assert.equal(prepared.productionAvailable,false);
  const configBytes=readFileSync(join(prepared.home,'.codex','config.toml'));
  assert.equal(createHash('sha256').update(configBytes).digest('hex'),prepared.configSha256);
  const runtimeChecks=[];
  for(let i=0;i<2;i++) {
    const checked=runCli(['check-windows-investigator'],{workspaceId:registered.id,
      profileRevision:profile.id,runtimeId:prepared.runtimeId});
    assert.equal(checked.runtimeId,prepared.runtimeId);
    assert.equal(checked.versionMatch,true);assert.equal(checked.configParseObserved,true);
    assert.equal(checked.featureFlagsMatch,true);assert.equal(checked.failureCause,'none');
    assert.equal(checked.isolationVerified,false);assert.equal(checked.strictConfigVerified,true);
    assert.equal(checked.productionAvailable,false);assert.equal(checked.modelTurn,'not_run');
    assert.equal(checked.authentication,'not_verified');
    assert.equal(existsSync(join(prepared.home,'.codex','auth.json')),false);
    assert.deepEqual(readFileSync(join(prepared.home,'.codex','config.toml')),configBytes);
    runtimeChecks.push(checked);
  }
  let retainedArchiveResult;
  if (retainedArchive) {
    assertRetentionDestination(retainedArchive);
    assert.ok(statSync(archive).size <= 32 * 1024 * 1024);
    copyFileSync(archive, retainedArchive, constants.COPYFILE_EXCL);
    const retainedBytes = readFileSync(retainedArchive);
    assert.equal(createHash('sha256').update(retainedBytes).digest('hex'), archiveSha256);
    assert.equal(`sha512-${createHash('sha512').update(retainedBytes).digest('base64')}`,
      archiveIntegrity);
    retainedArchiveResult = { path: retainedArchive, bytes: retainedBytes.length,
      sha256: archiveSha256, integrity: archiveIntegrity };
  }
  process.stdout.write(JSON.stringify({ installedNativeHelperPassed: true, archiveSha256,
    helperManifest: manifest, observations, desktopVersion: desktopVersion.stdout.trim(),
    readinessObservations, prepareOnlyObservation, cliReadiness,
    installedWindowsRuntime:{workspaceId:registered.id,profileRevision:profile.id,
      runtimeId:prepared.runtimeId,configSha256:prepared.configSha256,checks:runtimeChecks},
    ...(retainedArchiveResult ? { retainedArchive: retainedArchiveResult } : {}),
    releaseQualification: false }) + '\n');
  complete = true;
} finally {
  if (complete) {
    const home = realpathSync.native(homedir());
    const absolute = resolve(root);
    const child = relative(home, absolute);
    assert.ok(child === basename(absolute) && child.startsWith('rcac-windows-job-installed-') &&
      absolute.startsWith(home + sep));
    const stat = lstatSync(absolute);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(realpathSync.native(absolute).toLowerCase(), absolute.toLowerCase());
    rmSync(absolute, { recursive: true, force: true });
  } else process.stderr.write(`retained Windows Job smoke fixture: ${root}\n`);
}

import { spawn } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { valid } from 'semver';
import { assertPrivateInstallationDirectory } from './local-security.js';

const NPM_VERSION = '11.9.0';
const MAX_PACKAGE_JSON = 128 * 1024;
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_MIGRATION_OUTPUT = 4096;
const CHILD_TIMEOUT = 120_000;
const CLOSE_TIMEOUT = 5000;
const GENERATION = /^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(): never { throw new Error('INSTALLATION_CANDIDATE_UNSAFE'); }
function absolute(path: string): string {
  if (typeof path !== 'string' || !path || !isAbsolute(path) || resolve(path) !== path ||
    path === parse(path).root || path.endsWith(sep)) invalid();
  return path;
}
function same(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}
function directory(path: string, privateRoot = false): void {
  const selected = absolute(path);
  const stat = lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same(realpathSync.native(selected), selected)) invalid();
  if (privateRoot) assertPrivateInstallationDirectory(selected);
}
function file(path: string, limit: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    stat.size < 0 || stat.size > limit) invalid();
}
function privatePrefix(path: string): string {
  const prefix = absolute(path);
  directory(prefix, true);
  return prefix;
}
function npmCli(): string {
  const base = join(dirname(process.execPath), 'node_modules', 'npm');
  const metadata = join(base, 'package.json');
  const cli = join(base, 'bin', 'npm-cli.js');
  file(metadata, MAX_PACKAGE_JSON);
  file(cli, 1024 * 1024);
  let value: unknown;
  try { value = JSON.parse(readFileSync(metadata, 'utf8')) as unknown; }
  catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const packageJson = value as Record<string, unknown>;
  if (packageJson.name !== 'npm' || packageJson.version !== NPM_VERSION) invalid();
  return cli;
}
function ownConfig(prefix: string, name: string): string {
  const target = join(prefix, name);
  const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let primary: unknown;
  try { fsyncSync(descriptor); } catch (error) { primary = error; }
  try { closeSync(descriptor); }
  catch (error) {
    throw new AggregateError(primary === undefined ? [error] : [primary, error],
      'Installation npm config close unconfirmed', { cause: error });
  }
  if (primary !== undefined) throw primary;
  file(target, 0);
  return target;
}
function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    : ['HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (process.platform === 'win32') {
    const windows = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    env.ComSpec = join(windows, 'System32', 'cmd.exe');
    env.Path = [dirname(process.execPath), join(windows, 'System32'),
      join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  } else env.PATH = '/usr/bin:/bin';
  return env;
}
type Closed = { code: number; stdout: string };
function child(program: string, args: readonly string[], cwd: string, outputLimit: number,
  failure: string): Promise<Closed> {
  return new Promise((resolvePromise, rejectPromise) => {
    let subprocess: ReturnType<typeof spawn>;
    try { subprocess = spawn(program, [...args], { cwd, env: childEnvironment(),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { rejectPromise(new AggregateError([new Error('Spawn unconfirmed')], 'Installation child spawn unconfirmed')); return; }
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let uncertain: string | undefined;
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finishUncertain = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      rejectPromise(new AggregateError([new Error(uncertain ?? 'Close unconfirmed')],
        'Installation child completion unconfirmed'));
    };
    const stop = (reason: string): void => {
      if (uncertain) return;
      uncertain = reason;
      try { if (!subprocess.kill('SIGTERM')) uncertain = 'Child termination unconfirmed'; }
      catch { uncertain = 'Child termination unconfirmed'; }
      closeTimer = setTimeout(finishUncertain, CLOSE_TIMEOUT);
    };
    const timer = setTimeout(() => stop('Child timeout'), CHILD_TIMEOUT);
    subprocess.once('error', () => stop('Child spawn or execution error'));
    subprocess.stdout?.on('error', () => stop('Child stdout error'));
    subprocess.stderr?.on('error', () => stop('Child stderr error'));
    subprocess.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) { stop('Child output limit'); return; }
      stdout += chunk.toString('utf8');
    });
    subprocess.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) stop('Child output limit');
    });
    subprocess.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      if (uncertain || code === null || signal !== null) {
        rejectPromise(new AggregateError([new Error(uncertain ?? 'Child close or exit unconfirmed')],
          'Installation child completion unconfirmed'));
      } else if (code !== 0) rejectPromise(new Error(failure));
      else resolvePromise({ code, stdout });
    });
  });
}

/** Parent owns EXCLUSIVE and has already verified the fixed local archive. */
export async function installCandidatePackage(archiveAbsolute: string, prefixAbsolute: string): Promise<void> {
  const archive = absolute(archiveAbsolute);
  file(archive, MAX_ARCHIVE);
  if (!same(realpathSync.native(archive), archive)) invalid();
  const prefix = privatePrefix(prefixAbsolute);
  const cli = npmCli();
  const userconfig = ownConfig(prefix, '.rcac-npm-user.conf');
  const globalconfig = ownConfig(prefix, '.rcac-npm-global.conf');
  ownConfig(prefix, '.npmrc');
  await child(process.execPath, [cli, 'install', archive, '--prefix', prefix,
    '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    '--no-save', '--no-bin-links', '--allow-git=none', '--no-update-notifier',
    '--loglevel=error', '--userconfig', userconfig, '--globalconfig', globalconfig],
  prefix, MAX_OUTPUT, 'INSTALLATION_NPM_FAILED');
}

function installedEntry(prefix: string): { entry: string; packageVersion: string } {
  const packageRoot = join(prefix, 'node_modules', 'repo-conduit');
  for (const component of [join(prefix, 'node_modules'), packageRoot,
    join(packageRoot, 'dist'), join(packageRoot, 'dist', 'src'),
    join(packageRoot, 'dist', 'src', 'cli')]) directory(component);
  const metadata = join(packageRoot, 'package.json');
  const entry = join(packageRoot, 'dist', 'src', 'cli', 'migrate-installation.js');
  file(metadata, MAX_PACKAGE_JSON); file(entry, 16 * 1024 * 1024);
  let value: unknown;
  try { value = JSON.parse(readFileSync(metadata, 'utf8')) as unknown; }
  catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const packageJson = value as Record<string, unknown>;
  if (packageJson.name !== 'repo-conduit' || typeof packageJson.version !== 'string' ||
    valid(packageJson.version) !== packageJson.version) invalid();
  return { entry, packageVersion: packageJson.version };
}

/** Fixed candidate worker; parent remains the sole authority for publication. */
export async function executeInstallationCandidateMigration(prefixAbsolute: string, rootAbsolute: string,
  generation: string, fromVersion: string): Promise<{
    migrated: true; dataFormatVersion: 1; packageVersion: string
  }> {
  const prefix = privatePrefix(prefixAbsolute);
  const root = absolute(rootAbsolute);
  directory(root, true);
  if (!GENERATION.test(generation) || valid(fromVersion) !== fromVersion) invalid();
  const { entry, packageVersion } = installedEntry(prefix);
  const result = await child(process.execPath, [entry, root, generation, fromVersion], prefix,
    MAX_MIGRATION_OUTPUT, 'INSTALLATION_MIGRATION_FAILED');
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout) as unknown; }
  catch { return invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'dataFormatVersion,migrated,packageVersion' ||
    value.migrated !== true || value.dataFormatVersion !== 1 || value.packageVersion !== packageVersion) invalid();
  return { migrated: true, dataFormatVersion: 1, packageVersion };
}

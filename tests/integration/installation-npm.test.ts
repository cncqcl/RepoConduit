import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance, retainInstallationMaintenance } from '../../src/runtime/installation.js';
import { installCandidatePackage, executeInstallationCandidateMigration } from '../../src/runtime/installation-npm.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const parent = process.platform === 'win32' ? homedir() : tmpdir();
function fixture() {
  const base = mkdtempSync(join(parent, 'rcac-install-npm-'));
  protectNewDataDirectory(base);
  let retain = false;
  return {
    base,
    keep(): void { retain = true; },
    cleanup(): void {
      if (retain) return;
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-install-npm-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    }
  };
}
function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  protectNewDataDirectory(path);
}
function pack(source: string, destination: string, retain: () => void): string {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packed = spawnSync(process.execPath, [cli, 'pack', '--json', '--offline', '--ignore-scripts',
    '--pack-destination', destination], { cwd: source, encoding: 'utf8', timeout: 30_000 });
  if (packed.error || packed.signal !== null || typeof packed.status !== 'number') {
    retain();
    throw new AggregateError([packed.error ?? new Error('npm pack exit unconfirmed')], 'npm pack exit unconfirmed');
  }
  assert.equal(packed.status, 0, packed.stderr);
  const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0]?.filename;
  assert.ok(filename);
  return join(destination, filename);
}

test('fixed npm 11 installs a local archive offline with scripts and inherited Node options disabled', async () => {
  const f = fixture();
  try {
    const source = join(f.base, 'source'); privateDirectory(source);
    const cli = join(source, 'dist', 'src', 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'main.js'), 'export {}');
    writeFileSync(join(cli, 'migrate-installation.js'), 'export {}');
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'repo-conduit', version: '0.1.1',
      type: 'module', bin: { rcac: 'dist/src/cli/main.js' },
      scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('script-ran','yes')\"" } }));
    const archive = pack(source, f.base, f.keep);
    const prefix = join(f.base, 'prefix'); privateDirectory(prefix);
    const poison = join(f.base, 'node-options-poison.cjs');
    writeFileSync(poison, "require('node:fs').writeFileSync('node-options-ran','yes')");
    const prior = process.env.NODE_OPTIONS;
    const priorConfig = process.env.npm_config_global;
    try {
      process.env.NODE_OPTIONS = `--require=${poison}`;
      process.env.npm_config_global = 'true';
      await installCandidatePackage(archive, prefix);
    } catch (error) {
      if (error instanceof AggregateError) f.keep();
      throw error;
    } finally {
      if (prior === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prior;
      if (priorConfig === undefined) delete process.env.npm_config_global;
      else process.env.npm_config_global = priorConfig;
    }
    const installed = join(prefix, 'node_modules', 'repo-conduit');
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(existsSync(join(installed, 'script-ran')), false);
    assert.equal(existsSync(join(prefix, 'script-ran')), false);
    assert.equal(existsSync(join(f.base, 'node-options-ran')), false);
    assert.equal(existsSync(join(prefix, 'node-options-ran')), false);
    assert.equal(lstatSync(join(prefix, '.rcac-npm-user.conf')).isFile(), true);
    assert.equal(lstatSync(join(prefix, '.rcac-npm-global.conf')).isFile(), true);
  } catch (error) { f.keep(); throw error; }
  finally { f.cleanup(); }
});

test('installed product migration executes the fixed candidate entry and preserves old active selection', async () => {
  const f = fixture();
  try {
    const project = fileURLToPath(new URL('../..', import.meta.url));
    const archive = pack(project, f.base, f.keep);
    const prefix = join(f.base, 'prefix'); privateDirectory(prefix);
    try { await installCandidatePackage(archive, prefix); }
    catch (error) { if (error instanceof AggregateError) f.keep(); throw error; }
    const root = join(f.base, 'installation');
    createManagedInstallation(root);
    const before = readFileSync(join(root, 'managed.json'));
    const manifest = JSON.parse(before.toString('utf8')) as { activeGeneration: string };
    const oldData = join(root, 'generations', manifest.activeGeneration, 'data');
    const generation = `gen_${randomUUID()}`;
    const candidate = join(root, 'generations', generation);
    privateDirectory(candidate);
    const copy = join(candidate, 'data');
    cpSync(oldData, copy, { recursive: true });
    protectNewDataDirectory(copy);
    const owner = acquireInstallationMaintenance(root);
    let primary: unknown;
    let result: Awaited<ReturnType<typeof executeInstallationCandidateMigration>> | undefined;
    try {
      result = await executeInstallationCandidateMigration(prefix, root, generation, '0.1.0');
    } catch (error) { primary = error; }
    if (primary instanceof AggregateError) { retainInstallationMaintenance(owner); f.keep(); throw primary; }
    try { owner.release(); }
    catch (error) {
      retainInstallationMaintenance(owner); f.keep();
      throw new AggregateError(primary === undefined ? [error] : [primary, error],
        'Owner close unconfirmed', { cause: error });
    }
    if (primary !== undefined) throw primary;
    assert.deepEqual(result, { migrated: true, dataFormatVersion: 1, packageVersion: '0.1.0' });
    assert.deepEqual(readFileSync(join(root, 'managed.json')), before);
    assert.equal(existsSync(join(copy, 'state.sqlite')), true);
  } catch (error) { f.keep(); throw error; }
  finally { f.cleanup(); }
});

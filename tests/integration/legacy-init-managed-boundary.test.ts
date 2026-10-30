import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { acquireExclusiveMaintenanceGate, initializeMaintenanceGate } from '../../src/runtime/maintenance-gate.js';

test('legacy init cannot write managed descendants under exclusive maintenance, including junction parents', async (t) => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const fixture = mkdtempSync(join(base, 'rcac-legacy-boundary-'));
  const managed = join(fixture, 'managed');
  let held: ReturnType<typeof acquireExclusiveMaintenanceGate> | undefined;
  let primary: unknown;
  try {
    protectNewDataDirectory(fixture);
    mkdirSync(managed); protectNewDataDirectory(managed); initializeMaintenanceGate(managed);
    held = acquireExclusiveMaintenanceGate(managed);
    const gateBytes = readFileSync(join(managed, 'lifecycle.sqlite'));
    const init = (root: string) => spawnSync(process.execPath,
      ['--import', 'tsx', resolve('src/cli/main.ts'), '--data-dir', root, 'init'],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 20_000 });
    const direct = join(managed, 'forbidden');
    assert.equal(init(direct).status, 1, 'legacy init must reject before creating a managed child');
    assert.equal(existsSync(direct), false);
    const alias = join(fixture, 'alias');
    let linked = true;
    try { symlinkSync(managed, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
        linked = false; t.diagnostic(`directory link unavailable: ${String(error.code)}`);
      } else throw error;
    }
    if (linked) {
      assert.equal(init(join(alias, 'forbidden-alias')).status, 1);
      assert.equal(existsSync(join(managed, 'forbidden-alias')), false);
    }
    assert.deepEqual(readFileSync(join(managed, 'lifecycle.sqlite')), gateBytes);
    const independent = join(fixture, 'independent');
    const created = init(independent);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(existsSync(join(independent, 'state.sqlite')), true);
  } catch (error) { primary = error; }
  let cleanup: unknown;
  try {
    held?.release();
    assert.match(relative(resolve(base), resolve(fixture)), /^rcac-legacy-boundary-[A-Za-z0-9_-]{6}$/);
    rmSync(fixture, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (primary && cleanup) throw new AggregateError([primary, cleanup], 'Legacy init regression and cleanup failed');
  if (primary) throw primary;
  if (cleanup) throw cleanup;
});

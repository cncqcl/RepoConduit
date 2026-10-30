import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = mkdtempSync(join(tmpdir(), 'rcac-live-fixtures-'));
const run = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
};

for (const name of ['project-a', 'project-b']) {
  const target = join(destination, name);
  cpSync(join(repository, 'tests', 'fixtures', 'legacy-runtime', name), target, { recursive: true });
  if (name === 'project-a') {
    const scheduler = join(target, 'src', 'scheduler.py');
    const original = readFileSync(scheduler, 'utf8');
    const padding = Array.from({ length: 2400 }, (_, index) =>
      `# pagination line ${String(index + 1).padStart(4, '0')} — safe synthetic trace boundary\n`).join('');
    const expanded = original.replace('# __PAGINATION_FILLER__', padding);
    if (expanded === original || Buffer.byteLength(expanded) <= 64 * 1024) throw new Error('Fixture pagination threshold not met');
    writeFileSync(scheduler, expanded);
    writeFileSync(join(target, 'src', 'longline.txt'), `${'A'.repeat(65_535)}界${'B'.repeat(1024)}\n`, { flag: 'wx' });
  }
  run(target, 'init', '-q');
  run(target, 'config', 'user.name', 'RepoConduit Fixture');
  run(target, 'config', 'user.email', 'fixture@example.invalid');
  run(target, 'add', '.');
  run(target, 'commit', '-qm', 'Synthetic acceptance baseline');
}

const oracle = {
  projectA: {
    normalFlow: 'src/entry.py → src/scheduler.py → src/state.py → src/store.py',
    queuedCancel: 'src/cancel.py immediately marks cancelled; scheduler skips it',
    runningCancel: 'src/cancel.py only records intent; src/scheduler.py late_audit_branch reports nonterminal cancellation',
    lateFunction: 'src/scheduler.py:late_audit_branch occurs beyond the default 64 KiB read page',
    utf8Boundary: 'src/longline.txt has one line beyond 64 KiB with a multibyte character at the page boundary',
  },
  projectB: { exclusiveMarker: 'PROJECT_B_ONLY_CITRINE' },
};
writeFileSync(join(destination, 'oracle.json'), `${JSON.stringify(oracle, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${destination}\n`);

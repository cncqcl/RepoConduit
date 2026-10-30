import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli/main.js';

test('upgrade CLI rejects widened arguments and dispatches the fixed local route before runtime creation', async () => {
  const root = resolve('not-an-installation-for-upgrade-test');
  const archive = resolve('not-a-candidate-for-upgrade-test.tgz');
  const backup = resolve('not-a-backup-for-upgrade-test');
  const valid = ['--data-dir', root, 'upgrade', '--package', archive, '--backup', backup];
  for (const argv of [valid.slice(0, -1), [...valid, '--command', 'anything'],
    ['--data-dir', root, 'upgrade', '--package', 'relative.tgz', '--backup', backup],
    ['--data-dir', root, 'upgrade', '--backup', backup, '--package', archive]]) {
    await assert.rejects(main(argv), TypeError);
  }
  await assert.rejects(main(valid), error => error instanceof Error && error.message === 'INSTALLATION_UNSAFE');
});

test('upgrade dry-run CLI accepts only one terminal flag and reaches maintenance preflight', async () => {
  const fixed = ['--data-dir', resolve('missing-dry-run-installation'), 'upgrade',
    '--package', resolve('missing-dry-run.tgz'), '--backup', resolve('missing-dry-run-backup')];
  for (const argv of [[...fixed, '--dry-run', 'true'], [...fixed, '--dry-run', '--dry-run'],
    [...fixed, '--dryrun'], [...fixed, '--command', 'anything', '--dry-run']]) {
    await assert.rejects(main(argv), TypeError);
  }
  await assert.rejects(main([...fixed, '--dry-run']),
    error => error instanceof Error && error.message === 'INSTALLATION_UNSAFE');
});

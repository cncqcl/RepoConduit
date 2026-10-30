import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appServerUnitSpec } from '../../src/adapters/codex/investigator/systemd-pipe.js';

const input = {
  distro: 'Ubuntu-22.04', loginId: 'c033e1ac-1796-4a23-b807-1da8b9c949b1',
  linuxHome: '/home/fixture', linuxNode: '/home/fixture/.hermes/node/bin/node',
  codexEntry: '/home/fixture/.local/repoconduit-codex-0.157.1/package/bin/codex.js',
  unitName: 'rcac-investigator-11111111-1111-4111-8111-111111111111.service',
  maxWallSeconds: 60,
};

test('App Server unit spec uses a single transient service, private environment and bounded lifetime', () => {
  const spec = appServerUnitSpec(input);
  const root = `/home/fixture/.local/repoconduit-private-homes/${input.loginId}`;
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(spec.args, [
    '-d', 'Ubuntu-22.04', '--user', 'fixture', '--exec', '/usr/bin/systemd-run',
    '--user', '--quiet', `--unit=${input.unitName}`, '--service-type=exec',
    '--property=Restart=no', '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes', '--property=RuntimeMaxSec=60s',
    '--property=TimeoutStopSec=2s', `--working-directory=${root}/workspace`,
    '--pipe', '--wait', '/usr/bin/env', '-i',
    `HOME=${root}/home`, `CODEX_HOME=${root}/home/.codex`,
    'PATH=/home/fixture/.local/repoconduit-codex-0.157.1/bin:/home/fixture/.hermes/node/bin:/usr/bin:/bin',
    input.linuxNode, input.codexEntry, 'app-server', '--stdio',
  ]);
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
});

test('App Server unit spec rejects another unit shape, path, user or unbounded service', () => {
  for (const mutation of [
    { unitName: 'other.service' }, { unitName: 'rcac-investigator-../evil.service' },
    { maxWallSeconds: 0 }, { maxWallSeconds: 601 },
    { linuxHome: '/mnt/d/home' }, { codexEntry: '/home/fixture/other/codex.js' },
    { linuxNode: '/home/other/bin/node' }, { distro: 'Ubuntu; shell' },
  ]) assert.throws(() => appServerUnitSpec({ ...input, ...mutation }), /INVALID_ARGUMENT/);
});

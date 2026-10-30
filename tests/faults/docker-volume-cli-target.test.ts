import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedDockerVolumeInvocation } from '../../src/runtime/investigation-recovery.js';

test('Docker volume recovery pins one local endpoint despite mutable default contexts', () => {
  const command = ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'];
  const first = fixedDockerVolumeInvocation(command, {
    DOCKER_CONTEXT: 'remote-a', DOCKER_HOST: 'tcp://example.invalid:2375',
    DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/sensitive', TASK_MARKER: 'retained',
  });
  const second = fixedDockerVolumeInvocation(command, { DOCKER_CONTEXT: 'remote-b' });
  const endpoint = process.platform === 'win32' ?
    'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
  assert.deepEqual(first.args, ['--host', endpoint, ...command]);
  assert.deepEqual(second.args, first.args);
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    assert.equal(first.environment[key], undefined);
    assert.equal(second.environment[key], undefined);
  }
  assert.equal(first.environment.TASK_MARKER, 'retained');
});

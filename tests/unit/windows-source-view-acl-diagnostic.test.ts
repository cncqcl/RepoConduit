import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyWindowsAclProbe } from '../../src/adapters/codex/investigator/windows-source-view.js';

const probe = (status: number | null, stdout: string, stderr = '', errorCode?: string) =>
  ({ status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), signal: null, errorCode });

test('ACL probe accepts only its exact paired success frame', () => {
  assert.equal(classifyWindowsAclProbe(probe(0, 'RCAC_VIEW_ACL_V1:PASS'), 'acl'), null);
  for (const result of [
    probe(0, 'RCAC_VIEW_ACL_V1:PASS\n'),
    probe(0, 'RCAC_VIEW_ACL_V1:PASS', 'extra'),
    probe(41, 'RCAC_VIEW_ACL_V1:PASS'),
    probe(43, ''),
    probe(99, 'RCAC_VIEW_ACL_V1:RULE'),
    probe(0, 'RCAC_VIEW_ACL_V1:REPARSE'),
    probe(0, 'RCAC_VIEW_ACL_V1:UNKNOWN'),
    probe(0, 'RCAC_VIEW_ACL_V1:PASS\nRCAC_VIEW_ACL_V1:PASS'),
  ]) {
    assert.deepEqual(classifyWindowsAclProbe(result, 'acl'),
      { component: 'windows_acl', check: 'acl', reason: 'invalid_protocol' });
  }
});

test('ACL probe classifies only paired fixed rejection frames', () => {
  assert.deepEqual(classifyWindowsAclProbe(probe(41, 'RCAC_VIEW_ACL_V1:REPARSE'), 'reparse'),
    { component: 'windows_acl', check: 'reparse', reason: 'reparse_point' });
  assert.deepEqual(classifyWindowsAclProbe(probe(42, 'RCAC_VIEW_ACL_V1:OWNER'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'untrusted_owner' });
  assert.deepEqual(classifyWindowsAclProbe(probe(43, 'RCAC_VIEW_ACL_V1:RULE'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'untrusted_rule' });
  assert.deepEqual(classifyWindowsAclProbe(probe(44, 'RCAC_VIEW_ACL_V1:INSPECTION'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'inspection_failed' });
  assert.deepEqual(classifyWindowsAclProbe(probe(43, 'RCAC_VIEW_ACL_V1:RULE', 'detail'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'invalid_protocol' });
});

test('ACL probe process failures use fixed reasons without raw error details', () => {
  const raw = 'C:\\private\\secret.txt S-1-5-21-999';
  const rawFailure = { ...probe(null, raw, raw, 'ETIMEDOUT'), rawException: new Error(raw) };
  const timedOut = classifyWindowsAclProbe(rawFailure, 'acl');
  assert.deepEqual(timedOut,
    { component: 'windows_acl', check: 'acl', reason: 'timeout' });
  assert.equal(Object.isFrozen(timedOut), true);
  assert.equal(JSON.stringify(timedOut).includes(raw), false);
  assert.deepEqual(classifyWindowsAclProbe(probe(null, '', '', 'ENOBUFS'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'output_limit' });
  assert.deepEqual(classifyWindowsAclProbe(probe(null, '', '', 'ENOENT'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'launch_failed' });
  assert.deepEqual(classifyWindowsAclProbe(probe(null, '', '', 'EIO'), 'acl'),
    { component: 'windows_acl', check: 'acl', reason: 'process_failed' });
  assert.deepEqual(classifyWindowsAclProbe({ ...probe(null, ''), signal: 'SIGTERM' }, 'reparse'),
    { component: 'windows_acl', check: 'reparse', reason: 'process_failed' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflightWindowsDesktop } from '../../src/adapters/codex/investigator/windows-preflight.js';

test('default product readiness uses owned native Job stdio and returns exact closure proof',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const result = await preflightWindowsDesktop();
    assert.equal(result.isolationVerified, false);
    assert.equal(result.modelTurn, 'not_run');
    assert.ok('closure' in result, 'default diagnostic cannot rely on root-only child.kill');
    const closure = result.closure as { kind: string; root: unknown;
      members: { complete: boolean; assigned: number; listed: number; pids: number[] } };
    assert.equal(closure.kind, 'job_closed');
    assert.deepEqual(closure.members, { complete: true, assigned: 0, listed: 0, pids: [] });
    assert.ok('root' in result);
    assert.deepEqual(closure.root, result.root);
  });

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

for (const fault of ['nonzero', 'invalid_json']) {
  test(`archive diagnostic retains the first product failure stage: ${fault}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rcac-archive-diagnostic-'));
    try {
      const data = join(root, 'data'), evidence = join(root, 'evidence');
      mkdirSync(data); mkdirSync(join(evidence, 'verification'), { recursive: true });
      writeFileSync(join(evidence, 'verification', 'RUNTIME_ACCEPTANCE.json'), '{}');
      const cli = join(root, 'synthetic-cli.mjs');
      writeFileSync(cli, fault === 'nonzero' ?
        'process.stderr.write("SENSITIVE_RAW_ERROR");process.exitCode=2;' :
        'process.stdout.write("SENSITIVE_INVALID_JSON");');
      const result = spawnSync(process.execPath, [resolve('tools/archive-live-bundle.mjs'),
        '--data-dir', data, '--cli', cli, '--evidence-root', evidence], {
        input: JSON.stringify({ runId: 'LIVE01', role: 'v1', scope: {
          workspaceId: 'synthetic', collaborationId: 'synthetic' }, bundleId: 'synthetic' }),
        encoding: 'utf8', timeout: 5_000,
      });
      assert.equal(result.status, 1);
      const line = result.stderr.trim().split('\n').at(-1)!;
      const diagnostic = JSON.parse(line);
      assert.deepEqual(diagnostic, { stage: 'inspect',
        reason: fault === 'nonzero' ? 'product_nonzero' : 'product_invalid_response',
        exitCode: fault === 'nonzero' ? 2 : null });
      assert.equal(result.stderr.includes('SENSITIVE'), false);
      assert.equal(result.stderr.includes(root), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

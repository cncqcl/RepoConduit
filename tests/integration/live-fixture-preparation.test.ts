import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readSnapshot } from '../../src/adapters/repository/queries.js';
import { captureGitTree } from '../../src/adapters/repository/snapshots.js';

test('prepared live fixtures have real Git baselines, a paged late function, and a UTF-8 boundary', async () => {
  const root = execFileSync(process.execPath, ['tools/prepare-live-fixtures.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', windowsHide: true, timeout: 20_000,
  }).trim();
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.match(basename(root), /^rcac-live-fixtures-[A-Za-z0-9]+$/);
  try {
    const a = await captureGitTree(join(root, 'project-a'));
    const b = await captureGitTree(join(root, 'project-b'));
    assert.equal(a.sourceConsistency, 'verified_git_tree');
    assert.equal(b.sourceConsistency, 'verified_git_tree');
    assert.ok(a.manifest.some(file => file.path === 'src/scheduler.py' && file.sizeBytes > 64 * 1024));
    assert.ok(!a.manifest.some(file => file.path.includes('oracle')));
    assert.ok(!a.manifest.some(file => a.file(file.path)?.includes('PROJECT_B_ONLY_CITRINE')));
    assert.ok(b.file('src/marker.py')?.toString('utf8').includes('PROJECT_B_ONLY_CITRINE'));

    const context = { principal: 'fixture-reader', scopePaths: ['src/scheduler.py', 'src/longline.txt'] };
    let cursor: string | undefined;
    let pages = 0;
    let sawLateFunction = false;
    do {
      const page = readSnapshot(a, context, { path: 'src/scheduler.py', ...(cursor ? { cursor } : {}) });
      pages++;
      sawLateFunction ||= page.content.includes('def late_audit_branch');
      cursor = page.continuation;
      assert.ok(pages < 20);
    } while (cursor);
    assert.ok(pages > 1 && sawLateFunction);

    const first = readSnapshot(a, context, { path: 'src/longline.txt' });
    assert.equal(first.completeness, 'partial');
    assert.ok(first.continuation);
    const second = readSnapshot(a, context, { path: 'src/longline.txt', cursor: first.continuation });
    assert.ok((first.content + second.content).includes('界'));
    assert.ok(!(first.content + second.content).includes('\uFFFD'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

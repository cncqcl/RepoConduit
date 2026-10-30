import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureGitTree } from '../../src/adapters/repository/snapshots.ts';
import { readSnapshot, listSnapshot, inspectSnapshot, diffSnapshots } from '../../src/adapters/repository/queries.ts';

test('Git tree snapshot excludes dirty and untracked content and remains fixed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcac-repo-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), 'committed\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const commit = git('rev-parse', 'HEAD');
    await writeFile(join(root, 'src', 'main.ts'), 'dirty\n');
    await writeFile(join(root, 'src', 'new.ts'), 'untracked\n');
    const snapshot = await captureGitTree(root);
    assert.equal(snapshot.baseCommit, commit);
    assert.equal(snapshot.sourceConsistency, 'verified_git_tree');
    assert.ok(snapshot.exclusions.some(e => e.reason === 'dirty_worktree'));
    assert.ok(snapshot.exclusions.some(e => e.reason === 'untracked'));
    const context = { principal: 'alice', scopePaths: ['src/main.ts'] };
    assert.equal(readSnapshot(snapshot, context, { path: 'src/main.ts' }).content, 'committed\n');
    await writeFile(join(root, 'src', 'main.ts'), 'changed again\n');
    assert.equal(readSnapshot(snapshot, context, { path: 'src/main.ts' }).content, 'committed\n');
    assert.equal(listSnapshot(snapshot, context).entries.length, 1);
    assert.equal(inspectSnapshot(snapshot, context).sourceConsistency, 'verified_git_tree');
    assert.deepEqual(Object.keys(snapshot.toPersisted().files), ['src/main.ts']);
    const later = await captureGitTree(root, commit, { workingCopyId: snapshot.workingCopyId });
    assert.deepEqual(diffSnapshots(snapshot, later, context).changes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

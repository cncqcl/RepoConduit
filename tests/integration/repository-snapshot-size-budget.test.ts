import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGitTree } from '../../src/adapters/repository/snapshots.ts';

test('tree sizes avoid per-file metadata processes while preserving LFS and byte budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcac-tree-size-'));
  const original = childProcess.execFileSync;
  const calls: string[][] = [];
  try {
    const git = (...args: string[]) => original('git', ['-C', root, ...args]);
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    const binary = Buffer.from([0, 255, 10, 13, 9]);
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 1\n';
    await writeFile(join(root, 'a.bin'), binary);
    await writeFile(join(root, 'b-lfs.txt'), pointer);
    await writeFile(join(root, 'c tail.txt'), Buffer.alloc(145, 65));
    await writeFile(join(root, 'd-large.txt'), Buffer.alloc(151, 66));
    await writeFile(join(root, 'e-full.txt'), 'x');
    git('add', '.'); git('commit', '-qm', 'base');
    mock.method(childProcess, 'execFileSync', ((...args: unknown[]) => {
      calls.push([...(args[1] as string[])]);
      return Reflect.apply(original, childProcess, args);
    }) as typeof execFileSync);
    syncBuiltinESMExports();
    const snapshot = await captureGitTree(root, 'HEAD', { maxFileBytes: 150, maxTotalBytes: 150 });
    assert.deepEqual(snapshot.manifest.map(entry => entry.path), ['a.bin', 'c tail.txt']);
    assert.deepEqual(snapshot.file('a.bin'), binary);
    assert.deepEqual(snapshot.file('c tail.txt'), Buffer.alloc(145, 65));
    assert.ok(snapshot.exclusions.some(entry => entry.path === 'b-lfs.txt' && entry.reason === 'lfs_pointer'));
    for (const path of ['d-large.txt', 'e-full.txt']) {
      assert.ok(snapshot.exclusions.some(entry => entry.path === path && entry.reason === 'size_limit'));
    }
    assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('-s')).length, 0);
    assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('blob')).length, 3);
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    // root is the fresh synthetic directory returned by mkdtemp above.
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import type { InvestigationSourcePlan } from '../../src/application/investigation-source-plan.js';
import { closeWindowsFrozenSource, materializeWindowsFrozenSource } from '../../src/adapters/codex/investigator/windows-source-view.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const id = '11111111-1111-4111-8111-111111111111';
const binding = {
  workspaceId: `ws_${id}`, collaborationId: `collab_${id}`, workingCopyId: `copy_${id}`,
  snapshotRef: `snap_${id}`, contextRevisionId: `ctx_${id}`, recipient: 'tester',
  requestId: `inv_${id}`, attemptId: `attempt_${id}`, workerEpoch: 1,
};
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function plan(paths = ['src/a.ts']): InvestigationSourcePlan {
  const files = paths.map(path => {
    const bytes = Buffer.from('selected bytes\n');
    return { path, sizeBytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
  });
  return { binding, sourceConsistency: 'verified_git_tree', files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    digest: sha(JSON.stringify({ binding, sourceConsistency: 'verified_git_tree',
      files: files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })) })) };
}

function fixture(run: (root: string) => void): void {
  const home = homedir();
  const root = mkdtempSync(join(home, 'rcac-win-source-'));
  try {
    protectNewDataDirectory(root);
    writeFileSync(join(root, 'state.sqlite'), 'fixture');
    run(root);
  } finally {
    const child = relative(resolve(home), resolve(root));
    assert.ok(child.startsWith('rcac-win-source-') && !child.includes('..') && !child.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  }
}

test('native Windows source view publishes exact frozen bytes and is idempotent',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const first = materializeWindowsFrozenSource(plan(), root);
    assert.equal(first.sourceDigest, plan().digest);
    assert.equal(readFileSync(join(first.viewPath, 'src', 'a.ts'), 'utf8'), 'selected bytes\n');
    assert.equal(materializeWindowsFrozenSource(plan(), root).viewPath, first.viewPath);
    assert.equal(first.isolationVerified, false);
  }));

test('rejects changed bytes, aliases and injected fields before creating a view',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    for (const paths of [['../escape'], ['src/A.ts', 'src/a.ts'], ['src/a.ts', 'src/a.ts'],
      ['src/a.ts', 'src/a.ts/child'], ['.env'], ['CON.txt'],
      ['.RCAC-SOURCE-VIEW.JSON'], ['.rcac-source-view.json/child.ts']]) {
      assert.throws(() => materializeWindowsFrozenSource(plan(paths), root));
      assert.deepEqual(readdirSync(root).sort(), ['state.sqlite']);
    }
    const changed = plan(); changed.files[0]!.base64 = Buffer.from('other').toString('base64');
    assert.throws(() => materializeWindowsFrozenSource(changed, root));
    const injected = { ...plan(), untrustedRoot: root } as InvestigationSourcePlan;
    assert.throws(() => materializeWindowsFrozenSource(injected, root));
    assert.deepEqual(readdirSync(root).sort(), ['state.sqlite']);
    assert.equal(existsSync(join(root, `${binding.attemptId}.view`)), false);
  }));

test('same attempt cannot reuse a view for a different binding or digest',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const first = plan();
    materializeWindowsFrozenSource(first, root);
    const changedBinding = plan();
    changedBinding.binding = { ...changedBinding.binding, recipient: 'other' };
    changedBinding.digest = sha(JSON.stringify({ binding: changedBinding.binding,
      sourceConsistency: changedBinding.sourceConsistency,
      files: changedBinding.files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })) }));
    assert.throws(() => materializeWindowsFrozenSource(changedBinding, root), /SOURCE_VIEW_UNSAFE/);
    assert.deepEqual(readdirSync(root).sort(), [`${binding.attemptId}.view`, 'state.sqlite']);
  }));

test('rejects reparse root and existing source view with foreign link or hardlink',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const sibling = mkdtempSync(join(homedir(), 'rcac-win-source-sibling-'));
    try {
      const link = join(root, 'linked');
      symlinkSync(sibling, link, 'junction');
      assert.throws(() => materializeWindowsFrozenSource(plan(), link));
      const first = materializeWindowsFrozenSource(plan(), root);
      const source = join(first.viewPath, 'src', 'a.ts');
      const foreign = join(root, 'foreign.txt');
      linkSync(source, foreign);
      assert.throws(() => materializeWindowsFrozenSource(plan(), root));
      assert.equal(readFileSync(foreign, 'utf8'), 'selected bytes\n');
      unlinkSync(foreign);
      renameSync(join(first.viewPath, 'src'), join(first.viewPath, 'hidden-source'));
      symlinkSync(sibling, join(first.viewPath, 'src'), 'junction');
      assert.throws(() => materializeWindowsFrozenSource(plan(), root));
      assert.equal(existsSync(join(sibling, 'a.ts')), false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  }));

test('rejects data roots with untrusted replacement rights in ancestors',
  { skip: process.platform !== 'win32' }, () => {
    const parent = mkdtempSync(join(homedir(), 'rcac-win-source-parent-'));
    const root = join(parent, 'data');
    try {
      mkdirSync(root);
      protectNewDataDirectory(root);
      writeFileSync(join(root, 'state.sqlite'), 'fixture');
      execFileSync('C:\\Windows\\System32\\icacls.exe',
        [parent, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore' });
      assert.throws(() => materializeWindowsFrozenSource(plan(), root));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

test('refuses an interrupted staging artifact instead of silently publishing another view',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const stage = join(root, `${binding.attemptId}.${'a'.repeat(8)}.staging`);
    mkdirSync(stage);
    writeFileSync(join(stage, 'foreign'), 'preserve');
    assert.throws(() => materializeWindowsFrozenSource(plan(), root), /SOURCE_VIEW_UNSAFE/);
    assert.equal(readFileSync(join(stage, 'foreign'), 'utf8'), 'preserve');
    assert.equal(existsSync(join(root, `${binding.attemptId}.view`)), false);
  }));

const descriptor = () => ({ attemptId: binding.attemptId, workspaceId: binding.workspaceId,
  workerEpoch: binding.workerEpoch, sourceDigest: plan().digest });

test('close records a permanent tombstone for reserve-only attempt and rejects late materialization',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const closed = closeWindowsFrozenSource(descriptor(), root);
    assert.deepEqual(closed, { kind: 'closed', descriptor: descriptor(),
      viewPath: join(root, `${binding.attemptId}.view`), isolationVerified: false });
    assert.deepEqual(closeWindowsFrozenSource(descriptor(), root), closed);
    assert.throws(() => materializeWindowsFrozenSource(plan(), root), /SOURCE_VIEW_UNSAFE/);
  }));

test('close removes exact full view, persists tombstone, and rejects late materialization',
  { skip: process.platform !== 'win32' }, t => fixture(root => {
    const original = materializeWindowsFrozenSource(plan(), root);
    let closed;
    try { closed = closeWindowsFrozenSource(descriptor(), root); }
    catch (error) {
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause && typeof cause === 'object') {
        const fields = cause as Record<string, unknown>;
        if (Object.keys(fields).sort().join(',') === 'check,component,reason' &&
          fields.component === 'windows_acl' &&
          (fields.check === 'reparse' || fields.check === 'acl') &&
          ['reparse_point', 'untrusted_owner', 'untrusted_rule', 'inspection_failed',
            'timeout', 'output_limit', 'launch_failed', 'process_failed', 'invalid_protocol']
            .includes(String(fields.reason))) {
          t.diagnostic(JSON.stringify({ component: fields.component, check: fields.check,
            reason: fields.reason }));
        }
      }
      throw error;
    }
    assert.equal(closed.viewPath, original.viewPath);
    assert.equal(existsSync(original.viewPath), false);
    assert.ok(existsSync(join(root, `${binding.attemptId}.source.closed.json`)));
    assert.deepEqual(closeWindowsFrozenSource(descriptor(), root), closed);
    assert.throws(() => materializeWindowsFrozenSource(plan(), root), /SOURCE_VIEW_UNSAFE/);
  }));

test('close resumes only exact remaining files after interruption and refuses injected or altered paths',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const two = plan(['src/a.ts', 'src/b.ts']);
    materializeWindowsFrozenSource(two, root);
    const desc = { ...descriptor(), sourceDigest: two.digest };
    const view = join(root, `${binding.attemptId}.view`);
    const marker = JSON.parse(readFileSync(join(view, '.rcac-source-view.json'), 'utf8'));
    const tombstone = join(root, `${binding.attemptId}.source.closed.json`);
    writeFileSync(join(view, 'foreign'), 'do not touch');
    assert.throws(() => closeWindowsFrozenSource(desc, root), /SOURCE_VIEW_UNSAFE/);
    assert.equal(existsSync(tombstone), false);
    unlinkSync(join(view, 'foreign'));
    // Durable close intent exists; one planned file and marker were already removed.
    writeFileSync(tombstone, JSON.stringify({ descriptor: desc, marker }));
    unlinkSync(join(view, 'src', 'a.ts'));
    unlinkSync(join(view, '.rcac-source-view.json'));
    writeFileSync(join(view, 'foreign'), 'preserve');
    assert.throws(() => closeWindowsFrozenSource(desc, root), /SOURCE_VIEW_UNSAFE/);
    assert.equal(readFileSync(join(view, 'foreign'), 'utf8'), 'preserve');
    unlinkSync(join(view, 'foreign'));
    closeWindowsFrozenSource(desc, root);
    assert.equal(existsSync(view), false);
    assert.deepEqual(closeWindowsFrozenSource(desc, root), { kind: 'closed', descriptor: desc,
      viewPath: view, isolationVerified: false });
  }));

test('close refuses staging, preexisting lock, hardlink, and mismatched descriptor without deleting bytes',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const stage = join(root, `${binding.attemptId}.a.staging`);
    mkdirSync(stage);
    assert.throws(() => closeWindowsFrozenSource(descriptor(), root), /SOURCE_VIEW_UNSAFE/);
    rmSync(stage, { recursive: true });
    const stageAlias = join(root, `${binding.attemptId}.a.staging`.toUpperCase());
    mkdirSync(stageAlias);
    assert.throws(() => closeWindowsFrozenSource(descriptor(), root), /SOURCE_VIEW_UNSAFE/);
    assert.throws(() => materializeWindowsFrozenSource(plan(), root), /SOURCE_VIEW_UNSAFE/);
    rmSync(stageAlias, { recursive: true });
    const lock = join(root, `${binding.attemptId}.source.lock`);
    writeFileSync(lock, 'stale');
    assert.throws(() => closeWindowsFrozenSource(descriptor(), root));
    assert.equal(readFileSync(lock, 'utf8'), 'stale');
    unlinkSync(lock);
    const view = materializeWindowsFrozenSource(plan(), root).viewPath;
    assert.throws(() => closeWindowsFrozenSource({ ...descriptor(), sourceDigest: 'a'.repeat(64) }, root), /SOURCE_VIEW_UNSAFE/);
    const foreign = join(root, 'foreign.txt');
    linkSync(join(view, 'src', 'a.ts'), foreign);
    assert.throws(() => closeWindowsFrozenSource(descriptor(), root), /SOURCE_VIEW_UNSAFE/);
    assert.equal(existsSync(view), true);
    unlinkSync(foreign);
  }));

test('Windows case aliases cannot hide a view or tombstone from close and late materialize',
  { skip: process.platform !== 'win32' }, () => fixture(root => {
    const view = materializeWindowsFrozenSource(plan(), root).viewPath;
    const alias = join(root, `${binding.attemptId}.view`.toUpperCase());
    renameSync(view, alias);
    assert.throws(() => closeWindowsFrozenSource(descriptor(), root), /SOURCE_VIEW_UNSAFE/);
    assert.equal(readFileSync(join(alias, 'src', 'a.ts'), 'utf8'), 'selected bytes\n');
    assert.equal(existsSync(join(root, `${binding.attemptId}.source.closed.json`)), false);
    renameSync(alias, view);
    closeWindowsFrozenSource(descriptor(), root);
    const tombstone = join(root, `${binding.attemptId}.source.closed.json`);
    const tombstoneAlias = join(root, `${binding.attemptId}.source.closed.json`.toUpperCase());
    renameSync(tombstone, tombstoneAlias);
    assert.throws(() => materializeWindowsFrozenSource(plan(), root), /SOURCE_VIEW_UNSAFE/);
    assert.equal(existsSync(view), false);
  }));

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/main.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { openApplicationWithinInstallation } from '../../src/runtime/application.js';
import { prepareWindowsInvestigatorRuntime } from '../../src/runtime/windows-investigation-runtime-config.js';
import { createDailyCodexSelector, enableDailyInvestigation } from '../../src/cli/daily-investigation.js';
import { readDailyBinding } from '../../src/cli/daily-binding.js';

const principal = `${hostname()}\\${userInfo().username}`;
const owner = { principal, audience: 'local-os', recipient: principal };
const fixture = () => mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-invest-'));
function repo(dir: string, name: string): string {
  const root = join(dir, name); mkdirSync(root);
  execFileSync('git', ['init', '--quiet', root]);
  writeFileSync(join(root, 'README.md'), `${name} source`);
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--quiet', '-m', 'fixture']);
  return root;
}

test('one local Codex source supports explicit per-project investigation without changing the daily share', async () => {
  const dir = fixture(); const data = join(dir, 'data');
  const sourceRoot = repo(dir, 'A'); const targetRoot = repo(dir, 'B');
  let passed = false;
  try {
    await main(['setup', '--data-dir', data, '--skill-dir', join(dir, 'skills')]);
    await main(['discuss', '--data-dir', data, '--project', sourceRoot, '--topic', 'First',
      '--question', 'Review A', '--share-tracked']);
    await main(['discuss', '--data-dir', data, '--project', targetRoot, '--topic', 'Second',
      '--question', 'Review B', '--share-tracked']);
    const before = readFileSync(join(data, 'daily-binding.json'), 'utf8');
    await assert.rejects(main(['enable-investigation', '--data-dir', data, '--project', 'B']));
    assert.equal(readFileSync(join(data, 'daily-binding.json'), 'utf8'), before);
    const store = new SqliteStore(join(data, 'state.sqlite'));
    try {
      const source = store.getWorkspaceByRoot(realpathSync(sourceRoot));
      const target = store.getWorkspaceByRoot(realpathSync(targetRoot));
      assert.ok(source && target);
      const sourceProfile = store.insertProfileRevision({ workspaceId: source.id,
        expectedRevisionId: null, presetRef: 'static_readonly_v1',
        budget: { maxWallSeconds: 30, maxTurns: 1, maxToolCalls: 2 } }, principal, new Date());
      prepareWindowsInvestigatorRuntime(data, store,
        { ...owner, surface: 'local_admin', now: new Date() },
        { workspaceId: source.id, profileRevision: sourceProfile.id, modelRef: 'gpt-6-sol' });
      const result = await main(['use-codex', '--data-dir', data, '--source-data-dir', data,
        '--source-project', 'A']) as { configured: boolean; restartRequired: boolean };
      assert.equal(result.configured, true);
      assert.equal(result.restartRequired, true);
      const binding = readDailyBinding(data);
      assert.deepEqual(binding.codexRuntimeSource, { dataDirectory: data,
        workspaceId: source.id, profileRevision: sourceProfile.id });
      assert.deepEqual(binding.allowedFileOrigins, []);
      const saved = readFileSync(join(data, 'daily-binding.json'), 'utf8');
      await main(['use-codex', '--data-dir', data, '--source-data-dir', data, '--source-project', 'A']);
      assert.equal(readFileSync(join(data, 'daily-binding.json'), 'utf8'), saved);
      await assert.rejects(main(['use-codex', '--data-dir', data, '--source-data-dir', data,
        '--source-project', 'B']));
      assert.equal(readFileSync(join(data, 'daily-binding.json'), 'utf8'), saved);
      const enabled = await main(['enable-investigation', '--data-dir', data, '--project', 'B',
        '--max-turns', '1']) as { project: string; budget: { maxWallSeconds: number; maxTurns: number; maxToolCalls: number } };
      assert.equal(enabled.project, 'B');
      assert.deepEqual(enabled.budget, { maxWallSeconds: 120, maxTurns: 1, maxToolCalls: 12 });
      const profile = store.getCurrentProfileRevision(target.id); assert.ok(profile);
      prepareWindowsInvestigatorRuntime(data, store,
        { ...owner, surface: 'local_admin', now: new Date() },
        { workspaceId: target.id, profileRevision: profile.id, modelRef: 'gpt-6-sol' });
      await assert.rejects(main(['use-codex', '--data-dir', data, '--source-data-dir', data,
        '--source-project', 'B']), /CONFLICT/);
      assert.equal(readFileSync(join(data, 'daily-binding.json'), 'utf8'), saved);
      const selectorRuntime = acquireInstallationRuntime(data);
      try {
        const selected = createDailyCodexSelector(selectorRuntime, owner, binding.codexRuntimeSource!)(target.id);
        assert.equal(selected?.profileRevision, profile.id);
      } finally { selectorRuntime.release(); }
      const recipient = { principal: binding.principal, audience: binding.audience, recipient: binding.recipient };
      const groups = () => [owner, recipient].map(identity => store.grantsFor(identity.principal, identity.audience)
        .filter(grant => grant.workspaceId === target.id && grant.permissions.includes('investigation.request')));
      const initial = groups();
      for (const entries of initial) {
        assert.equal(entries.filter(grant => grant.revokedAt === null).length, 1);
        const grant = entries.find(item => item.revokedAt === null)!;
        assert.deepEqual([...grant.permissions].sort(), ['investigation.cancel', 'investigation.read', 'investigation.request']);
        assert.equal(grant.dataPaths, undefined);
      }
      await main(['enable-investigation', '--data-dir', data, '--project', targetRoot]);
      assert.deepEqual(groups().map(entries => entries.map(item => item.id)), initial.map(entries => entries.map(item => item.id)));
      store.insertGrant({ id: 'synthetic-recipientless-local-investigation', principal,
        audience: 'local-os', workspaceId: target.id, permissions: ['investigation.read'],
        expiresAt: null, revokedAt: null });
      await assert.rejects(main(['disable-investigation', '--data-dir', data, '--project', 'B']));
      assert.ok(groups().every(entries => entries.some(item => item.revokedAt === null)));
      store.revokeGrant('synthetic-recipientless-local-investigation', new Date().toISOString());
      await main(['disable-investigation', '--data-dir', data, '--project', 'B']);
      assert.ok(groups().every(entries => entries.every(item => item.revokedAt !== null)));
      await main(['enable-investigation', '--data-dir', data, '--project', 'B']);
      assert.ok(groups().every(entries => entries.length === 2 && entries.filter(item => item.revokedAt === null).length === 1));
      assert.equal(store.grantsFor(recipient.principal, recipient.audience)
        .filter(grant => grant.workspaceId === target.id && grant.permissions.includes('data.read')).length, 1);
      assert.deepEqual(readDailyBinding(data).allowedFileOrigins, []);
      const beforePolicy = readDailyBinding(data);
      await main(['add-file-origin', '--data-dir', data, '--file-origin', 'https://files.example.test']);
      await main(['enable-chatgpt-files', '--data-dir', data]);
      const afterPolicy = readDailyBinding(data);
      assert.deepEqual(afterPolicy.codexRuntimeSource, beforePolicy.codexRuntimeSource);
      assert.equal(afterPolicy.principal, beforePolicy.principal);
      assert.equal(afterPolicy.audience, beforePolicy.audience);
      assert.equal(afterPolicy.recipient, beforePolicy.recipient);
      assert.equal(afterPolicy.fileSourcePolicy, 'chatgpt-official-v1');
      assert.deepEqual(afterPolicy.allowedFileOrigins, ['https://files.example.test']);
      await main(['disable-investigation', '--data-dir', data, '--project', 'B']);
      const raceRuntime = acquireInstallationRuntime(data);
      const raceApp = openApplicationWithinInstallation(raceRuntime);
      try {
        await raceApp.ready;
        let inserted = false;
        const raceDispatch = { dispatch: async (...args: Parameters<typeof raceApp.dispatch.dispatch>) => {
          const result = await raceApp.dispatch.dispatch(...args);
          const command = args[1];
          if (command.operation === 'admin.grant' && !inserted &&
              (command.payload as { principal?: string }).principal === recipient.principal) {
            inserted = true;
            const head = store.getCurrentProfileRevision(target.id); assert.ok(head);
            store.insertProfileRevision({ workspaceId: target.id, expectedRevisionId: head.id,
              presetRef: 'static_readonly_v1', budget: head.budget }, principal, new Date());
          }
          return result;
        } };
        await assert.rejects(enableDailyInvestigation(raceRuntime, store, raceDispatch,
          { ...owner, surface: 'local_cli', now: new Date() }, 'B'));
        assert.equal(inserted, true);
        assert.ok(groups().every(entries => entries.some(item => item.revokedAt === null)),
          'partially completed grants are retained for explicit reconciliation');
        let revoked = 0;
        const disableRaceDispatch = { dispatch: async (...args: Parameters<typeof raceApp.dispatch.dispatch>) => {
          const result = await raceApp.dispatch.dispatch(...args);
          if (args[1].operation === 'admin.revoke' && ++revoked === 2)
            store.insertGrant({ id: 'synthetic-post-revoke-investigation', ...recipient,
              workspaceId: target.id, permissions: ['investigation.read'],
              expiresAt: null, revokedAt: null });
          return result;
        } };
        const { disableDailyInvestigation } = await import('../../src/cli/daily-investigation.js');
        await assert.rejects(disableDailyInvestigation(raceRuntime, store, disableRaceDispatch,
          { ...owner, surface: 'local_cli', now: new Date() }, 'B'));
        assert.equal(revoked, 2);
      } finally { await raceApp.close(); raceRuntime.release(); }
    } finally { store.close(); }
    passed = true;
  } finally {
    if (passed) rmSync(dir, { recursive: true, force: true });
    else process.stderr.write(`Preserved failed daily investigation fixture: ${dir}\n`);
  }
});

test('investigation flags and absent trusted source fail without creating target profile or grant', async () => {
  const dir = fixture(); const data = join(dir, 'data'); const targetRoot = repo(dir, 'B');
  let passed = false;
  try {
    await main(['setup', '--data-dir', data, '--skill-dir', join(dir, 'skills')]);
    await main(['discuss', '--data-dir', data, '--project', targetRoot, '--topic', 'Review',
      '--question', 'Review B', '--share-tracked']);
    for (const args of [
      ['--max-wall-seconds', '0'], ['--max-turns', '9'], ['--max-tool-calls', '-1'],
      ['--max-wall-seconds', '601'], ['--source-data-dir', data],
    ]) await assert.rejects(main(['enable-investigation', '--data-dir', data, '--project', 'B', ...args]));
    const store = new SqliteStore(join(data, 'state.sqlite'));
    try {
      const target = store.getWorkspaceByRoot(realpathSync(targetRoot)); assert.ok(target);
      assert.equal(store.getCurrentProfileRevision(target.id), null);
      assert.equal(store.grantsFor(principal, 'local-os')
        .filter(grant => grant.workspaceId === target.id && grant.permissions.includes('investigation.request')).length, 0);
    } finally { store.close(); }
    passed = true;
  } finally {
    if (passed) rmSync(dir, { recursive: true, force: true });
    else process.stderr.write(`Preserved failed daily investigation fixture: ${dir}\n`);
  }
});

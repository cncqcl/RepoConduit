import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli/main.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { DailyUseApplication } from '../../src/application/daily-use.js';
import { createDailyMcpServer } from '../../src/adapters/mcp/daily-server.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';
import { openApplicationWithinInstallation } from '../../src/runtime/application.js';
import { createManagedInstallation } from '../../src/cli/install.js';

test('daily CLI uses one installation for two projects and receives versions without chat history or user IDs', async () => {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-cli-'));
  const root = join(dir, 'data');
  const setup = ['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills')];
  try {
    const first = await main(setup) as { configured: boolean; connection: { command: string; args: string[] } };
    assert.equal(first.configured, true);
    assert.ok(first.connection.args.includes('mcp-daily'));
    const saved = readFileSync(join(root, 'daily-binding.json'), 'utf8');
    await main(setup);
    assert.equal(readFileSync(join(root, 'daily-binding.json'), 'utf8'), saved);
    const binding = JSON.parse(saved) as { principal: string };
    assert.ok(binding.principal);
    for (const name of ['A', 'B']) {
      const repo = join(dir, name); mkdirSync(repo);
      execFileSync('git', ['init', '--quiet', repo]);
      writeFileSync(join(repo, 'README.md'), name);
      execFileSync('git', ['-C', repo, 'add', 'README.md']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture']);
      const request = ['discuss', '--data-dir', root, '--project', repo, '--topic', 'Review', '--question', `Review ${name}`, '--share-tracked'];
      const topic = await main(request) as { topicHandle: string };
      const repeated = await main(request) as { topicHandle: string };
      assert.equal(repeated.topicHandle, topic.topicHandle);
    }
    const projects = await main(['projects', '--data-dir', root]) as { id: string }[];
    assert.equal(projects.length, 2);
    const repo = realpathSync(join(dir, 'A'));
    const review = join(dir, 'review.md'); writeFileSync(review, 'Original advice');
    const receive = ['receive', '--data-dir', root, '--project', repo, '--topic', 'Review', '--version', 'v1', '--file', review];
    const bundle = await main(receive) as { files: { sourceReceipt: string }[] };
    assert.equal(bundle.files[0]?.sourceReceipt, 'manual_import');
    assert.deepEqual(await main(receive), bundle);
    const downloaded = join(dir, 'downloaded');
    mkdirSync(join(downloaded, 'a'), { recursive: true }); mkdirSync(join(downloaded, 'b'));
    writeFileSync(join(downloaded, 'a', 'review.md'), 'First original');
    writeFileSync(join(downloaded, 'b', 'review.md'), 'Second original');
    const recovered = await main(['receive', '--data-dir', root, '--project', repo, '--topic', 'Review',
      '--version', 'recovered-v2', '--parent-version', 'v1', '--from-directory', downloaded]) as { files: { normalizedRelativePath: string; sha256: string }[] };
    assert.deepEqual(recovered.files.map(file => file.normalizedRelativePath).sort(), ['a/review.md', 'b/review.md']);
    assert.notEqual(recovered.files[0]!.sha256, recovered.files[1]!.sha256);
    const exported = await main(['export', '--data-dir', root, '--project', repo, '--topic', 'Review', '--version', 'v1']) as { files: unknown[] };
    assert.ok(exported);
    const inbox = await main(['inbox', '--data-dir', root, '--project', repo, '--topic', 'Review']);
    assert.match(JSON.stringify(inbox), /bun_daily_/);
    const other = await main(['inbox', '--data-dir', root, '--project', join(dir, 'B'), '--topic', 'Review']);
    assert.doesNotMatch(JSON.stringify(other), /bun_daily_/);
    assert.equal(readFileSync(join(root, 'daily-binding.json'), 'utf8'), saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('daily setup preserves an existing different Skill and refuses unknown flags', async () => {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-preserve-'));
  try {
    const skills = join(dir, 'skills'); const owned = join(skills, 'consult-external-agent');
    mkdirSync(owned, { recursive: true }); writeFileSync(join(owned, 'SKILL.md'), 'User content');
    await assert.rejects(main(['setup', '--data-dir', join(dir, 'data'), '--skill-dir', skills]));
    assert.equal(readFileSync(join(owned, 'SKILL.md'), 'utf8'), 'User content');
    await assert.rejects(main(['setup', '--data-dir', join(dir, 'other'), '--approve-all', 'true']));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('one-time Tunnel setup supports a generic connection dry run without a project or secret file', async () => {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-connect-'));
  try {
    const root = join(dir, 'data'); const executable = join(dir, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
    writeFileSync(executable, 'Not executed by dry run');
    const setup = ['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills'),
      '--tunnel-client', executable, '--tunnel-id', 'tunnel_fixture123'];
    await main(setup);
    const saved = readFileSync(join(root, 'daily-tunnel.json'), 'utf8');
    await main(setup);
    assert.equal(readFileSync(join(root, 'daily-tunnel.json'), 'utf8'), saved);
    const result = await main(['connect', '--data-dir', root, '--dry-run']) as { connectsNetwork: boolean; args: string[] };
    assert.equal(result.connectsNetwork, false);
    assert.ok(result.args.includes('env:CONTROL_PLANE_API_KEY'));
    assert.ok(result.args.some(arg => arg.includes('mcp-daily')));
    assert.doesNotMatch(saved, /api.key|secret|workspace|collaboration/i);
    await assert.rejects(main(['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills'), '--tunnel-id', 'tunnel_other123']));
    assert.equal(readFileSync(join(root, 'daily-tunnel.json'), 'utf8'), saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('managed daily connection selects the installation root rather than its active generation', async () => {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-managed-connect-'));
  try {
    const root = join(dir, 'installation'); createManagedInstallation(root);
    const executable = join(dir, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
    writeFileSync(executable, 'Not executed by dry run');
    await main(['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills'), '--tunnel-client', executable, '--tunnel-id', 'tunnel_fixture123']);
    const result = await main(['connect', '--data-dir', root, '--dry-run']) as { args: string[] };
    const command = result.args[result.args.indexOf('--mcp.command') + 1]!;
    assert.ok(command.endsWith(`--data-dir "${root.replaceAll('\\', '/')}",channel=main`), command);
    assert.doesNotMatch(command, /generations/);
    assert.match(result.args[result.args.indexOf('--health.url-file') + 1]!, /generations/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('one daily MCP connection discovers newly shared projects and publishes original file versions without a conversation', async () => {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-daily-mcp-'));
  const root = join(dir, 'data');
  await main(['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills')]);
  const runtime = acquireInstallationRuntime(root);
  const app = openApplicationWithinInstallation(runtime);
  const store = new SqliteStore(join(root, 'state.sqlite'));
  const binding = JSON.parse(readFileSync(join(root, 'daily-binding.json'), 'utf8')) as { principal: string; audience: string; recipient: string };
  let downloads = 0;
  const server = createDailyMcpServer({ daily: new DailyUseApplication(store, app.dispatch), dispatcher: app.dispatch,
    context: { ...binding, surface: 'external_mcp', now: new Date() },
    resolveFileTransfer: file => ({ referenceIdentity: file.file_id, mediaType: file.mime_type ?? null,
      async acquireBytes() { downloads++; return Buffer.from(`original-${file.file_id}`); } }) });
  const client = new Client({ name: 'daily-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await app.ready; await server.connect(serverTransport); await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const receipt = await client.callTool({ name, arguments: args });
      assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
      return JSON.parse((receipt.content as { text: string }[])[0]!.text) as unknown;
    };
    assert.deepEqual(await call('projects'), []);
    for (const name of ['A', 'B']) {
      const repo = join(dir, name); mkdirSync(repo);
      execFileSync('git', ['init', '--quiet', repo]); writeFileSync(join(repo, 'README.md'), `project-${name}`);
      writeFileSync(join(repo, 'original.bin'), Buffer.from([0, 255, 13, 10, 128]));
      execFileSync('git', ['-C', repo, 'add', 'README.md', 'original.bin']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture']);
      await main(['discuss', '--data-dir', root, '--project', repo, '--topic', 'Advice', '--question', `Review ${name}`, '--share-tracked']);
    }
    const projects = await call('projects') as { id: string; name: string }[];
    assert.deepEqual(projects.map(project => project.name).sort(), ['A', 'B']);
    assert.doesNotMatch(JSON.stringify(projects), /canonicalRoot|rcac-daily-mcp/);
    const topics = await call('topics', { project: projects.find(project => project.name === 'A')!.id }) as { topicHandle: string }[];
    const topic = topics[0]!.topicHandle;
    const read = await call('read_file', { topic, path: 'README.md' }) as { content: string };
    assert.equal(read.content, 'project-A');
    writeFileSync(join(dir, 'A', 'original.bin'), Buffer.from('Uncommitted live change'));
    const fromWeb = await call('open_topic', { project: projects.find(project => project.name === 'A')!.id,
      title: 'Web review', question: 'A new question from the webpage' }) as { topicHandle: string };
    const webContext = await call('context', { topic: fromWeb.topicHandle }) as {
      content: { goal: string }; discussionQuestion: { text: string; status: string };
    };
    assert.equal(webContext.content.goal, 'Review A');
    assert.equal(webContext.discussionQuestion.status, 'unaccepted');
    assert.equal(webContext.discussionQuestion.text, 'A new question from the webpage');
    const original = await client.callTool({ name: 'read_original', arguments: { topic: fromWeb.topicHandle, path: 'original.bin' } });
    assert.notEqual(original.isError, true);
    const resource = (original.content as { type: string; resource?: { blob: string } }[]).find(block => block.type === 'resource');
    assert.ok(resource?.resource);
    assert.ok(Buffer.from(resource.resource.blob, 'base64').equals(Buffer.from([0, 255, 13, 10, 128])));
    const sourceCopy = await main(['source-export', '--data-dir', root, '--project', join(dir, 'A'),
      '--topic', 'Web review', '--file', 'original.bin']) as { path: string };
    assert.ok(readFileSync(join(sourceCopy.path, 'files', 'original.bin')).equals(Buffer.from([0, 255, 13, 10, 128])));
    const updatedRoot = join(dir, 'A');
    writeFileSync(join(updatedRoot, 'later.md'), 'New committed evidence');
    execFileSync('git', ['-C', updatedRoot, 'add', 'later.md']);
    execFileSync('git', ['-C', updatedRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'new file']);
    await main(['discuss', '--data-dir', root, '--project', updatedRoot, '--topic', 'Updated baseline',
      '--question', 'Review new evidence', '--share-tracked']);
    const afterUpdate = await call('open_topic', { project: projects.find(project => project.name === 'A')!.id,
      title: 'After share update', question: 'Read the new file' }) as { topicHandle: string };
    assert.equal((await call('read_file', { topic: afterUpdate.topicHandle, path: 'later.md' }) as { content: string }).content, 'New committed evidence');
    assert.equal((await client.callTool({ name: 'read_file', arguments: { topic, path: 'later.md' } })).isError, true);
    await call('deliver_text', { topic: fromWeb.topicHandle, version: 'web-v1', files: [{ path: 'web.md', text: 'Independent web topic result' }] });
    const v1 = { topic, version: 'v1', files: [
      { file_id: 'one', download_url: 'https://files.example.test/one', file_name: 'notes/a.bin' },
      { file_id: 'two', download_url: 'https://files.example.test/two', file_name: 'b.bin' },
    ] };
    const first = await call('deliver_files', v1) as { bundleId: string; files: { sourceReceipt: string }[] };
    assert.equal(first.files.length, 2);
    assert.ok(first.files.every(file => file.sourceReceipt !== 'manual_import'));
    assert.deepEqual(await call('deliver_files', v1), first);
    assert.equal(downloads, 2, 'replay must reconcile the existing publication without downloading again');
    const second = await call('deliver_text', { topic, version: 'v2', parentVersion: 'v1',
      files: [{ path: 'review.md', text: 'Revised advice' }] }) as { parentBundleId: string };
    assert.equal(second.parentBundleId, first.bundleId);
    assert.deepEqual(await call('deliver_files', v1), first);
    const crossed = await client.callTool({ name: 'read_file', arguments: { topic, path: 'README.md', scope: { workspaceId: projects.find(project => project.name === 'B')!.id } } });
    assert.equal(crossed.isError, true);
    for (const grant of store.grantsFor(binding.principal, binding.audience)) store.revokeGrant(grant.id, new Date().toISOString());
    assert.deepEqual(await call('projects'), []);
    assert.equal((await client.callTool({ name: 'context', arguments: { topic } })).isError, true);
  } finally {
    await client.close(); await server.close(); await app.close(); store.close(); runtime.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

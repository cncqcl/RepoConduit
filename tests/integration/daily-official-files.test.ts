import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { main } from '../../src/cli/main.js';
import { enableDailyChatGPTFilesWithinInstallation, readDailyBinding } from '../../src/cli/daily-binding.js';
import { acquireInstallationRuntime } from '../../src/runtime/installation.js';

function fixture() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-official-files-'));
  const root = join(dir, 'data');
  const path = join(root, 'daily-binding.json');
  return { dir, root, path,
    setup: (...flags: string[]) => main(['setup', '--data-dir', root, '--skill-dir', join(dir, 'skills'), ...flags]),
    enable: () => main(['enable-chatgpt-files', '--data-dir', root]),
    dispose: (passed: boolean) => { if (passed) rmSync(dir, { recursive: true, force: true });
      else process.stderr.write(`Preserved official files fixture: ${dir}\n`); } };
}

test('new installation explicitly opts into the fixed file source without populating exact origins', async () => {
  const f = fixture(); let passed = false;
  try {
    await assert.rejects(f.setup('--file-source', 'arbitrary-domain'));
    assert.equal(existsSync(f.root), false);
    await f.setup('--file-source', 'chatgpt');
    const binding = readDailyBinding(f.root) as ReturnType<typeof readDailyBinding> & { fileSourcePolicy?: string };
    assert.equal(binding.fileSourcePolicy, 'chatgpt-official-v1');
    assert.deepEqual(binding.allowedFileOrigins, []);
    const bytes = readFileSync(f.path, 'utf8');
    await f.setup('--file-source', 'chatgpt'); await f.setup();
    assert.equal(readFileSync(f.path, 'utf8'), bytes);
    passed = true;
  } finally { f.dispose(passed); }
});

test('old binding requires explicit enable, preserving identity and exact origins on replay and later append', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup('--file-origin', 'https://original.example.test');
    const before = readDailyBinding(f.root);
    const bytes = readFileSync(f.path, 'utf8');
    await assert.rejects(f.setup('--file-source', 'chatgpt'));
    assert.equal(readFileSync(f.path, 'utf8'), bytes);
    const report = await f.enable() as { saveStatus: string; restartRequired: boolean; fileSourcePolicy: string };
    assert.equal(report.saveStatus, 'saved'); assert.equal(report.restartRequired, true);
    assert.equal(report.fileSourcePolicy, 'chatgpt-official-v1');
    const enabled = readFileSync(f.path, 'utf8');
    assert.deepEqual(JSON.parse(enabled), { ...before, fileSourcePolicy: 'chatgpt-official-v1' });
    assert.equal((await f.enable() as { saveStatus: string }).saveStatus, 'unchanged');
    assert.equal(readFileSync(f.path, 'utf8'), enabled);
    await main(['add-file-origin', '--data-dir', f.root, '--file-origin', 'https://extra.example.test']);
    assert.deepEqual(readDailyBinding(f.root), { ...before,
      allowedFileOrigins: ['https://original.example.test', 'https://extra.example.test'], fileSourcePolicy: 'chatgpt-official-v1' });
    passed = true;
  } finally { f.dispose(passed); }
});

test('enable rechecks the local management grant and refuses revoked authority without changing binding', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup(); const bytes = readFileSync(f.path, 'utf8');
    const store = new SqliteStore(join(f.root, 'state.sqlite'));
    try {
      const principal = `${hostname()}\\${userInfo().username}`;
      const grant = store.grantsFor(principal, 'local-os').find(g =>
        g.workspaceId === 'management' && g.permissions.includes('admin.grant'));
      assert.ok(grant); store.revokeGrant(grant.id, new Date().toISOString());
    } finally { store.close(); }
    await assert.rejects(f.enable());
    assert.equal(readFileSync(f.path, 'utf8'), bytes);
    passed = true;
  } finally { f.dispose(passed); }
});

test('malformed or unknown stored file policy fails closed', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup(); const binding = JSON.parse(readFileSync(f.path, 'utf8')) as Record<string, unknown>;
    for (const policy of [null, false, 'future-unreviewed-policy']) {
      writeFileSync(f.path, JSON.stringify({ ...binding, fileSourcePolicy: policy }));
      assert.throws(() => readDailyBinding(f.root));
    }
    passed = true;
  } finally { f.dispose(passed); }
});

test('network check uses only read-only private binding and mocked OS DNS, without SQLite or lifecycle writes', async () => {
  const f = fixture(); let passed = false;
  const originalLookup = dns.lookup;
  try {
    await f.setup('--file-source', 'chatgpt');
    // A deliberately non-SQLite fixture proves the read-only command never opens a product store.
    // Keep this private file present because the existing data-directory verifier requires it.
    const database = join(f.root, 'state.sqlite'); const sentinel = 'Fixture must never be opened as SQLite';
    writeFileSync(database, sentinel);
    const names = readdirSync(f.root).sort();
    const before = readFileSync(f.path, 'utf8'); let lookups = 0;
    mock.method(dns, 'lookup', async (host: string) => {
      assert.equal(host, 'sdmntprcentralus.oaiusercontent.com'); lookups++;
      return [{ address: '198.18.0.25', family: 4 }];
    }); syncBuiltinESMExports();
    const result = await main(['check-file-network', '--data-dir', f.root,
      '--file-origin', 'https://sdmntprcentralus.oaiusercontent.com']) as { status: string; dnsOnly: boolean; nextAction: string };
    assert.equal(result.status, 'fake_ip'); assert.equal(result.dnsOnly, true);
    assert.match(result.nextAction, /blacklist/); assert.match(result.nextAction, /\*\.oaiusercontent\.com/);
    await assert.rejects(main(['check-file-network', '--data-dir', f.root, '--file-origin', 'https://evil.test']));
    assert.equal(lookups, 1);
    writeFileSync(join(f.root, 'managed.json'), '{}');
    await assert.rejects(main(['check-file-network', '--data-dir', f.root,
      '--file-origin', 'https://sdmntprcentralus.oaiusercontent.com']), /requires a flat installation/);
    rmSync(join(f.root, 'managed.json')); assert.equal(lookups, 1);
    assert.equal(readFileSync(database, 'utf8'), sentinel);
    assert.deepEqual(readdirSync(f.root).sort(), names);
    assert.equal(readFileSync(f.path, 'utf8'), before);
    passed = true;
  } finally { mock.restoreAll(); dns.lookup = originalLookup; syncBuiltinESMExports(); f.dispose(passed); }
});

test('source enable preserves refusal and honest save outcomes on either side of atomic rename', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup('--file-origin', 'https://original.example.test');
    const bytes = readFileSync(f.path, 'utf8');
    const runtime = acquireInstallationRuntime(f.root);
    const principal = `${hostname()}\\${userInfo().username}`;
    const admin = { principal, audience: 'local-os', recipient: principal, surface: 'local_admin' as const, now: new Date() };
    try {
      assert.throws(() => enableDailyChatGPTFilesWithinInstallation(runtime, { ...admin, surface: 'external_mcp' }));
      assert.throws(() => enableDailyChatGPTFilesWithinInstallation(runtime, admin,
        { beforeRename: () => { throw Error('before rename fixture'); } }), /before rename fixture/);
      assert.equal(readFileSync(f.path, 'utf8'), bytes);
      const result = enableDailyChatGPTFilesWithinInstallation(runtime, admin,
        { afterRename: () => { throw Error('after rename fixture'); } });
      assert.equal(result.saveStatus, 'saved-but-cleanup-unconfirmed');
      assert.equal(result.fileSourcePolicy, 'chatgpt-official-v1');
      assert.deepEqual(result.allowedFileOrigins, ['https://original.example.test']);
    } finally { runtime.release(); }
    passed = true;
  } finally { f.dispose(passed); }
});

function child(root: string, action: string, ...flags: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), action, '--data-dir', root, ...flags],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    process.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    process.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    process.once('error', reject); process.once('close', code => resolveResult({ code, output }));
  });
}

test('concurrent enable and exact append preserve every successful policy mutation', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup();
    const [enable, append] = await Promise.all([child(f.root, 'enable-chatgpt-files'),
      child(f.root, 'add-file-origin', '--file-origin', 'https://concurrent.example.test')]);
    assert.ok(enable.code === 0 || append.code === 0, 'at least one uncontended policy update must succeed');
    for (const result of [enable, append]) if (result.code !== 0) assert.match(result.output, /"code":"CONFLICT"/);
    const saved = JSON.parse(readFileSync(f.path, 'utf8')) as { fileSourcePolicy?: string; allowedFileOrigins: string[] };
    if (enable.code === 0) assert.equal(saved.fileSourcePolicy, 'chatgpt-official-v1');
    if (append.code === 0) assert.ok(saved.allowedFileOrigins.includes('https://concurrent.example.test'));
    passed = true;
  } finally { f.dispose(passed); }
});

test('preset-only binding exposes eight real stdio tools and accepts new regional origin before other input checks', async () => {
  const f = fixture(); let passed = false;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/main.ts'),
    'mcp-daily', '--data-dir', f.root], stderr: 'pipe' });
  const client = new Client({ name: 'official-files-fixture', version: '1' }); let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await f.setup('--file-source', 'chatgpt'); await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 8); assert.ok(tools.some(tool => tool.name === 'deliver_files'));
    const result = await client.callTool({ name: 'deliver_files', arguments: { topic: 'col_missing', version: 'v1', files: [{
      download_url: 'https://sdmntprcentralus.oaiusercontent.com/private?sig=NOT_A_REAL_SIGNATURE',
      file_id: '', file_name: 'original.bin',
    }] } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /invalid_file_id/);
    assert.doesNotMatch(JSON.stringify(result), /sdmntprcentralus|NOT_A_REAL_SIGNATURE/);
    assert.doesNotMatch(stderr, /unapproved_file_origin|NOT_A_REAL_SIGNATURE/);
    passed = true;
  } finally { try { await client.close(); } finally { f.dispose(passed); } }
});

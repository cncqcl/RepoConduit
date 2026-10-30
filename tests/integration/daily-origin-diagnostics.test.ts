import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { main } from '../../src/cli/main.js';

function fixture() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-origin-stdio-'));
  const root = join(dir, 'data');
  return { root, setup: (...origins: string[]) => main(['setup', '--data-dir', root,
    '--skill-dir', join(dir, 'skills'), ...origins.flatMap(origin => ['--file-origin', origin])]),
    binding: () => JSON.parse(readFileSync(join(root, 'daily-binding.json'), 'utf8')) as { allowedFileOrigins: string[] },
    dispose: (passed: boolean) => { if (passed) rmSync(dir, { recursive: true, force: true });
      else process.stderr.write(`Preserved failed daily origin fixture: ${dir}\n`); } };
}

function cliArgs(root: string, action: string, ...rest: string[]): string[] {
  return ['--import', 'tsx', resolve('src/cli/main.ts'), action, '--data-dir', root, ...rest];
}

test('default daily setup starts real stdio MCP with seven tools and no file delivery', async () => {
  const f = fixture(); let passed = false;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: cliArgs(f.root, 'mcp-daily'), cwd: process.cwd(), stderr: 'pipe' });
  const client = new Client({ name: 'daily-origin-diagnostics', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await f.setup();
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 7);
    assert.equal(names.includes('deliver_files'), false);
    passed = true;
  } finally {
    try { await client.close(); } finally {
      if (!passed) process.stderr.write(`Daily stdio failure: ${stderr.slice(0, 1000)}\n`);
      f.dispose(passed);
    }
  }
});

test('configured stdio MCP reports only rejected origin to host stderr', async () => {
  const f = fixture(); let passed = false;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: cliArgs(f.root, 'mcp-daily'), cwd: process.cwd(), stderr: 'pipe' });
  const client = new Client({ name: 'daily-origin-host-event', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await f.setup('https://approved.example.test');
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 8);
    assert.ok(names.includes('deliver_files'));
    const result = await client.callTool({ name: 'deliver_files', arguments: {
      topic: 'col_missing', version: 'v1', files: [{
        download_url: 'https://unapproved.example.test/private/path?secret=hidden',
        file_id: 'private-file-id', file_name: 'original.pdf',
      }],
    } });
    assert.equal(result.isError, true);
    const event = stderr.split(/\r?\n/u).filter(line => line.includes('"event":"unapproved_file_origin"'))
      .map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(event, [{ event: 'unapproved_file_origin', source: 'untrusted_file_parameter',
      origin: 'https://unapproved.example.test' }]);
    const visible = JSON.stringify(result);
    assert.doesNotMatch(visible, /unapproved\.example|private\/path|hidden|private-file-id/u);
    assert.doesNotMatch(stderr, /private\/path|hidden|private-file-id/u);
    passed = true;
  } finally { try { await client.close(); } finally { f.dispose(passed); } }
});

test('two CLI append processes preserve every successful origin or return an explicit conflict', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup();
    const run = (origin: string) => new Promise<{ code: number | null; output: string }>((done) => {
      const child = spawn(process.execPath, cliArgs(f.root, 'add-file-origin', '--file-origin', origin),
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.once('close', code => done({ code, output }));
    });
    const origins = ['https://one.example.test', 'https://two.example.test'];
    const results = await Promise.all(origins.map(run));
    for (const result of results) {
      if (result.code !== 0) assert.match(result.output, /"code":"CONFLICT"/);
    }
    const expected = origins.filter((_, index) => results[index]!.code === 0);
    const saved = f.binding().allowedFileOrigins;
    for (const origin of expected) assert.ok(saved.includes(origin), `${origin} lost after successful append`);
    assert.deepEqual([...saved].sort(), [...expected].sort());
    assert.equal(new Set(saved).size, saved.length);
    passed = true;
  } finally { f.dispose(passed); }
});

test('held SQLite write lock gives public CONFLICT and leaves binding unchanged', async () => {
  const f = fixture(); let passed = false;
  try {
    await f.setup();
    const before = readFileSync(join(f.root, 'daily-binding.json'), 'utf8');
    const db = new DatabaseSync(join(f.root, 'state.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = await new Promise<{ code: number | null; output: string }>((done) => {
        const child = spawn(process.execPath,
          cliArgs(f.root, 'add-file-origin', '--file-origin', 'https://locked.example.test'),
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.once('close', code => done({ code, output }));
      });
      assert.equal(result.code, 1);
      assert.match(result.output, /"code":"CONFLICT"/);
      assert.equal(readFileSync(join(f.root, 'daily-binding.json'), 'utf8'), before);
    } finally { db.exec('ROLLBACK'); db.close(); }
    passed = true;
  } finally { f.dispose(passed); }
});

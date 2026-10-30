import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';

test('two coordinator processes preserve both acknowledged bundle files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcac-bundle-process-'));
  const events = join(dir, 'events.log');
  try {
    const objects = new ArtifactObjects(dir);
    objects.begin({ bundleId: 'bun', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'ctx',
      snapshotRefs: [], expectedPaths: ['a.md', 'b.md'] });
    const moduleUrl = pathToFileURL(resolve('src/adapters/storage/objects.ts')).href;
    const code = `
      import { appendFileSync } from 'node:fs';
      import { ArtifactObjects } from ${JSON.stringify(moduleUrl)};
      const [root, log, name] = process.argv.slice(1);
      const objects = new ArtifactObjects(root);
      await objects.withProcessLock('bun', async () => {
        appendFileSync(log, 'start:' + name + '\\n');
        await new Promise(resolve => setTimeout(resolve, 120));
        const receipt = objects.putText('bun', name + '.md', name, 'text/markdown', 'text_set_mcp');
        appendFileSync(log, 'end:' + name + ':' + receipt.sha256 + '\\n');
      });
    `;
    const run = (name: string) => new Promise<void>((resolveRun, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, dir, events, name],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    await Promise.all([run('a'), run('b')]);
    const lines = readFileSync(events, 'utf8').trim().split('\n');
    assert.match(lines[0] ?? '', /^start:[ab]$/);
    assert.match(lines[1] ?? '', /^end:[ab]:[a-f0-9]{64}$/);
    assert.match(lines[2] ?? '', /^start:[ab]$/);
    assert.match(lines[3] ?? '', /^end:[ab]:[a-f0-9]{64}$/);
    assert.notEqual(lines[0]?.slice(-1), lines[2]?.slice(-1));
    assert.deepEqual(objects.status('bun').missingPaths, []);
    assert.equal(objects.status('bun').files.length, 2);
  } finally {
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(child.startsWith('rcac-bundle-process-') && !child.includes('..') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  }
});

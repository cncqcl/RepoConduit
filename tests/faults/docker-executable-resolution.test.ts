import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('Windows Docker cleanup never starts a docker.exe from the working directory',
  { skip: process.platform !== 'win32' && 'Windows executable search only' }, () => {
    const dir = mkdtempSync(join(homedir(), 'rcac-docker-path-'));
    const marker = join(dir, 'executed.txt');
    const canary = join(dir, 'canary.cjs');
    try {
      // A Node executable is a real PE executable. NODE_OPTIONS makes its
      // execution observable without requiring a compiler or mock shell.
      try { linkSync(process.execPath, join(dir, 'docker.exe')); }
      catch { copyFileSync(process.execPath, join(dir, 'docker.exe')); }
      writeFileSync(canary, `require('node:fs').writeFileSync(process.env.RCAC_DOCKER_CANARY, 'executed');`);
      const workerUrl = pathToFileURL(resolve('src/adapters/investigator/docker-worker.ts')).href;
      const script = `import { cleanupPersistedContainer } from ${JSON.stringify(workerUrl)};
        process.chdir(${JSON.stringify(dir)});
        process.env.RCAC_DOCKER_CANARY = ${JSON.stringify(marker)};
        process.env.NODE_OPTIONS = '--require ' + ${JSON.stringify(canary)};
        try { await cleanupPersistedContainer('rcac-investigator-00000000-0000-4000-8000-000000000001', null, () => {}); }
        catch { /* No container is expected. */ }
        process.stdout.write('DONE\\n');`;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: resolve('.'), encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.match(result.stdout, /DONE/);
      assert.equal(existsSync(marker), false, 'cwd docker.exe was executed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

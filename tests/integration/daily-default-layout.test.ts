import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

test('first default setup creates its container and later default commands reuse the same private installation', () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const container = mkdtempSync(join(base, 'rcac-daily-default-'));
  const home = join(container, 'home'); mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const script = resolve('src/cli/main.ts');
  let completed = false;
  try {
    // Verify the child-only home override before allowing a default-path write.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      "import assert from 'node:assert/strict'; import {homedir} from 'node:os'; assert.equal(homedir(), process.env.USERPROFILE);"],
    { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
    const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', script, ...args],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })) as unknown;
    const setup = ['setup', '--skill-dir', join(container, 'skills')];
    const first = run(setup) as { dataDirectory: string; connection: { args: string[] } };
    const root = join(home, '.repo-conduit', 'data');
    assert.equal(first.dataDirectory, root);
    assert.ok(first.connection.args.includes(root));
    const binding = readFileSync(join(root, 'daily-binding.json'));
    assert.ok(existsSync(join(root, 'state.sqlite')));
    assert.equal(existsSync(join(home, '.repo-conduit', 'state.sqlite')), false);
    run(setup);
    assert.deepEqual(run(['projects']), []);
    assert.deepEqual(readFileSync(join(root, 'daily-binding.json')), binding);
    completed = true;
  } finally {
    if (completed) {
      const child = relative(resolve(base), resolve(container));
      assert.ok(child.startsWith('rcac-daily-default-') && !child.includes('..') && !child.includes('\\'));
      rmSync(container, { recursive: true, force: true });
    } else process.stderr.write(`Default setup fixture retained: ${container}\n`);
  }
});

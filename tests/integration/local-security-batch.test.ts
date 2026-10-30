import { privateFixtureParent } from '../support/private-fixture-parent.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import * as security from '../../src/runtime/local-security.js';

type Check = { directory: string; file?: string };
const batch = (security as unknown as {
  assertPrivateInstallationBatch?: (checks: readonly Check[]) => void;
}).assertPrivateInstallationBatch;
const trialParent = privateFixtureParent();
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function withHelper(fake: typeof childProcess.execFileSync, run: () => void): void {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = fake;
  syncBuiltinESMExports();
  try { run(); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
}

test('Windows batch uses one fixed helper, with every path only in bounded environment JSON',
  { skip: process.platform !== 'win32' }, () => {
    assert.equal(typeof batch, 'function');
    const checks = [
      { directory: 'C:\\a quoted " dir (one)', file: 'C:\\a quoted " dir (one)\\f [two].json' },
      { directory: 'C:\\another (dir) with spaces' },
    ];
    const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    withHelper(((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return Buffer.alloc(0);
    }) as typeof childProcess.execFileSync, () => batch!(checks));
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command, powershell);
    assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    const script = call.args[3]!;
    assert.ok(script.includes('RCAC_SECURITY_BATCH'));
    for (const check of checks) {
      assert.equal(script.includes(check.directory), false);
      if (check.file) assert.equal(script.includes(check.file), false);
    }
    const env = call.options.env as NodeJS.ProcessEnv;
    assert.deepEqual(JSON.parse(env.RCAC_SECURITY_BATCH!), checks);
    assert.equal(call.options.timeout, 15_000);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  });

test('batch rejects malformed, excessive and non-child paths before starting helper',
  { skip: process.platform !== 'win32' }, () => {
    assert.equal(typeof batch, 'function');
    let calls = 0;
    withHelper((() => { calls++; return Buffer.alloc(0); }) as unknown as typeof childProcess.execFileSync, () => {
      const invalid: unknown[] = [null, {}, 1, [], Array.from({ length: 17 }, (_, i) => ({ directory: `C:\\d${i}` })),
        [{}], [null], [new Date()], [Object.create({ directory: 'C:\\inherited' })],
        [{ directory: 1 }], [{ directory: 'C:\\ok', file: undefined }],
        [{ directory: 'relative' }], [{ directory: 'C:\\bad\0path' }],
        [{ directory: 'C:\\ok', extra: true }], [{ directory: 'C:\\ok', file: 'C:\\elsewhere\\f' }],
        [{ directory: 'C:\\ok', file: 'C:\\ok\\nested\\f' }],
        [{ directory: 'C:\\ok', file: 'f' }],
        [{ directory: 'C:\\' + 'a'.repeat(17_000) }]];
      for (const value of invalid) assert.throws(() => batch!(value as Check[]));
    });
    assert.equal(calls, 0);
  });

test('helper failure does not disclose helper stderr or environment',
  { skip: process.platform !== 'win32' }, () => {
    assert.equal(typeof batch, 'function');
    const secret = 'PRIVATE_HELPER_DIAGNOSTIC_SENTINEL';
    for (const [code, reason] of [
      [undefined, 'helper_rejected'], ['ETIMEDOUT', 'timeout'], ['ENOENT', 'spawn_missing'],
      ['EACCES', 'spawn_denied'], ['ENOBUFS', 'output_limit'],
    ] as const) {
      withHelper((() => {
        throw Object.assign(new Error(secret), { code, status: 1, stderr: Buffer.from(secret),
          env: { RCAC_SECURITY_BATCH: secret } });
      }) as typeof childProcess.execFileSync, () => {
        let failure: unknown;
        try { batch!([{ directory: 'C:\\safe' }]); } catch (error) { failure = error; }
        assert.ok(failure instanceof Error);
        assert.match(failure.message, /permissions unavailable or unsafe/);
        assert.equal(JSON.stringify(failure).includes(secret), false);
        assert.equal(JSON.stringify(failure.cause).includes(secret), false);
        assert.deepEqual(failure.cause, { component: 'private_directory',
          operation: 'verify_installation', reason });
      });
    }
  });

test('real Windows batch accepts private entries and rejects later unsafe ACLs, inheritance and reparse',
  { skip: process.platform !== 'win32' }, () => {
    assert.equal(typeof batch, 'function');
    assert.ok(isAbsolute(trialParent));
    const name = `rcac-acl-batch-${randomUUID()}`;
    const root = join(trialParent, name);
    assert.equal(dirname(root).toLowerCase(), trialParent.toLowerCase());
    assert.equal(basename(root), name);
    mkdirSync(root);
    security.protectNewDataDirectory(root);
    const good = join(root, "good 'quoted' [literal] (with spaces)");
    const badDirectory = join(root, 'bad-directory');
    const badFileDirectory = join(root, 'bad-file');
    const badAncestor = join(root, 'bad-ancestor');
    const underAncestor = join(badAncestor, 'child');
    const inherited = join(root, 'inherited');
    const linked = join(root, 'linked');
    for (const dir of [good, badDirectory, badFileDirectory, badAncestor]) {
      mkdirSync(dir); security.protectNewDataDirectory(dir);
    }
    mkdirSync(underAncestor); security.protectNewDataDirectory(underAncestor);
    mkdirSync(inherited);
    symlinkSync(good, linked, 'junction');
    const goodFile = join(good, "one 'literal' [file] (with spaces).json");
    const badFile = join(badFileDirectory, 'two.json');
    writeFileSync(goodFile, '{}'); writeFileSync(badFile, '{}');
    batch!([{ directory: good, file: goodFile }, { directory: badFileDirectory },
      { directory: underAncestor }]);
    const icacls = 'C:\\Windows\\System32\\icacls.exe';
    const grantEveryone = (path: string, right: string) => childProcess.execFileSync(icacls,
      [path, '/grant', `*S-1-1-0:${right}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    grantEveryone(badDirectory, '(OI)(CI)R');
    assert.throws(() => batch!([{ directory: good }, { directory: badDirectory }]));
    grantEveryone(badFile, 'R');
    assert.throws(() => batch!([{ directory: good }, { directory: badFileDirectory, file: badFile }]));
    grantEveryone(badAncestor, '(OI)(CI)F');
    assert.throws(() => batch!([{ directory: good }, { directory: underAncestor }]));
    assert.throws(() => batch!([{ directory: good }, { directory: inherited }]));
    assert.throws(() => batch!([{ directory: good }, { directory: linked }]));
    // All newly created fixtures are intentionally retained for inspection.
  });

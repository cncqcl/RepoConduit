import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { createInstallationTestDiagnostics, withInstallationFixtureCleanup } from
  '../support/installation-test-diagnostics.js';

test('installation diagnostics retain nested causes and primary/cleanup errors before reporting', () => {
  const events: Record<string, unknown>[] = [];
  const trace = createInstallationTestDiagnostics('unit', 'synthetic-fixture', value => events.push(value));
  const primary = new Error('original failure', { cause: new Error('helper timeout') });
  const cleanup = new Error('close failure');
  trace.event('open.begin');
  trace.failure('open', new AggregateError([primary, cleanup], 'both failures', { cause: primary }));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.stage, 'open.begin');
  assert.equal(events[0]!.fixture, 'synthetic-fixture');
  assert.equal(typeof events[0]!.elapsedMs, 'number');
  assert.match(String(events[1]!.error), /original failure/);
  assert.match(String(events[1]!.error), /helper timeout/);
  assert.match(String(events[1]!.error), /close failure/);
});

test('diagnostic sink failure cannot mask the original fixture failure', () => {
  const primary = new Error('preserve this exact object');
  const trace = createInstallationTestDiagnostics('unit', 'synthetic', () => { throw new Error('disk denied'); });
  assert.doesNotThrow(() => trace.event('protect.begin'));
  assert.throws(() => {
    try { throw primary; } catch (error) { trace.failure('protect', error); throw error; }
  }, error => error === primary);
});

test('fixture cleanup preserves primary, cleanup and their identity without changing successful values', () => {
  const primary = new Error('primary');
  const cleanup = new Error('cleanup');
  assert.throws(() => withInstallationFixtureCleanup(() => { throw primary; }, () => { throw cleanup; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.equal(error.cause, primary);
    return true;
  });
  assert.throws(() => withInstallationFixtureCleanup(() => { throw primary; }, () => {}), error => error === primary);
  assert.throws(() => withInstallationFixtureCleanup(() => 42, () => { throw cleanup; }), error => error === cleanup);
  let closed = false;
  assert.equal(withInstallationFixtureCleanup(() => 42, () => { closed = true; }), 42);
  assert.equal(closed, true);
  let sawUndefined = false;
  try { withInstallationFixtureCleanup(() => { throw undefined; }, () => {}); }
  catch (error) { sawUndefined = true; assert.equal(error, undefined); }
  assert.equal(sawUndefined, true);
});

test('configured private QA sink flushes records to disk before the recorder returns', () => {
  const parent = homedir();
  const base = mkdtempSync(join(parent, 'rcac-install-diagnostics-'));
  const previous = process.env.REPOCONDUIT_TEST_DIAGNOSTICS_DIR;
  let completed = false;
  try {
    protectNewDataDirectory(base);
    process.env.REPOCONDUIT_TEST_DIAGNOSTICS_DIR = base;
    const trace = createInstallationTestDiagnostics('unit-disk', 'separate-synthetic-fixture');
    trace.event('create-installation.begin');
    trace.failure('create-installation', new Error('known fixture failure'));
    const files = readdirSync(base);
    assert.equal(files.length, 1);
    const rows = readFileSync(join(base, files[0]!), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.stage, 'create-installation.begin');
    assert.match(String(rows[1]!.error), /known fixture failure/);
    completed = true;
  } finally {
    if (previous === undefined) delete process.env.REPOCONDUIT_TEST_DIAGNOSTICS_DIR;
    else process.env.REPOCONDUIT_TEST_DIAGNOSTICS_DIR = previous;
    if (completed) {
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-install-diagnostics-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    }
  }
});

import { appendFileSync, lstatSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { assertPrivateInstallationDirectory } from '../../src/runtime/local-security.js';

// Test-only output. The runner supplies a separate private QA directory, never a
// fixture whose protection may be the operation that failed. No product uses it.
const files = new Map<string, string>();
function append(suite: string, value: Record<string, unknown>): void {
  const directory = process.env.REPOCONDUIT_TEST_DIAGNOSTICS_DIR;
  if (directory === undefined) return;
  const root = resolve(directory);
  const key = `${root}\0${suite}`;
  let file = files.get(key);
  if (file === undefined) {
    if (!/^[a-z0-9-]+$/.test(suite) || lstatSync(root).isSymbolicLink())
      throw new Error('Invalid installation diagnostic directory or suite');
    assertPrivateInstallationDirectory(root);
    file = join(root, `${suite}-${process.pid}.ndjson`);
    writeFileSync(file, '', { flag: 'wx', mode: 0o600, flush: true });
    files.set(key, file);
  }
  appendFileSync(file, JSON.stringify(value) + '\n', { encoding: 'utf8', flush: true });
}

export function createInstallationTestDiagnostics(suite: string, fixture: string,
  sink?: (event: Record<string, unknown>) => void): {
    event(stage: string, details?: Record<string, unknown>): void;
    failure(stage: string, error: unknown): void;
  } {
  const started = process.hrtime.bigint();
  const record = (stage: string, details: Record<string, unknown> = {}): void => {
    const value = { ...details, suite, fixture, stage, atUtc: new Date().toISOString(),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
    try { if (sink) sink(value); else append(suite, value); }
    catch { try { writeSync(2, 'Installation test diagnostic write failed\n'); } catch { /* Original failure wins. */ } }
  };
  return {
    event: record,
    failure: (stage, error) => {
      // inspect preserves Error's non-enumerable stack, cause and AggregateError
      // children, including cycles. Bound diagnostic size, never alter the error.
      let description: string;
      try { description = inspect(error, { depth: 12, maxArrayLength: 32, maxStringLength: 32768 }); }
      catch { description = 'Error inspection failed'; }
      record(stage, { error: description.slice(0, 65536), errorTruncated: description.length > 65536 });
      if (!sink) try { writeSync(2, `Installation fixture failure: ${fixture} at ${stage}\n${description.slice(0, 65536)}\n`); }
      catch { /* Diagnostics must not replace the original error. */ }
    },
  };
}

export function withInstallationFixtureCleanup<T>(run: () => T, close: () => void): T {
  let value: T | undefined;
  let primary: unknown;
  let cleanup: unknown;
  let failed = false;
  let closeFailed = false;
  try { value = run(); } catch (error) { primary = error; failed = true; }
  try { close(); } catch (error) { cleanup = error; closeFailed = true; }
  if (closeFailed) {
    if (failed) throw new AggregateError([primary, cleanup], 'Installation fixture operation and close failed',
      { cause: primary });
    throw cleanup;
  }
  if (failed) throw primary;
  return value!;
}

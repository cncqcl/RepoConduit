/** Fixed contained initialize/EOF diagnostic. Never imported by the application. */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { buildWslIsolationCandidate, checkContainedPayload } from './wsl-isolation-candidate.js';
import { CodexJsonlTransport } from '../src/adapters/codex/protocol/stdio.js';
import { createInitializeOnlyDiagnosticWriter, checkDiagnosticInitializeSchema,
  diagnosticAppServerExited, diagnosticSameUnit } from '../src/adapters/codex/investigator/wsl-app-server-diagnostic.js';
import type { WslDiagnosticObservation } from '../src/adapters/codex/investigator/wsl-app-server-diagnostic.js';

/** Keep observation asynchronous so bridge failure handlers remain live. */
export async function observeBeforeInitialize(transport: CodexJsonlTransport,
  observe: () => Promise<unknown>, refuseIfFailed: () => void, enableWrites: () => void): Promise<unknown> {
  const payload = await observe();
  checkContainedPayload(payload);
  refuseIfFailed();
  enableWrites();
  return transport.initialize();
}

/** A Windows pipe finish is a local observation, not proof of native stdin EOF. */
export function finishContainedStdin(input: Writable, timeoutMs: number): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 ||
      input.destroyed || input.errored || input.writableEnded || input.writableFinished)
    return Promise.reject(new Error('STDIN_FINISH_UNCONFIRMED'));
  return new Promise((resolveFinish, reject) => {
    const finish = () => settle(true);
    const fail = () => settle(false);
    const timer = setTimeout(fail, timeoutMs);
    const settle = (success: boolean) => {
      clearTimeout(timer); input.off('finish', finish); input.off('error', fail); input.off('close', fail);
      if (success && input.writableFinished && !input.errored) resolveFinish();
      else reject(new Error('STDIN_FINISH_UNCONFIRMED'));
    };
    input.once('finish', finish); input.once('error', fail); input.once('close', fail);
    try { input.end(); } catch { fail(); }
  });
}

/** Poll only the saved original identity, within a pre-runtime-limit EOF window. */
export async function waitContainedOriginalExit(identity: WslDiagnosticObservation, deadlineMs: number,
  observe: (remainingMs: number) => Promise<WslDiagnosticObservation>): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs)) throw new Error('ORIGINAL_EXIT_UNCONFIRMED');
  while (Date.now() < deadlineMs) {
    const current = await observe(Math.min(8000, deadlineMs - Date.now()));
    if (Date.now() >= deadlineMs) throw new Error('ORIGINAL_EXIT_UNCONFIRMED');
    if (diagnosticAppServerExited(identity, current)) return;
    if (!diagnosticSameUnit(identity, current) || current.activeState !== 'active' ||
        current.subState !== 'running' || current.mainPid !== identity.mainPid || current.cgroupState !== 'populated')
      throw new Error('ORIGINAL_EXIT_UNCONFIRMED');
    await new Promise<void>(resolvePause => setTimeout(resolvePause, Math.min(100, Math.max(1, deadlineMs - Date.now()))));
  }
  throw new Error('ORIGINAL_EXIT_UNCONFIRMED');
}

/** Evaluated only in the actual bridge close handler, never from an exit request. */
export function containedCloseIsExpected(eofRequested: boolean, code: number | null, signal: string | null,
  stdoutEnded: boolean, stderrEnded: boolean, failure: boolean): boolean {
  return eofRequested && code === 0 && signal === null && stdoutEnded && stderrEnded && !failure;
}

/** Capture only the fixed helper's bounded output; an abort request is never exit proof. */
export function readContainedHelper(observed: ChildProcessWithoutNullStreams, source: string, timeout: number) {
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 8000) throw new Error('HELPER_BUDGET');
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), errorCode: string | null = null;
  return new Promise<{ status: number | null; signal: string | null; errorCode: string | null;
    unconfirmed: boolean; stdout: Buffer; stderr: Buffer }>(resolveResult => {
    let settled = false, aborted = false, fallback: NodeJS.Timeout | undefined;
    const finish = (status: number | null, signal: string | null, unconfirmed: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(helperTimer); if (fallback) clearTimeout(fallback);
      resolveResult({ status, signal, errorCode, unconfirmed, stdout, stderr });
    };
    const abort = (code: string) => {
      if (settled || aborted) return;
      aborted = true; errorCode = code;
      fallback = setTimeout(() => { observed.unref(); finish(null, null, true); }, 100);
      for (const stream of [observed.stdin, observed.stdout, observed.stderr]) stream.destroy();
      try { observed.kill(); } catch { /* Preserve unconfirmed termination, never promote the request. */ }
    };
    const helperTimer = setTimeout(() => abort('HELPER_TIMEOUT'), timeout);
    for (const stream of [observed.stdin, observed.stdout, observed.stderr])
      stream.on('error', () => abort('HELPER_STREAM_ERROR'));
    observed.on('error', () => abort('HELPER_SPAWN_ERROR'));
    observed.stdout.on('data', (part: Buffer) => {
      if (settled) return;
      const room = Math.max(0, 64 * 1024 - stdout.length); stdout = Buffer.concat([stdout, part.subarray(0, room)]);
      if (part.length > room) abort('HELPER_OUTPUT_LIMIT');
    });
    observed.stderr.on('data', (part: Buffer) => {
      if (settled) return;
      const room = Math.max(0, 64 * 1024 - stderr.length); stderr = Buffer.concat([stderr, part.subarray(0, room)]);
      if (part.length > room) abort('HELPER_OUTPUT_LIMIT');
    });
    observed.once('close', (status, signal) => finish(status, signal, false));
    try { observed.stdin.end(source); } catch { abort('HELPER_STREAM_ERROR'); }
  });
}

async function runContainedQualificationPreflight(): Promise<void> {
if (process.argv.length !== 2 || process.platform !== 'win32') throw new Error('FIXED_WINDOWS_DIAGNOSTIC_ONLY');
const started = Date.now();
const deadline = started + 175_000;
const id = randomUUID();
const spec = buildWslIsolationCandidate(id);
const unitName = `rcac-investigator-${id}.service`;
const output = resolve('.local/qualification/wsl-contained-initialize', id);
mkdirSync(output, { recursive: true });
const executable = 'C:/Windows/System32/wsl.exe';
const environment = { SystemRoot: 'C:/Windows', PATH: 'C:/Windows/System32' };
// These manager variables belong only to the trusted control plane; env-i in
// the fixed candidate removes them before bwrap/payload.
const manager = ['/usr/bin/env', '-i', `HOME=/home/${spec.initializeLaunch[3]}`, 'PATH=/usr/bin:/bin',
  'XDG_RUNTIME_DIR=/run/user/1000', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus'];
const launchArgs = [...spec.initializeLaunch.slice(0, 5), ...manager, ...spec.initializeLaunch.slice(5)];
const observerSource = readFileSync('tools/wsl-contained-observer.py', 'utf8');
const schemaPath = 'tests/fixtures/legacy-runtime/InitializeParams-legacy.json';
const schemaHash = '71d400afa8e843b0a567167848e384fa316523774168cb24734b7b2adb52c961';
const sources = ['tools/wsl-qualification-preflight.ts', 'tools/wsl-contained-observer.py',
  'tools/wsl-isolation-candidate.ts', 'src/adapters/codex/investigator/wsl-app-server-diagnostic.ts',
  'src/adapters/codex/protocol/stdio.ts', schemaPath];
const hashes = () => Object.fromEntries(sources.map(path => [path,
  createHash('sha256').update(readFileSync(path)).digest('hex')]));
const before = hashes();
const record: Record<string, unknown> = { id, startedAt: new Date(started).toISOString(),
  scope: 'contained_initialize_eof_zero_model_not_investigator_qualification',
  productionAvailable: false, modelTurn: 'not_run', cleanupAtomic: false,
  launch: { executable, args: launchArgs, env: environment }, sourceHashes: before,
  reservedUnit: unitName, stages: [] };
const save = () => writeFileSync(resolve(output, 'observation.json'), JSON.stringify(record, null, 2) + '\n');
const stage = (name: string) => { (record.stages as string[]).push(name); save(); console.log(name); };
const pause = () => new Promise<void>(r => setTimeout(r, 100));
let helperSequence = 0;
let saved: WslDiagnosticObservation | null = null;
let child: ReturnType<typeof spawn> | null = null;
let transport: CodexJsonlTransport | null = null;
let bridge: Promise<{ code: number | null; signal: string | null }> | null = null;
let stdoutEnded = false; let stderrEnded = false; let failure = false;
let eofRequested = false, expectedBridgeClose = false;
let payloadVerified = false;
let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0);
const disposeBridge = () => {
  child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
  try { child?.kill(); } catch { failure = true; }
  child?.unref();
};
const heartbeat = setInterval(() => console.log(`contained_elapsed_ms ${Date.now() - started}`), 20_000);
const timer = setTimeout(() => { failure = true; payloadVerified = false; disposeBridge(); }, 175_000);
async function helper(op: 'prepare' | 'unit' | 'payload' | 'stop', budgetDeadline = deadline): Promise<Record<string, unknown>> {
  const request = op === 'prepare' ? { op, id } : { op, id, saved };
  const timeout = Math.min(8000, deadline - Date.now(), budgetDeadline - Date.now());
  if (timeout <= 0) throw new Error('CONTAINED_DEADLINE');
  const prefix = `${String(++helperSequence).padStart(2, '0')}-${op}`;
  // Fixed source travels on this separate helper's stdin; no relay or payload
  // protocol is multiplexed with it. This also bounds the Windows argv length.
  const args = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--exec', ...manager,
    '/usr/bin/python3.10', '-I', '-S', '-', JSON.stringify(request)];
  const observed = spawn(executable, args, { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const result = await readContainedHelper(observed, observerSource, timeout);
  const out = result.stdout, err = result.stderr, errorCode = result.errorCode;
  writeFileSync(resolve(output, `${prefix}.stdout.bin`), out);
  writeFileSync(resolve(output, `${prefix}.stderr.bin`), err);
  appendFileSync(resolve(output, 'helper-exits.jsonl'), JSON.stringify({ op, prefix,
    exit: result.status, signal: result.signal, errorCode, unconfirmed: result.unconfirmed,
    stdoutBytes: out.length, stderrBytes: err.length }) + '\n');
  if (result.status !== 0 || errorCode || result.unconfirmed) throw new Error(`CONTAINED_${op.toUpperCase()}_FAILED`);
  const value: unknown = JSON.parse(out.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTAINED_HELPER_OUTPUT');
  return value as Record<string, unknown>;
}
function unitObservation(value: Record<string, unknown>): WslDiagnosticObservation {
  const keys = ['bootId', 'uid', 'unitName', 'invocationId', 'controlGroup', 'mainPid',
    'loadState', 'activeState', 'subState', 'cgroupState'] as const;
  if (keys.some(key => !(key in value))) throw new Error('UNIT_OBSERVATION_SHAPE');
  const projected = Object.fromEntries(keys.map(key => [key, value[key]])) as unknown as WslDiagnosticObservation;
  if (projected.unitName !== unitName || projected.uid !== 1000 ||
    !/^[0-9a-f-]{36}$/.test(projected.bootId) || !Number.isSafeInteger(projected.mainPid) || projected.mainPid < 0)
    throw new Error('UNIT_OBSERVATION_ID');
  return projected;
}
save();
try {
  if (Buffer.byteLength(observerSource) > 64 * 1024 || before[schemaPath] !== schemaHash)
    throw new Error('RETAINED_INPUT_CHANGED');
  checkDiagnosticInitializeSchema(JSON.parse(readFileSync(schemaPath, 'utf8')));
  record.schema = { path: schemaPath, sha256: schemaHash,
    origin: 'cbf10553 fixed0.157.1 actual generated schema; no new schema CLI run' };
  stage('prepare_create_only_contained_fixture');
  const prepared = await helper('prepare'); record.prepared = prepared; save();
  if (prepared.uid !== 1000 || typeof prepared.bootId !== 'string') throw new Error('PREPARE_IDENTITY');
  stage('start_fixed_contained_app_server');
  const launchedAt = Date.now(); record.launchStartedAt = new Date(launchedAt).toISOString(); save();
  child = spawn(executable, launchArgs, { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const launched = child;
  bridge = new Promise(r => launched.once('close', (code, signal) => {
    expectedBridgeClose = containedCloseIsExpected(eofRequested, code, signal, stdoutEnded, stderrEnded, failure);
    r({ code, signal });
  }));
  const fail = () => { failure = true; payloadVerified = false; child?.stdin?.end(); };
  const refuseIfFailed = () => {
    if (failure || Date.now() >= deadline || launched.exitCode !== null || launched.signalCode !== null ||
      launched.stdin!.destroyed || launched.stdin!.writableEnded ||
      JSON.stringify(before) !== JSON.stringify(hashes())) throw new Error('BRIDGE_FAILURE_BEFORE_WRITE');
  };
  launched.on('error', fail); launched.stdin!.on('error', fail);
  launched.stdout!.on('error', fail); launched.stderr!.on('error', fail);
  launched.stdout!.once('end', () => { stdoutEnded = true; });
  launched.stderr!.once('end', () => { stderrEnded = true; });
  launched.stdout!.on('data', (part: Buffer) => {
    const room = Math.max(0, 64 * 1024 - stdout.length); stdout = Buffer.concat([stdout, part.subarray(0, room)]);
    if (part.length > room) fail();
  });
  launched.stderr!.on('data', (part: Buffer) => {
    const room = Math.max(0, 64 * 1024 - stderr.length); stderr = Buffer.concat([stderr, part.subarray(0, room)]);
    if (part.length > room) fail();
  });
  const writer = createInitializeOnlyDiagnosticWriter(launched.stdin!, line =>
    appendFileSync(resolve(output, 'sent-intents.jsonl'), line));
  transport = new CodexJsonlTransport({ input: launched.stdin!, output: launched.stdout!, errors: launched.stderr!,
    exited: launched, terminate: () => { if (!expectedBridgeClose) fail(); } },
    { maxFrameBytes: 16 * 1024, maxTotalBytes: 64 * 1024, maxNotifications: 8, requestTimeoutMs: 8000 },
    'wsl-codex-0.157.1', undefined, (line, control) => {
      refuseIfFailed();
      if (!payloadVerified) throw new Error('CONTAINED_PAYLOAD_UNVERIFIED');
      return writer(line, control);
    });
  for (let attempt = 0; attempt < 4; attempt++) {
    const value = await helper('unit');
    if (value.pending === true) {
      if (value.bootId !== prepared.bootId || value.uid !== 1000 || value.unitName !== unitName ||
        Object.keys(value).length !== 4) throw new Error('INITIAL_PENDING_IDENTITY');
      record.lastPending = value; save();
      if (launched.exitCode !== null || failure) break;
      await pause(); continue;
    }
    const current = unitObservation(value);
    record.lastUnit = current; save();
    if (current.bootId !== prepared.bootId) throw new Error('PREPARE_BOOT_CHANGED');
    if (current.loadState === 'loaded' && current.activeState === 'active' && current.subState === 'running' &&
      current.mainPid > 0 && /^[0-9a-f]{32}$/.test(current.invocationId) &&
      current.controlGroup === `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}` &&
      current.cgroupState === 'populated') { saved = current; record.originalUnit = saved; save(); break; }
    if (launched.exitCode !== null || failure) break;
    await pause();
  }
  if (!saved) throw new Error('ORIGINAL_RUNNING_UNCONFIRMED');
  stage('observe_actual_contained_payload_before_write');
  const initialized = await observeBeforeInitialize(transport, async () => {
    const payload = await helper('payload'); record.payload = payload; save(); return payload;
  }, refuseIfFailed, () => { payloadVerified = true; stage('contained_payload_observed'); });
  record.initializeResponse = initialized; stage('initialize_completed');
  refuseIfFailed(); payloadVerified = false; eofRequested = true; stage('stdin_eof_requested');
  await finishContainedStdin(launched.stdin!, Math.min(2000, Math.max(1, deadline - Date.now())));
  record.stdinFinishObserved = true; stage('stdin_finish_observed');
  // Keep natural exit observation below the existing30s runtime kill bound.
  const exitDeadline = Math.min(Date.now() + 8000, launchedAt + 20_000, deadline - 8000);
  record.eofExitDeadline = new Date(exitDeadline).toISOString(); save();
  await waitContainedOriginalExit(saved, exitDeadline, async remaining => {
    if (failure) throw new Error('BRIDGE_FAILURE_DURING_EOF');
    const current = unitObservation(await helper('unit', Date.now() + remaining));
    record.lastUnit = current; save(); return current;
  });
  record.appServerExitObserved = true;
  stage('saved_original_group_empty');
} catch (error) {
  record.error = error instanceof Error ? error.message : 'CONTAINED_DIAGNOSTIC_FAILED';
  process.exitCode = 1;
} finally {
  payloadVerified = false; child?.stdin?.end();
  if (saved) {
    try {
      // The fixed observer rechecks original boot/UID/invocation/group before
      // conditional stop; this is diagnostic show/check/stop, never atomic CAS.
      record.cleanup = await helper('stop'); record.unitCleanupObserved = true;
    } catch (error) { record.cleanupError = error instanceof Error ? error.message : 'CLEANUP_FAILED'; }
  } else if (child) { record.cleanupError = 'ORIGINAL_IDENTITY_UNCONFIRMED'; }
  if (bridge) {
    let tailTimer: NodeJS.Timeout | undefined;
    record.bridge = await Promise.race([bridge, new Promise(r => {
      tailTimer = setTimeout(() => r({ unconfirmed: true }), Math.max(1, Math.min(8000, deadline - Date.now())));
    })]);
    if (tailTimer) clearTimeout(tailTimer);
    if ('unconfirmed' in (record.bridge as object)) { record.bridgeShutdownRequested = true; disposeBridge(); }
  }
  // Keep tail-frame validation live until bridge streams drain (or remain unconfirmed).
  transport?.close({ terminate: false });
  clearTimeout(timer); clearInterval(heartbeat);
  record.stdoutEnded = stdoutEnded; record.stderrEnded = stderrEnded;
  record.protocolFailure = failure;
  record.closureObserved = record.appServerExitObserved === true && record.unitCleanupObserved === true &&
    (record.bridge as { code?: number } | undefined)?.code === 0 && stdoutEnded && stderrEnded && !failure;
  record.sourceUnchanged = JSON.stringify(before) === JSON.stringify(hashes());
  record.elapsedMs = Date.now() - started;
  writeFileSync(resolve(output, 'stdout.jsonl'), stdout); writeFileSync(resolve(output, 'stderr.bin'), stderr);
  save(); console.log(JSON.stringify({ output, closureObserved: record.closureObserved, error: record.error ?? null }));
  if (record.closureObserved !== true || record.sourceUnchanged !== true || record.error) process.exitCode = 1;
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runContainedQualificationPreflight();
}

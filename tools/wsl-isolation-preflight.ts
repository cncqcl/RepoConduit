/** One local tools-only coordinator; no model/account/production dispatch. */
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildWslIsolationCandidate, isHelpOnlyDiagnostic } from './wsl-isolation-candidate.js';

const helpOnly = isHelpOnlyDiagnostic(process.argv.slice(2));
if (process.platform !== 'win32') throw new Error('FIXED_WINDOWS_ENTRY_ONLY');
const started = Date.now();
const id = randomUUID();
const spec = { ...buildWslIsolationCandidate(id), helpOnly };
const output = resolve('verification/probes/wsl-isolation-native-2026-10-11', id);
mkdirSync(output, { recursive: true });
const sources = ['tools/wsl-isolation-preflight.ts', 'tools/wsl-isolation-preflight.py', 'tools/wsl-isolation-candidate.ts'];
const hashes = () => Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const before = hashes();
const executable = 'C:/Windows/System32/wsl.exe';
const args = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--exec', '/usr/bin/python3.10', '-I', '-S', '-c',
  readFileSync('tools/wsl-isolation-preflight.py', 'utf8')];
writeFileSync(resolve(output, 'input.json'), JSON.stringify({ id, spec, executable, args, sourceHashes: before }, null, 2) + '\n');
console.log(`one_native_attempt ${id}`);
const child = spawn(executable, args, { windowsHide: true,
  env: { SystemRoot: 'C:/Windows', PATH: 'C:/Windows/System32' }, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let timedOut = false; let streamFailure = false;
const dispose = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  try { child.kill(); } catch { streamFailure = true; } child.unref(); };
const heartbeat = setInterval(() => console.log(`native_elapsed_ms ${Date.now() - started}`), 20_000);
child.stdin.on('error', () => { streamFailure = true; });
child.stdout.on('data', (part: Buffer) => {
  if (stdout.length + part.length > 128 * 1024) { streamFailure = true; dispose(); return; }
  stdout = Buffer.concat([stdout, part]);
  // Coordinator emits only synthetic diagnostics and bounded process metadata.
  for (const line of part.toString('utf8').split('\n')) if (line.startsWith('{"stage":')) console.log(line);
});
child.stderr.on('data', (part: Buffer) => {
  if (stderr.length + part.length > 64 * 1024) { streamFailure = true; dispose(); return; }
  stderr = Buffer.concat([stderr, part]);
});
let spawnError: string | undefined;
child.once('error', error => { spawnError = error.message; });
child.stdin.end(JSON.stringify(spec));
let timer: NodeJS.Timeout | undefined;
const exit = await new Promise<{ code: number | null; signal: string | null; unconfirmed: boolean }>(r => {
  child.once('close', (code, signal) => r({ code, signal, unconfirmed: false }));
  timer = setTimeout(() => { timedOut = true; dispose(); r({ code: null, signal: null, unconfirmed: true }); },
    Math.max(1, 175_000 - (Date.now() - started)));
});
if (timer) clearTimeout(timer); clearInterval(heartbeat);
writeFileSync(resolve(output, 'stdout.jsonl'), stdout);
writeFileSync(resolve(output, 'stderr.txt'), stderr);
const unchanged = JSON.stringify(before) === JSON.stringify(hashes());
const observation = { id, elapsedMs: Date.now() - started, ...exit, timedOut, streamFailure,
  spawnError: spawnError ?? null, sourceUnchanged: unchanged, productionAvailable: false, modelTurn: 'not_run' };
writeFileSync(resolve(output, 'bridge.json'), JSON.stringify(observation, null, 2) + '\n');
console.log(JSON.stringify({ output, ...observation }));
if (exit.code !== 0 || timedOut || streamFailure || spawnError || !unchanged) process.exitCode = 1;

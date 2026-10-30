import { spawnSync } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { runWindowsReadinessProtocol, type WindowsReadinessResult } from '../protocol/windows-readiness.js';
import { runOwnedWindowsReadiness, type OwnedReadinessResult } from './windows-job-stdio.js';
import {resolveWindowsDesktopTarget,WINDOWS_DESKTOP_LEGACY_CODEX,WINDOWS_DESKTOP_VERSION,
 desktopVersionMatches} from './windows-desktop-target.js';

/** Historical test-seam default only. Real launches resolve the supported official CLI. */
export const WINDOWS_DESKTOP_CODEX = WINDOWS_DESKTOP_LEGACY_CODEX;
export {WINDOWS_DESKTOP_VERSION,desktopVersionMatches};

type LaunchSpec = ReturnType<typeof windowsDesktopLaunchSpec>;
interface ReadinessChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
  unref(): void;
}
export interface WindowsReadinessRuntime {
  version(spec: LaunchSpec): { status: number | null; stdout: string; error?: unknown };
  open(spec: LaunchSpec): ReadinessChild;
  protocolTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export function windowsDesktopLaunchSpec(operation: 'version' | 'stdio',target?:string) {
  if (operation !== 'version' && operation !== 'stdio') throw new Error('INVALID_ARGUMENT');
  return {
    executable: target??resolveWindowsDesktopTarget(),
    args: operation === 'version' ? ['--version'] : ['app-server', '--stdio'],
    env: {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
      ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
    },
  };
}

/** Confirm process closure on success and failure; two bounded kill attempts, never a shell. */
export async function confirmWindowsChildClose(
  child: EventEmitter & { kill(): boolean }, timeoutMs = 1_000, observedClose?: Promise<boolean>,
): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error('INVALID_ARGUMENT');
  const closed = observedClose ?? new Promise<boolean>(resolve => child.once('close', () => resolve(true)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { child.kill(); } catch { /* Preserve failure and wait for an observed close. */ }
    let timer: NodeJS.Timeout | undefined;
    const confirmed = await Promise.race([closed, new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
    if (timer) clearTimeout(timer);
    if (confirmed) return true;
  }
  return false;
}

/** Diagnostic only: Desktop readiness is not private investigator HOME or model-turn isolation. */
export async function preflightWindowsDesktop(runtime?: WindowsReadinessRuntime): Promise<WindowsReadinessResult | OwnedReadinessResult> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_READINESS_FAILED');
  const selected=runtime?WINDOWS_DESKTOP_CODEX:resolveWindowsDesktopTarget();
  const version = windowsDesktopLaunchSpec('version',selected);
  const checked = runtime ? runtime.version(version) : spawnSync(version.executable, version.args, {
    env: version.env, windowsHide: true, shell: false, encoding: 'utf8', timeout: 5_000, maxBuffer: 512,
  });
  if (checked.error || checked.status !== 0 || !desktopVersionMatches(checked.stdout)) throw new Error('WINDOWS_READINESS_FAILED');
  if (!runtime) {
    try {
      // Trusted local diagnostic entry authorizes only the three zero-model payloads.
      // This callback does not qualify an investigator, grant source access or enable a model.
      return await runOwnedWindowsReadiness('desktop_readiness_v1', { assertDiagnosticAuthority: () => true },selected);
    } catch { throw new Error('WINDOWS_READINESS_FAILED'); }
  }
  // Supplied runtimes are a protocol test seam; their root-only close is not a Job receipt.
  const launch = windowsDesktopLaunchSpec('stdio',selected);
  const child = runtime.open(launch);
  const closed = new Promise<boolean>(resolve => child.once('close', () => resolve(true)));
  let result: WindowsReadinessResult | undefined;
  try {
    result = await runWindowsReadinessProtocol({ input: child.stdin, output: child.stdout, errors: child.stderr,
      exited: child, terminate: () => { child.kill(); } }, runtime.protocolTimeoutMs);
  } catch { /* Native or transport details remain private. */ }
  const terminated = await confirmWindowsChildClose(child, runtime.closeTimeoutMs ?? 1_000, closed);
  if (!terminated) {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream.destroy(); } catch { /* The child remains termination-unconfirmed. */ }
    }
    try { child.unref(); } catch { /* The child remains termination-unconfirmed. */ }
  }
  if (!terminated || !result) throw new Error('WINDOWS_READINESS_FAILED');
  return result;
}

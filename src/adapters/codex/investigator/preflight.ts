import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

/** Fixed system executable for the supported Windows host image. */
export const WSL_EXECUTABLE = 'C:\\Windows\\System32\\wsl.exe';

/** These values come only from trusted local installation configuration. */
export interface WslCodexInstallation {
  distro: string;
  binary: string;
}

export type WslCodexOperation = 'version' | 'stdio';

export function wslCodexArgs(installation: WslCodexInstallation, operation: WslCodexOperation): string[] {
  const { distro, binary } = installation;
  if (operation !== 'version' && operation !== 'stdio') throw new Error('INVALID_ARGUMENT');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(distro) ||
      !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(binary) ||
      binary.startsWith('/mnt/') || binary.split('/').some(part => part === '.' || part === '..')) throw new Error('INVALID_ARGUMENT');
  return ['-d', distro, '--exec', binary, ...(operation === 'version' ? ['--version'] : ['app-server', '--stdio'])];
}

function windowsLaunchEnv(): NodeJS.ProcessEnv {
  // This limits Windows-side inheritance for the version probe only. It does not
  // constrain the Linux user's HOME, Codex config, credentials, plugins or tools.
  return { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.Path ?? process.env.PATH ?? '' };
}

export function verifyWslCodexVersion(output: string, expectedVersion: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(expectedVersion) && output === `codex-cli ${expectedVersion}\n`;
}

/** Build the fixed executable launch; PATH is never used to choose the program. */
export function versionLaunchSpec(installation: WslCodexInstallation): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { executable: WSL_EXECUTABLE, args: wslCodexArgs(installation, 'version'), env: windowsLaunchEnv() };
}

/** A noninteractive version-string probe. It does not prove Linux binary provenance, model login or sandbox isolation. */
export async function preflightWslCodex(installation: WslCodexInstallation, expectedVersion = '0.157.1', timeoutMs = 5_000): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      !/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error('INVALID_ARGUMENT');
  const launch = versionLaunchSpec(installation);
  const child = spawn(launch.executable, launch.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: launch.env });
  const output = await readVersionProbe(child, timeoutMs);
  if (output.exitCode !== 0 || !verifyWslCodexVersion(output.stdout, expectedVersion)) throw new Error('CODEX_PREFLIGHT_FAILED');
}

/** Collect only the bounded output of the noninteractive `--version` process. */
export function readVersionProbe(child: EventEmitter & { stdout: Readable; stderr: Readable; kill(): boolean },
  timeoutMs: number): Promise<{ stdout: string; exitCode: number | null }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('INVALID_ARGUMENT');
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* Failure remains closed; WSL cleanup is not proven here. */ }
      reject(new Error('CODEX_PREFLIGHT_FAILED'));
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 256) return fail();
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024) fail();
    });
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout, exitCode: code });
    });
  });
}

import { posix } from 'node:path';
import { WSL_EXECUTABLE } from './preflight.js';

export interface WslPrivateLoginInput {
  distro: string;
  loginId: string;
  linuxHome: string;
  linuxNode: string;
  codexEntry: string;
}

function linuxPath(path: string): boolean {
  return /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) &&
    !path.startsWith('/mnt/') && !path.split('/').some(part => part === '.' || part === '..');
}

/** This is a displayable launch spec only. Its caller must first run the Linux-side create-only helper. */
export function privateLoginSpec(input: WslPrivateLoginInput): {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  privateHome: string;
  codexHome: string;
  workspace: string;
} {
  const { distro, loginId, linuxHome, linuxNode, codexEntry } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(distro) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(loginId) ||
    !/^\/home\/[A-Za-z_][A-Za-z0-9_-]*$/.test(linuxHome) ||
    !linuxPath(linuxNode) || !linuxPath(codexEntry) ||
    !linuxNode.startsWith(`${linuxHome}/`) || !codexEntry.startsWith(`${linuxHome}/`)) {
    throw new Error('INVALID_ARGUMENT');
  }
  const root = `${linuxHome}/.local/repoconduit-private-homes/${loginId}`;
  const privateHome = `${root}/home`;
  const codexHome = `${privateHome}/.codex`;
  const workspace = `${root}/workspace`;
  const linuxUser = linuxHome.slice('/home/'.length);
  return {
    executable: WSL_EXECUTABLE,
    args: ['-d', distro, '--user', linuxUser, '--cd', workspace, '--exec', '/usr/bin/env', '-i',
      `HOME=${privateHome}`, `CODEX_HOME=${codexHome}`,
      `PATH=${posix.dirname(linuxNode)}:/usr/bin:/bin`, linuxNode, codexEntry, 'login'],
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' },
    privateHome, codexHome, workspace,
  };
}

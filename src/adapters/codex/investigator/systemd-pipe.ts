import { posix } from 'node:path';
import { privateLoginSpec, type WslPrivateLoginInput } from './private-home.js';

export interface AppServerUnitInput extends WslPrivateLoginInput {
  unitName: string;
  maxWallSeconds: number;
}

/** Exact launch description for the currently verified WSL2 + systemd 249 route.
 * The caller must first persist this unit reservation and separately verify the native identity.
 */
export function appServerUnitSpec(input: AppServerUnitInput): {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const login = privateLoginSpec(input);
  if (!/^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(input.unitName) ||
    !Number.isInteger(input.maxWallSeconds) || input.maxWallSeconds < 1 || input.maxWallSeconds > 600 ||
    input.linuxNode !== `${input.linuxHome}/.hermes/node/bin/node` ||
    input.codexEntry !== `${input.linuxHome}/.local/repoconduit-codex-0.157.1/package/bin/codex.js`) {
    throw new Error('INVALID_ARGUMENT');
  }
  const installBin = posix.join(input.linuxHome, '.local', 'repoconduit-codex-0.157.1', 'bin');
  return {
    executable: login.executable,
    args: ['-d', input.distro, '--user', input.linuxHome.slice('/home/'.length),
      '--exec', '/usr/bin/systemd-run', '--user', '--quiet',
      `--unit=${input.unitName}`, '--service-type=exec',
      '--property=Restart=no', '--property=KillMode=control-group',
      '--property=SendSIGKILL=yes', `--property=RuntimeMaxSec=${input.maxWallSeconds}s`,
      '--property=TimeoutStopSec=2s', `--working-directory=${login.workspace}`,
      '--pipe', '--wait', '/usr/bin/env', '-i',
      `HOME=${login.privateHome}`, `CODEX_HOME=${login.codexHome}`,
      `PATH=${installBin}:${posix.dirname(input.linuxNode)}:/usr/bin:/bin`,
      input.linuxNode, input.codexEntry, 'app-server', '--stdio'],
    env: login.env,
  };
}

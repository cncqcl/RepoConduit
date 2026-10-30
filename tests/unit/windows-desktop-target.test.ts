import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {WINDOWS_DESKTOP_CODEX,WINDOWS_DESKTOP_VERSION,windowsDesktopLaunchSpec}
 from '../../src/adapters/codex/investigator/windows-preflight.js';
import {WINDOWS_APP_SERVER_PROTOCOL_TARGET}
 from '../../src/adapters/codex/investigator/windows-launch-record.js';

test('Desktop launch freezes one selected target while retaining historical location and labels',
 {timeout: 5_000},()=>{
 const current='C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
 const native=readFileSync(resolve('native/windows/WindowsJobHost.cs'),'utf8');
 assert.ok(native.includes(`private const string DesktopExe = @"${current}";`));
 assert.equal(WINDOWS_DESKTOP_CODEX,current);
 const selected='C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\0123456789abcdef\\codex.exe';
 assert.equal(windowsDesktopLaunchSpec('version',selected).executable,selected);
 assert.equal(windowsDesktopLaunchSpec('stdio',selected).executable,selected);
 assert.deepEqual(windowsDesktopLaunchSpec('version',selected).args,['--version']);
 assert.deepEqual(windowsDesktopLaunchSpec('stdio',selected).args,['app-server','--stdio']);
 assert.equal(WINDOWS_DESKTOP_VERSION,'0.165.0-alpha.1.2');
 assert.ok(native.includes('private const string DesktopVersion = "codex-cli 0.165.0-alpha.1.2\\n";'));
 assert.equal(WINDOWS_APP_SERVER_PROTOCOL_TARGET,
  'windows-desktop-codex-0.163.0-alpha.11');
});

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildClaudeMcpSandboxSpec } from '../../src/adapters/secondary-investigator/claude-mcp-sandbox-spec.js';

const wsl = 'C:\\Windows\\System32\\wsl.exe';
const distro = 'Ubuntu-22.04';
const linuxUser = 'fixture';

test('generated bwrap mounts only synthetic MCP relay and empty work', { timeout: 25000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows WSL only'); return; }
  try {
    execFileSync(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', '/usr/bin/test', '-x', '/usr/bin/bwrap'],
      { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { t.skip('private WSL bwrap fixture unavailable'); return; }
  const id = randomUUID();
  const root = `/home/fixture/.local/share/rcac-claude-mcp-boundary-${id}`;
  const fifo = `${root}/attempt_${id}-1.mcp`;
  const paths = { installRoot: `${root}/runtime`, nodeRoot: `${root}/node`,
    srtSettingsFile: `${root}/srt.json`, mcpConfigFile: `${root}/mcp.json`,
    helperFile: `${root}/helper.py`, privateFifoDirectory: fifo, privateAuthHome: `${root}/auth` };
  const setup = String.raw`
import os,sys
root, fifo = sys.argv[1:3]
os.mkdir(root, 0o700)
for path in ('runtime','runtime/node_modules','runtime/deps','node','auth'):
    os.mkdir(root+'/'+path, 0o700)
os.mkdir(fifo, 0o700)
for name in ('in','out'): os.mkfifo(fifo+'/'+name, 0o600)
for name, content in [('srt.json','{}'),('mcp.json','{}'),('helper.py','fixture-helper')]:
    with open(root+'/'+name,'w',encoding='ascii') as target: target.write(content)
`;
  execFileSync(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', setup, root, fifo],
  { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  let child: ReturnType<typeof spawn> | undefined;
  let observedClosed = false;
  let normalExit = false;
  try {
    const spec = buildClaudeMcpSandboxSpec(paths);
    const outerEnd = spec.argv.indexOf('--');
    assert.ok(outerEnd > 0);
    const inspect = String.raw`
import json,os,stat
assert os.getcwd() == '/work'
assert os.listdir('/work') == []
for path in ('/snapshot','/source','/gate','/hostprivate','/run','/sys','/home/fixture'):
    assert not os.path.exists(path), path
assert open('/opt/mcp-fifo.py',encoding='ascii').read() == 'fixture-helper'
assert os.listdir('/home/claude') == []
assert sorted(os.listdir('/relay')) == ['in','out']
for name in ('in','out'):
    entry = os.stat('/relay/'+name, follow_symlinks=False)
    assert stat.S_ISFIFO(entry.st_mode) and stat.S_IMODE(entry.st_mode) == 0o600
print(json.dumps({'cwd':os.getcwd(),'relay':sorted(os.listdir('/relay')),'helper':True}))
`;
    child = spawn(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', spec.file,
      ...spec.argv.slice(0, outerEnd), '--', '/usr/bin/python3', '-I', '-S', '-c', inspect],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await new Promise<{ code: number | null; stdout: string; stderrBytes: number }>((resolve, reject) => {
      let stdout = ''; let stderrBytes = 0; let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error('bwrap inspection timeout'); child!.kill(); }, 12000);
      child!.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8'); if (stdout.length > 2048) {
          failure = new Error('bwrap inspection output limit'); child!.kill();
        }
      });
      child!.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length; if (stderrBytes > 2048) {
          failure = new Error('bwrap inspection stderr limit'); child!.kill();
        }
      });
      child!.once('error', error => { failure = error; });
      child!.once('close', code => {
        observedClosed = true; clearTimeout(timer);
        if (failure) reject(failure); else resolve({ code, stdout, stderrBytes });
      });
    });
    normalExit = result.code === 0;
    assert.equal(result.code, 0, `bwrap inspect failed; stderr bytes=${result.stderrBytes}`);
    assert.deepEqual(JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('{')).trim()),
      { cwd: '/work', relay: ['in', 'out'], helper: true });
  } finally {
    if (child && !observedClosed) {
      child.kill();
      await Promise.race([new Promise<void>(resolve => child!.once('close', () => {
        observedClosed = true; resolve();
      })), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
    }
    if (!child || normalExit) execFileSync(wsl,
      ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', '/usr/bin/python3', '-I', '-S',
        '-c', 'import shutil,sys;shutil.rmtree(sys.argv[1])', root],
      { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
});

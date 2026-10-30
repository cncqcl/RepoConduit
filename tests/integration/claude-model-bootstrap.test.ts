import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, encodeClaudeModelBootstrapFrame } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';

const wsl = 'C:\\Windows\\System32\\wsl.exe';
const base = ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/bwrap',
  '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
  '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
  '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/python3', '-I', '-S', '-c'];

function wslBridgeStderr(): Buffer {
  const bridge = spawnSync(wsl,
    ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/true'],
    { encoding: 'buffer', timeout: 5000, maxBuffer: 4096 });
  assert.equal(bridge.status, 0);
  assert.equal(bridge.stdout.length, 0);
  // The host may emit its localhost proxy warning before the Linux command runs.
  return bridge.stderr;
}

async function run(script: string, send: (ready: unknown) => Buffer | 'hold' | null,
  cap: string | null = '3'): Promise<{
  code: number | null; stdout: Buffer; stderr: Buffer; ready: unknown;
}> {
  const child = spawn(wsl, [...base, script, ...(cap === null ? [] : [cap])],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const output: Buffer[] = []; const errors: Buffer[] = [];
  let ready: unknown; let sent = false;
  const timer = setTimeout(() => child.kill(), 9000);
  try {
    child.stdout.on('data', (part: Buffer) => {
      output.push(Buffer.from(part));
      if (Buffer.concat(output).length > 8192) child.kill();
      const joined = Buffer.concat(output);
      const newline = joined.indexOf(10);
      if (!sent && newline >= 0) {
        sent = true;
        ready = JSON.parse(joined.subarray(0, newline).toString('utf8'));
        const frame = send(ready);
        if (frame === 'hold') return;
        if (frame) child.stdin.end(frame); else child.stdin.end();
      }
    });
    child.stderr.on('data', (part: Buffer) => {
      errors.push(Buffer.from(part));
      if (Buffer.concat(errors).length > 8192) child.kill();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve); child.once('error', reject);
    });
    return { code, stdout: Buffer.concat(output), stderr: Buffer.concat(errors), ready };
  } finally { clearTimeout(timer); child.stdin.destroy(); }
}

test('real WSL bootstrap rejects missing or malformed turn cap before READY',
  {timeout:15000},async t=>{
    if(process.platform!=='win32'){t.skip('WSL only');return;}
    const bridgeStderr=wslBridgeStderr();
    for(const cap of [null,'0','9','01','1.5']) {
      const result=await run(CLAUDE_MODEL_BOOTSTRAP_PYTHON,()=>null,cap);
      assert.equal(result.code,86);
      assert.deepEqual(result.stderr,bridgeStderr);
      assert.equal(result.ready,undefined);
      assert.equal(result.stdout.length,0);
    }
  });

test('real WSL bootstrap READY is bounded and malformed frames exit before exec',
  { timeout: 30000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL only'); return; }
    const payload = Buffer.from('prompt');
    const bridgeStderr = wslBridgeStderr();
    const hash = createHash('sha256').update(payload).digest('hex');
    const valid = encodeClaudeModelBootstrapFrame(payload, hash);
    const variants = [
      Buffer.from(''),
      valid.subarray(0, valid.length - 1),
      Buffer.concat([valid, Buffer.from('x')]),
      Buffer.from(valid.toString('binary').replace(hash, '0'.repeat(64)), 'binary'),
      Buffer.concat([Buffer.from('{"protocol":"claude_model_bootstrap_v1","byteLength":6,"byteLength":6,"sha256":"' + hash + '"}\n'), payload]),
    ];
    for (const frame of variants) {
      const result = await run(CLAUDE_MODEL_BOOTSTRAP_PYTHON, () => frame);
      assert.equal(result.code, 86);
      assert.deepEqual(result.stderr, bridgeStderr);
      assert.equal((result.ready as { protocol?: string })?.protocol, 'claude_model_bootstrap_v1');
      assert.equal((result.ready as { kind?: string })?.kind, 'ready');
      const ready = result.ready as Record<string, unknown>;
      assert.deepEqual(Object.keys(ready).sort(),
        ['protocol','kind','pid','ppid','startTicks','namespaces','capEff','noNewPrivs'].sort());
      assert.equal(ready.capEff, '0');
      assert.equal(ready.noNewPrivs, 1);
      assert.deepEqual(Object.keys(ready.namespaces as object).sort(),
        ['pid','mnt','net','user','ipc','uts','cgroup'].sort());
      assert.ok(result.stdout.length <= 512, `unexpected model output bytes=${result.stdout.length}`);
    }
  });

test('real WSL bootstrap rejects an open frame at its original five second deadline',
  { timeout: 12000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL only'); return; }
    const started = Date.now();
    const bridgeStderr = wslBridgeStderr();
    const result = await run(CLAUDE_MODEL_BOOTSTRAP_PYTHON, () => 'hold');
    assert.equal(result.code, 86);
    assert.deepEqual(result.stderr, bridgeStderr);
    assert.equal((result.ready as { kind?: string })?.kind, 'ready');
    assert.ok(Date.now() - started >= 4500);
    assert.ok(Date.now() - started < 9000);
  });

test('real WSL derived final-tail marker receives sealed exact raw prompt',
  { timeout: 15000 }, async t => {
    if (process.platform !== 'win32') { t.skip('WSL only'); return; }
    const tail = /^os\.execve\('\/runtime\/node_modules\/\.bin\/srt'.*\)$/m;
    const marker = `import json,stat\nraw=os.read(0,16385)\nlive=[]\nfor name in os.listdir('/proc/self/fd'):\n try: os.fstat(int(name))\n except OSError as error:\n  if error.errno == 9: continue\n  raise\n live.append(int(name))\nprint(json.dumps({'synthetic':True,'rawHex':raw.hex(),'fdMode':stat.S_IFMT(os.fstat(0).st_mode),'seals':fcntl.fcntl(0,fcntl.F_GET_SEALS),'fds':sorted(live)}))`;
    assert.equal(CLAUDE_MODEL_BOOTSTRAP_PYTHON.match(tail)?.length, 1);
    const derived = CLAUDE_MODEL_BOOTSTRAP_PYTHON.replace(tail, marker);
    const payload = Buffer.from([0, 10, 13, 255, 1]);
    const hash = createHash('sha256').update(payload).digest('hex');
    const result = await run(derived, () => encodeClaudeModelBootstrapFrame(payload, hash));
    assert.equal(result.code, 0, `stderr bytes=${result.stderr.length}`);
    const lines = result.stdout.toString('utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const proof = JSON.parse(lines[1]!);
    assert.equal(proof.synthetic, true);
    assert.equal(proof.rawHex, payload.toString('hex'));
    assert.equal(proof.seals & 15, 15);
    assert.deepEqual(proof.fds, [0, 1, 2]);
  });

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildClaudeModelLaunchConfig } from
  '../../src/adapters/secondary-investigator/claude-model-launch-config.js';
import { CLAUDE_MODEL_CONFIG_READER_PYTHON, encodeClaudeModelConfigInput } from
  '../../src/adapters/secondary-investigator/claude-model-config-wire.js';

const profile = { allowedDomains: [] };
const wsl = 'C:\\Windows\\System32\\wsl.exe';
const expected = buildClaudeModelLaunchConfig(profile).files.map(({ target, byteLength, sha256 }) =>
  ({ target, byteLength, sha256 }));

function frameParts(frame: Buffer): { header: Record<string, unknown>; newline: number } {
  const newline = frame.indexOf(10);
  assert.ok(newline > 0 && newline <= 2048);
  return { header: JSON.parse(frame.subarray(0, newline).toString('ascii')) as Record<string, unknown>, newline };
}

function readerScript(mode: 'normal' | 'expired' | 'reserve' | 'short'): string {
  return `${CLAUDE_MODEL_CONFIG_READER_PYTHON}\n
import errno, fcntl, hashlib, json, os, sys, time
EXPECTED = json.loads(${JSON.stringify(JSON.stringify(expected))})
try:
    if ${JSON.stringify(mode)} == 'reserve':
        reserved = os.open('/dev/null', os.O_RDONLY)
        os.dup2(reserved, 32)
        if reserved != 32: os.close(reserved)
    deadline = time.monotonic() - 0.01 if ${JSON.stringify(mode)} == 'expired' else time.monotonic() + (0.25 if ${JSON.stringify(mode)} == 'short' else 3)
    fds = read_sealed_config(EXPECTED, deadline)
    rows = []
    for fd in fds:
        os.lseek(fd, 0, os.SEEK_SET)
        body = os.read(fd, 65537)
        try: os.pwrite(fd, b'x', 0); write_errno = 0
        except OSError as exc: write_errno = exc.errno
        rows.append({'fd':fd,'size':len(body),'sha256':hashlib.sha256(body).hexdigest(),
                     'seals':fcntl.fcntl(fd, fcntl.F_GET_SEALS), 'writeDenied':write_errno == errno.EPERM})
        os.close(fd)
    tail = os.read(0, 64).hex()
    reserved_ok = os.fstat(32).st_mode > 0 if ${JSON.stringify(mode)} == 'reserve' else None
    print(json.dumps({'rows':rows,'tail':tail,'reserved':reserved_ok}))
except Exception:
    live = []
    for fd in range(32, 64):
        try: os.fstat(fd); live.append(fd)
        except OSError: pass
    print(json.dumps({'failed':True,'live':live}))
    sys.exit(86)
`;
}

function runReader(frame: Buffer, mode: 'normal' | 'expired' | 'reserve' = 'normal') {
  return spawnSync(wsl, ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', readerScript(mode)],
  { input: frame, encoding: 'buffer', timeout: 8000, maxBuffer: 16 * 1024 });
}

test('encoder emits exact fixed metadata and a copied body frame', () => {
  const config = buildClaudeModelLaunchConfig(profile);
  const encoded = encodeClaudeModelConfigInput(config, profile);
  const { header, newline } = frameParts(encoded);
  assert.deepEqual(header, { protocol: 'claude_model_config_input_v1', files: expected });
  assert.deepEqual(encoded.subarray(newline + 1), Buffer.concat(config.files.map(file => file.bytes)));
  const original = Buffer.from(encoded);
  config.files[0].bytes[0]! ^= 1;
  assert.deepEqual(encoded, original);
  assert.throws(() => encodeClaudeModelConfigInput(config, profile));
});

test('real WSL reader seals three high FDs, preserves an existing FD and leaves prompt bytes',
  { timeout: 12000 }, t => {
    if (process.platform !== 'win32') { t.skip('WSL only'); return; }
    const frame = encodeClaudeModelConfigInput(buildClaudeModelLaunchConfig(profile), profile);
    const prompt = Buffer.from('PROMPT_REMAINS_UNREAD');
    const result = runReader(Buffer.concat([frame, prompt]), 'reserve');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
    const output = JSON.parse(result.stdout.toString()) as {
      rows: {fd:number;size:number;sha256:string;seals:number;writeDenied:boolean}[];
      tail:string;reserved:boolean;
    };
    assert.equal(output.reserved, true);
    assert.deepEqual(output.rows.map(row => row.sha256), expected.map(file => file.sha256));
    assert.deepEqual(output.rows.map(row => row.size), expected.map(file => file.byteLength));
    assert.ok(output.rows.every(row => row.fd >= 33 && row.seals === 15));
    assert.ok(output.rows.every(row => row.writeDenied));
    assert.equal(output.tail, prompt.toString('hex'));
  });

test('real WSL reader rejects changed metadata, hash, duplicate keys, truncation and deadline',
  { timeout: 45000 }, t => {
    if (process.platform !== 'win32') { t.skip('WSL only'); return; }
    const valid = encodeClaudeModelConfigInput(buildClaudeModelLaunchConfig(profile), profile);
    const { header, newline } = frameParts(valid);
    const body = valid.subarray(newline + 1);
    const changed = structuredClone(header) as {files: typeof expected};
    changed.files[0]!.target = '/opt/elsewhere' as typeof expected[number]['target'];
    const badHash = structuredClone(header) as {files: typeof expected};
    badHash.files[2]!.sha256 = createHash('sha256').update('wrong').digest('hex');
    const overFileLimit = structuredClone(header) as {files: typeof expected};
    overFileLimit.files[0]!.byteLength = 65537;
    const overTotalLimit = structuredClone(header) as {files: typeof expected};
    for (const file of overTotalLimit.files) file.byteLength = 65536;
    const floatLength = JSON.stringify(header).replace(
      `"byteLength":${expected[0]!.byteLength}`, `"byteLength":${expected[0]!.byteLength}.0`);
    const paddedHeader = JSON.stringify(header).padEnd(2048, ' ') + '\n';
    assert.equal(Buffer.byteLength(paddedHeader), 2049);
    const variants = [
      Buffer.concat([Buffer.from(JSON.stringify(changed) + '\n'), body]),
      Buffer.concat([Buffer.from(JSON.stringify(badHash) + '\n'), body]),
      Buffer.concat([Buffer.from(JSON.stringify(overFileLimit) + '\n'), body]),
      Buffer.concat([Buffer.from(JSON.stringify(overTotalLimit) + '\n'), body]),
      Buffer.concat([Buffer.from(floatLength + '\n'), body]),
      Buffer.concat([Buffer.from(paddedHeader), body]),
      Buffer.concat([Buffer.from('{"protocol":"claude_model_config_input_v1","protocol":"claude_model_config_input_v1","files":' + JSON.stringify(expected) + '}\n'), body]),
      valid.subarray(0, valid.length - 1),
      Buffer.concat([Buffer.from('x'.repeat(2049) + '\n'), body]),
    ];
    for (const variant of variants) {
      const result = runReader(variant);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 86, result.stderr.toString());
      const output = JSON.parse(result.stdout.toString()) as {failed:boolean;live:number[]};
      assert.equal(output.failed, true);
      assert.deepEqual(output.live, []);
    }
    const expired = runReader(valid, 'expired');
    assert.equal(expired.error, undefined);
    assert.equal(expired.status, 86);
  });

test('real WSL reader deadline expires while stdin remains open', { timeout: 10000 }, async t => {
  if (process.platform !== 'win32') { t.skip('WSL only'); return; }
  const child = spawn(wsl, ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', readerScript('short')],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const output: Buffer[] = [];
  child.stdout.on('data', (part: Buffer) => output.push(Buffer.from(part)));
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 86);
    const result = JSON.parse(Buffer.concat(output).toString()) as { failed: boolean; live: number[] };
    assert.equal(result.failed, true);
    assert.deepEqual(result.live, []);
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
});

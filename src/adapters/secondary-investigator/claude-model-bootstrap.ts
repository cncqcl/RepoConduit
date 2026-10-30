import { createHash } from 'node:crypto';

/** Fixed process body inside the model namespace. No caller argv, environment or path is read. */
export const CLAUDE_MODEL_BOOTSTRAP_PYTHON = String.raw`import fcntl, hashlib, hmac, json, os, select, sys, time

deadline = time.monotonic() + 5.0

def fail():
    os._exit(86)

def read_bounded(count):
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            fail()
        readable, _, _ = select.select([0], [], [], left)
        if not readable:
            fail()
        try:
            return os.read(0, count)
        except InterruptedError:
            continue

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate header key')
        result[key] = value
    return result

try:
    if len(sys.argv) != 2 or sys.argv[1] not in ('1','2','3','4','5','6','7','8'):
        fail()
    names = os.listdir('/proc/self/fd')
    if len(names) > 64 or any(not name.isdecimal() for name in names):
        fail()
    for name in names:
        fd = int(name)
        if fd > 2:
            try:
                os.close(fd)
            except OSError as exc:
                if exc.errno != 9:
                    raise
    fields = {}
    with open('/proc/self/status', encoding='ascii') as source:
        for row in source:
            key, sep, value = row.partition(':')
            if sep and key in ('CapEff', 'NoNewPrivs'):
                if key in fields:
                    fail()
                fields[key] = value.strip()
    if set(fields) != {'CapEff', 'NoNewPrivs'} or int(fields['CapEff'], 16) != 0 or fields['NoNewPrivs'] != '1':
        fail()
    with open('/proc/self/stat', encoding='ascii') as source:
        statline = source.read(4096)
    if len(statline) >= 4096 or not statline.startswith(str(os.getpid()) + ' ('):
        fail()
    after = statline[statline.rfind(')') + 2:].split()
    if len(after) < 20:
        fail()
    ticks = int(after[19])
    if ticks <= 0:
        fail()
    namespaces = {key: os.readlink('/proc/self/ns/' + key) for key in
                  ('pid', 'mnt', 'net', 'user', 'ipc', 'uts', 'cgroup')}
    ready = {'protocol': 'claude_model_bootstrap_v1', 'kind': 'ready',
             'pid': os.getpid(), 'ppid': os.getppid(), 'startTicks': ticks,
             'namespaces': namespaces, 'capEff': '0', 'noNewPrivs': 1}
    line = json.dumps(ready, separators=(',', ':')).encode('ascii') + b'\n'
    if len(line) > 512:
        fail()
    os.write(1, line)

    header = bytearray()
    while True:
        part = read_bounded(1)
        if not part:
            fail()
        header.extend(part)
        if len(header) > 512:
            fail()
        if part == b'\n':
            break
    data = json.loads(header[:-1].decode('ascii'), object_pairs_hook=unique_pairs)
    if (type(data) is not dict or set(data) != {'protocol', 'byteLength', 'sha256'} or
        data['protocol'] != 'claude_model_bootstrap_v1' or
        type(data['byteLength']) is not int or not 1 <= data['byteLength'] <= 16384 or
        type(data['sha256']) is not str or len(data['sha256']) != 64 or
        any(ch not in '0123456789abcdef' for ch in data['sha256'])):
        fail()
    body = bytearray()
    while len(body) < data['byteLength']:
        part = read_bounded(data['byteLength'] - len(body))
        if not part:
            fail()
        body.extend(part)
    if read_bounded(1):
        fail()
    if not hmac.compare_digest(hashlib.sha256(body).hexdigest(), data['sha256']):
        fail()
    memfd = os.memfd_create('claude-model-prompt', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    if os.write(memfd, body) != len(body):
        fail()
    os.lseek(memfd, 0, os.SEEK_SET)
    seals = fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE
    fcntl.fcntl(memfd, fcntl.F_ADD_SEALS, seals)
    os.dup2(memfd, 0)
    os.close(memfd)
except BaseException:
    fail()

os.execve('/runtime/node_modules/.bin/srt', ['/runtime/node_modules/.bin/srt', '--settings', '/opt/srt.json', '--', '/runtime/node_modules/.bin/claude', '--print', '--no-session-persistence', '--restricted', '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '/opt/mcp.json', '--tools', '', '--disable-slash-commands', '--output-format', 'json', '--max-turns', sys.argv[1]], {'HOME': '/home/claude', 'PATH': '/runtime/deps/usr/bin:/node/bin:/usr/bin:/bin', 'LD_LIBRARY_PATH': '/runtime/deps/usr/lib/x86_64-linux-gnu'})`;

export const CLAUDE_MODEL_BOOTSTRAP_SHA256 = createHash('sha256')
  .update(CLAUDE_MODEL_BOOTSTRAP_PYTHON).digest('hex');

/** A private runner sends this only after durable prompt intent and READY validation. */
export function encodeClaudeModelBootstrapFrame(bytes: Buffer, expectedSha256: string): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16384 ||
    !/^[0-9a-f]{64}$/.test(expectedSha256))
    throw new Error('MODEL_PROMPT_UNAVAILABLE');
  const snapshot = Buffer.from(bytes);
  if (createHash('sha256').update(snapshot).digest('hex') !== expectedSha256)
    throw new Error('MODEL_PROMPT_UNAVAILABLE');
  const header = Buffer.from(JSON.stringify({ protocol: 'claude_model_bootstrap_v1',
    byteLength: snapshot.length, sha256: expectedSha256 }) + '\n', 'ascii');
  if (header.length > 512) throw new Error('MODEL_PROMPT_UNAVAILABLE');
  return Buffer.concat([header, snapshot]);
}

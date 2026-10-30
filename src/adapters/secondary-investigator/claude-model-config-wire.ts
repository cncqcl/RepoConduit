import { cloneValidateClaudeModelLaunchConfig } from './claude-model-launch-config.js';
import type { ClaudeModelLaunchConfig, ClaudeModelLaunchProfile } from './claude-model-launch-config.js';

export function encodeClaudeModelConfigInput(
  config: ClaudeModelLaunchConfig, profile: ClaudeModelLaunchProfile,
): Buffer {
  const fixed = cloneValidateClaudeModelLaunchConfig(config, profile);
  const header = Buffer.from(JSON.stringify({
    protocol: 'claude_model_config_input_v1',
    files: fixed.files.map(({ target, byteLength, sha256 }) => ({ target, byteLength, sha256 })),
  }) + '\n', 'ascii');
  if (header.length > 2048) throw new TypeError('Claude model config header too large');
  return Buffer.concat([header, ...fixed.files.map(file => file.bytes)]);
}

export const CLAUDE_MODEL_CONFIG_READER_PYTHON = String.raw`
import fcntl
import hashlib
import json
import os
import re
import select
import time

_CONFIG_TARGETS = ('/opt/srt.json', '/opt/mcp.json', '/opt/mcp-fifo.py')
_CONFIG_KEYS = {'target', 'byteLength', 'sha256'}

def _config_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate config key')
        result[key] = value
    return result

def _config_read_some(count, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('config deadline')
    if not select.select([0], [], [], remaining)[0]:
        raise TimeoutError('config deadline')
    data = os.read(0, count)
    if not data:
        raise EOFError('truncated config input')
    return data

def _config_read_exact(count, deadline):
    chunks = []
    remaining = count
    while remaining:
        part = _config_read_some(min(remaining, 8192), deadline)
        chunks.append(part)
        remaining -= len(part)
    return b''.join(chunks)

def read_sealed_config(expected_files, deadline):
    if type(deadline) not in (float, int):
        raise ValueError('invalid config deadline')
    if type(expected_files) not in (list, tuple) or len(expected_files) != 3:
        raise ValueError('invalid expected config files')
    trusted = []
    total = 0
    for index, item in enumerate(expected_files):
        if type(item) is not dict or set(item) != _CONFIG_KEYS:
            raise ValueError('invalid expected config metadata')
        target, size, digest = item['target'], item['byteLength'], item['sha256']
        if target != _CONFIG_TARGETS[index] or type(size) is not int or not (1 <= size <= 65536):
            raise ValueError('invalid expected config size or target')
        if type(digest) is not str or not re.fullmatch('[0-9a-f]{64}', digest):
            raise ValueError('invalid expected config digest')
        total += size
        trusted.append({'target': target, 'byteLength': size, 'sha256': digest})
    if total > 131072:
        raise ValueError('config input too large')
    owned = []
    try:
        header = bytearray()
        while True:
            if len(header) >= 2048:
                raise ValueError('config header too large')
            character = _config_read_some(1, deadline)
            if character == b'\n':
                break
            header.extend(character)
        decoded = json.loads(header.decode('ascii'), object_pairs_hook=_config_object)
        if type(decoded) is not dict or set(decoded) != {'protocol', 'files'} or \
                decoded['protocol'] != 'claude_model_config_input_v1' or \
                type(decoded['files']) is not list or len(decoded['files']) != 3:
            raise ValueError('invalid config header')
        for index, item in enumerate(decoded['files']):
            if type(item) is not dict or set(item) != _CONFIG_KEYS or \
                    type(item['target']) is not str or \
                    type(item['byteLength']) is not int or \
                    type(item['sha256']) is not str or \
                    not re.fullmatch('[0-9a-f]{64}', item['sha256']) or \
                    item != trusted[index]:
                raise ValueError('config metadata mismatch')
        result = []
        for item in trusted:
            body = _config_read_exact(item['byteLength'], deadline)
            if hashlib.sha256(body).hexdigest() != item['sha256']:
                raise ValueError('config body digest mismatch')
            raw = os.memfd_create('rcac-config', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
            owned.append(raw)
            offset = 0
            while offset < len(body):
                written = os.write(raw, body[offset:])
                if written <= 0:
                    raise OSError('config memfd write failed')
                offset += written
            os.lseek(raw, 0, os.SEEK_SET)
            fcntl.fcntl(raw, fcntl.F_ADD_SEALS,
                        fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK |
                        fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE)
            high = fcntl.fcntl(raw, fcntl.F_DUPFD_CLOEXEC, 32)
            owned.append(high)
            os.close(raw)
            owned.remove(raw)
            result.append(high)
        return tuple(result)
    except BaseException:
        for fd in reversed(owned):
            try:
                os.close(fd)
            except OSError:
                pass
        raise
`;

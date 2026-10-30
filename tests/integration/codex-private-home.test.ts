import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateLoginSpec } from '../../src/adapters/codex/investigator/private-home.js';

const scriptPath = fileURLToPath(new URL('../../tools/prepare-wsl-private-home.sh', import.meta.url));

test('private login spec uses only an exact WSL argv and sanitized environment', () => {
  const spec = privateLoginSpec({ distro: 'Ubuntu-22.04', loginId: '00000000-0000-4000-8000-000000000001',
    linuxHome: '/home/fixture', linuxNode: '/home/fixture/.hermes/node/bin/node',
    codexEntry: '/home/fixture/.local/repoconduit-codex-0.157.1/package/bin/codex.js' });
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(spec.args, ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd',
    '/home/fixture/.local/repoconduit-private-homes/00000000-0000-4000-8000-000000000001/workspace',
    '--exec', '/usr/bin/env', '-i',
    'HOME=/home/fixture/.local/repoconduit-private-homes/00000000-0000-4000-8000-000000000001/home',
    'CODEX_HOME=/home/fixture/.local/repoconduit-private-homes/00000000-0000-4000-8000-000000000001/home/.codex',
    'PATH=/home/fixture/.hermes/node/bin:/usr/bin:/bin', '/home/fixture/.hermes/node/bin/node',
    '/home/fixture/.local/repoconduit-codex-0.157.1/package/bin/codex.js', 'login']);
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
  for (const input of [
    { linuxHome: '/mnt/c/Users/owner' }, { linuxNode: '/mnt/c/node' },
    { codexEntry: '/home/fixture/../owner/codex.js' }, { distro: 'Ubuntu; echo secret' },
    { loginId: '../other' },
  ]) assert.throws(() => privateLoginSpec({ distro: 'Ubuntu-22.04', loginId: randomUUID(),
    linuxHome: '/home/fixture', linuxNode: '/home/fixture/.hermes/node/bin/node',
    codexEntry: '/home/fixture/.local/repoconduit-codex-0.157.1/package/bin/codex.js', ...input }), /INVALID_ARGUMENT/);
});

const available = spawnSync('C:\\Windows\\System32\\wsl.exe',
  ['-d', 'Ubuntu-22.04', '--exec', '/usr/bin/id', '-un'], { encoding: 'utf8', timeout: 30_000 }).status === 0;

test('WSL helper creates only private 0700 directories and a 0600 config, then refuses reuse',
  { skip: !available && 'Ubuntu-22.04 WSL is unavailable' }, () => {
    const loginId = randomUUID();
    const script = readFileSync(scriptPath, 'utf8');
    const args = ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-s', '--', loginId,
      '/home/fixture/.local/repoconduit-codex-0.157.1'];
    const run = () => spawnSync('C:\\Windows\\System32\\wsl.exe', args,
      { input: script, encoding: 'utf8', timeout: 15_000 });
    const root = `/home/fixture/.local/repoconduit-private-homes/${loginId}`;
    try {
      const created = run();
      assert.equal(created.status, 0, created.stderr);
      const checked = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
          root="$HOME/.local/repoconduit-private-homes/$1"
          test "$root" = "$2"
          for dir in "$root" "$root/home" "$root/home/.codex" "$root/workspace"; do
            test "$(stat -c %a -- "$dir")" = 700 || exit 4
            test "$(stat -c %u -- "$dir")" = "$(id -u)" || exit 5
          done
          test "$(stat -c %a -- "$root/home/.codex/config.toml")" = 600
          test "$(stat -c %u -- "$root/home/.codex/config.toml")" = "$(id -u)"
          test "$(find "$root" -type f | wc -l)" = 1
          test "$(find "$root" -type l | wc -l)" = 0
          grep -Fqx 'default_permissions = "investigator"' "$root/home/.codex/config.toml"
          grep -Fqx 'enabled = false' "$root/home/.codex/config.toml"
        `, 'audit', loginId, root], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(checked.status, 0, checked.stderr);
      const cwdProbe = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--user', 'fixture', '--cd', `${root}/workspace`, '--exec', '/usr/bin/pwd'],
        { encoding: 'utf8', timeout: 10_000 });
      assert.equal(cwdProbe.status, 0, cwdProbe.stderr);
      assert.equal(cwdProbe.stdout.trim(), `${root}/workspace`);
      const spec = privateLoginSpec({ distro: 'Ubuntu-22.04', loginId, linuxHome: '/home/fixture',
        linuxNode: '/home/fixture/.hermes/node/bin/node',
        codexEntry: '/home/fixture/.local/repoconduit-codex-0.157.1/package/bin/codex.js' });
      const loginHelp = spawnSync(spec.executable, [...spec.args, '--help'],
        { env: spec.env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(loginHelp.status, 0, loginHelp.stderr);
      assert.match(loginHelp.stdout, /Usage: codex login/);
      assert.notEqual(run().status, 0);
    } finally {
      const cleaned = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
          uid=$(id -u)
          for dir in / /home "$HOME" "$HOME/.local" "$HOME/.local/repoconduit-private-homes"; do
            test -d "$dir" && test ! -L "$dir" && test "$(realpath -e -- "$dir")" = "$dir" || exit 3
            mode=$(stat -c %a -- "$dir")
            (( (8#$mode & 0022) == 0 )) || exit 3
          done
          test "$(stat -c %u -- /home)" = 0 || exit 3
          for dir in "$HOME" "$HOME/.local" "$HOME/.local/repoconduit-private-homes"; do
            test "$(stat -c %u -- "$dir")" = "$uid" || exit 3
          done
          root="$HOME/.local/repoconduit-private-homes/$1"
          test "$root" = "$2" && test -d "$root" && test ! -L "$root" || exit 3
          test "$(realpath -e -- "$root")" = "$root" || exit 3
          test "$(stat -c %u -- "$root")" = "$uid" && test "$(stat -c %a -- "$root")" = 700 || exit 3
          rm -r -- "$root"
        `, 'cleanup', loginId, root], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(cleaned.status, 0, cleaned.stderr);
    }
  });

test('WSL helper refuses a preexisting symlink without writing through it',
  { skip: !available && 'Ubuntu-22.04 WSL is unavailable' }, () => {
    const loginId = randomUUID();
    const script = readFileSync(scriptPath, 'utf8');
    const prepared = spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
        base="$HOME/.local/repoconduit-private-homes"
        test -d "$base" && test ! -L "$base" || exit 3
        ln -s /etc -- "$base/$1"
      `, 'setup', loginId], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(prepared.status, 0, prepared.stderr);
    try {
      const rejected = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-s', '--', loginId,
          '/home/fixture/.local/repoconduit-codex-0.157.1'],
        { input: script, encoding: 'utf8', timeout: 10_000 });
      assert.notEqual(rejected.status, 0);
      const checked = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
          test "$(readlink -- "$HOME/.local/repoconduit-private-homes/$1")" = /etc
        `, 'check', loginId], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(checked.status, 0, checked.stderr);
    } finally {
      const cleaned = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
          link="$HOME/.local/repoconduit-private-homes/$1"
          test -L "$link" && test "$(readlink -- "$link")" = /etc || exit 3
          unlink -- "$link"
        `, 'cleanup', loginId], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(cleaned.status, 0, cleaned.stderr);
    }
  });

test('WSL parent audit rejects writable and wrong-owner ancestors',
  { skip: !available && 'Ubuntu-22.04 WSL is unavailable' }, () => {
    const id = randomUUID();
    const safe = `/home/fixture/.local/rcac-audit-${id}-safe`;
    const unsafe = `/home/fixture/.local/rcac-audit-${id}-unsafe`;
    const script = readFileSync(scriptPath, 'utf8');
    const setup = spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
        mkdir -m 700 -- "$1" "$2"
        chmod 777 -- "$2"
      `, 'setup', safe, unsafe], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(setup.status, 0, setup.stderr);
    const audit = (path: string, uid: number) => spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-s', '--', '--audit-parent', path, String(uid)],
      { input: script, encoding: 'utf8', timeout: 10_000 });
    try {
      assert.equal(audit(safe, 1000).status, 0);
      assert.notEqual(audit(unsafe, 1000).status, 0);
      assert.notEqual(audit(safe, 999).status, 0);
    } finally {
      const cleaned = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-c', `
          for dir in "$1" "$2"; do
            test ! -L "$dir" && test -d "$dir" && test "$(stat -c %u -- "$dir")" = "$(id -u)" || exit 3
            rmdir -- "$dir"
          done
        `, 'cleanup', safe, unsafe], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(cleaned.status, 0, cleaned.stderr);
    }
  });

test('WSL entry audit refuses group- or other-writable installed code',
  { skip: !available && 'Ubuntu-22.04 WSL is unavailable' }, () => {
    const script = readFileSync(scriptPath, 'utf8');
    const created = spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--exec', '/usr/bin/mktemp',
        '/home/fixture/.local/repoconduit-private-homes/entry-audit-XXXXXXXX'],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(created.status, 0, created.stderr);
    const entry = created.stdout.trim();
    assert.match(entry, /^\/home\/fixture\/\.local\/repoconduit-private-homes\/entry-audit-[A-Za-z0-9]{8}$/);
    const audit = () => spawnSync('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu-22.04', '--exec', '/bin/bash', '-s', '--', '--audit-entry', entry, '1000'],
      { input: script, encoding: 'utf8', timeout: 10_000 });
    try {
      assert.equal(audit().status, 0);
      const changed = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/usr/bin/chmod', '0666', '--', entry],
        { encoding: 'utf8', timeout: 10_000 });
      assert.equal(changed.status, 0, changed.stderr);
      assert.notEqual(audit().status, 0);
    } finally {
      const removed = spawnSync('C:\\Windows\\System32\\wsl.exe',
        ['-d', 'Ubuntu-22.04', '--exec', '/usr/bin/rm', '--', entry],
        { encoding: 'utf8', timeout: 10_000 });
      assert.equal(removed.status, 0, removed.stderr);
    }
  });

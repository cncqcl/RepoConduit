import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ClaudeModelOuterProbeInput, ClaudeModelOuterRawProbe } from '../../src/adapters/secondary-investigator/claude-model-outer-probe.js';
import { validateClaudeModelOuterMounts } from '../../src/adapters/secondary-investigator/claude-model-outer-mounts.js';

const stem = 'tests/fixtures/legacy-runtime/outer-observer';
const meta = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
const raw = JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8')) as ClaudeModelOuterRawProbe;
const input = { running: meta.running, startup: meta.startup,
  descriptor: meta.descriptor, paths: meta.paths, profile: meta.profile } as ClaudeModelOuterProbeInput;
const copy = <T>(value: T): T => structuredClone(value);

test('deidentified outer mount fixture matches the trusted recipe', () => {
  assert.equal(validateClaudeModelOuterMounts(input, raw, {maxWallSeconds:20}), true);
});

test('accepts a host without one optional system nested mount', () => {
  const probe = copy(raw);
  const drop = (text: string, target: string) => text.split('\n').filter(line =>
    !line.includes(` ${target} `)).join('\n');
  probe.hostMountinfoRaw = drop(probe.hostMountinfoRaw, '/usr/lib/wsl/lib');
  probe.hostMountinfoRawAfter = drop(probe.hostMountinfoRawAfter, '/usr/lib/wsl/lib');
  for (const process of [probe.processes.outer, probe.processes.bootstrap]) {
    process.mountinfoRaw = drop(drop(process.mountinfoRaw!, '/usr/lib/wsl/lib'), '/lib/wsl/lib');
    process.mountinfoRawAfter = drop(drop(process.mountinfoRawAfter!, '/usr/lib/wsl/lib'), '/lib/wsl/lib');
  }
  probe.backingPaths = probe.backingPaths.filter(pair =>
    pair.target !== '/usr/lib/wsl/lib' && pair.target !== '/lib/wsl/lib');
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), true);
});

test('rejects writable relay aliased to private auth despite consistent copied metadata', () => {
  const probe = copy(raw);
  const auth = probe.backingPaths.find(pair => pair.target === '/home/claude')!;
  const relay = probe.backingPaths.find(pair => pair.target === '/relay')!;
  const oldRoot = relay.realpath;
  relay.realpath = auth.realpath;
  relay.host = copy(auth.host);
  relay.sandbox = copy(auth.sandbox);
  for (const process of [probe.processes.outer, probe.processes.bootstrap]) {
    process.mountinfoRaw = process.mountinfoRaw!.replace(` ${oldRoot} /relay `, ` ${auth.realpath} /relay `);
    process.mountinfoRawAfter = process.mountinfoRawAfter!.replace(` ${oldRoot} /relay `, ` ${auth.realpath} /relay `);
  }
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

test('rejects consistent work stat claiming a device other than the work mount', () => {
  const probe = copy(raw);
  probe.sandboxPaths.work.dev = 123456;
  probe.sandboxPaths.outer.cwd.dev = 123456;
  probe.sandboxPaths.bootstrap.cwd.dev = 123456;
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

test('rejects root stat claiming a device other than the private root mount', () => {
  const probe = copy(raw);
  probe.sandboxPaths.outer.root.dev = 123456;
  probe.sandboxPaths.bootstrap.root.dev = 123456;
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

test('rejects relay sharing the auth backing object despite different source paths', () => {
  const probe = copy(raw);
  const auth = probe.backingPaths.find(pair => pair.target === '/home/claude')!;
  const relay = probe.backingPaths.find(pair => pair.target === '/relay')!;
  relay.host.ino = auth.host.ino;
  relay.sandbox.ino = auth.sandbox.ino;
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

test('rejects relay host submount rooted inside readonly auth despite distinct inode', () => {
  const probe = copy(raw);
  const auth = probe.backingPaths.find(pair => pair.target === '/home/claude')!;
  const relay = probe.backingPaths.find(pair => pair.target === '/relay')!;
  const aliasedRoot = `${auth.realpath}/.claude`;
  const hostLine = `999 82 8:48 ${aliasedRoot} ${relay.source} rw,relatime - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered\n`;
  probe.hostMountinfoRaw += hostLine;
  probe.hostMountinfoRawAfter += hostLine;
  for (const process of [probe.processes.outer, probe.processes.bootstrap]) {
    process.mountinfoRaw = process.mountinfoRaw!.replace(` ${relay.realpath} /relay `,
      ` ${aliasedRoot} /relay `);
    process.mountinfoRawAfter = process.mountinfoRawAfter!.replace(` ${relay.realpath} /relay `,
      ` ${aliasedRoot} /relay `);
  }
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

test('rejects readonly fixed mounts that also claim rw', () => {
  const probe = copy(raw);
  for (const process of [probe.processes.outer, probe.processes.bootstrap]) {
    process.mountinfoRaw = process.mountinfoRaw!.replace(/( \/opt\/(?:srt\.json|mcp\.json|mcp-fifo\.py|rcac-bootstrap\.py) ro),/g, '$1,rw,');
    process.mountinfoRawAfter = process.mountinfoRawAfter!.replace(/( \/opt\/(?:srt\.json|mcp\.json|mcp-fifo\.py|rcac-bootstrap\.py) ro),/g, '$1,rw,');
  }
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

test('rejects a device character mount that claims both rw and ro', () => {
  const probe = copy(raw);
  for (const process of [probe.processes.outer, probe.processes.bootstrap]) {
    process.mountinfoRaw = process.mountinfoRaw!.replace(' /dev/null rw,', ' /dev/null rw,ro,');
    process.mountinfoRawAfter = process.mountinfoRawAfter!.replace(' /dev/null rw,', ' /dev/null rw,ro,');
  }
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

for (const mode of [0o104600, 0o102600, 0o101600])
  test(`rejects fixed file special mode ${mode.toString(8)}`, () => {
    const probe = copy(raw);
    probe.mountedFixedFiles[0]!.stat.mode = mode;
    assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
  });

test('rejects a regular file as a backing directory', () => {
  const probe = copy(raw);
  const relay = probe.backingPaths.find(pair => pair.target === '/relay')!;
  relay.host.mode = 0o100700;
  relay.sandbox.mode = 0o100700;
  assert.equal(validateClaudeModelOuterMounts(input, probe, {maxWallSeconds:20}), false);
});

for (const [name, mutate] of [
  ['writable system bind', (probe: ClaudeModelOuterRawProbe) => { probe.processes.outer.mountinfoRaw = probe.processes.outer.mountinfoRaw!.replace('/usr /usr ro,', '/usr /usr rw,'); }],
  ['extra mount', (probe: ClaudeModelOuterRawProbe) => { probe.processes.outer.mountinfoRaw += '999 663 0:89 / /unexpected rw - tmpfs tmpfs rw\n'; }],
  ['hidden mount', (probe: ClaudeModelOuterRawProbe) => { probe.processes.outer.mountinfoRaw = probe.processes.outer.mountinfoRaw!.replace('665 664', '665 999'); }],
  ['wrong source', (probe: ClaudeModelOuterRawProbe) => { probe.backingPaths[0]!.realpath = '/wrong'; }],
  ['wrong stat', (probe: ClaudeModelOuterRawProbe) => { probe.backingPaths[0]!.sandbox.ino++; }],
  ['wrong device', (probe: ClaudeModelOuterRawProbe) => { probe.backingPaths[0]!.sandbox.dev++; }],
  ['wrong fixed hash', (probe: ClaudeModelOuterRawProbe) => { probe.mountedFixedFiles[0]!.sha256 = '0'.repeat(64); }],
  ['fixed file mode', (probe: ClaudeModelOuterRawProbe) => { probe.mountedFixedFiles[0]!.stat.mode = 0o100644; }],
  ['device propagation', (probe: ClaudeModelOuterRawProbe) => { probe.processes.outer.mountinfoRaw = probe.processes.outer.mountinfoRaw!.replace('master:14', 'shared:14'); }],
  ['shared temporary filesystem', (probe: ClaudeModelOuterRawProbe) => { probe.processes.outer.mountinfoRaw = probe.processes.outer.mountinfoRaw!.replace('684 663 0:93', '684 663 0:94'); }],
  ['dangerous filesystem', (probe: ClaudeModelOuterRawProbe) => { probe.processes.outer.mountinfoRaw = probe.processes.outer.mountinfoRaw!.replace(' - ext4 /dev/sdd ', ' - proc proc '); }],
  ['host mount change', (probe: ClaudeModelOuterRawProbe) => { probe.hostMountinfoRawAfter = probe.hostMountinfoRawAfter.replace(' /usr/lib/wsl/lib ', ' /usr/lib/wsl/other '); }],
] as const) test(`rejects ${name}`, () => {
  const candidate = copy(raw);
  mutate(candidate);
  assert.equal(validateClaudeModelOuterMounts(input, candidate, {maxWallSeconds:20}), false);
});

import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { buildClaudeModelSealedLaunch } from './claude-model-sealed-launch.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON } from './claude-model-bootstrap.js';
import { historicalClaudeModelRecipe, HISTORICAL_BOOTSTRAP_BYTE_LENGTH,
  HISTORICAL_BOOTSTRAP_SHA256 } from './claude-model-historical.js';
import type { ClaudeModelLaunchLimits } from './claude-model-supervisor.js';
import { parseLinuxMountinfo, type LinuxMountEntry } from './linux-mountinfo.js';
import { projectLinuxBindMounts } from './linux-bind-mount-projection.js';
import type { ClaudeModelOuterProbeInput, ClaudeModelOuterRawProbe } from './claude-model-outer-probe.js';
import { createHash } from 'node:crypto';

const chars = ['null', 'zero', 'full', 'random', 'urandom', 'tty'] as const;
const fixedTargets = ['/opt/srt.json', '/opt/mcp.json', '/opt/mcp-fifo.py', '/opt/rcac-bootstrap.py'];
const systemTargets = new Set(['/usr', '/bin', '/lib', '/lib64']);
const has = (entry: LinuxMountEntry, ...flags: string[]) => flags.every(flag => entry.mountOptions.includes(flag));
const no = (entry: LinuxMountEntry, ...flags: string[]) => flags.every(flag => !entry.mountOptions.includes(flag));
const safe = (value: number) => Number.isSafeInteger(value) && value >= 0;
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const covers = (parent: string, child: string) => parent === '/' || child === parent || child.startsWith(`${parent}/`);

function device(dev: number): [number, number] {
  if (!safe(dev)) throw new Error('invalid device');
  const value = BigInt(dev);
  const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn);
  const minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
  if (major > BigInt(Number.MAX_SAFE_INTEGER) || minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('invalid device');
  return [Number(major), Number(minor)];
}

function checkedTable(raw: string): readonly LinuxMountEntry[] {
  const entries = parseLinuxMountinfo(raw);
  const byId = new Map(entries.map(entry => [entry.mountId, entry]));
  if (byId.size !== entries.length || new Set(entries.map(entry => entry.mountPoint)).size !== entries.length)
    throw new Error('stacked mount');
  const root = entries.find(entry => entry.mountPoint === '/');
  if (!root) throw new Error('missing root');
  for (const entry of entries) {
    if (entry.mountId === root.mountId) continue;
    const parent = byId.get(entry.parentId);
    if (!parent || !covers(parent.mountPoint, entry.mountPoint) || parent.mountPoint === entry.mountPoint)
      throw new Error('disconnected mount');
    const nearest = entries.filter(other => other.mountId !== entry.mountId &&
      covers(other.mountPoint, entry.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
    if (nearest?.mountId !== parent.mountId) throw new Error('non-nearest mount parent');
    const visited = new Set<number>([entry.mountId]);
    let current = parent;
    while (current.mountId !== root.mountId) {
      if (visited.has(current.mountId)) throw new Error('mount cycle');
      visited.add(current.mountId);
      current = byId.get(current.parentId)!;
      if (!current) throw new Error('disconnected mount');
    }
  }
  return entries;
}

function direct(entry: LinuxMountEntry, root: string, fs: string, source: string,
  flags: string[], forbidden: string[] = [], optional: string[] = []): void {
  if (entry.root !== root || entry.filesystemType !== fs || entry.mountSource !== source ||
    !has(entry, ...flags) || !no(entry, ...forbidden) || !same(entry.optionalFields, optional))
    throw new Error('mount mismatch');
}

function validate(input: ClaudeModelOuterProbeInput, probe: ClaudeModelOuterRawProbe,
  limits: ClaudeModelLaunchLimits | {maxWallSeconds:number}): void {
  const historical = !Object.hasOwn(limits, 'maxTurns');
  const sealed = historical ? historicalClaudeModelRecipe(input.paths, input.profile) :
    buildClaudeModelSealedLaunch(input.paths, input.profile, (limits as ClaudeModelLaunchLimits).maxTurns);
  if (sealed.commandDigest !== input.descriptor.commandDigest) throw new Error('recipe changed');
  const manifest = [...sealed.recipe.configFiles, {
    target: '/opt/rcac-bootstrap.py', byteLength: historical ? HISTORICAL_BOOTSTRAP_BYTE_LENGTH :
      Buffer.byteLength(CLAUDE_MODEL_BOOTSTRAP_PYTHON),
    sha256: historical ? HISTORICAL_BOOTSTRAP_SHA256 :
      createHash('sha256').update(CLAUDE_MODEL_BOOTSTRAP_PYTHON).digest('hex'),
  }];
  if (!same(manifest.map(file => file.target), fixedTargets)) throw new Error('manifest');
  const host = parseLinuxMountinfo(probe.hostMountinfoRaw);
  const hostAfter = parseLinuxMountinfo(probe.hostMountinfoRawAfter);
  const outer = checkedTable(probe.processes.outer.mountinfoRaw!);
  if (!same(outer, checkedTable(probe.processes.outer.mountinfoRawAfter!)) ||
    !same(outer, checkedTable(probe.processes.bootstrap.mountinfoRaw!)) ||
    !same(outer, checkedTable(probe.processes.bootstrap.mountinfoRawAfter!))) throw new Error('sandbox mount changed');
  if (outer.some(entry => entry.mountOptions.includes('ro') === entry.mountOptions.includes('rw')))
    throw new Error('mount access flags');
  const map = new Map(outer.map(entry => [entry.mountPoint, entry]));
  const base = ['/', '/proc', '/dev', ...chars.map(name => `/dev/${name}`), '/dev/pts', '/tmp', '/work'];
  const sources = [
    ['/usr', '/usr'], ['/bin', '/bin'], ['/lib', '/lib'], ['/lib64', '/lib64'],
    ['/usr/bin/which.debianutils', '/etc/alternatives/which'],
    [`${input.paths.installRoot}/node_modules`, '/runtime/node_modules'],
    [`${input.paths.installRoot}/deps`, '/runtime/deps'], [input.paths.nodeRoot, '/node'],
    [input.paths.privateAuthHome, '/home/claude'], [input.paths.privateFifoDirectory, '/relay'],
  ] as const;
  const backed = probe.backingPaths;
  if (!Array.isArray(backed) || backed.length < sources.length) throw new Error('backing count');
  const pairs = new Map(backed.map(item => [item.target, item]));
  if (pairs.size !== backed.length) throw new Error('duplicate backing');
  const relay = pairs.get('/relay');
  if (!relay) throw new Error('missing relay');
  const expected = new Map<string, { source: string; root: string; major: number; minor: number;
    filesystemType: string; mountSource: string; nested: boolean; relay: boolean }>();
  for (const [source, target] of sources) {
    const pair = pairs.get(target);
    if (!pair || pair.source !== source || !posix.isAbsolute(pair.realpath) ||
      posix.normalize(pair.realpath) !== pair.realpath || !safe(pair.host.dev) ||
      !safe(pair.host.ino) || !safe(pair.host.mode) || !same(pair.host, pair.sandbox))
      throw new Error('backing identity');
    if ((pair.host.mode & 0o170000) !==
      (target === '/etc/alternatives/which' ? 0o100000 : 0o040000))
      throw new Error('backing object type');
    // These private and runtime paths are canonical inputs. Only the four system
    // binds and the fixed `which` file may resolve through host symlinks.
    if (!systemTargets.has(target) && target !== '/etc/alternatives/which' &&
      pair.realpath !== source) throw new Error('private backing alias');
    if (target !== '/relay' &&
      (covers(pair.realpath, relay.realpath) || covers(relay.realpath, pair.realpath) ||
        (pair.host.dev === relay.host.dev && pair.host.ino === relay.host.ino)))
      throw new Error('writable relay aliases another bind');
    const before = projectLinuxBindMounts(host, pair.realpath, target);
    const after = projectLinuxBindMounts(hostAfter, pair.realpath, target);
    if (!same(before, after) || (!systemTargets.has(target) && before.length !== 1))
      throw new Error('host projection changed');
    for (const item of before) {
      if (expected.has(item.target)) throw new Error('overlapping projection');
      expected.set(item.target, { ...item, nested: item.target !== target, relay: target === '/relay' });
    }
    if (systemTargets.has(target)) {
      for (const item of before.slice(1)) {
        const nested = pairs.get(item.target);
        if (!nested || nested.source !== item.source || nested.realpath !== item.source ||
          !same(nested.host, nested.sandbox) || !safe(nested.host.dev) ||
          !safe(nested.host.ino) || !safe(nested.host.mode) ||
          (nested.host.mode & 0o170000) !== 0o040000) throw new Error('nested backing');
      }
    }
  }
  const writable = expected.get('/relay');
  if (!writable || [...expected.values()].some(item => !item.relay &&
    item.major === writable.major && item.minor === writable.minor &&
    (covers(item.root, writable.root) || covers(writable.root, item.root))))
    throw new Error('writable relay overlaps readonly source');
  if (pairs.size !== expected.size) throw new Error('backing set');
  if (outer.length !== base.length + expected.size + fixedTargets.length) throw new Error('mount count');
  if (outer.some(entry => ![...base, ...expected.keys(), ...fixedTargets].includes(entry.mountPoint)))
    throw new Error('unexpected mount');
  const root = map.get('/')!;
  direct(root, '/newroot', 'tmpfs', 'tmpfs', ['rw', 'nosuid', 'nodev'], ['ro']);
  if (root.parentId === root.mountId || root.optionalFields.length !== 0) throw new Error('root propagation');
  direct(map.get('/proc')!, '/', 'proc', 'proc', ['rw', 'nosuid', 'nodev', 'noexec'], ['ro']);
  direct(map.get('/dev')!, '/', 'tmpfs', 'tmpfs', ['rw', 'nosuid', 'nodev'], ['ro']);
  direct(map.get('/dev/pts')!, '/', 'devpts', 'devpts', ['rw', 'nosuid', 'noexec'], ['ro']);
  for (const target of ['/tmp', '/work'])
    direct(map.get(target)!, '/', 'tmpfs', 'tmpfs', ['rw', 'nosuid', 'nodev'], ['ro']);
  const fresh = ['/','/proc','/dev','/dev/pts','/tmp','/work'].map(target => map.get(target)!);
  if (new Set(fresh.map(entry => `${entry.major}:${entry.minor}`)).size !== fresh.length)
    throw new Error('shared fresh device');
  for (const process of [probe.sandboxPaths.outer, probe.sandboxPaths.bootstrap]) {
    if (!same(device(process.root.dev), [root.major, root.minor]) ||
      !same(device(process.cwd.dev), [map.get('/work')!.major, map.get('/work')!.minor]))
      throw new Error('sandbox path device');
  }
  if (!same(device(probe.sandboxPaths.work.dev),
    [map.get('/work')!.major, map.get('/work')!.minor])) throw new Error('work device');
  const hostDev = projectLinuxBindMounts(host, '/dev', '/dev')[0];
  const hostDevAfter = projectLinuxBindMounts(hostAfter, '/dev', '/dev')[0];
  if (!hostDev || !same(hostDev, hostDevAfter)) throw new Error('host dev changed');
  const hostChar = chars.map(name => {
    const before = projectLinuxBindMounts(host, `/dev/${name}`, `/dev/${name}`);
    const after = projectLinuxBindMounts(hostAfter, `/dev/${name}`, `/dev/${name}`);
    if (!same(before, after) || before.length !== 1) throw new Error('host char changed');
    return before[0]!;
  });
  const hostDevices = new Set([...expected.values()].map(item => `${item.major}:${item.minor}`));
  hostDevices.add(`${hostDev.major}:${hostDev.minor}`);
  for (const item of fresh) {
    if (hostDevices.has(`${item.major}:${item.minor}`)) throw new Error('fresh host device');
  }
  for (const [index, name] of chars.entries()) {
    const item = map.get(`/dev/${name}`)!;
    const projected = hostChar[index]!;
    const hostMount = host.find(entry => entry.mountPoint === '/dev');
    const shared = hostMount?.optionalFields.find(field => /^shared:[1-9][0-9]*$/.test(field));
    if (!shared || projected.root !== posix.join(hostDev.root, name) ||
      projected.major !== hostDev.major || projected.minor !== hostDev.minor ||
      projected.filesystemType !== hostDev.filesystemType ||
      projected.mountSource !== hostDev.mountSource || item.root !== projected.root ||
      item.major !== projected.major ||
      item.minor !== projected.minor || item.filesystemType !== projected.filesystemType ||
      item.mountSource !== projected.mountSource || !has(item, 'rw', 'nosuid') ||
      !same(item.optionalFields, [`master:${shared.slice(7)}`])) throw new Error('device bind');
  }
  for (const [target, projection] of expected) {
    const item = map.get(target);
    if (!item || item.root !== projection.root || item.major !== projection.major ||
      item.minor !== projection.minor || item.filesystemType !== projection.filesystemType ||
      item.mountSource !== projection.mountSource || item.optionalFields.length !== 0 ||
      !has(item, projection.relay ? 'rw' : 'ro', 'nosuid', 'nodev') ||
      !no(item, projection.relay ? 'ro' : 'rw')) throw new Error('projected bind');
    if ((projection.nested || systemTargets.has(target)) &&
      !['ext4', 'overlay', '9p'].includes(item.filesystemType))
      throw new Error('system filesystem');
    const pair = pairs.get(target)!;
    const [major, minor] = device(pair.host.dev);
    if (major !== item.major || minor !== item.minor) throw new Error('backing device');
  }
  if (!Array.isArray(probe.mountedFixedFiles) || probe.mountedFixedFiles.length !== 4 ||
    new Set(probe.mountedFixedFiles.map(file => file.target)).size !== 4) throw new Error('fixed files');
  const inodes = new Set<number>();
  for (const [index, wanted] of manifest.entries()) {
    const observed = probe.mountedFixedFiles[index];
    const mount = map.get(wanted.target);
    if (!observed || !mount || observed.target !== wanted.target ||
      observed.byteLength !== wanted.byteLength || observed.sha256 !== wanted.sha256 ||
      observed.stat.size !== wanted.byteLength || observed.stat.uid !== input.descriptor.uid ||
      observed.stat.gid !== input.descriptor.uid || observed.stat.nlink !== 0 ||
      observed.stat.mode !== 0o100600 || !safe(observed.stat.ino) ||
      inodes.has(observed.stat.ino) || observed.stat.dev !== probe.sandboxPaths.outer.root.dev ||
      !/^\/bindfile[A-Za-z0-9]+\/\/deleted$/.test(mount.root) ||
      mount.major !== root.major || mount.minor !== root.minor ||
      mount.filesystemType !== 'tmpfs' || mount.mountSource !== 'tmpfs' ||
      !has(mount, 'ro', 'nosuid', 'nodev') || mount.optionalFields.length !== 0)
      throw new Error('fixed file bind');
    inodes.add(observed.stat.ino);
    if (!same(device(observed.stat.dev), [mount.major, mount.minor])) throw new Error('fixed device');
  }
}

/** Checks a bounded candidate against the trusted launch recipe; grants no authority. */
export function validateClaudeModelOuterMounts(input: ClaudeModelOuterProbeInput,
  probe: ClaudeModelOuterRawProbe, limits: ClaudeModelLaunchLimits | {maxWallSeconds:number}): boolean {
  try {
    const saved = structuredClone({ input, probe, limits });
    validate(saved.input, saved.probe, saved.limits);
    return true;
  } catch {
    return false;
  }
}

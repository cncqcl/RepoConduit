import { posix } from 'node:path';
import type { LinuxMountEntry } from './linux-mountinfo.js';

export interface LinuxBindMountProjection {
  source: string;
  target: string;
  major: number;
  minor: number;
  root: string;
  filesystemType: string;
  mountSource: string;
}

function canonical(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0') &&
    posix.normalize(path) === path && (path === '/' || !path.endsWith('/'));
}

function covers(parent: string, child: string): boolean {
  return parent === '/' || child === parent || child.startsWith(`${parent}/`);
}

/** Metadata projection only: it does not validate readonly flags, stat identity or confinement. */
export function projectLinuxBindMounts(host: readonly LinuxMountEntry[],
  sourceRealPath: string, target: string): readonly LinuxBindMountProjection[] {
  if (!Array.isArray(host) || host.length < 1 || host.length > 128 ||
    !canonical(sourceRealPath) || !canonical(target)) throw new Error('INVALID_BIND_PROJECTION');
  const ids = new Map(host.map(mount => [mount.mountId, mount]));
  if (ids.size !== host.length) throw new Error('AMBIGUOUS_BIND_SOURCE');
  const relevant = host.filter(mount => covers(mount.mountPoint, sourceRealPath) ||
    covers(sourceRealPath, mount.mountPoint));
  // A path prefix is insufficient: an older child mount may be hidden by an
  // ancestor overmount. Reject that topology rather than guessing visibility.
  for (const mount of relevant) {
    const ancestors = new Set<number>();
    let parent = ids.get(mount.parentId);
    while (parent) {
      if (parent.mountId === parent.parentId && parent.mountPoint === '/') {
        if (parent.mountId !== mount.mountId) ancestors.add(parent.mountId);
        break;
      }
      if (parent.mountId === mount.mountId || ancestors.has(parent.mountId))
        throw new Error('AMBIGUOUS_BIND_SOURCE');
      ancestors.add(parent.mountId);
      parent = ids.get(parent.parentId);
    }
    if (host.some(enclosing => enclosing.mountId !== mount.mountId &&
      covers(enclosing.mountPoint, mount.mountPoint) && !ancestors.has(enclosing.mountId)))
      throw new Error('AMBIGUOUS_BIND_SOURCE');
  }
  const covering = host.filter(mount => canonical(mount.mountPoint) &&
    covers(mount.mountPoint, sourceRealPath)).sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  const base = covering[0];
  if (!base || covering.some((mount, index) => index > 0 && mount.mountPoint === base.mountPoint))
    throw new Error('AMBIGUOUS_BIND_SOURCE');
  const nested = host.filter(mount => mount.mountPoint !== sourceRealPath &&
    covers(sourceRealPath, mount.mountPoint)).sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
  const seen = new Set<string>([sourceRealPath]);
  for (const mount of nested) {
    if (!canonical(mount.mountPoint) || seen.has(mount.mountPoint))
      throw new Error('AMBIGUOUS_BIND_SOURCE');
    seen.add(mount.mountPoint);
  }
  return [base, ...nested].map((mount, index) => {
    if (!canonical(mount.root)) throw new Error('INVALID_BIND_PROJECTION');
    const source = index === 0 ? sourceRealPath : mount.mountPoint;
    const root = index === 0 ? posix.join(mount.root, posix.relative(mount.mountPoint, source)) : mount.root;
    return { source, target: index === 0 ? target : posix.join(target, posix.relative(sourceRealPath, source)),
      major: mount.major, minor: mount.minor, root,
      filesystemType: mount.filesystemType, mountSource: mount.mountSource };
  });
}

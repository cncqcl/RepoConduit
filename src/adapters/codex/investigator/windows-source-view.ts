import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { InvestigationSourcePlan } from '../../../application/investigation-source-plan.js';
import { portablePathKey, validateRelativePath } from '../../repository/path-policy.js';
import { assertPrivateDataDirectory } from '../../../runtime/local-security.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const invalid = (): never => { throw new Error('INVALID_ARGUMENT'); };
const unsafe = (): never => { throw new Error('SOURCE_VIEW_UNSAFE'); };
const markerName = '.rcac-source-view.json';
const markerKey = portablePathKey(markerName);
const maxFiles = 128;
const maxFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 128 * 1024 * 1024;
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

type WindowsAclCheck = 'reparse' | 'acl';
type WindowsAclReason = 'reparse_point' | 'untrusted_owner' | 'untrusted_rule' |
  'inspection_failed' | 'timeout' | 'output_limit' | 'launch_failed' |
  'process_failed' | 'invalid_protocol';
interface WindowsAclDiagnostic {
  component: 'windows_acl';
  check: WindowsAclCheck;
  reason: WindowsAclReason;
}

/** Only fixed protocol fields cross the process boundary into a public error cause. */
export function classifyWindowsAclProbe(result: {
  status: number | null;
  signal: string | null;
  stdout: unknown;
  stderr: unknown;
  errorCode: string | undefined;
}, check: WindowsAclCheck): WindowsAclDiagnostic | null {
  const diagnostic = (nextCheck: WindowsAclCheck, reason: WindowsAclReason): WindowsAclDiagnostic =>
    Object.freeze({ component: 'windows_acl', check: nextCheck, reason });
  if (result.errorCode === 'ETIMEDOUT') return diagnostic(check, 'timeout');
  if (result.errorCode === 'ENOBUFS') return diagnostic(check, 'output_limit');
  if (result.errorCode === 'ENOENT' || result.errorCode === 'EACCES' ||
      result.errorCode === 'ENOTDIR') return diagnostic(check, 'launch_failed');
  if (result.errorCode !== undefined) return diagnostic(check, 'process_failed');
  if (result.signal !== null || result.status === null) return diagnostic(check, 'process_failed');
  if ((!Buffer.isBuffer(result.stdout) && typeof result.stdout !== 'string') ||
      (!Buffer.isBuffer(result.stderr) && typeof result.stderr !== 'string')) {
    return diagnostic(check, 'invalid_protocol');
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
  if (stderr !== '') return diagnostic(check, 'invalid_protocol');
  const fixed = new Map<number, [string, WindowsAclCheck | null, WindowsAclReason | null]>([
    [0, ['RCAC_VIEW_ACL_V1:PASS', null, null]],
    [41, ['RCAC_VIEW_ACL_V1:REPARSE', 'reparse', 'reparse_point']],
    [42, ['RCAC_VIEW_ACL_V1:OWNER', 'acl', 'untrusted_owner']],
    [43, ['RCAC_VIEW_ACL_V1:RULE', 'acl', 'untrusted_rule']],
    [44, ['RCAC_VIEW_ACL_V1:INSPECTION', check, 'inspection_failed']],
  ]);
  const expected = fixed.get(result.status);
  if (!expected || stdout !== expected[0]) return diagnostic(check, 'invalid_protocol');
  return expected[2] === null ? null : diagnostic(expected[1]!, expected[2]);
}

function unsafeAcl(diagnostic: WindowsAclDiagnostic): never {
  throw new Error('SOURCE_VIEW_UNSAFE', { cause: diagnostic });
}

interface Marker {
  binding: InvestigationSourcePlan['binding'];
  sourceConsistency: InvestigationSourcePlan['sourceConsistency'];
  digest: string;
  files: { path: string; sizeBytes: number; sha256: string }[];
}

export interface WindowsFrozenSourceView {
  viewPath: string;
  sourceDigest: string;
  isolationVerified: false;
}

export interface WindowsFrozenSourceDescriptor {
  attemptId: string;
  workspaceId: string;
  workerEpoch: number;
  sourceDigest: string;
}

export interface WindowsFrozenSourceClosed {
  kind: 'closed';
  descriptor: WindowsFrozenSourceDescriptor;
  viewPath: string;
  isolationVerified: false;
}

export type WindowsFrozenSourceClosedObservation = WindowsFrozenSourceClosed;

interface CloseTombstone {
  descriptor: WindowsFrozenSourceDescriptor;
  marker: Marker | null;
}

function validateDescriptor(value: WindowsFrozenSourceDescriptor): WindowsFrozenSourceDescriptor {
  if (!value || Object.keys(value).sort().join(',') !== 'attemptId,sourceDigest,workerEpoch,workspaceId' ||
    !/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.attemptId) ||
    !/^ws_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.workspaceId) ||
    !Number.isSafeInteger(value.workerEpoch) || value.workerEpoch < 1 ||
    !/^[0-9a-f]{64}$/.test(value.sourceDigest)) invalid();
  return { ...value };
}

function matchesDescriptor(marker: Marker, descriptor: WindowsFrozenSourceDescriptor): boolean {
  return marker.binding.attemptId === descriptor.attemptId &&
    marker.binding.workspaceId === descriptor.workspaceId &&
    marker.binding.workerEpoch === descriptor.workerEpoch && marker.digest === descriptor.sourceDigest;
}

function validateStoredMarker(value: unknown, descriptor: WindowsFrozenSourceDescriptor): Marker {
  if (!value || typeof value !== 'object') unsafe();
  const marker = value as Marker;
  if (Object.keys(marker).sort().join(',') !== 'binding,digest,files,sourceConsistency' ||
    !marker.binding || !Array.isArray(marker.files) || marker.files.length < 1 || marker.files.length > maxFiles ||
    !matchesDescriptor(marker, descriptor) ||
    !['verified_git_tree', 'best_effort_capture'].includes(marker.sourceConsistency)) unsafe();
  const keys = new Set<string>();
  let total = 0;
  for (const file of marker.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'path,sha256,sizeBytes' ||
      typeof file.path !== 'string' || typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 || file.sizeBytes > maxFileBytes) unsafe();
    try { validateRelativePath(file.path); } catch { unsafe(); }
    const key = portablePathKey(file.path);
    if (key === markerKey || key.startsWith(`${markerKey}/`) || keys.has(key) ||
      [...keys].some(other => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) unsafe();
    keys.add(key);
    total += file.sizeBytes;
    if (total > maxTotalBytes) unsafe();
  }
  if (sha(JSON.stringify({ binding: marker.binding, sourceConsistency: marker.sourceConsistency,
    files: marker.files })) !== marker.digest) unsafe();
  return marker;
}

function validatePlan(plan: InvestigationSourcePlan): Marker {
  if (!plan || Object.keys(plan).sort().join(',') !== 'binding,digest,files,sourceConsistency,totalBytes' ||
    !plan.binding || Object.keys(plan.binding).sort().join(',') !==
    'attemptId,collaborationId,contextRevisionId,recipient,requestId,snapshotRef,workerEpoch,workingCopyId,workspaceId' ||
    !/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(plan.binding.attemptId) ||
    !Number.isSafeInteger(plan.binding.workerEpoch) || plan.binding.workerEpoch < 1 ||
    Object.values(plan.binding).some(value => value === '' || value === null || value === undefined) ||
    !['verified_git_tree', 'best_effort_capture'].includes(plan.sourceConsistency) ||
    !Array.isArray(plan.files) || plan.files.length < 1 || plan.files.length > maxFiles ||
    !/^[0-9a-f]{64}$/.test(plan.digest)) invalid();
  const keys = new Set<string>();
  const prefixes = new Map<string, string>();
  let total = 0;
  const files: Marker['files'] = [];
  for (const file of plan.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'base64,path,sha256,sizeBytes' ||
      typeof file.path !== 'string' ||
      Buffer.byteLength(file.path) > 4096) invalid();
    try { validateRelativePath(file.path); } catch { invalid(); }
    const key = portablePathKey(file.path);
    if (key === markerKey || key.startsWith(`${markerKey}/`)) invalid();
    if (keys.has(key) || [...keys].some(other => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) invalid();
    keys.add(key);
    const parts = file.path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const folded = portablePathKey(prefix);
      if (prefixes.has(folded) && prefixes.get(folded) !== prefix) invalid();
      prefixes.set(folded, prefix);
    }
    if (typeof file.base64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > maxFileBytes ||
      !/^[0-9a-f]{64}$/.test(file.sha256)) invalid();
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256) invalid();
    total += bytes.length;
    if (total > maxTotalBytes) invalid();
    files.push({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 });
  }
  if (total !== plan.totalBytes ||
    sha(JSON.stringify({ binding: plan.binding, sourceConsistency: plan.sourceConsistency, files })) !== plan.digest) invalid();
  return { binding: { ...plan.binding }, sourceConsistency: plan.sourceConsistency,
    digest: plan.digest, files };
}

/** Native Windows ACL inspection; source bytes never enter a shell command or environment. */
function assertTrustedAcl(paths: readonly string[], checkAcl = true): void {
  const check: WindowsAclCheck = checkAcl ? 'acl' : 'reparse';
  if (!existsSync(powershell)) unsafeAcl(Object.freeze({ component: 'windows_acl', check, reason: 'launch_failed' }));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$verdict = 'PASS'
$exitCode = 0
try {
  $paths = [string[]](ConvertFrom-Json -InputObject $env:RCAC_VIEW_PATHS)
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @($current, 'S-1-5-18')
  foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      $verdict = 'REPARSE'; $exitCode = 41; break
    }
    if ($env:RCAC_VIEW_CHECK_ACL -eq '1') {
      $acl = if ($item.PSIsContainer) { [System.IO.Directory]::GetAccessControl($path) }
        else { [System.IO.File]::GetAccessControl($path) }
      if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {
        $verdict = 'OWNER'; $exitCode = 42; break
      }
      foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $trusted -notcontains $rule.IdentityReference.Value) {
          $verdict = 'RULE'; $exitCode = 43; break
        }
      }
      if ($exitCode -ne 0) { break }
    }
  }
} catch {
  $verdict = 'INSPECTION'; $exitCode = 44
}
[Console]::Out.Write('RCAC_VIEW_ACL_V1:' + $verdict)
exit $exitCode
`;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, RCAC_VIEW_PATHS: JSON.stringify(paths), RCAC_VIEW_CHECK_ACL: checkAcl ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ?
      error.code : undefined;
    const diagnostic = classifyWindowsAclProbe({ status: null, signal: null,
      stdout: '', stderr: '', errorCode: code }, check);
    unsafeAcl(diagnostic!);
  }
  const errorCode = result.error && 'code' in result.error && typeof result.error.code === 'string' ?
    result.error.code : result.error ? 'PROCESS_ERROR' : undefined;
  const diagnostic = classifyWindowsAclProbe({ ...result, errorCode }, check);
  if (diagnostic) unsafeAcl(diagnostic);
}

function assertNoReparseAncestors(path: string): void {
  let current = resolve(path);
  const paths: string[] = [];
  while (true) {
    const st = lstatSync(current);
    if (st.isSymbolicLink()) unsafe();
    paths.push(current);
    const parent = resolve(current, '..');
    if (parent === current || parse(current).root === current) break;
    current = parent;
  }
  assertTrustedAcl(paths, false);
}

function assertPrivateRoot(root: string): string {
  if (process.platform !== 'win32' || typeof root !== 'string' || !isAbsolute(root) ||
      root.includes('\0') || root !== resolve(root) || root.endsWith(sep)) invalid();
  assertNoReparseAncestors(root);
  assertPrivateDataDirectory(root);
  assertTrustedAcl([root]);
  const canonical = realpathSync.native(root);
  if (canonical.toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) unsafe();
  return root;
}

function verifiedFile(path: string, expected: { sizeBytes: number; sha256: string }): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size !== expected.sizeBytes) unsafe();
  const fd = openSync(path, 'r');
  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.nlink !== 1 || held.size !== expected.sizeBytes ||
      held.dev !== entry.dev || held.ino !== entry.ino) unsafe();
    const bytes = readFileSync(fd);
    if (bytes.length !== expected.sizeBytes || sha(bytes) !== expected.sha256) unsafe();
    const after = lstatSync(path);
    if (after.dev !== held.dev || after.ino !== held.ino || after.nlink !== 1 || after.isSymbolicLink()) unsafe();
  } finally { closeSync(fd); }
}

function verifyView(view: string, marker: Marker): void {
  if (!lstatSync(view).isDirectory()) unsafe();
  const expectedFiles = new Set([markerName, ...marker.files.map(file => file.path)]);
  const expectedDirectories = new Set<string>();
  for (const file of marker.files) {
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const allPaths = [view];
  const visit = (relative: string) => {
    const directory = relative ? join(view, ...relative.split('/')) : view;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) unsafe();
      allPaths.push(full);
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(path)) unsafe();
        seenDirectories.add(path);
        visit(path);
      } else {
        if (!expectedFiles.has(path)) unsafe();
        seenFiles.add(path);
      }
    }
  };
  visit('');
  if (seenFiles.size !== expectedFiles.size || seenDirectories.size !== expectedDirectories.size) unsafe();
  assertTrustedAcl(allPaths);
  for (const file of marker.files) verifiedFile(join(view, ...file.path.split('/')), file);
  const markerBytes = Buffer.from(JSON.stringify(marker));
  verifiedFile(join(view, markerName), { sizeBytes: markerBytes.length, sha256: sha(markerBytes) });
}

function writeChecked(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function attemptEntries(root: string, attemptId: string): string[] {
  const prefix = `${attemptId}.`.toLocaleLowerCase('en-US');
  return readdirSync(root).filter(entry => entry.toLocaleLowerCase('en-US').startsWith(prefix));
}

function assertNoOtherAttemptEntries(root: string, descriptor: WindowsFrozenSourceDescriptor): void {
  const allowed = new Set([`${descriptor.attemptId}.view`, `${descriptor.attemptId}.source.lock`,
    `${descriptor.attemptId}.source.closed.json`]);
  if (attemptEntries(root, descriptor.attemptId).some(entry => !allowed.has(entry))) unsafe();
}

function readMarker(view: string, descriptor: WindowsFrozenSourceDescriptor): Marker {
  const path = join(view, markerName);
  if (!readdirSync(view).includes(markerName)) unsafe();
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 256 * 1024) unsafe();
  let marker: Marker | undefined;
  try { marker = validateStoredMarker(JSON.parse(readFileSync(path, 'utf8')) as unknown, descriptor); }
  catch { unsafe(); }
  if (!marker) throw new Error('SOURCE_VIEW_UNSAFE');
  const bytes = Buffer.from(JSON.stringify(marker));
  verifiedFile(path, { sizeBytes: bytes.length, sha256: sha(bytes) });
  return marker;
}

/** Read-only verification uses the same ACL and byte rules as materialization and close. */
export function verifyWindowsFrozenSourceView(input: WindowsFrozenSourceDescriptor,
  privateRoot: string): WindowsFrozenSourceView & {
    binding: Readonly<InvestigationSourcePlan['binding']>;
  } {
  const descriptor = validateDescriptor(input);
  const root = assertPrivateRoot(privateRoot);
  const name = `${descriptor.attemptId}.view`;
  const entries = attemptEntries(root, descriptor.attemptId);
  if (entries.length !== 1 || entries[0] !== name) unsafe();
  const view = join(root, name);
  const stat = lstatSync(view);
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
  assertNoReparseAncestors(view);
  const marker = readMarker(view, descriptor);
  verifyView(view, marker);
  return Object.freeze({ viewPath: view, sourceDigest: marker.digest,
    isolationVerified: false, binding: Object.freeze({ ...marker.binding }) });
}

/** Verify every remaining planned path before resuming a partially completed close. */
function verifyRemainingView(view: string, marker: Marker): { files: string[]; directories: string[] } {
  const rootStat = lstatSync(view);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) unsafe();
  const expectedFiles = new Map<string, { sizeBytes: number; sha256: string }>();
  const markerBytes = Buffer.from(JSON.stringify(marker));
  expectedFiles.set(markerName, { sizeBytes: markerBytes.length, sha256: sha(markerBytes) });
  const expectedDirectories = new Set<string>();
  for (const file of marker.files) {
    expectedFiles.set(file.path, file);
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join('/'));
  }
  const files: string[] = [];
  const directories: string[] = [];
  const allPaths = [view];
  const visit = (relative: string) => {
    const directory = relative ? join(view, ...relative.split('/')) : view;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) unsafe();
      allPaths.push(full);
      if (st.isDirectory()) {
        if (!expectedDirectories.has(path)) unsafe();
        directories.push(full);
        visit(path);
      } else {
        if (!st.isFile() || !expectedFiles.has(path)) unsafe();
        files.push(full);
      }
    }
  };
  visit('');
  assertTrustedAcl(allPaths);
  for (const full of files) {
    const relative = full.slice(view.length + 1).split(sep).join('/');
    verifiedFile(full, expectedFiles.get(relative)!);
  }
  return { files, directories };
}

/** Close intent remains on disk so a late materializer cannot recreate this attempt's view. */
export function closeWindowsFrozenSource(input: WindowsFrozenSourceDescriptor,
  privateRoot: string): WindowsFrozenSourceClosed {
  const descriptor = validateDescriptor(input);
  const root = assertPrivateRoot(privateRoot);
  const view = join(root, `${descriptor.attemptId}.view`);
  const tombstonePath = join(root, `${descriptor.attemptId}.source.closed.json`);
  const lock = join(root, `${descriptor.attemptId}.source.lock`);
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    writeSync(lockFd, `${process.pid}\n`);
    fsyncSync(lockFd);
    assertNoOtherAttemptEntries(root, descriptor);
    const entries = attemptEntries(root, descriptor.attemptId);
    const hasView = entries.includes(`${descriptor.attemptId}.view`);
    const hasTombstone = entries.includes(`${descriptor.attemptId}.source.closed.json`);
    let tombstone: CloseTombstone | undefined;
    if (hasTombstone) {
      const stat = lstatSync(tombstonePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) unsafe();
      assertTrustedAcl([tombstonePath]);
      try { tombstone = JSON.parse(readFileSync(tombstonePath, 'utf8')) as CloseTombstone; }
      catch { unsafe(); }
      if (!tombstone) throw new Error('SOURCE_VIEW_UNSAFE');
      if (Object.keys(tombstone).sort().join(',') !== 'descriptor,marker' ||
        JSON.stringify(tombstone.descriptor) !== JSON.stringify(descriptor)) unsafe();
      if (tombstone.marker !== null) validateStoredMarker(tombstone.marker, descriptor);
      if (hasView && tombstone.marker === null) unsafe();
    } else {
      let marker: Marker | null = null;
      if (hasView) {
        const stat = lstatSync(view);
        if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
        marker = readMarker(view, descriptor);
        verifyView(view, marker);
      }
      tombstone = { descriptor, marker };
      writeChecked(tombstonePath, Buffer.from(JSON.stringify(tombstone)));
      assertTrustedAcl([tombstonePath]);
    }
    if (!tombstone) throw new Error('SOURCE_VIEW_UNSAFE');
    if (hasView) {
      const marker = tombstone.marker;
      if (!marker) throw new Error('SOURCE_VIEW_UNSAFE');
      const remaining = verifyRemainingView(view, marker);
      for (const file of remaining.files) unlinkSync(file);
      for (const directory of remaining.directories.sort((a, b) => b.length - a.length)) rmdirSync(directory);
      rmdirSync(view);
    }
    return { kind: 'closed', descriptor, viewPath: view, isolationVerified: false };
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

/** Host-owned frozen staging only. This never asserts an investigator sandbox or grants a reader SID. */
export function materializeWindowsFrozenSource(plan: InvestigationSourcePlan, privateRoot: string): WindowsFrozenSourceView {
  const marker = validatePlan(plan);
  const root = assertPrivateRoot(privateRoot);
  const name = `${marker.binding.attemptId}.view`;
  const view = join(root, name);
  const lock = join(root, `${marker.binding.attemptId}.source.lock`);
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    writeSync(lockFd, `${process.pid}\n`);
    fsyncSync(lockFd);
    assertNoOtherAttemptEntries(root, {
      attemptId: marker.binding.attemptId, workspaceId: marker.binding.workspaceId,
      workerEpoch: marker.binding.workerEpoch, sourceDigest: marker.digest,
    });
    if (attemptEntries(root, marker.binding.attemptId).includes(`${marker.binding.attemptId}.source.closed.json`)) unsafe();
    if (readdirSync(root).some(entry => entry.startsWith(`${marker.binding.attemptId}.`) &&
      entry.endsWith('.staging'))) unsafe();
    if (existsSync(view)) {
      verifyView(view, marker);
      return { viewPath: view, sourceDigest: marker.digest, isolationVerified: false };
    }
    const stage = join(root, `${marker.binding.attemptId}.${randomUUID()}.staging`);
    mkdirSync(stage, { mode: 0o700 });
    for (const file of plan.files) {
      const parts = file.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        mkdirSync(join(stage, ...parts.slice(0, index)), { recursive: true, mode: 0o700 });
      }
      writeChecked(join(stage, ...parts), Buffer.from(file.base64, 'base64'));
    }
    writeChecked(join(stage, markerName), Buffer.from(JSON.stringify(marker)));
    verifyView(stage, marker);
    renameSync(stage, view);
    verifyView(view, marker);
    return { viewPath: view, sourceDigest: marker.digest, isolationVerified: false };
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

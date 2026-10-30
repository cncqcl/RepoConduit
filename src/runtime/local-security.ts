import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const protectWindows = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:RCAC_SECURITY_TARGET
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
$acl = [System.IO.Directory]::GetAccessControl($target)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagate = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $full, $inherit, $propagate, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $full, $inherit, $propagate, $allow)))
[System.IO.Directory]::SetAccessControl($target, $acl)
`;

const verifyWindows = String.raw`
$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($current, 'S-1-5-18')
$trustedOwners = @($current, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$first = $true
$targets = @($env:RCAC_SECURITY_TARGET)
if ($env:RCAC_SECURITY_INCLUDE_STATE -eq '1') {
  $targets += [System.IO.Path]::Combine($env:RCAC_SECURITY_TARGET, 'state.sqlite')
}
if ($env:RCAC_SECURITY_FILE) { $targets += $env:RCAC_SECURITY_FILE }
foreach ($target in $targets) {
  if ($env:RCAC_SECURITY_INCLUDE_STATE -eq '0') {
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse target' }
  }
  $acl = if ($first) { [System.IO.Directory]::GetAccessControl($target) } else { [System.IO.File]::GetAccessControl($target) }
  if ($first -and -not $acl.AreAccessRulesProtected) { throw 'Inherited access rules are not allowed' }
  if ($trustedOwners -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted owner' }
  $first = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $allowed -notcontains $rule.IdentityReference.Value) { throw 'Untrusted access rule' }
  }
}
$critical = [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
$parent = [System.IO.Path]::GetDirectoryName($env:RCAC_SECURITY_TARGET)
while ($parent) {
  if ($env:RCAC_SECURITY_INCLUDE_STATE -eq '0') {
    $item = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse ancestor' }
  }
  $acl = [System.IO.Directory]::GetAccessControl($parent)
  if ($trustedOwners -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted ancestor owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
      $trustedOwners -notcontains $rule.IdentityReference.Value -and
      (($rule.FileSystemRights -band $critical) -ne 0)) { throw "Replaceable ancestor $parent $($rule.IdentityReference.Value) $($rule.FileSystemRights)" }
  }
  $next = [System.IO.Path]::GetDirectoryName($parent)
  if (-not $next -or $next -eq $parent) { break }
  $parent = $next
}
`;

// Paths are data, not PowerShell source. Each entry runs the unchanged policy in
// a fresh script scope, including its own directory/file and ancestor state.
const verifyWindowsBatch = String.raw`
$ErrorActionPreference = 'Stop'
$checks = ConvertFrom-Json -InputObject $env:RCAC_SECURITY_BATCH -ErrorAction Stop
foreach ($check in $checks) {
  $env:RCAC_SECURITY_TARGET = [string]$check.directory
  $env:RCAC_SECURITY_FILE = if ($null -ne $check.file) { [string]$check.file } else { '' }
  $env:RCAC_SECURITY_INCLUDE_STATE = if ($check.includeState -eq $true) { '1' } else { '0' }
  & {
${verifyWindows}
  }
}
`;

function privateDirectoryFailure(error: unknown,
  operation: 'protect' | 'verify_data' | 'verify_installation'): never {
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
  const reason = value.code === 'ETIMEDOUT' ? 'timeout' : value.code === 'ENOBUFS' ? 'output_limit' :
    value.code === 'ENOENT' ? 'spawn_missing' :
    value.code === 'EACCES' || value.code === 'EPERM' ? 'spawn_denied' :
    typeof value.status === 'number' && value.status !== 0 ? 'helper_rejected' : 'unknown';
  // Never retain raw subprocess Error, stdout/stderr, paths, SIDs, or environment in a public cause.
  throw new Error('Data directory permissions unavailable or unsafe', {
    cause: Object.freeze({ component: 'private_directory', operation, reason }),
  });
}

function powershell(script: string, directory: string, file?: string, includeState = false,
  operation: 'protect' | 'verify_data' | 'verify_installation' = 'protect', batch?: string): void {
  try {
    // A bare executable name searches the current project directory on Windows.
    // Fail closed on hosts whose system PowerShell is installed elsewhere.
    const systemPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    if (!existsSync(systemPowerShell)) throw new Error('Trusted PowerShell unavailable');
    execFileSync(systemPowerShell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, RCAC_SECURITY_TARGET: directory, RCAC_SECURITY_FILE: file ?? '',
        RCAC_SECURITY_INCLUDE_STATE: includeState ? '1' : '0', RCAC_SECURITY_BATCH: batch ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
  } catch (error) {
    privateDirectoryFailure(error, operation);
  }
}

/** A local same-user CLI cannot trust a writable database merely because its RequestContext is OS-derived. */
export function protectNewDataDirectory(directory: string): void {
  if (process.platform === 'win32') powershell(protectWindows, directory);
  else if ((statSync(directory).mode & 0o077) !== 0) throw new Error('Data directory must be private');
}

export function assertPrivateDataDirectory(directory: string, file?: string): void {
  if (process.platform === 'win32') powershell(verifyWindows, directory, file, true, 'verify_data');
  else {
    if ((statSync(directory).mode & 0o077) !== 0) throw new Error('Data directory is not private');
    statSync(join(directory, 'state.sqlite'));
    if (file && (statSync(file).mode & 0o077) !== 0) throw new Error('Binding file is not private');
  }
}

/** Managed installation root uses the same private-directory policy without an old flat state.sqlite. */
export function assertPrivateInstallationDirectory(directory: string, file?: string): void {
  if (process.platform === 'win32') powershell(verifyWindows, directory, file, false, 'verify_installation');
  else {
    if ((statSync(directory).mode & 0o077) !== 0) throw new Error('Data directory is not private');
    if (file && (statSync(file).mode & 0o077) !== 0) throw new Error('Binding file is not private');
  }
}

function runPrivateBatch(checks: readonly { directory: string; file?: string; includeState?: boolean }[]): void {
  const serialized = JSON.stringify(checks);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024)
    privateDirectoryFailure({ code: 'EINVAL' }, 'verify_installation');
  if (process.platform === 'win32') {
    powershell(verifyWindowsBatch, checks[0]!.directory, undefined, false,
      'verify_installation', serialized);
  } else {
    for (const check of checks) {
      if (check.includeState) assertPrivateDataDirectory(check.directory);
      else assertPrivateInstallationDirectory(check.directory, check.file);
    }
  }
}

/** One bounded, read-only invocation for this load's fixed installation paths. */
export function assertPrivateInstallationBatch(checks: readonly { directory: string; file?: string }[]): void {
  const invalid = () => privateDirectoryFailure({ code: 'EINVAL' }, 'verify_installation');
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 16) invalid();
  const safePath = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value);
  const normalized = checks.map((check: unknown) => {
    if (!check || typeof check !== 'object' || Array.isArray(check) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(check)) ||
        Object.keys(check).some(key => key !== 'directory' && key !== 'file')) return invalid();
    const entry = check as Record<string, unknown>;
    if (!safePath(entry.directory)) return invalid();
    if (!Object.hasOwn(entry, 'file')) return { directory: entry.directory };
    if (!safePath(entry.file)) return invalid();
    const sameParent = process.platform === 'win32'
      ? dirname(entry.file).toLowerCase() === entry.directory.toLowerCase()
      : dirname(entry.file) === entry.directory;
    if (!sameParent) return invalid();
    return { directory: entry.directory, file: entry.file };
  });
  runPrivateBatch(normalized);
}

/** Fixed sourced-load shape: two data roots followed by the existing eleven installation checks. */
export function assertPrivateRuntimeSourceBatch(dataRoots: readonly [string, string],
  checks: readonly { directory: string; file?: string }[]): void {
  const invalid = () => privateDirectoryFailure({ code: 'EINVAL' }, 'verify_installation');
  if (!Array.isArray(dataRoots) || dataRoots.length !== 2 || !Array.isArray(checks) ||
      checks.length !== 11) invalid();
  const roots = dataRoots.map(root => {
    if (typeof root !== 'string' || !root || root.includes('\0') || !isAbsolute(root)) return invalid();
    return { directory: root, includeState: true };
  });
  const installations = checks.map((check: unknown) => {
    if (!check || typeof check !== 'object' || Array.isArray(check) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(check)) ||
        Object.keys(check).some(key => key !== 'directory' && key !== 'file')) return invalid();
    const entry = check as Record<string, unknown>;
    if (typeof entry.directory !== 'string' || !entry.directory ||
        entry.directory.includes('\0') || !isAbsolute(entry.directory)) return invalid();
    if (!Object.hasOwn(entry, 'file')) return { directory: entry.directory, includeState: false };
    if (typeof entry.file !== 'string' || !entry.file || entry.file.includes('\0') ||
        !isAbsolute(entry.file)) return invalid();
    const sameParent = process.platform === 'win32'
      ? dirname(entry.file).toLowerCase() === entry.directory.toLowerCase()
      : dirname(entry.file) === entry.directory;
    if (!sameParent) return invalid();
    return { directory: entry.directory, file: entry.file, includeState: false };
  });
  runPrivateBatch([...roots, ...installations]);
}

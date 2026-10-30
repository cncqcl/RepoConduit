#requires -Version 7.0
param(
    [Parameter(Mandatory = $true)][string] $TunnelId,
    [Parameter(Mandatory = $true)][string] $ProbeUrl,
    [string] $HttpsProxy
)

$ErrorActionPreference = 'Stop'
if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9_-]{8,80}$') { throw 'Invalid tunnel ID shape' }
if ($ProbeUrl -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}/mcp$') { throw 'Probe URL must be loopback MCP endpoint' }
if ($HttpsProxy -and $HttpsProxy -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}$') {
    throw 'HTTPS proxy must be a local HTTP proxy without credentials'
}

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary = Join-Path $workspace '.local\tunnel-client-v0.0.15\tunnel-client.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Verified tunnel-client binary is missing' }
$healthFile = Join-Path $workspace ".local\capability-probe-health-$([Guid]::NewGuid().ToString('N')).url"
$secureKey = Read-Host 'Restricted Tunnels Read+Use runtime key (input hidden; never paste into chat)' -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$process = $null
try {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $binary
    $start.UseShellExecute = $false
    $start.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value) { $start.Environment[$name] = $value }
    }
    $start.Environment['CONTROL_PLANE_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
    foreach ($argument in @(
        'run',
        '--control-plane.base-url', 'https://api.openai.com',
        '--control-plane.tunnel-id', $TunnelId,
        '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
        '--mcp.server-url', "url=$ProbeUrl,channel=main",
        '--health.listen-addr', '127.0.0.1:0',
        '--health.url-file', $healthFile,
        '--log.level', 'warn',
        '--log.file', 'stdout'
    )) { [void]$start.ArgumentList.Add($argument) }
    if ($HttpsProxy) {
        [void]$start.ArgumentList.Add('--control-plane.http-proxy')
        [void]$start.ArgumentList.Add($HttpsProxy)
    }
    Write-Host "This run's health URL file: $healthFile"
    $process = [System.Diagnostics.Process]::Start($start)
    $start.Environment['CONTROL_PLANE_API_KEY'] = ''
    if ($null -eq $process) { throw 'Tunnel client did not start' }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'Tunnel client exited unsuccessfully' }
} finally {
    try {
        if ($null -ne $process) {
            if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
            $process.Dispose()
        }
    } finally {
        Remove-Item -LiteralPath $healthFile -ErrorAction SilentlyContinue
        if ($null -ne $start) { $start.Environment['CONTROL_PLANE_API_KEY'] = '' }
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
        $secureKey.Dispose()
    }
}

#Requires -Version 5.1
# QA-only manifest preview. Never uploads PDF bytes, OCR, or source paths.
param(
    [Parameter(Mandatory)][string]$TestOrigin,
    [Parameter(Mandatory)][guid]$Operation,
    [Parameter(Mandatory)][string]$VersionExport,
    [Parameter(Mandatory)][string]$Index,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][string]$Python,
    [switch]$Enroll,
    [switch]$VercelProtected,
    [switch]$EnrollBypass,
    [switch]$RefreshVersionExport
)
$ErrorActionPreference = 'Stop'

if ($TestOrigin -cnotmatch '^https://[a-z0-9.-]+(:[0-9]+)?$') {
    throw 'Specify a lowercase HTTPS origin without a path or trailing slash'
}
if ($env:KL_STAGE5_TEST_ORIGIN -cne $TestOrigin) {
    throw 'Set KL_STAGE5_TEST_ORIGIN to the independently verified isolated QA origin first'
}
if ($EnrollBypass -and -not $VercelProtected) {
    throw '-EnrollBypass requires -VercelProtected'
}
$hashBytes = [Security.Cryptography.SHA256]::Create().ComputeHash(
    [Text.Encoding]::UTF8.GetBytes($TestOrigin)
)
$hash = [BitConverter]::ToString($hashBytes)
$vault = Join-Path $env:LOCALAPPDATA 'KnowledgeLibrary\TestDeviceKeys'
[IO.Directory]::CreateDirectory($vault) | Out-Null
# Preserve the existing per-origin DPAPI device credential file.
$deviceFile = Join-Path $vault ($hash + '.xml')
$bypassFile = Join-Path $vault ($hash + '.vercel.xml')

if ($Enroll) {
    Read-Host 'QA device bearer key (hidden)' -AsSecureString |
        Export-Clixml -LiteralPath $deviceFile
}
if ($EnrollBypass) {
    Read-Host 'QA Vercel protection bypass key (hidden)' -AsSecureString |
        Export-Clixml -LiteralPath $bypassFile
}
if (-not (Test-Path -LiteralPath $deviceFile)) {
    throw 'QA device key is not enrolled. Run with -Enroll'
}
if ($VercelProtected -and -not (Test-Path -LiteralPath $bypassFile)) {
    throw 'QA Vercel protection bypass is not enrolled. Run with -EnrollBypass'
}

$deviceSecure = $null
$bypassSecure = $null
$deviceKey = $null
$bypassKey = $null
try {
    $deviceSecure = Import-Clixml -LiteralPath $deviceFile
    $deviceKey = [Net.NetworkCredential]::new('', $deviceSecure).Password
    $lines = @($deviceKey)
    $arguments = @('-B', (Join-Path $PSScriptRoot 'api_v2.py'),
        '--test-origin', $TestOrigin,
        '--operation', $Operation.ToString(),
        '--version-export', $VersionExport,
        '--index', $Index,
        '--root', $Root,
        '--directory', $Directory)

    if ($RefreshVersionExport) {
        $arguments += '--refresh-version-export'
    }
    if ($VercelProtected) {
        $bypassSecure = Import-Clixml -LiteralPath $bypassFile
        $bypassKey = [Net.NetworkCredential]::new('', $bypassSecure).Password
        $lines += $bypassKey
        $arguments += '--vercel-protected'
    }
    # Pass both secrets through stdin, never CLI arguments, environment or logs.
    $lines | & $Python @arguments
    if ($LASTEXITCODE -ne 0) {
        throw 'QA manifest preview failed. No apply-selection was attempted'
    }
} finally {
    Remove-Variable deviceKey, bypassKey, lines -ErrorAction SilentlyContinue
    if ($null -ne $deviceSecure) { $deviceSecure.Dispose() }
    if ($null -ne $bypassSecure) { $bypassSecure.Dispose() }
}

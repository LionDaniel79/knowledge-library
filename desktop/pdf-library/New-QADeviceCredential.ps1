#Requires -Version 5.1
# Generate a QA-only device bearer credential locally; never send bearer plaintext to ChatGPT, GitHub or logs.
param(
    [Parameter(Mandatory)][string]$TestOrigin,
    [switch]$Replace
)
$ErrorActionPreference = 'Stop'

if ($TestOrigin -cnotmatch '^https://knowledge-library-stage5-[a-z0-9-]+\.vercel\.app$') {
    throw 'Use only the explicitly verified knowledge-library-stage5 QA deployment origin'
}
if ($env:KL_STAGE5_TEST_ORIGIN -cne $TestOrigin) {
    throw 'Set KL_STAGE5_TEST_ORIGIN to exactly this QA deployment URL before enrollment'
}
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash(
    [Text.Encoding]::UTF8.GetBytes($TestOrigin)
)
$vault = Join-Path $env:LOCALAPPDATA 'KnowledgeLibrary\TestDeviceKeys'
[IO.Directory]::CreateDirectory($vault) | Out-Null
$file = Join-Path $vault (([BitConverter]::ToString($hash)) + '.xml')
if ((Test-Path -LiteralPath $file) -and (-not $Replace)) {
    throw 'An enrolled device key already exists for this origin. Use -Replace only after the old QA token is revoked'
}

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$base64url = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$bearer = 'klw_' + $base64url
if ($bearer.Length -ne 47) { throw 'Unexpected generated credential length' }
$secure = ConvertTo-SecureString $bearer -AsPlainText -Force
try {
    $secure | Export-Clixml -LiteralPath $file
    $shaBytes = [Security.Cryptography.SHA256]::Create().ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($bearer)
    )
    $digest = ([BitConverter]::ToString($shaBytes)).Replace('-', '').ToLowerInvariant()
    # Only the SHA-256 digest and a nonsecret UUID leave this computer.
    [pscustomobject]@{
        qaOrigin = $TestOrigin
        deviceId = [guid]::NewGuid().ToString()
        tokenSha256 = $digest
        plaintextKeyShared = $false
        nextStep = 'Provide only deviceId + tokenSha256 to QA administrator for QA database enrollment'
    } | ConvertTo-Json -Compress
} finally {
    Remove-Variable bearer, base64url, bytes, digest -ErrorAction SilentlyContinue
    $secure.Dispose()
}

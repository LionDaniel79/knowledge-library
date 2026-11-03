param([Parameter(Mandatory)][string]$TestOrigin,
 [Parameter(Mandatory)][guid]$Operation,[Parameter(Mandatory)][string]$VersionExport,
 [Parameter(Mandatory)][string]$Index,[Parameter(Mandatory)][string]$Root,
 [Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][string]$Python,[switch]$Enroll)
$ErrorActionPreference='Stop'
if ($TestOrigin -cnotmatch '^https://[a-z0-9.-]+(:[0-9]+)?$') {throw 'Specify a lowercase HTTPS origin'}
$hash=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($TestOrigin))
$vault=Join-Path $env:LOCALAPPDATA 'KnowledgeLibrary\TestDeviceKeys'
[IO.Directory]::CreateDirectory($vault) | Out-Null
$file=Join-Path $vault ([BitConverter]::ToString($hash)+'.xml')
if($Enroll){Read-Host 'Test device key' -AsSecureString | Export-Clixml -LiteralPath $file}
$secret=Import-Clixml -LiteralPath $file
$key=[Net.NetworkCredential]::new('', $secret).Password
try {
 $key | & $Python -B "$PSScriptRoot\api_v2.py" --test-origin $TestOrigin --operation $Operation --version-export $VersionExport --index $Index --root $Root --directory $Directory
 if($LASTEXITCODE){throw 'Test preview failed'}
} finally {Remove-Variable key; $secret.Dispose()}

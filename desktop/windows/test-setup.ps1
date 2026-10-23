param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$core=Join-Path $PSScriptRoot 'SetupCore.cs'
if(-not(Test-Path -LiteralPath $core)){throw 'FAIL: setup connection protection and path validation are not implemented.'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testExe=Join-Path $output 'SetupTests.exe'
& $compiler /nologo /codepage:65001 /platform:x64 /target:exe /main:SetupTests /r:System.Security.dll /r:System.Web.Extensions.dll ("/out:$testExe") $core (Join-Path $PSScriptRoot 'SetupTests.cs')
if($LASTEXITCODE -ne 0){throw 'Setup tests failed to compile.'}
& $testExe
if($LASTEXITCODE -ne 0){throw 'Setup tests failed.'}

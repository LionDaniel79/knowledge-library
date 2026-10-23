param([Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'setup-worker.ps1') -NoRun
$root=Join-Path ([IO.Path]::GetFullPath($TestRoot)) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root -Force | Out-Null
$count=0
function Check($value,[string]$label){if(-not $value){throw ('FAIL: '+$label)};$script:count++}
function Rejected([scriptblock]$action,[string]$label){$refused=$false;try{& $action}catch{$refused=$true};Check $refused $label}
Check ((Assert-SetupPath 'D:\서재 실행') -eq 'D:\서재 실행') 'Korean and spaced paths'
Rejected {Assert-SetupPath 'D:\'} 'drive root refused'
Rejected {Assert-SetupPath '\\server\share\folder'} 'network folder refused'
Rejected {Assert-SetupPath 'relative'} 'relative folder refused'
$fake=[pscustomobject]@{Actions=@([pscustomobject]@{Execute='D:\runtime\node.exe';Arguments='"D:\library\start-private-pc.mjs"'})}
Assert-SetupTask $fake 'D:\runtime\node.exe' '"D:\library\start-private-pc.mjs"';Check $true 'owned task accepted'
Rejected {Assert-SetupTask $fake 'D:\other\node.exe' '"D:\library\start-private-pc.mjs"'} 'unrelated existing task preserved'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=Join-Path $root 'traversal.zip'
$z=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
try{$null=$z.CreateEntry('safe.txt');$null=$z.CreateEntry('../escape.txt')}finally{$z.Dispose()}
Rejected {Expand-SetupZip $archive (Join-Path $root 'expanded')} 'zip traversal refused before extraction'
Check (-not(Test-Path -LiteralPath (Join-Path $root 'escape.txt'))) 'no file escaped destination'
Check (-not(Test-Path -LiteralPath (Join-Path $root 'expanded\safe.txt'))) 'preflight prevents partial extraction'
$archive=Join-Path $root 'safe.zip';$z=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
try{$writer=New-Object IO.StreamWriter($z.CreateEntry('folder\content.txt').Open());try{$writer.Write('checked')}finally{$writer.Dispose()}}finally{$z.Dispose()}
Expand-SetupZip $archive (Join-Path $root 'safe-expanded')
Check ((Get-Content -LiteralPath (Join-Path $root 'safe-expanded\folder\content.txt')) -eq 'checked') 'valid ZIP extracted'
$runtimeRoot=Join-Path $root 'runtime';New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'fixture') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $runtimeRoot 'fixture\partial.txt'),'preserve')
$runtimeHash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
Install-SetupRuntime $archive $runtimeRoot 'fixture' '' $runtimeHash
Check (Test-Path -LiteralPath (Join-Path $runtimeRoot 'fixture\folder\content.txt')) 'partial runtime recovers through staged extraction'
Check (@(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'partial-fixture-*').Count -eq 1) 'incomplete runtime is preserved'
Install-SetupRuntime $archive $runtimeRoot 'fixture' '' $runtimeHash
Check (@(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'partial-fixture-*').Count -eq 1) 'verified runtime reused on retry'
$buildApp=Join-Path $root 'build-app';New-Item -ItemType Directory -Path (Join-Path $buildApp '.next\server') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $buildApp '.next\BUILD_ID'),'partial')
Check (-not(Test-SetupBuildReady $buildApp 'fixture-source')) 'BUILD_ID alone is not a completed build'
[IO.File]::WriteAllText((Join-Path $buildApp '.setup-build-ready'),'fixture-source')
Check (-not(Test-SetupBuildReady $buildApp 'fixture-source')) 'receipt with missing manifests is not reused'
foreach($file in @('.next\build-manifest.json','.next\prerender-manifest.json','.next\routes-manifest.json','.next\server\app-paths-manifest.json')){[IO.File]::WriteAllText((Join-Path $buildApp $file),'{}')}
Check (Test-SetupBuildReady $buildApp 'fixture-source') 'successful matching artifact can be reused'
Check (-not(Test-SetupBuildReady $buildApp 'different-source')) 'different source never reuses build'
$hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
Get-SetupDownload 'https://not-contacted.invalid/archive.zip' $archive $hash;Check $true 'verified cached download reused without network'
Rejected {Get-SetupDownload 'https://not-contacted.invalid/archive.zip' $archive ('0'*64)} 'wrong cached hash refused'
if(Get-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' -ErrorAction SilentlyContinue){
 $actual=Get-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF'
 Rejected {Assert-SetupTask $actual 'Z:\fixture\node.exe' 'Z:\fixture\start-private-pc.mjs'} 'actual operational server task preserved'
}
Write-Output ("PASS "+$count+" setup worker assertions; isolated fixtures: "+$root)

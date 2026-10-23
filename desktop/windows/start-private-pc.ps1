param([Parameter(Mandatory=$true)][string]$LauncherPath)
$ErrorActionPreference='Stop'
$expected=Join-Path $PSScriptRoot 'start-private-pc.mjs'
if([IO.Path]::GetFullPath($LauncherPath) -ne [IO.Path]::GetFullPath($expected)){throw 'Unexpected library launcher.'}
$digest=[Security.Cryptography.SHA256]::Create()
try{$key=([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant())))).Replace('-','')}finally{$digest.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\KnowledgeLibraryServer-'+$key))
$taken=$false
try{
 try{$taken=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$taken=$true}
 if(-not $taken){exit 0}
 $config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pc-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 & $config.node $expected
 exit $LASTEXITCODE
}finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}

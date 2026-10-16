param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [switch]$Check,
  [switch]$ResumeIndexing,
  [switch]$OpenBrowser
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'library-start-state.ps1')
$config=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json
$repo=[IO.Path]::GetFullPath([string]$config.workspace)
$data=[IO.Path]::GetFullPath([string]$config.dataRoot)
foreach($path in @($repo,$data,[string]$config.node,[string]$config.python)){
  if($path -match '["\r\n]' -or -not(Test-Path -LiteralPath $path)){throw 'A configured path is missing or invalid.'}
}
$index=Join-Path $data '색인/pdf-library.sqlite'
$queue=Join-Path $data '검수/priority-isbn-20261015/catalog-incremental'
$envFile=Join-Path $repo '.env.local'
# Runtime externals resolve from the project even when generated .next files
# are on another disk through a directory junction.
$env:NODE_PATH=Join-Path $repo 'node_modules'
if(-not(Test-Path -LiteralPath $envFile)){throw 'Library environment file is missing.'}
function Find-Task([string]$pattern) {
  @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID})
}
function Quote-Arg([string]$value) {
  if($value -match '["\r\n]'){throw 'Invalid process argument.'}
  return '"'+$value+'"'
}
function Get-Tasks {
  $repoPattern=[regex]::Escape($repo.Replace('\','/'))
  $all=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine})
  $app=@($all | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine.Replace('\','/') -match "$repoPattern/node_modules/next/dist/server/lib/start-server.js"})
  # Also recognize the parent launched here before Next has created its server.
  $appParent=@($all | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine.Replace('\','/') -match "$repoPattern/node_modules/next/dist/bin/next.*dev.*--port 3000"})
  $api=@($all | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine.Replace('\','/') -match "$repoPattern/scripts/assist-worker.ts"})
  $ocr=@($all | Where-Object {$_.Name -eq 'python.exe' -and $_.CommandLine -match 'scripts[/\\]pdf_ocr.py' -and $_.CommandLine.Replace('\','/') -match [regex]::Escape($index.Replace('\','/'))})
  $catalog=@($all | Where-Object {$_.Name -match '^(pwsh|powershell).exe$' -and $_.CommandLine -match 'continue-priority-catalog.ps1' -and $_.CommandLine.Replace('\','/') -match [regex]::Escape($index.Replace('\','/'))})
  return @{app=@($app+$appParent | Select-Object -ExpandProperty ProcessId -Unique);api=@($api | Select-Object -ExpandProperty ProcessId);ocr=@($ocr | Select-Object -ExpandProperty ProcessId);catalog=@($catalog | Select-Object -ExpandProperty ProcessId)}
}
if($Check){Get-Tasks|ConvertTo-Json -Compress;exit 0}
$logDir=Join-Path $data 'private-data/operations'
New-Item -ItemType Directory -Path $logDir -Force|Out-Null
$lock=[IO.File]::Open((Join-Path $logDir 'start.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  $tasks=Get-Tasks
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  if(-not $tasks.app.Count){
    if(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue){throw 'Port 3000 is occupied by another process.'}
    $argsLine=(Quote-Arg (Join-Path $repo 'node_modules/next/dist/bin/next'))+' dev --hostname 127.0.0.1 --port 3000'
    $null=Start-Process -FilePath $config.node -ArgumentList $argsLine -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$stamp.web.out.log") -RedirectStandardError (Join-Path $logDir "$stamp.web.err.log") -PassThru
  }
  $ready=$false
  for($attempt=0;$attempt -lt 20;$attempt++){
    try {$null=Invoke-WebRequest 'http://127.0.0.1:3000/' -TimeoutSec 2;$ready=$true;break}catch{Start-Sleep -Milliseconds 500}
  }
  if(-not $ready){throw 'The library did not start. Check the web log.'}
  if(-not $tasks.api.Count){
    $env:LIBRARY_WORKER_CONFIG=Join-Path $data 'private-data/config/api-worker.private.json'
    if(-not(Test-Path -LiteralPath $env:LIBRARY_WORKER_CONFIG)){throw 'API worker connection file is missing.'}
    $loader=([uri]::new((Join-Path $repo 'node_modules/tsx/dist/loader.mjs'))).AbsoluteUri
    $argsLine='--env-file='+ (Quote-Arg $envFile) +' --import='+$loader+' '+(Quote-Arg (Join-Path $repo 'scripts/assist-worker.ts'))
    $null=Start-Process -FilePath $config.node -ArgumentList $argsLine -WorkingDirectory $data -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$stamp.api.out.log") -RedirectStandardError (Join-Path $logDir "$stamp.api.err.log") -PassThru
  }
  if($ResumeIndexing){
    $ocrStatePath=[IO.Path]::ChangeExtension($index,'.ocr-status.json')
    $state=Read-LibraryOcrState $ocrStatePath
    if(-not $tasks.ocr.Count -and $state.status -ne 'completed'){
      if(-not(Test-Path -LiteralPath $index)){throw 'PDF index is missing.'}
      $argsLine='-X utf8 '+(Quote-Arg (Join-Path $repo 'scripts/pdf_ocr.py'))+' --index '+(Quote-Arg $index)+' --language ko --workers 1 --min-free-gb 8 --priority identity-first'
      $ocrStartedAt=[datetime]::UtcNow
      $newOcr=Start-Process -FilePath $config.python -ArgumentList $argsLine -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$stamp.ocr.out.log") -RedirectStandardError (Join-Path $logDir "$stamp.ocr.err.log") -PassThru
      # The supervisor validates the OCR PID; wait for the new worker's state file.
      $readiness='waiting'
      for($attempt=0;$attempt -lt 300;$attempt++){
        Start-Sleep -Milliseconds 500
        $state=Read-LibraryOcrState $ocrStatePath
        $readiness=Get-LibraryOcrReadiness $state $newOcr.Id $ocrStartedAt
        if($readiness -eq 'ready'){break}
        if($readiness -eq 'failed' -or $newOcr.HasExited){throw 'OCR failed before becoming ready. Check its log.'}
      }
      if($readiness -ne 'ready'){throw 'OCR is still initializing. Run resume again after its status becomes ready; the catalog was not started.'}
    }
    $queueStatePath=Join-Path $queue 'queue-status.json'
    $queueState=if(Test-Path -LiteralPath $queueStatePath){Get-Content -LiteralPath $queueStatePath -Raw|ConvertFrom-Json}else{$null}
    if(-not $tasks.catalog.Count -and $queueState.phase -ne 'complete'){
      if(-not(Test-Path -LiteralPath $config.preservationBaseline)){throw 'Preservation baseline is missing.'}
      $argsLine='-NoProfile -File '+(Quote-Arg (Join-Path $repo 'scripts/continue-priority-catalog.ps1'))+' -IndexPath '+(Quote-Arg $index)+' -OutputDirectory '+(Quote-Arg $queue)+' -PreservationBaseline '+(Quote-Arg $config.preservationBaseline)
      $null=Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $argsLine -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$stamp.catalog.out.log") -RedirectStandardError (Join-Path $logDir "$stamp.catalog.err.log") -PassThru
    }
  }
  if($OpenBrowser){Start-Process 'http://127.0.0.1:3000/'}
  Get-Tasks|ConvertTo-Json -Compress
} finally {$lock.Dispose()}

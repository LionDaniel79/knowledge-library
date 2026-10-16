param(
  [Parameter(Mandatory=$true)][string]$IndexPath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$PreservationBaseline
)
$ErrorActionPreference = 'Stop'
$libraryWorkspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $libraryWorkspace
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$statePath = Join-Path $OutputDirectory 'queue-status.json'
$lockPath = Join-Path $OutputDirectory 'queue.lock'
$handle = [System.IO.File]::Open($lockPath,[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
$ocrStatePath = [System.IO.Path]::ChangeExtension($IndexPath,'.ocr-status.json')
$batch=0
$runDirectory=Join-Path $OutputDirectory ('run-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')+'-'+$PID)
New-Item -ItemType Directory -Path $runDirectory | Out-Null
function Save-Queue([string]$phase,[string]$reason) {
  $temporary=$statePath+".$PID.tmp"
  @{phase=$phase;reason=$reason;pid=$PID;batch=$batch;runDirectory=$runDirectory;updatedAt=[DateTime]::UtcNow.ToString('o');aiCalls=$false;pdfWrites=$false}|ConvertTo-Json|Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
function Read-ActiveOcr {
  $current=Get-Content -LiteralPath $ocrStatePath -Raw|ConvertFrom-Json
  if($current.status -notin @('running','completed')) {throw 'OCR is paused or failed. Available results are preserved.'}
  if($current.status -eq 'running') {
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($current.pid)" | Where-Object { $_.CommandLine -match 'scripts[/\\]pdf_ocr.py' }
    if(-not $process) {throw 'OCR process exited unexpectedly.'}
  }
  return $current
}
function Invoke-Step([string]$name,[string[]]$taskArgs) {
  $null=Read-ActiveOcr
  $conflicts=Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts[/\\](identify-pdfs|collect-catalog|adopt-collected-classifications|collect-pdf-outlines|collect-printed-toc)\.(ts|js)' }
  if($conflicts) { throw 'Another collection writer is active.' }
  Save-Queue $name 'Process ready general-book evidence while body OCR continues.'
  $logName='{0:D4}-{1}' -f $batch,$name
  & node @taskArgs 1> (Join-Path $runDirectory ($logName+'.log')) 2> (Join-Path $runDirectory ($logName+'-error.log'))
  if($LASTEXITCODE -ne 0) { throw 'Collection stopped; inspect the saved log.' }
}
function Read-Identity {
  $lastLine=Get-Content -LiteralPath (Join-Path $runDirectory (('{0:D4}-{1}.log' -f $batch,$script:identityStep))) -Tail 1
  $result=$lastLine|ConvertFrom-Json
  if($result.stopped -notin @('complete','batch_limit')) { throw 'Identity collection did not finish its batch.' }
  return $result
}
function Classify-NewBooks($result, [string]$label) {
  if($result.applied -le 0) {return}
  $ids=@($result.appliedBookIds | Select-Object -Unique)
  if($ids.Count -ne $result.applied -or ($ids | Where-Object {$_ -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'})) {
    throw 'Newly identified book IDs are missing or invalid; do not scan the entire library as a fallback.'
  }
  Invoke-Step $label @('--env-file=.env.local','--import','tsx','scripts/adopt-collected-classifications.ts','--apply','--limit','5000','--book-ids',($ids -join ','),'--output',(Join-Path $runDirectory ($label+'-'+$batch+'.json')))
}
try {
  # Existing ISBNs are independent of OCR, so collect them immediately.
  do {
    Invoke-Step 'known_isbn' @('--env-file=.env.local','--import','tsx','scripts/collect-catalog.ts','--online','--apply','--limit','100')
    $known=Get-Content -LiteralPath (Join-Path $runDirectory (('{0:D4}-known_isbn.log' -f $batch))) -Tail 1|ConvertFrom-Json
    if($known.stopped -ne 'complete') {throw 'Known-ISBN collection did not finish its batch.'}
    if($known.pending -gt 0 -and $known.requests -eq 0 -and $known.applied -eq 0) {throw 'Known-ISBN collection made no progress.'}
    $batch++
  } while($known.pending -gt 0)
  $lastOcrProgress=-1
  while($true) {
    # Capture before scanning: edge completion during API calls must trigger another pass.
    $scanOcr=Read-ActiveOcr
    $lastOcrProgress=[long]$scanOcr.counts.front_back
    $batch++
    $identityStep='isbn_priority'
    Invoke-Step $identityStep @('--env-file=.env.local','--import','tsx','scripts/identify-pdfs.ts','--online','--apply','--ready-only','--isbn-only','--limit','100')
    $isbn=Read-Identity
    Classify-NewBooks $isbn 'classification'
    if($isbn.stopped -eq 'batch_limit') {continue}
    $identityStep='title_author'
    Invoke-Step $identityStep @('--env-file=.env.local','--import','tsx','scripts/identify-pdfs.ts','--online','--apply','--ready-only','--limit','100')
    $fallback=Read-Identity
    Classify-NewBooks $fallback 'title_classification'
    if($fallback.stopped -eq 'batch_limit') {continue}
    $ocr=Read-ActiveOcr
    if($ocr.status -eq 'completed') {break}
    if([long]$ocr.counts.front_back -ne $lastOcrProgress) {continue}
    Save-Queue 'waiting_new_edges' 'Current ready books are processed. Check for new front/back OCR results; do not wait for all body pages.'
    do {
      Start-Sleep -Seconds 30
      $ocr=Get-Content -LiteralPath $ocrStatePath -Raw|ConvertFrom-Json
      $ocrProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($ocr.pid)" | Where-Object { $_.CommandLine -match 'scripts[/\\]pdf_ocr.py' }
      if($ocr.status -eq 'running' -and -not $ocrProcess) {throw 'OCR process exited unexpectedly.'}
    } while($ocr.status -eq 'running' -and [long]$ocr.counts.front_back -eq $lastOcrProgress)
  }
  $batch++
  Invoke-Step 'final_identity' @('--env-file=.env.local','--import','tsx','scripts/identify-pdfs.ts','--online','--apply','--limit','5000')
  Invoke-Step 'final_classification' @('--env-file=.env.local','--import','tsx','scripts/adopt-collected-classifications.ts','--apply','--limit','5000','--output',(Join-Path $runDirectory 'classification-final.json'))
  Invoke-Step 'outlines' @('--env-file=.env.local','--import','tsx','scripts/collect-pdf-outlines.ts','--apply','--limit','5000')
  Invoke-Step 'printed_contents' @('--env-file=.env.local','--import','tsx','scripts/collect-printed-toc.ts','--apply','--limit','5000')
  Invoke-Step 'preservation_audit' @('--env-file=.env.local','--import','tsx','scripts/audit-library-completion.ts','--baseline',$PreservationBaseline,'--output',(Join-Path $runDirectory 'audit.json'))
  Save-Queue 'complete' 'Priority identification and final follow-up completed; ambiguous editions remain for review.'
} catch {
  Save-Queue 'stopped_error' 'Inspect the last step. No automatic API retries, OCR restarts, deletion or paid AI calls.'
  exit 1
} finally {
  $handle.Dispose()
}

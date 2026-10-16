function Read-LibraryOcrState([string]$Path) {
  if(-not(Test-Path -LiteralPath $Path)){return $null}
  try { return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop) }
  catch { return $null }
}
function Get-LibraryOcrReadiness($State,[int]$ExpectedPid,[datetime]$StartedAt) {
  if($null -eq $State -or $State.pid -ne $ExpectedPid -or -not $State.updatedAt){return 'waiting'}
  try {$updated=[datetime]::Parse([string]$State.updatedAt).ToUniversalTime()}catch{return 'waiting'}
  if($updated -lt $StartedAt.ToUniversalTime()){return 'waiting'}
  if($State.status -in @('running','completed')){return 'ready'}
  if($State.status -in @('failed','paused')){return 'failed'}
  return 'waiting'
}

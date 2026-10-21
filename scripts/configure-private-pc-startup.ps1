param(
  [string]$TaskName = 'KnowledgeLibrary-PrivatePDF',
  [Parameter(Mandatory = $true)][string]$BackupDirectory
)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName
if ($task.Actions.Count -ne 1 -or -not $task.Actions[0].Arguments.Contains('start-private-pc.mjs')) {
  throw 'Unexpected task action; preserve the existing task.'
}
if (-not [IO.Path]::IsPathRooted($BackupDirectory)) { throw 'An absolute backup directory is required.' }
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$backupPath = Join-Path $BackupDirectory ("startup-before-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $backupPath -Encoding Unicode
$login = New-ScheduledTaskTrigger -AtLogOn -User $task.Principal.UserId
$retry = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$task.Triggers = @($login, $retry)
$task.Settings.StartWhenAvailable = $true
$task.Settings.DisallowStartIfOnBatteries = $false
$task.Settings.StopIfGoingOnBatteries = $false
$task.Settings.RunOnlyIfIdle = $false
$task.Settings.IdleSettings.StopOnIdleEnd = $false
$task.Settings.ExecutionTimeLimit = 'PT0S'
$task.Settings.RestartCount = 10
$task.Settings.RestartInterval = 'PT1M'
# The existing account, hidden launcher and IgnoreNew policy are retained.
Set-ScheduledTask -InputObject $task | Out-Null
$checked = Get-ScheduledTask -TaskName $TaskName
if ($checked.Triggers.Count -ne 2) { throw 'Startup trigger verification failed.' }
[pscustomobject]@{ task = $TaskName; triggers = $checked.Triggers.Count; retryInterval = 'PT1M'; state = $checked.State.ToString() } | ConvertTo-Json -Compress

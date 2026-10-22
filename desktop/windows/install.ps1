param(
  [Parameter(Mandatory=$true)][string]$BuildDirectory,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$RuntimeFile,
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$DataFolder,
  [Parameter(Mandatory=$true)][string]$Url,
  [string]$TaskName='KnowledgeLibrary-PrivatePDF',
  [int]$Port=3001
)
$ErrorActionPreference='Stop'
$install=[IO.Path]::GetFullPath($InstallDirectory)
$build=[IO.Path]::GetFullPath($BuildDirectory)
if ($install -eq $build) { throw 'Build and installed runtime must be separate directories.' }
$task=Get-ScheduledTask -TaskPath '\' -TaskName $TaskName
if ($task.Actions.Count -ne 1 -or -not $task.Actions[0].Arguments.Contains('start-private-pc.mjs')) { throw 'Expected private library task not found.' }
$compiled=Join-Path $build 'KnowledgeLibraryServer.exe'
if (-not (Test-Path -LiteralPath $compiled)) { throw 'Build the tray program first.' }
$startup=Join-Path ([Environment]::GetFolderPath('Startup')) '지식서재 서버.lnk'
$desktop=Join-Path ([Environment]::GetFolderPath('Desktop')) '지식서재 서버.lnk'
$legacy=Join-Path ([Environment]::GetFolderPath('Startup')) '지식서재 비공개 PDF 연결.lnk'
$exe=Join-Path $install 'KnowledgeLibraryServer.exe'
$shell=New-Object -ComObject WScript.Shell
# Inspect all existing shortcuts before changing any files.
foreach($link in @($startup,$desktop)) {
 if(Test-Path -LiteralPath $link) {
  $existing=$shell.CreateShortcut($link)
  if($existing.TargetPath -ne $exe) { throw "An unrelated shortcut already uses this name: $link" }
 }
}
if(Test-Path -LiteralPath $legacy) {
 $old=$shell.CreateShortcut($legacy)
 if(-not $old.Arguments.Contains("Start-ScheduledTask -TaskName '$TaskName'")) { throw 'Legacy startup shortcut changed; inspect before replacement.' }
}
New-Item -ItemType Directory -Path $install -Force | Out-Null
$backup=Join-Path $install ('backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach($entry in @(@($exe,'KnowledgeLibraryServer.exe'),@((Join-Path $install 'tray-config.json'),'tray-config.json'),@($startup,'startup-tray.lnk'),@($desktop,'desktop-tray.lnk'),@($legacy,'startup-legacy.lnk'))) {
 if(Test-Path -LiteralPath $entry[0]) { Copy-Item -LiteralPath $entry[0] -Destination (Join-Path $backup $entry[1]) }
}
Copy-Item -LiteralPath $compiled -Destination $exe
Copy-Item -LiteralPath (Join-Path $build 'library.ico') -Destination (Join-Path $install 'library.ico')
$config=@{
 TaskName=$TaskName; TaskExecutable=$task.Actions[0].Execute; TaskArguments=$task.Actions[0].Arguments
 RuntimeFile=[IO.Path]::GetFullPath($RuntimeFile); AppRoot=[IO.Path]::GetFullPath($AppRoot)
 DataFolder=[IO.Path]::GetFullPath($DataFolder); Url=$Url; Port=$Port
 LogsFolder=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($RuntimeFile))
}
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install 'tray-config.json') -Encoding UTF8
foreach($link in @($startup,$desktop)) {
 $shortcut=$shell.CreateShortcut($link);$shortcut.TargetPath=$exe;$shortcut.Arguments='';$shortcut.WorkingDirectory=$install
 $shortcut.IconLocation=$exe+',0';$shortcut.Description='지식서재 서버를 트레이에서 관리합니다.';$shortcut.Save()
 if($shell.CreateShortcut($link).TargetPath -ne $exe) { throw 'Shortcut verification failed.' }
}
if(Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy }
Write-Output ([pscustomobject]@{Executable=$exe;StartupShortcut=$startup;DesktopShortcut=$desktop;Backup=$backup})

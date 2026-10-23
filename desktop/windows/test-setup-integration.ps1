param([Parameter(Mandatory=$true)][string]$TestRoot,[Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$BuildDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'setup-worker.ps1') -NoRun
Add-Type -AssemblyName System.Security
$root=Join-Path ([IO.Path]::GetFullPath($TestRoot)) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root -Force | Out-Null
$count=0
function Check($ok,[string]$why){if(-not $ok){throw ('FAIL: '+$why)};$script:count++}
$profile=@{DATABASE_URL='postgresql://library_web_runtime:fixture@db.example/library';NEON_AUTH_BASE_URL='https://auth.example/auth';NEON_AUTH_COOKIE_SECRET=('c'*40);LIBRARY_OWNER_EMAIL='한글@example.invalid'}
$bytes=[Text.Encoding]::UTF8.GetBytes(($profile|ConvertTo-Json))
$protected=@{protected=[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))}
$profileFile=Join-Path $root 'fixture.dpapi.json'
Write-SetupJson $profileFile $protected
$module=([uri]::new((Join-Path $PSScriptRoot 'start-private-pc.mjs'))).AbsoluteUri
$code='const {unlockProfile}=await import(process.argv[2]); const p=unlockProfile({profileFile:process.argv[3]}); if(p.LIBRARY_OWNER_EMAIL!=="\uD55C\uAE00@example.invalid")process.exit(1);console.log("PASS Windows DPAPI UTF8 bridge");'
$checkFile=Join-Path $root 'check-dpapi.mjs';[IO.File]::WriteAllText($checkFile,$code,(New-Object Text.UTF8Encoding($false)))
& $NodePath $checkFile $module $profileFile
Check ($LASTEXITCODE -eq 0) 'real Windows DPAPI bridge'
$wrapper=Join-Path $root 'start-private-pc.ps1';Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-private-pc.ps1') -Destination $wrapper
Copy-Item -LiteralPath (Join-Path $BuildDirectory 'KnowledgeLibraryHost.exe') -Destination $root
$entry=Join-Path $root 'start-private-pc.mjs'
[IO.File]::WriteAllText($entry,'import{appendFileSync}from"node:fs";appendFileSync(new URL("./starts.txt",import.meta.url),"start\n");setTimeout(()=>{},2500);')
Write-SetupJson (Join-Path $root 'pc-runtime.json') @{node=$NodePath}
$spec=Get-SetupTaskSpec $root
$first=Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments -WindowStyle Hidden -PassThru
for($i=0;$i -lt 30 -and -not(Test-Path -LiteralPath (Join-Path $root 'starts.txt'));$i++){Start-Sleep -Milliseconds 100}
$second=Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments -WindowStyle Hidden -PassThru
Check ($second.WaitForExit(8000)) 'duplicate wrapper exits'
Check ($first.WaitForExit(8000)) 'first wrapper finishes'
Check (@(Get-Content -LiteralPath (Join-Path $root 'starts.txt')).Count -eq 1) 'OS mutex suppresses duplicate launch'
$third=Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments -WindowStyle Hidden -PassThru
Check ($third.WaitForExit(8000)) 'wrapper can relaunch after exit'
Check (@(Get-Content -LiteralPath (Join-Path $root 'starts.txt')).Count -eq 2) 'OS mutex automatically released'
$taskName='KnowledgeLibrary-Setup-Test-'+[guid]::NewGuid().ToString()
$registered=$false
try{
 $action=New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Arguments -WorkingDirectory $root
 $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
 Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $action -Principal $principal | Out-Null
 $registered=$true
 Start-ScheduledTask -TaskPath '\' -TaskName $taskName
 for($i=0;$i -lt 50;$i++){Start-Sleep -Milliseconds 150;$info=Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName;if($info.LastRunTime.Year -gt 2000 -and (Get-ScheduledTask -TaskPath '\' -TaskName $taskName).State -ne 'Running'){break}}
 Check ((Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName).LastTaskResult -eq 0) 'own limited-user scheduled launcher runs'
 Check (@(Get-Content -LiteralPath (Join-Path $root 'starts.txt')).Count -eq 3) 'scheduled wrapper reached its Node child'
}finally{
 if($registered){$task=Get-ScheduledTask -TaskPath '\' -TaskName $taskName;Assert-SetupTask $task $spec.Execute $spec.Arguments;Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false}
}
Write-Output ("PASS "+$count+" setup integration assertions; operational server and OCR untouched")

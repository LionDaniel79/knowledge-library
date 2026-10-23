param([string]$RequestPath,[switch]$NoRun)
$ErrorActionPreference='Stop'
function Assert-SetupPath([string]$Path) {
 if(-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\') -or $Path -match '["\r\n]'){throw '전용 로컬 폴더를 선택해 주세요.'}
 $full=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
 if($full.Length -lt 4 -or $full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')){throw '드라이브 전체를 설치 폴더로 사용할 수 없습니다.'}
 return $full
}
function Quote-SetupArgument([string]$Value) {
 if($Value -match '["\r\n]'){throw '잘못된 실행 경로입니다.'}
 return '"'+$Value.TrimEnd('\')+'"'
}
function Expand-SetupZip([string]$Archive,[string]$Destination) {
 Add-Type -AssemblyName System.IO.Compression
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $root=[IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\'
 $zip=[IO.Compression.ZipFile]::OpenRead($Archive)
 try {
  foreach($entry in $zip.Entries) {
   $target=[IO.Path]::GetFullPath((Join-Path $root $entry.FullName))
   if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw '압축 파일의 경로가 올바르지 않습니다.'}
  }
 } finally {$zip.Dispose()}
 [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$Destination)
}
function Get-SetupTaskSpec([string]$Install) {
 $exe=Join-Path $Install 'KnowledgeLibraryHost.exe'
 $taskArguments='--launcher {0}' -f (Quote-SetupArgument (Join-Path $Install 'start-private-pc.mjs'))
 return @{Execute=$exe;Arguments=$taskArguments}
}
function Assert-SetupTask($Task,[string]$Executable,[string]$Arguments) {
 if($null -eq $Task){return}
 if($Task.Actions.Count -ne 1 -or $Task.Actions[0].Execute -ne $Executable -or $Task.Actions[0].Arguments -ne $Arguments){throw '이 PC에 다른 지식서재 서버가 등록되어 있습니다. 기존 설치를 유지했습니다.'}
}
function Move-SetupDirectory([string]$Source,[string]$Destination,[string]$Parent) {
 $boundary=[IO.Path]::GetFullPath($Parent).TrimEnd('\')+'\'
 if(-not [IO.Path]::GetFullPath($Source).StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($Destination).StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)){throw '설치 경로 범위를 확인해 주세요.'}
 Move-Item -LiteralPath $Source -Destination $Destination
}
function Install-SetupRuntime([string]$Archive,[string]$Parent,[string]$Name,[string]$Top,[string]$Hash) {
 $destination=Join-Path $Parent $Name
 $receipt=Join-Path $destination '.setup-runtime-sha256'
 if((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Hash){throw '실행 도구 파일 검증에 실패했습니다.'}
 if((Test-Path -LiteralPath $receipt) -and (Get-Content -LiteralPath $receipt -Raw).Trim() -eq $Hash){return}
 $staging=Join-Path $Parent ('unpack-'+[guid]::NewGuid().ToString())
 Expand-SetupZip $Archive $staging
 $completed=if($Top){Join-Path $staging $Top}else{$staging}
 if(-not(Test-Path -LiteralPath $completed)){throw '실행 도구의 폴더를 확인해 주세요.'}
 [IO.File]::WriteAllText((Join-Path $completed '.setup-runtime-sha256'),$Hash)
 if(Test-Path -LiteralPath $destination){Move-SetupDirectory $destination (Join-Path $Parent ('partial-'+$Name+'-'+[guid]::NewGuid().ToString())) $Parent}
 Move-SetupDirectory $completed $destination $Parent
}
function Assert-SetupTray([string]$Install) {
 $exe=Join-Path $Install 'tray\KnowledgeLibraryServer.exe'
 $shell=New-Object -ComObject WScript.Shell
 foreach($folder in @([Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('Desktop'))) {
  $link=Join-Path $folder '지식서재 서버.lnk'
  if((Test-Path -LiteralPath $link) -and $shell.CreateShortcut($link).TargetPath -ne $exe){throw '이름이 같은 기존 바로가기는 변경하지 않았습니다.'}
 }
 $legacy=Join-Path ([Environment]::GetFolderPath('Startup')) '지식서재 비공개 PDF 연결.lnk'
 if((Test-Path -LiteralPath $legacy) -and -not $shell.CreateShortcut($legacy).Arguments.Contains("Start-ScheduledTask -TaskName 'KnowledgeLibrary-PrivatePDF'")){throw '기존 자동 실행 바로가기를 유지했습니다.'}
 if(@(Get-Process -Name KnowledgeLibraryServer -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $exe}).Count -gt 0){throw '설치한 트레이 아이콘을 닫은 뒤 다시 실행해 주세요.'}
}
function Read-SetupManifest([string]$Folder) {
 $manifest=Get-Content -LiteralPath (Join-Path $Folder 'setup-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($manifest.version -ne 1 -or $manifest.commit -notmatch '^[a-f0-9]{40}$' -or $manifest.sourceSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw '설치 패키지를 확인해 주세요.'}
 $archive=Join-Path $Folder 'library-source.zip'
 if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $manifest.sourceSha256){throw '설치 파일이 손상되었습니다. 다시 받아 주세요.'}
 return $manifest
}
function Get-SetupDownload([string]$Url,[string]$Path,[string]$Hash) {
 if(Test-Path -LiteralPath $Path) {
  if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Hash){return}
  throw '받아 둔 설치 파일의 검증 값이 다릅니다. 다운로드 폴더를 확인해 주세요.'
 }
 $partial=$Path+'.partial'
 Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial -TimeoutSec 180
 if((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Hash){throw '공식 실행 도구 검증에 실패했습니다.'}
 Move-Item -LiteralPath $partial -Destination $Path
}
function Invoke-SetupNative([string]$Exe,[string[]]$Arguments) {
 & $Exe @Arguments
 if($LASTEXITCODE -ne 0){throw '실행 도구 준비에 실패했습니다. 마지막 설치 단계를 다시 시도해 주세요.'}
}
function Write-SetupJson([string]$Path,$Value) {
 $text=$Value | ConvertTo-Json -Depth 8
 [IO.File]::WriteAllText($Path,$text,(New-Object Text.UTF8Encoding($false)))
}
function Test-SetupBuildReady([string]$App,[string]$Stamp) {
 $receipt=Join-Path $App '.setup-build-ready'
 if(-not(Test-Path -LiteralPath $receipt) -or [IO.File]::ReadAllText($receipt).Trim() -ne $Stamp){return $false}
 foreach($file in @('.next\BUILD_ID','.next\build-manifest.json','.next\prerender-manifest.json','.next\routes-manifest.json','.next\server\app-paths-manifest.json')){if(-not(Test-Path -LiteralPath (Join-Path $App $file))){return $false}}
 return $true
}
function Start-PcSetup([string]$File) {
 [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
 $r=Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
 $install=Assert-SetupPath $r.installRoot; $data=Assert-SetupPath $r.dataRoot; $pdf=Assert-SetupPath $r.pdfRoot
 $installDrive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($install))
 if($installDrive.DriveFormat -notin @('NTFS','ReFS')){throw '프로그램은 NTFS 형식의 PC 드라이브에 설치해 주세요. 자료·색인은 외장하드를 사용할 수 있습니다.'}
 if($install -eq $data -or $install -eq $pdf -or $pdf.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase)){throw '설치 폴더는 PDF 원본 폴더와 구분해 주세요.'}
 $origin=[uri]$r.origin
 if($origin.Scheme -ne 'https' -or $origin.DnsSafeHost -notmatch '^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$' -or $origin.Port -ne 443 -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo){throw '새 PC의 Tailscale 주소를 확인해 주세요.'}
 $package=$PSScriptRoot
 $m=Read-SetupManifest $package
 $marker=Join-Path $install 'setup-owner.json'
 if(Test-Path -LiteralPath $install) {
  if(Test-Path -LiteralPath $marker) {$owner=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json;if($owner.product -ne 'KnowledgeLibraryPC'){throw '다른 프로그램의 설치 폴더입니다.'}}
  elseif(@(Get-ChildItem -LiteralPath $install -Force).Count -gt 0){throw '비어 있는 전용 설치 폴더를 선택해 주세요.'}
 }
 $nodeHome=Join-Path $install 'runtime\node-v24.22.0-win-x64'; $node=Join-Path $nodeHome 'node.exe'
 $pythonHome=Join-Path $install 'runtime\python-3.13.16'; $python=Join-Path $pythonHome 'python.exe'
 $launcher=Join-Path $install 'start-private-pc.mjs'
 $taskSpec=Get-SetupTaskSpec $install
 $existing=Get-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' -ErrorAction SilentlyContinue
 Assert-SetupTask $existing $taskSpec.Execute $taskSpec.Arguments
 Assert-SetupTray $install
 if($existing -and $existing.Settings.Enabled){throw '기존 트레이에서 서버 중지를 선택한 뒤 설치를 다시 진행해 주세요.'}
 if(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue){throw '서버가 이미 실행 중이거나 포트 3001이 사용 중입니다. 기존 프로그램은 종료하지 않았습니다.'}
 Write-Output 'STEP|설치 파일·폴더 확인'
 if(-not(Test-Path -LiteralPath $r.profileFile)){throw '암호화 연결 정보를 다시 불러와 주세요.'}
 $profile=Get-Content -LiteralPath $r.profileFile -Raw -Encoding UTF8 | ConvertFrom-Json
 if($profile.protection -ne 'DPAPI-CurrentUser' -or -not $profile.protected){throw '이 Windows 사용자의 연결 설정이 필요합니다.'}
 New-Item -ItemType Directory -Path $install -Force | Out-Null
 if(-not(Test-Path -LiteralPath $marker)){Write-SetupJson $marker @{product='KnowledgeLibraryPC';id=[guid]::NewGuid().ToString();created=[datetime]::UtcNow.ToString('o')}}
 $owner=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
 if($owner.id -notmatch '^[a-fA-F0-9-]{36}$'){throw '설치 소유 정보가 잘못되었습니다.'}
 $runtime=Join-Path $install 'runtime'; $releaseParent=Join-Path $install 'releases'; $app=Join-Path $releaseParent $m.commit.Substring(0,12)
 $op=Join-Path $data ('private-data\operations\pc-'+$owner.id)
 $cache=Join-Path $data 'private-data\runtime\pc-setup-cache'; $temp=Join-Path $op 'tmp'
 foreach($dir in @($runtime,$releaseParent,$op,$cache,$temp)){New-Item -ItemType Directory -Path $dir -Force | Out-Null}
 $lock=[IO.File]::Open((Join-Path $install 'setup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try {
  $env:TEMP=$temp;$env:TMP=$temp;$env:SQLITE_TMPDIR=$temp;$env:PIP_CACHE_DIR=Join-Path $cache 'pip';$env:npm_config_cache=Join-Path $cache 'npm';$env:NEXT_TELEMETRY_DISABLED='1';$env:PYTHONUTF8='1'
  # Dependencies and build never receive the imported DB/API credentials.
  Write-Output 'STEP|독립 실행 도구 준비'
  $nodeZip=Join-Path $cache 'node-v24.22.0-win-x64.zip'
  Get-SetupDownload 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip' $nodeZip 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'
  Install-SetupRuntime $nodeZip $runtime 'node-v24.22.0-win-x64' 'node-v24.22.0-win-x64' 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'
  $pythonZip=Join-Path $cache 'python-3.13.16-amd64.zip'
  Get-SetupDownload 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.zip' $pythonZip 'bbf675bb5e763c1efbb09a3a461b259d81598a63c30c4b0d7ea11b9f063df159'
  Install-SetupRuntime $pythonZip $runtime 'python-3.13.16' '' 'bbf675bb5e763c1efbb09a3a461b259d81598a63c30c4b0d7ea11b9f063df159'
  $env:PATH=$nodeHome+[IO.Path]::PathSeparator+$env:PATH
  foreach($exe in @($node,$python)){if(-not(Test-Path -LiteralPath $exe)){throw '실행 도구가 없습니다.'}}
  $pythonSignature=Get-AuthenticodeSignature -LiteralPath $python
  if($pythonSignature.Status -ne 'Valid' -or $pythonSignature.SignerCertificate.Subject -notmatch 'O=Python Software Foundation'){throw 'Python 공식 서명을 확인하지 못했습니다.'}
  Write-Output 'STEP|지식서재 코드 준비'
  $receipt=Join-Path $app '.setup-source-sha256'
  if(Test-Path -LiteralPath $app) {
   if(-not(Test-Path -LiteralPath $receipt) -or (Get-Content -LiteralPath $receipt -Raw).Trim() -ne $m.sourceSha256){throw '기존 코드 폴더는 변경하지 않았습니다. 새 설치 폴더를 선택해 주세요.'}
  } else {
   $staging=Join-Path $releaseParent ('unpack-'+[guid]::NewGuid().ToString())
   Expand-SetupZip (Join-Path $package 'library-source.zip') $staging
   [IO.File]::WriteAllText((Join-Path $staging '.setup-source-sha256'),$m.sourceSha256)
   Move-SetupDirectory $staging $app $releaseParent
  }
  $npm=Join-Path $nodeHome 'node_modules\npm\bin\npm-cli.js'
  Push-Location -LiteralPath $app
  try {
   Write-Output 'STEP|PDF·OCR 도구 설치'
   Invoke-SetupNative $python @('-m','pip','install','--disable-pip-version-check','-r',(Join-Path $app 'scripts\requirements-pdf.txt'),'-r',(Join-Path $app 'scripts\requirements-ocr.txt'))
   Write-Output 'STEP|앱 구성 요소 설치·빌드'
   if(-not(Test-Path -LiteralPath (Join-Path $app '.setup-npm-ready'))) {
    Invoke-SetupNative $node @($npm,'ci','--no-audit','--no-fund')
    [IO.File]::WriteAllText((Join-Path $app '.setup-npm-ready'),$m.commit)
   }
   if(-not(Test-SetupBuildReady $app $m.sourceSha256)){
    Invoke-SetupNative $node @($npm,'run','build')
    [IO.File]::WriteAllText((Join-Path $app '.setup-build-ready'),$m.sourceSha256)
    if(-not(Test-SetupBuildReady $app $m.sourceSha256)){throw '앱 빌드의 최종 파일을 확인하지 못했습니다.'}
   }
  } finally {Pop-Location}
  Write-Output 'STEP|PC 연결 설정 저장'
  $protectedFile=Join-Path $install 'connection.dpapi.json'
  Copy-Item -LiteralPath $r.profileFile -Destination $protectedFile -Force
  $acl=New-Object Security.AccessControl.FileSecurity
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
  Set-Acl -LiteralPath $protectedFile -AclObject $acl
  $stateFile=Join-Path $op 'runtime.json'
  $config=@{app=$app;node=$node;python=$python;dataRoot=$data;pdfRoot=$pdf;index=(Join-Path $data '색인\pdf-library.sqlite');origin=$origin.GetLeftPart([UriPartial]::Authority);port=3001;runtimeFile=$stateFile;profileFile=$protectedFile;temp=$temp;operations=$op}
  Write-SetupJson (Join-Path $install 'pc-runtime.json') $config
  Copy-Item -LiteralPath (Join-Path $package 'start-private-pc.mjs') -Destination $launcher -Force
  Copy-Item -LiteralPath (Join-Path $package 'start-private-pc.ps1') -Destination (Join-Path $install 'start-private-pc.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $package 'KnowledgeLibraryHost.exe') -Destination (Join-Path $install 'KnowledgeLibraryHost.exe') -Force
  Write-Output 'STEP|트레이·자동 실행 등록'
  $taskAction=New-ScheduledTaskAction -Execute $taskSpec.Execute -Argument $taskSpec.Arguments -WorkingDirectory $install
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $login=New-ScheduledTaskTrigger -AtLogOn -User $user
  $retry=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $beforeXml=if($existing){Export-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF'}else{$null}
  if($beforeXml){$beforeXml | Set-Content -LiteralPath (Join-Path $op ('task-before-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.xml')) -Encoding Unicode}
  $settings.Enabled=$false
  $taskRegistered=$false;$trayInstalled=$false;$installed=$false
  try {
   Register-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' -Action $taskAction -Trigger @($login,$retry) -Settings $settings -Principal $principal -Force | Out-Null
   $taskRegistered=$true
   & (Join-Path $package 'install.ps1') -BuildDirectory $package -InstallDirectory (Join-Path $install 'tray') -RuntimeFile $stateFile -AppRoot $releaseParent -DataFolder $pdf -Url $config.origin | Out-Null
   $trayInstalled=$true
   Enable-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' | Out-Null
   Start-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF'
   $ready=$false
   for($i=0;$i -lt 40;$i++){try{$reply=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/' -TimeoutSec 2;$ready=$reply.StatusCode -eq 200;if($ready){break}}catch{};Start-Sleep -Milliseconds 500}
   if(-not $ready){throw '서버 응답을 확인하지 못했습니다. 연결 설정과 설치 기록을 확인해 주세요.'}
   $installed=$true
  }finally {
   if($taskRegistered -and -not $installed) {
    $now=Get-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF'
    Assert-SetupTask $now $taskSpec.Execute $taskSpec.Arguments
    Disable-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' | Out-Null
    if($trayInstalled){$stop=Start-Process -FilePath (Join-Path $install 'tray\KnowledgeLibraryServer.exe') -ArgumentList '--command stop' -WindowStyle Hidden -Wait -PassThru;if($stop.ExitCode -ne 0){throw '설치한 서버 중지를 확인해 주세요. 자동 재실행은 중지했습니다.'}}
    if($beforeXml){Register-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' -Xml $beforeXml -Force | Out-Null}
    else{Unregister-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF' -Confirm:$false}
   }
  }
  Start-Process -FilePath (Join-Path $install 'tray\KnowledgeLibraryServer.exe') -WindowStyle Hidden
  Write-SetupJson (Join-Path $install 'setup-result.json') @{installed=$true;commit=$m.commit;origin=$config.origin;checked=[datetime]::UtcNow.ToString('o');remaining=@('Tailscale 연결과 로그인 허용 주소 확인','Google 로그인 후 PDF 원문 확인')}
  Write-Output 'DONE|설치 완료 · Tailscale 연결과 Google 로그인을 확인해 주세요.'
 } finally {$lock.Dispose()}
}
if(-not $NoRun) {
 try {try{[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)}catch{};Start-PcSetup $RequestPath}
 catch {Write-Output ('ERROR|'+$_.Exception.Message);exit 1}
}

#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$Python,
 [Parameter(Mandatory)][string]$Root,
 [string]$Index='',
 [string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'KnowledgeLibrary\PdfLibrary'),
 [switch]$PreparePython,
 [switch]$NoShortcut,
 [switch]$StartWithWindows,
 [switch]$Start
)
$ErrorActionPreference='Stop'
$install=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$pdfRoot=[IO.Path]::GetFullPath($Root).TrimEnd('\')
if($install.Equals($pdfRoot,[StringComparison]::OrdinalIgnoreCase) -or $install.StartsWith($pdfRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw '설치 폴더는 PDF 저장소 밖에 지정하세요.'}
if(!(Test-Path -LiteralPath $Python -PathType Leaf)){throw 'Python 3.12 이상 실행 파일을 지정하세요.'}
if(!(Test-Path -LiteralPath $pdfRoot -PathType Container)){throw 'PDF 저장소를 연결한 뒤 설치하세요.'}
if($Index -and !(Test-Path -LiteralPath $Index -PathType Leaf)){throw '기존 색인 파일을 확인하거나 Index를 생략하세요.'}
if($Index){$Index=(Resolve-Path -LiteralPath $Index).Path}
foreach($target in @($install,$pdfRoot)){
 $parent=$target
 while($parent){if((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '연결/바로가기 폴더를 제외한 실제 설치 및 PDF 폴더를 지정하세요.'};$parent=[IO.Path]::GetDirectoryName($parent)}
}
$marker=Join-Path $install 'pdf-library-install.json'
if((Test-Path -LiteralPath $install) -and !(Test-Path -LiteralPath $marker)){throw '다른 파일을 보호하기 위해 새 빈 설치 경로를 지정하세요.'}
if(Test-Path -LiteralPath $marker){$old=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json;if($old.application -ne 'KnowledgeLibrary.PdfLibrary'){throw 'PDF 서재 설치 소유 정보를 확인하지 못했습니다.'}}
[IO.Directory]::CreateDirectory($install)|Out-Null
# Current-user private state; never changes permissions on the PDF root or old installation.
$acl=Get-Acl -LiteralPath $install
$acl.SetAccessRuleProtection($true,$false)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.SetAccessRule($rule);Set-Acl -LiteralPath $install -AclObject $acl
@{application='KnowledgeLibrary.PdfLibrary';version=1;setupState='preparing'}|ConvertTo-Json|Set-Content -LiteralPath $marker -Encoding UTF8
$state=Join-Path $install 'state';[IO.Directory]::CreateDirectory($state)|Out-Null
$release=Join-Path $install ('releases\'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$app=Join-Path $release 'desktop\pdf-library';$scripts=Join-Path $release 'scripts'
[IO.Directory]::CreateDirectory($app)|Out-Null;[IO.Directory]::CreateDirectory($scripts)|Out-Null
Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object {($_.Extension -eq '.py' -and $_.Name -notmatch '^(test_|smoke\.py$)') -or $_.Extension -eq '.cs' -or $_.Name -in @('Build.ps1','Connect-PdfLibrary.ps1','README.md')} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $app}
$sourceScripts=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts'))
Get-ChildItem -LiteralPath $sourceScripts -File | Where-Object {$_.Name -like 'pdf_*.py' -or $_.Name -in @('requirements-pdf.txt','requirements-ocr.txt')} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $scripts}
$interpreter=(Resolve-Path -LiteralPath $Python).Path
if($PreparePython){
 $venv=Join-Path $install 'runtime'
 if(!(Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))){& $interpreter -m venv $venv;if($LASTEXITCODE){throw 'Python 환경 생성 실패'}}
 $interpreter=Join-Path $venv 'Scripts\python.exe'
 & $interpreter -m pip install --disable-pip-version-check -r (Join-Path $scripts 'requirements-pdf.txt') -r (Join-Path $scripts 'requirements-ocr.txt')
 if($LASTEXITCODE){throw 'PDF/OCR 도구 설치 실패. 기존 PDF와 색인은 변경하지 않았습니다.'}
}
& $interpreter -B -c "import sys; assert sys.version_info >= (3,12); import pypdfium2,PIL; from winrt.windows.media.ocr import OcrEngine; assert len(OcrEngine.available_recognizer_languages)>0"
if($LASTEXITCODE){throw 'PDF/OCR 도구가 필요합니다. Python 3.12 이상과 Windows OCR 언어를 확인하고 -PreparePython으로 설치하세요.'}
$exe=Join-Path $app 'PdfDesktop.exe'
& (Join-Path $app 'Build.ps1') -Output $exe
$config=Join-Path $install 'library.json'
@{version=1;python=$interpreter;worker=(Join-Path $app 'worker.py');index=$Index;root=$pdfRoot;directory=$state} | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
$files=Get-ChildItem -LiteralPath $release -Recurse -File | ForEach-Object {[pscustomobject]@{path=$_.FullName.Substring($release.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}}
@{application='KnowledgeLibrary.PdfLibrary';version=1;setupState='ready';installedAt=[DateTime]::UtcNow.ToString('o');release=$release;files=@($files)}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $marker -Encoding UTF8
$shell=New-Object -ComObject WScript.Shell
function New-PdfShortcut([string]$path){$link=$shell.CreateShortcut($path);$link.TargetPath=$exe;$link.Arguments='--config "'+$config+'"';$link.WorkingDirectory=$app;$link.Description='전자도서관 PDF 서재';$link.Save()}
New-PdfShortcut (Join-Path $install 'PdfLibrary.lnk')
if(!$NoShortcut){New-PdfShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) '전자도서관 PDF 서재.lnk')}
if($StartWithWindows){New-PdfShortcut (Join-Path ([Environment]::GetFolderPath('Startup')) '전자도서관 PDF 서재.lnk')}
if($Start){Start-Process -FilePath $exe -ArgumentList @('--config',('"'+$config+'"'))}
Write-Output '설치 완료 · PDF 서재 바로가기로 시작하세요. 웹 연결은 앱의 웹 연결 설정에서 선택할 수 있습니다.'

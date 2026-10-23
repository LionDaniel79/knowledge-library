param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$output=[IO.Path]::GetFullPath($OutputDirectory)
$package=Join-Path $output 'KnowledgeLibrary-PC-Setup'
if(Test-Path -LiteralPath $package){throw '새 출력 폴더를 지정해 주세요. 기존 설치 꾸러미는 덮어쓰지 않습니다.'}
Push-Location -LiteralPath $repo
try {
 $dirty=@(git status --porcelain --untracked-files=normal)
 if($dirty.Count -gt 0){throw '배포할 변경을 모두 먼저 커밋해 주세요. 설치 꾸러미에는 커밋된 소스만 포함합니다.'}
 $commit=(git rev-parse HEAD).Trim()
 New-Item -ItemType Directory -Path $package -Force | Out-Null
 & (Join-Path $PSScriptRoot 'build-setup.ps1') -OutputDirectory $package
 & (Join-Path $PSScriptRoot 'build.ps1') -OutputDirectory (Join-Path $output 'tray-build')
 foreach($name in @('KnowledgeLibraryServer.exe','KnowledgeLibraryHost.exe','library.ico')){Copy-Item -LiteralPath (Join-Path (Join-Path $output 'tray-build') $name) -Destination $package}
 $source=Join-Path $package 'library-source.zip'
 & git archive --format=zip ("--output="+$source) $commit
 if($LASTEXITCODE -ne 0){throw '소스 꾸러미 생성에 실패했습니다.'}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $zip=[IO.Compression.ZipFile]::OpenRead($source)
 try {
  foreach($entry in $zip.Entries){if($entry.FullName -match '(^|/)(private-data|node_modules|\.git|\.superpowers)/|(^|/)\.env($|/|\.local)|\.dpapi\.json$|\.private\.json$|\.sqlite($|-)'){throw '비공개 파일은 설치 꾸러미에 포함할 수 없습니다.'}}
 }finally{$zip.Dispose()}
 $manifest=@{version=1;commit=$commit;sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash;node='24.22.0';python='3.13.16';built=[datetime]::UtcNow.ToString('o')}
 [IO.File]::WriteAllText((Join-Path $package 'setup-manifest.json'),($manifest|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
 Copy-Item -LiteralPath (Join-Path $repo 'docs/windows-pc-setup.md') -Destination (Join-Path $package '사용안내.md')
 $bundle=Join-Path $output 'KnowledgeLibrary-PC-Setup.zip'
 [IO.Compression.ZipFile]::CreateFromDirectory($package,$bundle)
 Get-FileHash -LiteralPath $bundle -Algorithm SHA256 | Select-Object Path,Hash
}finally{Pop-Location}

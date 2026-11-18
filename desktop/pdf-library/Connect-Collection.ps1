param(
 [Parameter(Mandatory)][string]$Configuration,
 [Parameter(Mandatory)][string]$RuntimeConfiguration,
 [Parameter(Mandatory)][string]$StateDirectory,
 [Parameter(Mandatory)][string]$LegacyReportDirectory,
 [Parameter(Mandatory)][string]$FrontierDirectory,
 [ValidateRange(0,10000)][int]$LogosDailyLimit=300,
 [ValidateRange(0,10000)][int]$PdfDailyLimit=100
)
$ErrorActionPreference='Stop'
# Links an existing private runtime profile. Does not decrypt it, start a worker,
# clear a halt, alter a task, or touch the PDF/index/management databases.
$library=Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
$runtime=Get-Content -LiteralPath $RuntimeConfiguration -Raw -Encoding UTF8 | ConvertFrom-Json
$helper=Join-Path $runtime.app 'desktop\windows\collection-host.mjs'
if(!(Test-Path -LiteralPath $runtime.node -PathType Leaf) -or !(Test-Path -LiteralPath $helper -PathType Leaf)){throw '최신 소스의 수집 실행기와 Node 경로를 확인하세요.'}
$state=[IO.Path]::GetFullPath($StateDirectory)
if(!(Test-Path -LiteralPath $state -PathType Container)){throw '기존 비공개 수집 상태 폴더를 지정하세요. 이 명령은 새 원장을 만들지 않습니다.'}
if($state.Equals([IO.Path]::GetFullPath($library.root),[StringComparison]::OrdinalIgnoreCase) -or $state.StartsWith([IO.Path]::GetFullPath($library.root).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw '상태 폴더는 PDF 원본 폴더 밖에 있어야 합니다.'}
$configPath=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Configuration))) 'collection.json'
$value=@{version=1;node=$runtime.node;host=$helper;runtimeConfiguration=[IO.Path]::GetFullPath($RuntimeConfiguration);libraryConfiguration=[IO.Path]::GetFullPath($Configuration);stateDirectory=$state;legacyReportDirectory=[IO.Path]::GetFullPath($LegacyReportDirectory);frontierDirectory=[IO.Path]::GetFullPath($FrontierDirectory)}
function Save-Json([string]$Path,$Value){
 $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($temp,($Value|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
 if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temp,$Path,$Path+'.previous')}else{[IO.File]::Move($temp,$Path)}
}
Save-Json $configPath $value
$settings=Join-Path $state 'user-settings.json'
if(!(Test-Path -LiteralPath $settings)){Save-Json $settings @{logos=@{dailyLimit=$LogosDailyLimit;paused=$false};pdf=@{dailyLimit=$PdfDailyLimit;paused=$false}}}
Copy-Item -LiteralPath $Configuration -Destination ($Configuration+'.before-collection-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmss')+'.json')
$library|Add-Member -NotePropertyName collectionConfiguration -NotePropertyValue $configPath -Force
Save-Json ([IO.Path]::GetFullPath($Configuration)) $library
Write-Output '수집 메뉴 연결 완료. 기존 실행 앱과 수집기는 변경하지 않았습니다. 다음 앱 실행부터 적용됩니다.'

#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$Configuration,
 [Parameter(Mandatory)][string]$Origin,
 [Security.SecureString]$Token,
 [switch]$ReuseExisting
)
$ErrorActionPreference='Stop'
$originValue=$Origin.Trim().TrimEnd('/')
$uri=$null
if(![Uri]::TryCreate($originValue,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo){throw '경로나 계정 정보를 제외한 HTTPS 웹 주소를 지정하세요.'}
$config=Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
$state=[IO.Path]::GetFullPath($config.directory)
if(!(Test-Path -LiteralPath $state -PathType Container)){throw '앱 설치의 전용 관리 폴더를 찾지 못했습니다.'}
$file=Join-Path $state 'web-device.xml'
if($ReuseExisting){
 $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($originValue)))
 $found=$false
 foreach($folder in @('DeviceKeys','TestDeviceKeys')){
  $existing=Join-Path $env:LOCALAPPDATA ('KnowledgeLibrary\'+$folder+'\'+$hash+'.xml')
  if(Test-Path -LiteralPath $existing -PathType Leaf){$file=$existing;$found=$true;break}
 }
 if(!$found){throw '이 웹 주소에 저장된 기기 키가 없습니다. ReuseExisting을 생략하고 발급된 키를 입력하세요.'}
 $secret=Import-Clixml -LiteralPath $file
} else {
 if($null -eq $Token){$Token=Read-Host '웹에서 발급한 이 PC의 등록 권한 기기 키 (숨김)' -AsSecureString}
 $secret=$Token
}
try{
 $plain=[Net.NetworkCredential]::new('', $secret).Password
 if($plain -cnotmatch '^klw_[A-Za-z0-9_-]{43}$'){throw '웹에서 발급한 기기 키 형식을 확인하세요.'}
 if(!$ReuseExisting){$secret|Export-Clixml -LiteralPath $file}
 @{webOrigin=$originValue;credentialFile=$file}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $state 'web-connection.json') -Encoding UTF8
 Write-Output '연결 설정 저장 완료 · 앱을 다시 열고 웹 서지 일괄 등록을 누르세요.'
} finally {
 Remove-Variable plain -ErrorAction SilentlyContinue
 if($ReuseExisting -and $secret){$secret.Dispose()}
}

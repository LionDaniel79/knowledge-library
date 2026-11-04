param([Parameter(Mandatory)][string]$Output,[switch]$Smoke)
$ErrorActionPreference='Stop'
$framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$refs=@('System.dll','System.Core.dll','System.Security.dll','System.Xml.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll','System.Xaml.dll') | ForEach-Object {
 $path=Join-Path $framework $_
 if(!(Test-Path -LiteralPath $path)){ $path=Join-Path "$framework\WPF" $_ }
 "/reference:$path"
}
$sources=@("$PSScriptRoot\Desktop.cs","$PSScriptRoot\WorkerJob.cs","$PSScriptRoot\DesktopManagement.cs")
$target='/target:winexe'
if($Smoke){$target='/target:exe';$sources+=@('/main:DesktopSmoke',"$PSScriptRoot\DesktopSmoke.cs")}
& "$framework\csc.exe" /nologo $target /platform:x64 /codepage:65001 "/out:$Output" $refs $sources
if($LASTEXITCODE){throw 'WPF 빌드 실패'}

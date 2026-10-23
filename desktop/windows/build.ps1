param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler not found.' }
$source = Join-Path $PSScriptRoot 'KnowledgeLibraryTray.cs'
$tests = Join-Path $PSScriptRoot 'TrayTests.cs'
$references = @('/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Management.dll','/r:System.Web.Extensions.dll','/r:Microsoft.CSharp.dll')
$common = @('/nologo','/codepage:65001','/platform:x64','/optimize+') + $references
$testExe = Join-Path $output 'TrayTests.exe'
& $compiler @common '/target:exe' '/main:TrayTests' ("/out:$testExe") $source $tests
if ($LASTEXITCODE -ne 0) { throw 'Native tray tests did not compile.' }
& $testExe
if ($LASTEXITCODE -ne 0) { throw 'Native tray tests failed.' }
$bootstrap = Join-Path $output 'icon-builder.exe'
& $compiler @common '/target:winexe' '/main:KnowledgeLibrary.Program' ("/out:$bootstrap") $source
if ($LASTEXITCODE -ne 0) { throw 'Icon generator did not compile.' }
$icon = Join-Path $output 'library.ico'
$result = Start-Process -FilePath $bootstrap -ArgumentList @('--write-icon', ('"'+$icon+'"')) -WindowStyle Hidden -Wait -PassThru
if ($result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $icon)) { throw 'Native icon creation failed.' }
$exe = Join-Path $output 'KnowledgeLibraryServer.exe'
& $compiler @common '/target:winexe' '/main:KnowledgeLibrary.Program' ("/win32icon:$icon") ("/out:$exe") $source
if ($LASTEXITCODE -ne 0) { throw 'Tray executable did not compile.' }
$smokeConfig = @{
 TaskName='TrayBuildSmoke'; TaskExecutable=$compiler; TaskArguments='smoke-only'
 RuntimeFile=(Join-Path $output 'not-a-runtime.json'); AppRoot=$output; DataFolder=$output
 Url='http://127.0.0.1:3001'; Port=3001; LogsFolder=$output
}
$smokeConfig | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'tray-config.json') -Encoding UTF8
$smokeInfo = New-Object Diagnostics.ProcessStartInfo
$smokeInfo.FileName=$exe; $smokeInfo.Arguments='--command status'; $smokeInfo.UseShellExecute=$false
$smokeInfo.CreateNoWindow=$true; $smokeInfo.RedirectStandardOutput=$true; $smokeInfo.RedirectStandardError=$true
$smokeInfo.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
$smokeInfo.StandardErrorEncoding=New-Object Text.UTF8Encoding($false)
$smoke = [Diagnostics.Process]::Start($smokeInfo)
try {
 $smokeOutput=$smoke.StandardOutput.ReadToEnd(); $smokeError=$smoke.StandardError.ReadToEnd(); $smoke.WaitForExit()
 if ($smoke.ExitCode -ne 0) { throw "Windowless status command failed: $smokeError" }
 $smokeStatus=$smokeOutput | ConvertFrom-Json
 if ($smokeStatus.Running -or $smokeStatus.Label -ne '서버 중지됨') { throw 'Windowless status output was incorrect.' }
 Write-Output 'PASS windowless UTF-8 status command'
} finally { $smoke.Dispose() }
Write-Output $exe

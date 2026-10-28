param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'test-setup.ps1') -OutputDirectory $OutputDirectory
$output=[IO.Path]::GetFullPath($OutputDirectory)
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe=Join-Path $output 'KnowledgeLibrarySetup.exe'
& $compiler /nologo /codepage:65001 /platform:x64 /target:winexe /main:KnowledgeLibrary.Setup.SetupProgram /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ("/out:$exe") (Join-Path $PSScriptRoot 'SetupCore.cs') (Join-Path $PSScriptRoot 'SetupForm.cs')
if($LASTEXITCODE -ne 0){throw 'Setup executable failed to compile.'}
$ui=Start-Process -FilePath $exe -ArgumentList '--self-test-ui' -WindowStyle Hidden -Wait -PassThru
if($ui.ExitCode -ne 0){throw 'Setup window smoke test failed.'}
Write-Output 'PASS native setup window smoke test'
foreach($name in @('setup-worker.ps1','install-ocr-languages.ps1','install.ps1','start-private-pc.ps1')) {
 # Windows PowerShell 5.1 needs BOM for Korean script text.
 $text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot $name))
 [IO.File]::WriteAllText((Join-Path $output $name),$text,(New-Object Text.UTF8Encoding($true)))
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-private-pc.mjs') -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'catalog-worker.mjs') -Destination $output -Force
Write-Output $exe

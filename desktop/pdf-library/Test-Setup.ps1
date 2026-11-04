param([Parameter(Mandatory)][string]$Python,[string]$SmokeExecutable)
$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('pdf-setup-'+[guid]::NewGuid())
try {
 $root=Join-Path $fixture 'PDF';[IO.Directory]::CreateDirectory($root)|Out-Null
 $target=Join-Path $fixture 'Installed'
 & "$PSScriptRoot/Setup-PdfLibrary.ps1" -Python $Python -Root $root -InstallRoot $target -NoShortcut
 $config=Get-Content -Raw -Encoding UTF8 (Join-Path $target 'library.json')|ConvertFrom-Json
 if($config.index -ne ''){throw 'First-user installation requires a legacy index'}
 if(!(Test-Path -LiteralPath $config.worker)){throw 'Worker bundle absent'}
 if(!(Test-Path -LiteralPath (Join-Path $target 'PdfLibrary.lnk'))){throw 'Launch shortcut absent'}
 $configFile=Join-Path $target 'library.json'
 $secure=ConvertTo-SecureString ('klw_'+('a'*43)) -AsPlainText -Force
 & "$PSScriptRoot/Connect-PdfLibrary.ps1" -Configuration $configFile -Origin 'https://fixture.example.invalid' -Token $secure
 $connection=Get-Content -Raw -Encoding UTF8 (Join-Path $config.directory 'web-connection.json')|ConvertFrom-Json
 $stored=Import-Clixml -LiteralPath $connection.credentialFile
 if([Net.NetworkCredential]::new('', $stored).Password -cne ('klw_'+('a'*43))){throw 'DPAPI credential roundtrip failed'}
 if((Get-Content -Raw -Encoding UTF8 $configFile).Contains('klw_')){throw 'Plain credential in configuration'}
 if($SmokeExecutable){
  $sample=Join-Path $root '기독도서\Setup sample.pdf';[IO.Directory]::CreateDirectory((Split-Path -Parent $sample))|Out-Null
  & $Python -B -c 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from smoke import text_pdf;text_pdf(Path(sys.argv[2]))' $PSScriptRoot $sample
  if($LASTEXITCODE){throw 'Synthetic PDF creation failed'}
  & $SmokeExecutable --config $configFile (Join-Path $fixture 'setup-smoke.png')
  if($LASTEXITCODE){throw 'Installed configuration WPF smoke failed'}
 }
 Write-Output 'PASS standalone setup/no-index/private bundle/shortcut/DPAPI connection'
} finally {
 if($stored){$stored.Dispose()};if($secure){$secure.Dispose()}
 $resolved=[IO.Path]::GetFullPath($fixture)
 if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) {Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue}
}


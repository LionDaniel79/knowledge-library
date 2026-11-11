param([Parameter(Mandatory)][string]$Python,[string]$SmokeExecutable)
$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('pdf-setup-'+[guid]::NewGuid())
try {
 $root=Join-Path $fixture 'PDF';[IO.Directory]::CreateDirectory($root)|Out-Null
 $target=Join-Path $fixture 'Installed'
 & "$PSScriptRoot/Setup-PdfLibrary.ps1" -Python $Python -Root $root -InstallRoot $target -NoShortcut
 $config=Get-Content -Raw -Encoding UTF8 (Join-Path $target 'library.json')|ConvertFrom-Json
 if($config.PSObject.Properties['catalogConfiguration']){throw 'A new installation must not configure a collector automatically'}
 $retainedCatalog=Join-Path $fixture 'catalog 구성.json'
 $config|Add-Member -NotePropertyName catalogConfiguration -NotePropertyValue $retainedCatalog
 $config|Add-Member -NotePropertyName unapprovedRuntimeField -NotePropertyValue 'must-not-copy'
 $config|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $target 'library.json') -Encoding UTF8
 $ssdState=Join-Path $fixture 'private-ssd-state'
 [IO.Directory]::CreateDirectory($ssdState)|Out-Null
 $config.directory=$ssdState
 $config|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $target 'library.json') -Encoding UTF8
 $preserved=Join-Path $config.directory 'upgrade-preservation.txt'
 [IO.File]::WriteAllText($preserved,'preserve existing private state')
 $originalState=$config.directory
 & "$PSScriptRoot/Setup-PdfLibrary.ps1" -Python $Python -Root $root -InstallRoot $target -NoShortcut
 $config=Get-Content -Raw -Encoding UTF8 (Join-Path $target 'library.json')|ConvertFrom-Json
 if($config.directory -ne $originalState -or [IO.File]::ReadAllText($preserved) -ne 'preserve existing private state'){throw 'Upgrade changed private state'}
 if($config.catalogConfiguration -ne $retainedCatalog -or $config.PSObject.Properties['unapprovedRuntimeField']){throw 'Upgrade did not preserve only the optional collector configuration string'}
 if($config.index -ne ''){throw 'First-user installation requires a legacy index'}
 if(!(Test-Path -LiteralPath $config.worker)){throw 'Worker bundle absent'}
 if(!(Test-Path -LiteralPath (Join-Path $target 'PdfLibrary.lnk'))){throw 'Launch shortcut absent'}
 # Exercise the installed bridge and its helper using an image-only PDF. A
 # native-text fixture would bypass Windows OCR and miss omitted bundle files.
 $rasterCheck=@'
import json, os, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
app, root, state = map(Path, sys.argv[1:4])
sys.path.insert(0, str(app))
import management
for name in ('기독도서', '일반도서'):
    (root / name).mkdir(exist_ok=True)
path = root / '기독도서' / 'Raster OCR fixture.pdf'
with Image.new('RGB', (1500, 800), 'white') as image:
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(Path(os.environ['WINDIR']) / 'Fonts' / 'arial.ttf'), 74)
    draw.multiline_text((90, 140), 'LIBRARY RASTER OCR\nWINDOWS ENGINE READY\nREADING TEST 2026', font=font, fill='black', spacing=42)
    image.save(path, 'PDF', resolution=150)
import pypdfium2
with pypdfium2.PdfDocument(str(path)) as pdf:
    page = pdf[0]
    try:
        textpage = page.get_textpage()
        try:
            assert not textpage.get_text_bounded().strip(), 'Fixture must have no embedded text'
        finally:
            textpage.close()
    finally:
        page.close()
management.scan(root, state)
result = management.ocr_step(state)
assert result['state'] == 'done', 'Installed raster OCR did not finish: ' + json.dumps(result)
hits = management.search(state, 'LIBRARY')['hits']
assert hits and all(hit['method'] != 'PDFium' for hit in hits), 'Windows OCR did not recognize the raster fixture'
assert all('body-footnotes-300dpi-v5' in hit['method'] for hit in hits), 'Installed OCR bypassed the quality profile'
for name in ('management', 'quality_recognition', 'pdf_ocr_quality', 'pdf_ocr', 'pdf_ocr_languages', 'pdf_ocr_pipeline', 'pdf_library', 'pdf_job_state'):
    assert Path(sys.modules[name].__file__).resolve().is_relative_to(app.parents[1]), 'OCR imported outside the installed bundle: ' + name
assert not management.status(state)['paused'], 'Healthy installed engine must remain ready'
print('PASS installed image-only PDF / Windows OCR quality profile / recognized search / private bundle imports')
'@
 & $config.python -B -c $rasterCheck (Split-Path -Parent $config.worker) $root $config.directory
 if($LASTEXITCODE){throw 'Installed raster OCR pipeline failed'}
 $configFile=Join-Path $target 'library.json'
 $secure=ConvertTo-SecureString ('klw_'+('a'*43)) -AsPlainText -Force
 & "$PSScriptRoot/Connect-PdfLibrary.ps1" -Configuration $configFile -Origin 'https://fixture.example.invalid' -Token $secure
 $connection=Get-Content -Raw -Encoding UTF8 (Join-Path $config.directory 'web-connection.json')|ConvertFrom-Json
 $stored=Import-Clixml -LiteralPath $connection.credentialFile
 if([Net.NetworkCredential]::new('', $stored).Password -cne ('klw_'+('a'*43))){throw 'DPAPI credential roundtrip failed'}
 if((Get-Content -Raw -Encoding UTF8 $configFile).Contains('klw_')){throw 'Plain credential in configuration'}
 if($SmokeExecutable){
  $fakeApp=Join-Path $fixture 'Fake catalog 앱';$fakeModules=Join-Path $fakeApp 'desktop\windows'
  [IO.Directory]::CreateDirectory($fakeModules)|Out-Null
  $fakeCollector=@'
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),config=JSON.parse(readFileSync(args[args.indexOf('--config')+1],'utf8').replace(/^\uFEFF/,''));
const blocked=['OPENAI_API_KEY','DATABASE_URL','NEON_AUTH_BASE_URL','NEON_AUTH_COOKIE_SECRET','LIBRARY_DEVICE_TOKEN','NODE_OPTIONS','LIBRARY_PDF_ROOT','LIBRARY_PDF_INDEX'];
const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
writeFileSync(config.probeFile,JSON.stringify({parent:process.pid,child:child.pid,unsafeEnvironment:blocked.some(key=>Boolean(process.env[key])),validArguments:args.length===4&&args[0]==='--config'&&args[2]==='--notification'&&args[3]===config.expectedNotification}));
setInterval(()=>{},1000);
'@
  [IO.File]::WriteAllText((Join-Path $fakeModules 'catalog-detached.mjs'),$fakeCollector,(New-Object Text.UTF8Encoding($false)))
  $fakeRuntime=@{node=(Get-Command node -ErrorAction Stop).Source;app=$fakeApp;profileFile='must-not-unlock.dpapi.json';probeFile=(Join-Path $config.directory 'catalog-sidecar-probe.json');expectedNotification=(Join-Path $config.directory 'catalog-request.json')}
  [IO.File]::WriteAllText($retainedCatalog,($fakeRuntime|ConvertTo-Json),(New-Object Text.UTF8Encoding($true)))
  $config|Add-Member -NotePropertyName catalogSmokeProbe -NotePropertyValue 'active'
  $config|ConvertTo-Json|Set-Content -LiteralPath $configFile -Encoding UTF8
  $sample=Join-Path $root '기독도서\Setup sample.pdf';[IO.Directory]::CreateDirectory((Split-Path -Parent $sample))|Out-Null
  & $Python -B -c 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from smoke import text_pdf;text_pdf(Path(sys.argv[2]))' $PSScriptRoot $sample
  if($LASTEXITCODE){throw 'Synthetic PDF creation failed'}
  $sentinels=@{}
  foreach($key in @('OPENAI_API_KEY','DATABASE_URL','NEON_AUTH_BASE_URL','NEON_AUTH_COOKIE_SECRET','LIBRARY_DEVICE_TOKEN','NODE_OPTIONS','LIBRARY_PDF_ROOT','LIBRARY_PDF_INDEX')){$sentinels[$key]=[Environment]::GetEnvironmentVariable($key,'Process');[Environment]::SetEnvironmentVariable($key,'secret-sentinel','Process')}
  try{& $SmokeExecutable --config $configFile (Join-Path $fixture 'setup-smoke.png')}
  finally{foreach($key in $sentinels.Keys){[Environment]::SetEnvironmentVariable($key,$sentinels[$key],'Process')}}
  if($LASTEXITCODE){throw 'Installed configuration WPF smoke failed'}
  foreach($file in @((Join-Path $config.directory 'catalog-sidecar-probe.json'),(Join-Path $config.directory 'catalog-request.json'),(Join-Path $root 'UI smoke new copy.pdf'))){if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}}
  $fakeRuntime.node=Join-Path $fixture 'missing-node.exe'
  [IO.File]::WriteAllText($retainedCatalog,($fakeRuntime|ConvertTo-Json),(New-Object Text.UTF8Encoding($true)))
  $config.catalogSmokeProbe='invalid';$config|ConvertTo-Json|Set-Content -LiteralPath $configFile -Encoding UTF8
  & $SmokeExecutable --config $configFile (Join-Path $fixture 'setup-invalid-collector-smoke.png')
  if($LASTEXITCODE){throw 'Invalid optional collector blocked local WPF workflows'}
 }
 Write-Output 'PASS standalone setup/no-index/private bundle/shortcut/DPAPI connection'
} finally {
 if($stored){$stored.Dispose()};if($secure){$secure.Dispose()}
 $resolved=[IO.Path]::GetFullPath($fixture)
 if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) {Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue}
}


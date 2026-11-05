param([Parameter(Mandatory)][string]$Python,[string]$SmokeExecutable)
$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('pdf-setup-'+[guid]::NewGuid())
try {
 $root=Join-Path $fixture 'PDF';[IO.Directory]::CreateDirectory($root)|Out-Null
 $target=Join-Path $fixture 'Installed'
 & "$PSScriptRoot/Setup-PdfLibrary.ps1" -Python $Python -Root $root -InstallRoot $target -NoShortcut
 $config=Get-Content -Raw -Encoding UTF8 (Join-Path $target 'library.json')|ConvertFrom-Json
 $preserved=Join-Path $config.directory 'upgrade-preservation.txt'
 [IO.File]::WriteAllText($preserved,'preserve existing private state')
 $originalState=$config.directory
 & "$PSScriptRoot/Setup-PdfLibrary.ps1" -Python $Python -Root $root -InstallRoot $target -NoShortcut
 $config=Get-Content -Raw -Encoding UTF8 (Join-Path $target 'library.json')|ConvertFrom-Json
 if($config.directory -ne $originalState -or [IO.File]::ReadAllText($preserved) -ne 'preserve existing private state'){throw 'Upgrade changed private state'}
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
for name in ('management', 'sandbox', 'pdf_ocr', 'pdf_ocr_languages', 'pdf_ocr_pipeline', 'pdf_library', 'pdf_job_state'):
    assert Path(sys.modules[name].__file__).resolve().is_relative_to(app.parents[1]), 'OCR imported outside the installed bundle: ' + name
assert not management.status(state)['paused'], 'Healthy installed engine must remain ready'
print('PASS installed image-only PDF / Windows OCR helper / recognized search / private bundle imports')
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


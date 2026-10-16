"""Exercise the real supervisor with fake OCR state and no network/DB writes."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

PWSH = shutil.which('pwsh') or str(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')


@unittest.skipUnless(Path(PWSH).is_file(), 'PowerShell 7 is required')
class PrioritySupervisorTests(unittest.TestCase):
    def run_case(self, scenario):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'scripts').mkdir()
            (root/'output').mkdir()
            previous=root/'output/0002-isbn_priority.log';previous.write_text('prior run evidence')
            shutil.copyfile(Path(__file__).with_name('continue-priority-catalog.ps1'),root/'scripts/continue-priority-catalog.ps1')
            (root/'index.ocr-status.json').write_text(json.dumps({'status':'running','pid':123,'counts':{'front_back':0}}))
            harness=r'''
param([string]$Case)
$global:caseName=$Case
$global:isbnCalls=0
$global:ocrPath=Join-Path $PSScriptRoot 'index.ocr-status.json'
$global:eventsPath=Join-Path $PSScriptRoot 'events.txt'
function global:Get-CimInstance { param($ClassName,$Filter)
  if($Filter -like 'ProcessId=*') { [pscustomobject]@{CommandLine='python scripts/pdf_ocr.py'} }
}
function global:Start-Sleep { throw 'Unexpected sleep: work completed during the scan must be processed now.' }
function global:node {
  $step=[string]($args|Where-Object {$_ -like 'scripts/*.ts'})
  Add-Content -LiteralPath $global:eventsPath -Value ($step+$(if($args -contains '--isbn-only'){' isbn'}else{''}))
  if($args -contains '--book-ids') {
    Add-Content -LiteralPath $global:eventsPath -Value ('target='+$args[[array]::IndexOf($args,'--book-ids')+1])
  }
  $global:LASTEXITCODE=0
  if($step -like '*collect-catalog*') {'{"stopped":"complete","pending":0,"requests":0,"applied":0}';return}
  if($global:caseName -eq 'targeted' -and $step -like '*identify-pdfs*') {
    '{"status":"completed","pid":123,"counts":{"front_back":1}}'|Set-Content -LiteralPath $global:ocrPath
    if($args -contains '--ready-only') {
      '{"stopped":"complete","applied":1,"appliedBookIds":["11111111-1111-4111-8111-111111111111"]}';return
    }
  }
  if($step -like '*identify-pdfs*' -and $args -contains '--isbn-only') {
    $global:isbnCalls++
    if($global:isbnCalls -eq 1) {
      if($global:caseName -eq 'edges_during_scan') {
        '{"status":"running","pid":123,"counts":{"front_back":1}}'|Set-Content -LiteralPath $global:ocrPath
      } elseif($global:caseName -eq 'pause_after_isbn') {
        '{"status":"paused","pid":123,"counts":{"front_back":0}}'|Set-Content -LiteralPath $global:ocrPath
        '{"stopped":"batch_limit","applied":0}';return
      }
    } else {
      if($global:caseName -ne 'edges_during_scan') {throw 'A new batch started after pause.'}
      '{"status":"completed","pid":123,"counts":{"front_back":1}}'|Set-Content -LiteralPath $global:ocrPath
    }
  } elseif($step -like '*identify-pdfs*' -and $args -contains '--ready-only' -and $global:caseName -eq 'pause_after_title') {
    '{"status":"failed","pid":123,"counts":{"front_back":0}}'|Set-Content -LiteralPath $global:ocrPath
    '{"stopped":"batch_limit","applied":0}';return
  }
  '{"stopped":"complete","applied":0}'
}
& (Join-Path $PSScriptRoot 'scripts/continue-priority-catalog.ps1') -IndexPath (Join-Path $PSScriptRoot 'index.sqlite') -OutputDirectory (Join-Path $PSScriptRoot 'output') -PreservationBaseline 'fake-baseline.json'
'''
            (root/'test.ps1').write_text(harness,encoding='utf-8')
            subprocess.run([PWSH,'-NoProfile','-File',str(root/'test.ps1'),scenario],capture_output=True,timeout=20)
            events=(root/'events.txt').read_text(encoding='utf-8-sig').splitlines()
            state=json.loads((root/'output/queue-status.json').read_text(encoding='utf-8-sig'))
            self.assertEqual(previous.read_text(),'prior run evidence')
            return events,state

    def test_last_edges_completed_during_scan_do_not_wait_for_body(self):
        events,state=self.run_case('edges_during_scan')
        self.assertEqual(events.count('scripts/identify-pdfs.ts isbn'),2)
        self.assertEqual(state['phase'],'complete')

    def test_pause_during_isbn_batch_stops_before_next_batch(self):
        events,state=self.run_case('pause_after_isbn')
        self.assertEqual(events.count('scripts/identify-pdfs.ts isbn'),1)
        self.assertEqual(state['phase'],'stopped_error')

    def test_failure_during_title_batch_stops_before_next_batch(self):
        events,state=self.run_case('pause_after_title')
        self.assertEqual(events.count('scripts/identify-pdfs.ts isbn'),1)
        self.assertEqual(state['phase'],'stopped_error')

    def test_each_identity_pass_classifies_only_newly_applied_books(self):
        events,state=self.run_case('targeted')
        self.assertEqual(state['phase'],'complete')
        self.assertEqual(events.count('target=11111111-1111-4111-8111-111111111111'),2)
        self.assertEqual(events.count('scripts/adopt-collected-classifications.ts'),3)


if __name__=='__main__':unittest.main()

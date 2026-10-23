$ErrorActionPreference='Stop'
try {
 foreach($language in @('ko-KR','en-US')) {
  $name='Language.OCR~~~'+$language+'~0.0.1.0'
  $current=Get-WindowsCapability -Online -Name $name
  if($current.State -ne 'Installed'){$result=Add-WindowsCapability -Online -Name $name;if($result.RestartNeeded){$restart=$true}}
 }
 if($restart){exit 3010}
 exit 0
}catch{exit 1}

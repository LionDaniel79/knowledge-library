param([Parameter(Mandatory=$true)][string]$TestRoot,[Parameter(Mandatory=$true)][string]$BuildDirectory,[Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'setup-worker.ps1') -NoRun
$root=Join-Path ([IO.Path]::GetFullPath($TestRoot)) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root -Force | Out-Null
$wrapper=Join-Path $root 'start-private-pc.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-private-pc.ps1') -Destination $wrapper
$hostFile=Join-Path $BuildDirectory 'KnowledgeLibraryHost.exe'
if(Test-Path -LiteralPath $hostFile){Copy-Item -LiteralPath $hostFile -Destination $root}
$entry=Join-Path $root 'start-private-pc.mjs'
[IO.File]::WriteAllText($entry,'// isolated console-allocation probe')
$probe=Join-Path $root 'fixture-node.exe'
$code=@'
using System;using System.IO;using System.Runtime.InteropServices;using System.Threading;
public class ConsoleProbe {
 [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
 public static int Main(string[] args) {
  File.AppendAllText("starts.txt","start\n");
  File.WriteAllText("console.txt",GetConsoleWindow().ToInt64().ToString());
  Console.WriteLine("launcher stdout");Console.Error.WriteLine("launcher stderr");
  Thread.Sleep(1200);return 7;
 }
}
'@
Add-Type -TypeDefinition $code -OutputAssembly $probe -OutputType ConsoleApplication
Write-SetupJson (Join-Path $root 'pc-runtime.json') @{node=$probe}
$spec=Get-SetupTaskSpec $root
$p=Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
if(-not $p.WaitForExit(12000)){throw 'Fixture did not finish'}
if((Get-Content -LiteralPath (Join-Path $root 'console.txt') -Raw).Trim() -ne '0'){throw 'FAIL: server still inherits or allocates a console window'}
if($p.ExitCode -ne 7){throw 'FAIL: launcher did not preserve server exit code'}
if((Get-Content -LiteralPath (Join-Path $root 'launcher.out.log') -Raw) -notmatch 'launcher stdout'){throw 'FAIL: stdout log missing'}
if((Get-Content -LiteralPath (Join-Path $root 'launcher.err.log') -Raw) -notmatch 'launcher stderr'){throw 'FAIL: stderr log missing'}
$before=@(Get-Content -LiteralPath (Join-Path $root 'starts.txt')).Count
$a=Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
for($i=0;$i -lt 50;$i++){if(@(Get-Content -LiteralPath (Join-Path $root 'starts.txt')).Count -gt $before){break};Start-Sleep -Milliseconds 30}
$b=Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
if(-not $b.WaitForExit(8000) -or -not $a.WaitForExit(8000)){throw 'FAIL: duplicate host did not finish'}
if(@(Get-Content -LiteralPath (Join-Path $root 'starts.txt')).Count -ne ($before+1)){throw 'FAIL: duplicate server launched'}
Rename-Item -LiteralPath (Join-Path $root 'pc-runtime.json') -NewName 'fixture-runtime.saved.json'
$legacyArguments=$spec.Arguments+' --node '+(Quote-SetupArgument $probe)
$legacy=Start-Process -FilePath $spec.Execute -ArgumentList $legacyArguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
if(-not $legacy.WaitForExit(8000) -or $legacy.ExitCode -ne 7){throw 'FAIL: legacy explicit Node path failed'}
if((Get-Content -LiteralPath (Join-Path $root 'console.txt') -Raw).Trim() -ne '0'){throw 'FAIL: legacy server acquired a console'}
$bad=Start-Process -FilePath $spec.Execute -ArgumentList ('--launcher '+(Quote-SetupArgument (Join-Path $root 'outside.mjs'))+' --node '+(Quote-SetupArgument $probe)) -WorkingDirectory $root -WindowStyle Hidden -PassThru
if(-not $bad.WaitForExit(8000) -or $bad.ExitCode -ne 2){throw 'FAIL: unexpected launcher accepted'}
$chain=Join-Path $root 'node child chain';New-Item -ItemType Directory -Path $chain | Out-Null
Copy-Item -LiteralPath $hostFile -Destination $chain
$chainEntry=Join-Path $chain 'start-private-pc.mjs'
$js='import{spawn}from"node:child_process";import{fileURLToPath}from"node:url";const c=spawn(fileURLToPath(new URL("../fixture-node.exe",import.meta.url)),[],{windowsHide:true,stdio:["ignore","pipe","pipe"]});c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);c.on("exit",code=>{process.exitCode=code});'
[IO.File]::WriteAllText($chainEntry,$js,(New-Object Text.UTF8Encoding($false)))
Write-SetupJson (Join-Path $chain 'pc-runtime.json') @{node=$NodePath}
$nestedSpec=Get-SetupTaskSpec $chain
$nested=Start-Process -FilePath $nestedSpec.Execute -ArgumentList $nestedSpec.Arguments -WorkingDirectory $chain -WindowStyle Hidden -PassThru
if(-not $nested.WaitForExit(8000) -or $nested.ExitCode -ne 7){throw 'FAIL: real Node child chain failed'}
if((Get-Content -LiteralPath (Join-Path $chain 'console.txt') -Raw).Trim() -ne '0'){throw 'FAIL: Node child allocated a console'}
Write-Output 'PASS native headless console allocation, exit code, stdout/stderr and duplicate-launch checks'

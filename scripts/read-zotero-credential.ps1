param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
try {
  $config=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json
  if($config.protection -ne 'Windows DPAPI CurrentUser' -or [string]$config.userId -notmatch '^[1-9][0-9]{0,19}$'){throw 'Invalid credential format'}
  $secure=ConvertTo-SecureString -String $config.apiKeyProtected
  try {
    # Captured in the server process only; never run directly in an interactive terminal.
    [Console]::Out.Write((@{userId=[string]$config.userId;apiKey=[System.Net.NetworkCredential]::new('',$secure).Password}|ConvertTo-Json -Compress))
  } finally {$secure.Dispose()}
} catch { [Console]::Error.Write('Could not read the current Windows user credential.');exit 1 }

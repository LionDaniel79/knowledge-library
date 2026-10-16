import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
it.skipIf(process.platform !== "win32")(
  "waits for a fresh matching OCR PID and tolerates a missing state file",
  async () => {
    const script = resolve("scripts/library-start-state.ps1").replaceAll(
      "'",
      "''",
    );
    const { stdout } = await promisify(execFile)(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
    $ErrorActionPreference='Stop'
    . '${script}'
    $started=[datetime]'2026-10-15T01:00:00Z'
    $missing=Read-LibraryOcrState (Join-Path $env:TEMP 'library-state-nonexistent-61d791a9.json')
    @(
      (Get-LibraryOcrReadiness $missing 123 $started),
      (Get-LibraryOcrReadiness ([pscustomobject]@{pid=999;status='running';updatedAt='2026-10-15T01:01:00Z'}) 123 $started),
      (Get-LibraryOcrReadiness ([pscustomobject]@{pid=123;status='running';updatedAt='2026-10-14T01:00:00Z'}) 123 $started),
      (Get-LibraryOcrReadiness ([pscustomobject]@{pid=123;status='running';updatedAt='2026-10-15T01:01:00Z'}) 123 $started),
      (Get-LibraryOcrReadiness ([pscustomobject]@{pid=123;status='completed';updatedAt='2026-10-15T01:01:00Z'}) 123 $started),
      (Get-LibraryOcrReadiness ([pscustomobject]@{pid=123;status='failed';updatedAt='2026-10-15T01:01:00Z'}) 123 $started)
    )|ConvertTo-Json -Compress
  `,
      ],
      { windowsHide: true, timeout: 15000 },
    );
    expect(JSON.parse(stdout)).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "ready",
      "ready",
      "failed",
    ]);
  },
);

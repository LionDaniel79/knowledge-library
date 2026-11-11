import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Detached bibliography workers reuse the existing encrypted connection profile.
// They do not need the retired web server's login, origin, or PDF configuration.
const allowed = [
  "DATABASE_URL",
  "LIBRARY_OWNER_EMAIL",
  "LIBRARY_CATALOG_OWNER_ID",
  "YES24_API_KEY",
  "DATA4LIBRARY_KEY",
  "GOOGLE_BOOKS_API_KEY",
];

export function runtimeEnvironment(c, profile) {
  if (new URL(profile.DATABASE_URL).username !== "library_web_runtime")
    throw Error("Restricted database role required.");
  const env = {};
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PATH",
    "Path",
  ])
    if (process.env[key]) env[key] = process.env[key];
  for (const key of allowed)
    if (typeof profile[key] === "string") env[key] = profile[key];
  for (const key of ["DATABASE_URL", "LIBRARY_OWNER_EMAIL"])
    if (!env[key]) throw Error("Connection settings missing.");
  return {
    ...env,
    NODE_ENV: "production",
    NODE_PATH: join(c.app, "node_modules"),
    LIBRARY_APP_ROLE: "library_web_runtime",
    CATALOG_CACHE_DIR: join(c.dataRoot, "private-data", "catalog"),
    CATALOG_API_USAGE_PATH: join(
      c.dataRoot,
      "private-data",
      "catalog",
      "api-usage.sqlite",
    ),
    LIBRARY_YES24_JOB_DIR: join(
      c.dataRoot,
      "private-data",
      "operations",
      "yes24-batch",
    ),
    TEMP: c.temp,
    TMP: c.temp,
    SQLITE_TMPDIR: c.temp,
    PYTHONUTF8: "1",
  };
}

export function unlockProfile(c) {
  const encrypted = JSON.parse(
    readFileSync(c.profileFile, "utf8").replace(/^\uFEFF/, ""),
  );
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const code =
    "Add-Type -AssemblyName System.Security;$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$w=New-Object IO.StreamWriter([Console]::OpenStandardOutput(),(New-Object Text.UTF8Encoding($false)));try{$w.Write([Text.Encoding]::UTF8.GetString($b));$w.Flush()}finally{[Array]::Clear($b,0,$b.Length)}";
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", code],
    {
      input: encrypted.protected,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    },
  );
  if (result.status !== 0)
    throw Error("Cannot unlock this Windows user's library connection.");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

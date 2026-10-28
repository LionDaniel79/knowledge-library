import {
  readFileSync,
  writeFileSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { startCatalogWorker } from "./catalog-worker.mjs";

const allowed = [
  "DATABASE_URL",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_COOKIE_SECRET",
  "LIBRARY_OWNER_EMAIL",
  "YES24_API_KEY",
  "DATA4LIBRARY_KEY",
  "GOOGLE_BOOKS_API_KEY",
];
export function runtimeEnvironment(c, profile) {
  if (new URL(profile.DATABASE_URL).username !== "library_web_runtime")
    throw Error("Restricted database role required.");
  const env = {};
  for (const k of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PATH",
    "Path",
  ])
    if (process.env[k]) env[k] = process.env[k];
  for (const k of allowed)
    if (typeof profile[k] === "string") env[k] = profile[k];
  for (const k of allowed.slice(0, 4))
    if (!env[k]) throw Error("Connection settings missing.");
  return {
    ...env,
    NODE_ENV: "production",
    NODE_PATH: join(c.app, "node_modules"),
    NEXT_TELEMETRY_DISABLED: "1",
    APP_ORIGIN: c.origin,
    LIBRARY_APP_ROLE: "library_web_runtime",
    LIBRARY_PC_ORIGIN: c.origin,
    LIBRARY_PC_PRIVATE_CONFIRMED: "true",
    LIBRARY_PDF_ROOT: c.pdfRoot,
    LIBRARY_PDF_INDEX: c.index,
    LIBRARY_PYTHON: c.python,
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
export const serverArguments = (c) => [
  join(c.app, "node_modules", "next", "dist", "bin", "next"),
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  "3001",
];
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
  const r = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", code],
    {
      input: encrypted.protected,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    },
  );
  if (r.status !== 0)
    throw Error("Cannot unlock this Windows user's library connection.");
  return JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
}
const portOpen = () =>
  new Promise((done) => {
    const s = createConnection({ host: "127.0.0.1", port: 3001 });
    const finish = (value) => {
      s.destroy();
      done(value);
    };
    s.setTimeout(500);
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    s.once("timeout", () => finish(false));
  });
export async function runServer(configPath) {
  const c = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  if (
    c.port !== 3001 ||
    !existsSync(join(c.app, ".next", "BUILD_ID")) ||
    !existsSync(c.pdfRoot)
  )
    throw Error("Library runtime is not ready.");
  if (await portOpen())
    throw Error("Port 3001 is already occupied; no process was changed.");
  // The native windowless host holds an OS mutex for this installation.
  // Windows releases it on process exit/reboot; no stale PID file is used.
  const env = runtimeEnvironment(c, unlockProfile(c));
  const child = spawn(c.node, serverArguments(c), {
    cwd: c.app,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const catalogWorker = startCatalogWorker(c, env);
  const log = createWriteStream(join(c.operations, "server.out.log"), {
      flags: "a",
    }),
    errors = createWriteStream(join(c.operations, "server.err.log"), {
      flags: "a",
    });
  child.stdout.pipe(log);
  child.stderr.pipe(errors);
  writeFileSync(
    c.runtimeFile,
    JSON.stringify({
      pid: child.pid,
      origin: c.origin,
      port: 3001,
      app: c.app,
      startedAt: new Date().toISOString(),
      role: "library_web_runtime",
    }),
  );
  return await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => {
      catalogWorker?.kill();
      log.end();
      errors.end();
      done(code ?? 1);
    });
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runServer(
      join(dirname(fileURLToPath(import.meta.url)), "pc-runtime.json"),
    );
  } catch {
    console.error(
      "Private library startup failed. Check PC configuration and port 3001.",
    );
    process.exitCode = 1;
  }
}

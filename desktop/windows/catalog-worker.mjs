import { existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
export function catalogWorkerEnvironment(env) {
  const result = {};
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PATH",
    "Path",
    "DATABASE_URL",
    "LIBRARY_OWNER_EMAIL",
    "LIBRARY_CATALOG_OWNER_ID",
    "YES24_API_KEY",
    "DATA4LIBRARY_KEY",
    "DATA4LIBRARY_DAILY_LIMIT",
    "DATA4LIBRARY_IP_REGISTERED",
    "YES24_DAILY_LIMIT",
    "CATALOG_CACHE_DIR",
    "CATALOG_API_USAGE_PATH",
    "TEMP",
    "TMP",
    "SQLITE_TMPDIR",
  ])
    if (env[key]) result[key] = env[key];
  return result;
}
export function startCatalogWorker(c, env, spawnWorker = spawn) {
  const script = join(c.app, "scripts", "catalog-supplement-worker.ts"),
    loader = join(c.app, "node_modules", "tsx", "dist", "loader.mjs");
  if (
    !existsSync(script) ||
    !existsSync(loader) ||
    (!env.YES24_API_KEY && !env.DATA4LIBRARY_KEY)
  )
    return null;
  const log = createWriteStream(join(c.operations, "catalog-worker.log"), {
    flags: "a",
  });
  let child,
    timer,
    stopped = false;
  const launch = () => {
    if (stopped) return;
    child = spawnWorker(
      c.node,
      ["--import", pathToFileURL(loader).href, script, "--watch"],
      {
        cwd: c.app,
        env: catalogWorkerEnvironment(env),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const again = () => {
      if (!stopped && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          launch();
        }, 30000);
    };
    child.once("error", again);
    child.once("exit", again);
  };
  log.on("error", () => {});
  launch();
  return {
    kill() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
      log.end();
    },
  };
}

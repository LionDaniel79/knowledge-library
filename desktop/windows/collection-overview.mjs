import fs from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeCollectionState } from "./collection-state.mjs";

// Aggregate on startup, after batches and while idle; UI refreshes read the snapshot.
export async function refreshCollectionOverview(
  config,
  { launch = spawn, timeoutMs = 45000 } = {},
) {
  if (!config.runtimeConfiguration || !config.configurationFile) return;
  const failed = () => {
    try {
      writeCollectionState(
        join(config.stateDirectory, "overview-refresh.json"),
        { at: new Date().toISOString(), ok: false },
      );
    } catch {}
  };
  try {
    const runtime = JSON.parse(
      fs
        .readFileSync(config.runtimeConfiguration, "utf8")
        .replace(/^\uFEFF/, ""),
    );
    const script = join(runtime.app, "scripts", "collection-overview.ts");
    if (!fs.existsSync(script)) {
      failed();
      return;
    }
    await new Promise((resolve) => {
      const child = launch(
        process.execPath,
        ["--import", "tsx", script, "--config", config.configurationFile],
        { cwd: runtime.app, windowsHide: true, stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        failed();
        child.kill();
      }, timeoutMs);
      const done = (code) => {
        clearTimeout(timer);
        if (code !== 0) failed();
        resolve();
      };
      child.once("error", done);
      child.once("close", done);
    });
  } catch {
    failed();
    /* A read-only overview failure must never stop collection. */
  }
}

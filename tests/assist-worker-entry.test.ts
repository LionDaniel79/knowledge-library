import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

it("does not start a PC worker when server execution is enabled", async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LIBRARY_SERVER_ASSIST_ENABLED: "true",
  };
  delete env.LIBRARY_WORKER_CONFIG;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/assist-worker.ts"],
    { env, windowsHide: true, timeout: 15000 },
  );
  expect(stdout).toContain("서버에서 처리");
});

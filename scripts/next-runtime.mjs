// Keep external dependencies resolvable when .next is stored on another drive.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(
  process.execPath,
  [join(root, "node_modules/next/dist/bin/next"), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_PATH: [join(root, "node_modules"), process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter),
    },
  },
);
child.on("error", () => {
  console.error("지식서재 실행 도구를 찾지 못했습니다.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));

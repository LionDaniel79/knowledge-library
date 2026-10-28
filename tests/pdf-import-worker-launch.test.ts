import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startPdfImportWorker } from "../src/server/pdf-import";
vi.mock("node:child_process", async (original) => ({
  ...(await original<any>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
it("starts the Windows worker with a file URL that Node can import, without a console", () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-launch-")),
    before = process.env.LIBRARY_PDF_INDEX;
  try {
    process.env.LIBRARY_PDF_INDEX = join(root, "index.sqlite");
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(child as any);
    startPdfImportWorker("synthetic-owner", crypto.randomUUID());
    const [binary, args, options] = vi.mocked(spawn).mock.calls[0] as any;
    expect(binary).toBe(process.execPath);
    expect(args[1]).toBe(
      pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
    );
    expect(options.windowsHide).toBe(true);
    const smoke = spawnSync(
      binary,
      ["--import", args[1], "--eval", "process.stdout.write('ready')"],
      { windowsHide: true, encoding: "utf8", timeout: 10000 },
    );
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(smoke.stdout).toBe("ready");
  } finally {
    if (before === undefined) delete process.env.LIBRARY_PDF_INDEX;
    else process.env.LIBRARY_PDF_INDEX = before;
    rmSync(root, { recursive: true, force: true });
  }
});

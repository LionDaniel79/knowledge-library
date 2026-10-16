import { it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as atomic from "../src/local/atomic-json";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
it("retries a transient Windows reader lock without truncating the previous checkpoint", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "library-checkpoint-")),
    file = join(dir, "status.json");
  await fs.writeFile(file, JSON.stringify({ cursor: 1033 }));
  const spy = vi.mocked(fs.rename).mockImplementationOnce(async () => {
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      cursor: 1033,
    });
    throw Object.assign(Error("file held open"), { code: "EPERM" });
  });
  try {
    await atomic.atomicWriteJson?.(file, { cursor: 1034 });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      cursor: 1034,
    });
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual(
      [],
    );
  } finally {
    spy.mockRestore();
    await fs.unlink(file);
    await fs.rmdir(dir);
  }
});

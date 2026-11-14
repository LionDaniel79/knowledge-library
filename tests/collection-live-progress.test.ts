import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogosCompletion } from "../src/local/curation/logos-runner";
it("reports bounded live progress after each completed book without leaking a book or token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kl-live-"));
  try {
    const updates: any[] = [];
    await runLogosCompletion({
      owner: "fixture",
      dir,
      books: [{ id: "1" }, { id: "2" }] as any,
      limit: 2,
      online: true,
      apply: true,
      lookup: async () => [],
      applyDecision: async () => "complete",
      onProgress: async (s) => {
        updates.push(s);
      },
    });
    expect(updates.map((x) => [x.considered, x.applied])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(updates.every((x) => !("books" in x) && !("owner" in x))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

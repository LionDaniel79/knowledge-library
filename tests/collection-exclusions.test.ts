import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionExclusions } from "../src/local/curation/collection-exclusions";

it("uses only the current kind's investigated IDs and fails closed for damaged or stale daily state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-ledger-"));
  const path = join(dir, "ledger.json");
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
  }).format(new Date());
  const ledger = {
    day,
    logos: { ids: ["already-investigated"] },
    pdf: { ids: ["pdf-investigated"] },
  };
  try {
    await writeFile(path, JSON.stringify(ledger));
    expect([...(await collectionExclusions(path, "logos"))]).toEqual([
      "already-investigated",
    ]);
    expect([...(await collectionExclusions(path, "pdf"))]).toEqual([
      "pdf-investigated",
    ]);
    expect((await collectionExclusions(undefined, "logos")).size).toBe(0);
    await writeFile(path, JSON.stringify({ ...ledger, day: "2000-01-01" }));
    await expect(collectionExclusions(path, "logos")).rejects.toThrow(
      "Invalid daily",
    );
    await writeFile(
      path,
      JSON.stringify({ ...ledger, logos: { ids: ["same", "same"] } }),
    );
    await expect(collectionExclusions(path, "logos")).rejects.toThrow(
      "Invalid daily",
    );
    await writeFile(path, "{");
    await expect(collectionExclusions(path, "logos")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

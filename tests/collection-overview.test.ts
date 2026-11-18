import { it, expect } from "vitest";
import { summarizeCollectionBooks } from "../src/local/curation/collection-overview";
it("counts unique active books, separates unapplied holds from uninvestigated and applied histories", () => {
  const books: any[] = [
    { id: "1", applied: true },
    { id: "2", state: "review" },
    { id: "3" },
    { id: "4" },
    { id: "5", state: "missing" },
    { id: "1", applied: true },
  ];
  const checkpoints = new Map([["3", { state: "source_unavailable" }]]);
  expect(summarizeCollectionBooks(books, checkpoints)).toEqual({
    total: 5,
    investigated: 4,
    applied: 1,
    remaining: 4,
    uninvestigated: 1,
    held: 3,
    holds: { review: 1, missing: 1, source: 1, retry: 0, other: 0 },
  });
});
it("does not count an applied book twice or treat error checkpoints as successful applications", () => {
  expect(
    summarizeCollectionBooks(
      [{ id: "1", applied: true }, { id: "2" }],
      new Map([
        ["1", { state: "error" }],
        ["2", { state: "error" }],
      ]),
    ),
  ).toMatchObject({
    total: 2,
    investigated: 2,
    applied: 1,
    remaining: 1,
    held: 1,
    holds: { retry: 1 },
  });
});
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readLogosCollectionCheckpoints } from "../src/local/curation/collection-overview";
it("includes Logos retry checkpoints even when no DB completion was saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "kl-overview-"));
  const owner = "fixture";
  try {
    const book: any = {
      id: "fixture",
      version: 1,
      resourceId: "x",
      title: "test",
      author: "a",
      publisher: "p",
      isbn: "",
      publicationDate: "",
      edition: "",
      resourceType: "",
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["logos-completion/v1", owner, book]))
      .digest("hex");
    const dir = join(
      root,
      "logos",
      createHash("sha256").update(owner).digest("hex"),
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, fingerprint + ".json"),
      JSON.stringify({
        fingerprint,
        records: [],
        lookupRetry: { attempts: 3, nextAttemptAt: 0 },
      }),
    );
    const checkpoints = await readLogosCollectionCheckpoints(root, owner, [
      { book },
    ]);
    expect(
      summarizeCollectionBooks([{ id: book.id }], checkpoints),
    ).toMatchObject({
      investigated: 1,
      uninvestigated: 0,
      held: 1,
      holds: { retry: 1 },
    });
    await writeFile(join(dir, fingerprint + ".json"), "{broken");
    await expect(
      readLogosCollectionCheckpoints(root, owner, [{ book }]),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

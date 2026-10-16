import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createCurationStore } from "../src/server/curation-store";
import {
  buildCurationInventory,
  selectCurationSample,
} from "../src/local/curation/inventory";
import {
  validateCurationItems,
  applyValidated,
} from "../src/local/curation/validate";
let fixture: Awaited<ReturnType<typeof testDatabase>>, dir: string;
beforeAll(async () => {
  fixture = await testDatabase();
  dir = await mkdtemp(join(tmpdir(), "curation-"));
  await mkdir(join(dir, "books"));
});
afterAll(async () => {
  await fixture?.pg.close();
  await rm(dir, { recursive: true, force: true });
});
it("inventories privately and runs a disjoint dry-run, apply and rollback without changing originals", async () => {
  const owner = "inventory-owner",
    library = createLibraryStore(fixture.db),
    store = createCurationStore(fixture.db);
  for (let i = 0; i < 40; i++)
    await library.mutate(owner, {
      requestId: randomUUID(),
      type: "addBook",
      payload: {
        title: `책 ${i}`,
        author: i < 30 ? "저자" : "",
        formats: ["paper"],
      },
    });
  for (let i = 0; i < 20; i++)
    await library.mutate(owner, {
      requestId: randomUUID(),
      type: "addNote",
      payload: {
        title: `기록 ${i}`,
        content: "책의 말과 내 생각을 함께 기록한다.",
        kind: "thought",
      },
    });
  const before = await library.snapshot(owner);
  const input = {
    owner,
    pdfRoot: join(dir, "books"),
    outputDir: join(dir, "private"),
  };
  const inv = await buildCurationInventory(fixture.db, input);
  expect(
    JSON.parse(await readFile(join(input.outputDir, "inventory.json"), "utf8"))
      .snapshotHash,
  ).toBe(inv.snapshotHash);
  const sample = selectCurationSample(inv);
  expect(sample.items).toHaveLength(60);
  expect(
    new Set(sample.items.map((x) => x.source.kind + ":" + x.source.id)).size,
  ).toBe(60);
  const note = inv.records.find((x) => x.source.kind === "note")!;
  const item = {
    id: randomUUID(),
    source: note.source,
    kind: "tag",
    proposedValue: "생각",
    evidence: { quote: "내 생각" },
    coverage: "partial",
    origin: "codex",
    generator: "development-v1",
  };
  const valid = validateCurationItems(
    [
      item,
      {
        ...item,
        id: randomUUID(),
        source: { ...note.source, version: "stale" },
      },
      { ...item, id: randomUUID(), evidence: { quote: "없는 근거" } },
    ],
    inv,
  );
  expect(valid.valid).toHaveLength(1);
  expect(valid.rejected).toHaveLength(2);
  expect(await applyValidated(fixture.db, owner, inv, [item])).toMatchObject({
    dryRun: true,
    valid: 1,
  });
  expect(
    (
      await fixture.db.query(
        "SELECT * FROM library_curation_runs WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
  const applied = await applyValidated(fixture.db, owner, inv, [item], {
    apply: true,
  });
  expect(applied.applied).toBe(1);
  expect(await library.snapshot(owner)).toEqual(before);
  await store.rollback(owner, applied.runId!);
  expect(await library.snapshot(owner)).toEqual(before);
  await expect(
    applyValidated(fixture.db, owner, inv, [item], {
      apply: true,
      runId: applied.runId,
    }),
  ).rejects.toThrow("열린");
  await expect(
    applyValidated(fixture.db, "other", inv, [item], { apply: true }),
  ).rejects.toThrow("소유자");
  await expect(
    buildCurationInventory(fixture.db, {
      ...input,
      outputDir: join(input.pdfRoot, "unsafe"),
    }),
  ).rejects.toThrow("원본");
});
it("treats shared hashes and different editions as candidates, never merges or trusts empty OCR", () => {
  const book = (id: string, isbn: string, hash: string) => ({
    source: { kind: "book" as const, id, version: "1" },
    text: "서로 다른 번역판",
    title: "서로 다른 번역판",
    eligible: true,
    coverage: "metadata" as const,
    missing: [],
    ambiguous: false,
    pdf: {
      signature: "1:1",
      sha256: hash,
      status: "needs_ocr",
      textPages: 0,
      pages: 3,
    },
    isbn,
  });
  const inv: any = {
    owner: "a",
    snapshotHash: "x",
    records: [
      book("one", "9788937460313", "same"),
      book("two", "9788937460443", "same"),
    ],
    references: [],
  };
  const result = selectCurationSample(inv);
  expect(result.duplicateCandidates).toEqual([["one", "two"]]);
  expect(inv.records).toHaveLength(2);
  const result2 = validateCurationItems(
    [
      {
        id: randomUUID(),
        source: inv.records[0].source,
        kind: "description",
        proposedValue: "책 전체 내용",
        evidence: { quote: "서로 다른 번역판" },
        coverage: "full",
        origin: "codex",
        generator: "test",
      },
    ],
    inv,
  );
  expect(result2.valid).toHaveLength(0);
});

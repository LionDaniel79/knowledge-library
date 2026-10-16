import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { storeCoverMirror } from "../src/server/cover-mirrors";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { curationMarkdown } from "../src/server/curation-export";
import { displayProviderText } from "../src/lib/provider-text";
import {
  parseGoogleBooks,
  collectBookReference,
} from "../src/local/curation/catalog";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => fixture?.pg.close());
it("requires matching ISBN, records provider evidence separately and never overwrites a human field", async () => {
  const library = createLibraryStore(fixture.db),
    owner = "catalog";
  const b = await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: {
      title: "나의 책 제목",
      isbn: "9780306406157",
      author: "내가 쓴 저자",
      formats: ["paper"],
    },
  });
  const raw = {
    items: [
      {
        id: "test",
        volumeInfo: {
          title: "공급자 제목",
          authors: ["공급자 저자"],
          publisher: "출판사",
          industryIdentifiers: [
            { type: "ISBN_13", identifier: "9780306406157" },
          ],
          description: "&lt;주의&gt; 본문 &amp;quot;표기&amp;quot;",
          imageLinks: { thumbnail: "https://books.google.com/cover.png" },
        },
      },
    ],
  };
  expect(parseGoogleBooks(raw, "9788999727764")).toBeNull();
  const match = parseGoogleBooks(raw, "9780306406157")!;
  const cover = await storeCoverMirror(
    fixture.db,
    owner,
    "https://books.google.com/cover.png",
    await sharp({
      create: { width: 20, height: 30, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const before = await library.snapshot(owner);
  const source = { kind: "book" as const, id: b.id!, version: "1" };
  expect(
    await collectBookReference(fixture.db, owner, source, match, false),
  ).toMatchObject({ dryRun: true });
  expect(
    (await fixture.db.query("SELECT * FROM library_reference_sources")).rows,
  ).toHaveLength(0);
  const result = await collectBookReference(
    fixture.db,
    owner,
    source,
    match,
    true,
  );
  expect(result.applied).toBeGreaterThan(0);
  const after = await library.snapshot(owner);
  expect(after.books[0].catalogCoverUrl).toBe(cover.url);
  expect({
    ...after,
    books: after.books.map(({ catalogCoverUrl, ...book }) => book),
  }).toEqual(before);
  expect(
    await collectBookReference(fixture.db, owner, source, match, true),
  ).toMatchObject({ duplicate: true });
  await expect(
    collectBookReference(fixture.db, "other", source, match, true),
  ).rejects.toThrow();
  const exported = await library.exportLibrary(owner);
  const intro = exported.curation.items.find(
    (i: any) => i.kind === "publisher_intro",
  );
  expect(intro?.generator).toBe("Google Books/plain-text-v1");
  expect(
    displayProviderText({
      value: intro!.value,
      origin: intro!.origin,
      generator: intro!.generator,
      reviewed_by: intro!.reviewed_by,
    }),
  ).toBe("<주의> 본문 &quot;표기&quot;");
  const markdown = curationMarkdown(exported.curation);
  const reference = exported.curation.sources[0];
  expect(markdown).toContain(reference.url);
  expect(markdown).toContain(reference.retrieved_at);
  expect(markdown).toContain(reference.edition_match);
  expect(markdown).toContain(exported.curation.runs[0].id);
  expect(markdown).toContain(exported.curation.runs[0].state);
});

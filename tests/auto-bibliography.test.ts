import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { testDatabase } from "./helpers/database";
import { applyLogos } from "../src/server/logos-import";
import {
  applyAutomaticBibliography,
  readAutomaticBibliography,
  decideAutomaticBibliography,
} from "../src/server/auto-bibliography";
import { decideAutomaticCandidate } from "../src/local/curation/logos-discovery";
const source: any = {
  id: "book",
  version: 1,
  resourceId: "R",
  title: "Same Work Volume 1",
  author: "John Smith",
  publisher: "Press",
  isbn: "",
  publicationDate: "1900",
  edition: "",
  resourceType: "단행본",
};
const record: any = {
  provider: "예스24",
  url: "https://www.yes24.com/product/goods/123",
  title: source.title,
  isbn: "9780306406157",
  facts: {
    title: source.title,
    author: "Smith, John",
    publisher: "Press",
    isbn: "9780306406157",
    coverUrl: "https://image.yes24.com/123",
  },
  format: "print",
  publicationYear: "2024",
  description: "A description",
  toc: ["Chapter one"],
};
it("accepts alternate print editions but blocks author/volume conflicts and tied editions", () => {
  expect(
    decideAutomaticCandidate(source, [
      {
        ...record,
        facts: { ...record.facts, title: source.title + " Study Guide" },
      },
    ]).state,
  ).toBe("missing");
  expect(decideAutomaticCandidate(source, [record])).toMatchObject({
    state: "certain",
    alternateEdition: true,
  });
  expect(
    decideAutomaticCandidate(source, [
      { ...record, facts: { ...record.facts, author: "Mary Brown" } },
    ]).state,
  ).toBe("missing");
  expect(
    decideAutomaticCandidate(source, [
      { ...record, facts: { ...record.facts, title: "Same Work Volume 2" } },
    ]).state,
  ).toBe("missing");
  expect(
    decideAutomaticCandidate(source, [
      record,
      {
        ...record,
        isbn: "9788999727764",
        facts: { ...record.facts, isbn: "9788999727764" },
      },
    ]).state,
  ).toBe("review");
  expect(
    decideAutomaticCandidate({ ...source, author: "", publisher: "" }, [record])
      .state,
  ).toBe("missing");
});
it("stores provenance, keeps/undoes selected fields safely, preserves later reader edits and prevents reapplication", async () => {
  const f = await testDatabase();
  const old = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
  try {
    await applyLogos(f.db, "owner", {
      items: [
        {
          resourceId: "LLS:AUTO",
          title: source.title,
          author: source.author,
          publisher: "",
          resourceType: "단행본",
          license: "permanent",
        },
      ],
    });
    const b = (await f.db.query("SELECT id,version FROM library_books"))
      .rows[0];
    await f.db.query(
      "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,'owner',$2,'Reader note','Keep this','thought')",
      [randomUUID(), b.id],
    );
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status) VALUES($1,'owner',$2,'reading')",
      [randomUUID(), b.id],
    );
    const image = await sharp({
      create: { width: 100, height: 150, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const result = await applyAutomaticBibliography(
      f.db,
      "owner",
      b.id,
      1,
      record,
      async () => image,
    );
    expect(result.state).toBe("applied");
    expect(
      (
        await applyAutomaticBibliography(
          f.db,
          "owner",
          b.id,
          2,
          { ...record, url: record.url + "4" },
          async () => image,
        )
      ).state,
    ).toBe("protected");
    let current = await readAutomaticBibliography(f.db, "owner", b.id);
    expect(current.application.alternateEdition).toBe(true);
    const kept = await decideAutomaticBibliography(f.db, "owner", {
      bookId: b.id,
      expectedVersion: current.version,
      action: "keep",
      fields: ["coverUrl"],
    });
    expect(kept.application.fields).toContain("coverUrl");
    await f.db.query(
      "UPDATE library_books SET publisher='Reader publisher',version=version+1 WHERE id=$1",
      [b.id],
    );
    current = await readAutomaticBibliography(f.db, "owner", b.id);
    const undo = await decideAutomaticBibliography(f.db, "owner", {
      bookId: b.id,
      expectedVersion: current.version,
      action: "undo",
    });
    expect(undo.skipped).toContain("publisher");
    const saved = (
      await f.db.query(
        "SELECT publisher,cover_url,isbn,enrichment FROM library_books",
      )
    ).rows[0];
    expect(saved.publisher).toBe("Reader publisher");
    expect(saved.cover_url).toBe("");
    expect(saved.isbn).toBe("");
    expect(
      (
        await applyAutomaticBibliography(
          f.db,
          "owner",
          b.id,
          undo.version,
          record,
          async () => image,
        )
      ).state,
    ).toBe("protected");
    expect(
      (await f.db.query("SELECT content FROM library_notes")).rows[0].content,
    ).toBe("Keep this");
    expect(
      (await f.db.query("SELECT status FROM library_cycles")).rows[0].status,
    ).toBe("reading");
    await expect(
      decideAutomaticBibliography(f.db, "owner", {
        bookId: b.id,
        expectedVersion: current.version,
        action: "undo",
      }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    if (old === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = old;
    await f.pg.close();
  }
});

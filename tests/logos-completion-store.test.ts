import { expect, it } from "vitest";
import sharp from "sharp";
import { testDatabase } from "./helpers/database";
import { applyLogos } from "../src/server/logos-import";
import { applyLogosCompletion } from "../src/server/logos-completion";
import { decideLogosCandidate } from "../src/local/curation/logos-discovery";
import { readStoredBookCover } from "../src/server/cover-mirrors";
import { LibraryError } from "../src/server/library-store";
import { randomUUID } from "node:crypto";

it("stores a confirmed digital cover with its source evidence without assigning print ISBN or replacing Logos metadata", async () => {
  const f = await testDatabase();
  const previous = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
  try {
    await applyLogos(f.db, "owner", {
      items: [
        {
          resourceId: "LLS:JOURNAL",
          title: "Journal 2020",
          author: "Editor",
          publisher: "Publisher",
          license: "temporary",
          resourceType: "학술지",
          publicationDate: "2020",
          edition: "Digital edition",
        },
      ],
    });
    const stored = (
      await f.db.query(
        "SELECT id,version FROM library_books WHERE owner_id='owner'",
      )
    ).rows[0];
    const book = {
      id: String(stored.id),
      version: Number(stored.version),
      resourceId: "LLS:JOURNAL",
      title: "Journal 2020",
      author: "Editor",
      publisher: "Publisher",
      isbn: "",
      publicationDate: "2020",
      edition: "Digital edition",
      resourceType: "학술지",
    };
    const record = {
      provider: "예스24" as const,
      url: "https://www.yes24.com/product/goods/123",
      isbn: "9780306406157",
      title: book.title,
      facts: {
        title: book.title,
        author: book.author,
        publisher: book.publisher,
        isbn: "9780306406157",
        coverUrl: "https://image.yes24.com/123",
      },
      publicationYear: "2020",
      edition: "Digital edition",
      format: "digital" as const,
    };
    const image = await sharp({
      create: { width: 100, height: 150, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    expect(
      await applyLogosCompletion(
        f.db,
        "owner",
        book,
        decideLogosCandidate(book, [record]),
        async () => image,
      ),
    ).toBe("complete");
    const saved = (
      await f.db.query(
        "SELECT title,isbn,cover_url,source_data,enrichment,version FROM library_books WHERE id=$1",
        [book.id],
      )
    ).rows[0];
    expect(saved.isbn).toBe("");
    expect(saved.title).toBe(book.title);
    expect(saved.source_data.raw.license).toBe("temporary");
    expect(saved.enrichment.logosCompletion.state).toBe("certain");
    expect(saved.cover_url).toMatch(/^\/api\/book-covers\//);
    expect(
      (await readStoredBookCover(f.db, "owner", book.id)).bytes?.length,
    ).toBeGreaterThan(0);
    expect(
      await applyLogosCompletion(
        f.db,
        "owner",
        book,
        decideLogosCandidate(book, [record]),
        async () => {
          throw Error("stale books must not download");
        },
      ),
    ).toBe("stale");
  } finally {
    if (previous === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = previous;
    await f.pg.close();
  }
});

async function completionFixture() {
  const f = await testDatabase();
  const previous = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
  const source = {
    resourceId: "LLS:GUARDS",
    title: "Cover guards",
    author: "Author",
    publisher: "Publisher",
    license: "permanent" as const,
    resourceType: "단행본" as const,
    publicationDate: "2020",
    edition: "Digital edition",
  };
  await applyLogos(f.db, "owner", { items: [source] });
  const row = (
    await f.db.query("SELECT id FROM library_books WHERE owner_id='owner'")
  ).rows[0];
  const book = { ...source, id: String(row.id), version: 1, isbn: "" };
  const record = {
    provider: "예스24" as const,
    url: "https://www.yes24.com/product/goods/123",
    isbn: "9780306406157",
    title: book.title,
    facts: {
      title: book.title,
      author: book.author,
      publisher: book.publisher,
      isbn: "9780306406157",
      coverUrl: "https://image.yes24.com/missing",
    },
    publicationYear: "2020",
    edition: source.edition,
    format: "digital" as const,
  };
  return {
    ...f,
    book,
    decision: decideLogosCandidate(book, [record]),
    close: async () => {
      if (previous === undefined)
        delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
      else process.env.LIBRARY_STAGE5_WRITE_ENABLED = previous;
      await f.pg.close();
    },
  };
}

it("skips downloads for another owner's book, stale or excluded books, and existing or protected covers", async () => {
  const f = await completionFixture();
  let downloads = 0;
  const download = async () => {
    downloads++;
    throw new LibraryError(404, "must not download");
  };
  try {
    expect(
      await applyLogosCompletion(
        f.db,
        "other-owner",
        f.book,
        f.decision,
        download,
      ),
    ).toBe("excluded");
    expect(
      await applyLogosCompletion(
        f.db,
        "owner",
        { ...f.book, version: 2 },
        f.decision,
        download,
      ),
    ).toBe("stale");
    await f.db.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,'owner','periodical','fixture',$2)",
      [f.book.id, randomUUID()],
    );
    expect(
      await applyLogosCompletion(f.db, "owner", f.book, f.decision, download),
    ).toBe("excluded");
    await f.db.query(
      "DELETE FROM library_book_exclusions WHERE owner_id='owner'",
    );
    for (const patch of [
      "cover_url='https://image.yes24.com/manual'",
      "cover_url='',enrichment='{\"coverRemoved\":true}'",
      "enrichment='{}',source_data=jsonb_set(source_data,'{cover}','{\"sha256\":\"fixture\"}')",
    ]) {
      await f.db.query(
        "UPDATE library_books SET " +
          patch +
          ",version=1 WHERE owner_id='owner'",
      );
      expect(
        await applyLogosCompletion(f.db, "owner", f.book, f.decision, download),
      ).toBe("complete");
    }
    await f.db.query(
      "UPDATE library_books SET source_data=source_data-'cover',version=1 WHERE owner_id='owner'",
    );
    const runId = randomUUID();
    await f.db.query(
      "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,'owner','fixture','fixture')",
      [runId],
    );
    await f.db.query(
      "INSERT INTO library_curation_items(id,owner_id,run_id,source_kind,source_id,source_version,kind,value,evidence,coverage,origin,generator,fingerprint,state) VALUES($1,'owner',$2,'book',$3,'1','bibliography','{}','{}','metadata','provider','fixture','guard-test','hidden')",
      [randomUUID(), runId, f.book.id],
    );
    expect(
      await applyLogosCompletion(f.db, "owner", f.book, f.decision, download),
    ).toBe("complete");
    expect(downloads).toBe(0);
  } finally {
    await f.close();
  }
});

it("keeps failed images unverified and rechecks version and manual cover protection after downloading", async () => {
  const f = await completionFixture();
  try {
    expect(
      await applyLogosCompletion(
        f.db,
        "owner",
        f.book,
        f.decision,
        async () => {
          throw new LibraryError(404, "private-url");
        },
      ),
    ).toBe("cover_failed");
    expect(
      await applyLogosCompletion(f.db, "owner", f.book, f.decision, async () =>
        Buffer.from("bad-image"),
      ),
    ).toBe("cover_failed");
    expect(
      (await f.db.query("SELECT count(*)::int n FROM library_cover_locations"))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await f.db.query(
          "SELECT enrichment,version FROM library_books WHERE id=$1",
          [f.book.id],
        )
      ).rows[0],
    ).toMatchObject({ enrichment: {}, version: 1 });
    const image = await sharp({
      create: { width: 100, height: 150, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    expect(
      await applyLogosCompletion(
        f.db,
        "owner",
        f.book,
        f.decision,
        async () => {
          await f.db.query(
            "UPDATE library_books SET cover_url='https://image.yes24.com/manual' WHERE id=$1",
            [f.book.id],
          );
          return image;
        },
      ),
    ).toBe("complete");
    expect(
      (
        await f.db.query("SELECT cover_url FROM library_books WHERE id=$1", [
          f.book.id,
        ])
      ).rows[0].cover_url,
    ).toBe("https://image.yes24.com/manual");
    expect(
      (await f.db.query("SELECT count(*)::int n FROM library_cover_assets"))
        .rows[0].n,
    ).toBe(0);
  } finally {
    await f.close();
  }
});

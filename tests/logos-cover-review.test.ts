import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { applyLogos } from "../src/server/logos-import";
import { saveVerifiedLogosCover } from "../src/server/logos-cover";
import { LibraryError } from "../src/server/library-store";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
it("reviews three candidates independently, preserving ISBN, manual category and reading history", async () => {
  const f = await testDatabase();
  const before = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
  try {
    await applyLogos(f.db, "owner", {
      items: [1, 2, 3].map((i) => ({
        resourceId: "LLS:COVER" + i,
        title: "Candidate " + i,
        author: "Author",
        publisher: "Publisher",
        resourceType: "단행본",
        license: "permanent",
      })),
    });
    const books = (
      await f.db.query("SELECT id,version FROM library_books ORDER BY title")
    ).rows;
    await f.db.query(
      `UPDATE library_books SET category='100',classification='{"method":"manual","verified":false}' WHERE id=$1`,
      [books[0].id],
    );
    await f.db.query(
      `INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,'owner',$2,'reading','2026-11-01')`,
      [randomUUID(), books[0].id],
    );
    const image = await sharp({
      create: { width: 100, height: 150, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    for (const [i, b] of books.entries()) {
      const promise = saveVerifiedLogosCover(
        f.db,
        "owner",
        {
          bookId: b.id,
          expectedVersion: 1,
          coverUrl: `https://image.yes24.com/${i}.jpg`,
          verification: "manual",
          origin: "fixture",
        },
        async () => {
          if (i === 1) throw new LibraryError(502, "fixture unavailable");
          return image;
        },
      );
      if (i === 1) await expect(promise).rejects.toMatchObject({ status: 502 });
      else await expect(promise).resolves.toMatchObject({ version: 2 });
    }
    const saved = (
      await f.db.query(
        "SELECT isbn,category,classification,version FROM library_books ORDER BY title",
      )
    ).rows;
    expect(saved.map((b) => b.isbn)).toEqual(["", "", ""]);
    expect(saved.map((b) => b.version)).toEqual([2, 1, 2]);
    expect(saved[0]).toMatchObject({
      category: "100",
      classification: { method: "manual" },
    });
    expect(
      (await f.db.query("SELECT status,current_page FROM library_cycles")).rows,
    ).toEqual([{ status: "reading", current_page: 0 }]);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_revisions WHERE action='logosCover'",
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    if (before === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = before;
    await f.pg.close();
  }
});

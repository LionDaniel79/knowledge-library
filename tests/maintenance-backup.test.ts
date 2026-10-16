import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  importCatalogReview,
  readCatalogReviews,
  decideCatalogReview,
} from "../src/server/catalog-review-store";
import { saveBookIntroduction } from "../src/server/book-introduction";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
it("restores human candidate decisions and sourced introductions", async () => {
  const a = await testDatabase(),
    b = await testDatabase();
  try {
    const book = await createLibraryStore(a.db).mutate("owner", {
      type: "addBook",
      requestId: randomUUID(),
      payload: { title: "책", formats: ["paper"] },
    });
    await importCatalogReview(a.db, "owner", {
      bookId: book.id!,
      sourceVersion: 1,
      record: {
        provider: "예스24",
        url: "https://www.yes24.com/product/goods/1",
        isbn: "9780306406157",
        title: "책",
        facts: {
          title: "책",
          author: "저자",
          publisher: "출판사",
          isbn: "9780306406157",
          coverUrl: "",
        },
      },
    });
    const id = (await readCatalogReviews(a.db, "owner", {})).items![0].id;
    await decideCatalogReview(a.db, "owner", {
      id,
      expectedVersion: 1,
      requestId: randomUUID(),
      action: "reject",
    });
    await saveBookIntroduction(a.db, "owner", {
      bookId: book.id,
      bookVersion: 1,
      expectedVersion: 0,
      text: "내 소개",
      sources: [
        {
          kind: "review",
          url: "https://example.org/review",
          excerpt: "실제 발췌",
        },
      ],
      requestId: randomUUID(),
    });
    const backup = await createLibraryBackup(a.db, "owner");
    await restoreLibraryBackup(b.db, "copy", backup);
    expect((await createLibraryBackup(b.db, "copy")).tables).toEqual(
      backup.tables,
    );
  } finally {
    await a.pg.close();
    await b.pg.close();
  }
});

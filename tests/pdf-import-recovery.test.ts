import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "./helpers/database";
import {
  importPdfCatalog,
  type PdfCatalogDocument,
} from "../src/server/pdf-catalog-import";
import { PdfImportJobs, type ImportItem } from "../src/local/pdf-import/jobs";
import { runPdfImport } from "../src/local/pdf-import/runner";
import { applyImportMetadata } from "../src/local/pdf-import/metadata";
const doc = (root: string, title: string): PdfCatalogDocument => ({
  id: randomUUID(),
  root,
  path: join(root, title + ".pdf"),
  relative_path: title + ".pdf",
  title,
  author: "",
  bytes: 10,
  mtime_ns: "1",
  page_count: 1,
  processing_scope: "full",
  material_kind: "book",
  scope_reason: "book",
  scope_version: "v",
});
it("matches moved documents only under a verified root and retains changed/excluded decisions", async () => {
  const { db, pg } = await testDatabase(),
    root = mkdtempSync(join(tmpdir(), "moved-import-")),
    jobs = new PdfImportJobs(join(root, "jobs.sqlite"));
  try {
    const original = [
      doc(join(root, "old"), "changed"),
      doc(join(root, "old"), "excluded"),
    ];
    await importPdfCatalog(db, "owner", original);
    const book = (
      await db.query("SELECT book_id FROM library_documents WHERE id=$1", [
        original[1].id,
      ])
    ).rows[0].book_id;
    await db.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,'owner','paper','exclude',$2)",
      [book, randomUUID()],
    );
    const moved = original.map((d) => ({
      ...d,
      id: randomUUID(),
      root,
      path: join(root, d.relative_path),
      mtime_ns: "2",
    }));
    const rpc = {
      call: async (_action: string, _params: any, emit: any) => {
        moved.forEach(emit);
        return true as any;
      },
      close() {},
    };
    const j = jobs.create("owner", root);
    await runPdfImport(db, jobs, "owner", j.id, rpc, {
      connectedRoot: async () => root,
    } as any);
    expect(jobs.summary("owner", j.id)).toMatchObject({
      counts: { changed: 1, excluded: 1 },
    });
    jobs.discard("owner", j.id);
    const unrelated = jobs.create("owner", root);
    await runPdfImport(db, jobs, "owner", unrelated.id, rpc, {
      connectedRoot: async () => null,
    } as any);
    expect(jobs.summary("owner", unrelated.id)).toMatchObject({
      counts: { new: 2 },
    });
  } finally {
    jobs.close();
    await pg.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("recognizes an already committed metadata operation after checkpoint loss without replacing a later human edit", async () => {
  const { db, pg } = await testDatabase();
  try {
    const document = doc("D:/fixture", "Book");
    await importPdfCatalog(db, "owner", [document]);
    const book = (
      await db.query("SELECT book_id FROM library_documents WHERE id=$1", [
        document.id,
      ])
    ).rows[0].book_id;
    const item: ImportItem = {
      document,
      kind: "new",
      registered: true,
      bookId: book,
      bookVersion: 1,
      hash: "a".repeat(64),
    };
    const record = {
      provider: "Google Books" as const,
      url: "https://books.google.com/books?id=fixture",
      isbn: "9780306406157",
      title: "Book",
      facts: {
        title: "Book",
        author: "Author",
        publisher: "Publisher",
        isbn: "9780306406157",
        coverUrl: "",
      },
    };
    expect(await applyImportMetadata(db, "owner", item, record)).toBe(2);
    // Simulate process death before SQLite patch: item still says version 1.
    expect(await applyImportMetadata(db, "owner", item, record)).toBe(2);
    await db.query(
      "UPDATE library_books SET title='My edited title',version=3 WHERE id=$1",
      [book],
    );
    expect(await applyImportMetadata(db, "owner", item, record)).toBe(3);
    expect(
      (await db.query("SELECT title FROM library_books WHERE id=$1", [book]))
        .rows[0].title,
    ).toBe("My edited title");
    await expect(
      applyImportMetadata(db, "owner", item, {
        ...record,
        title: "Other",
        facts: { ...record.facts, title: "Other" },
      }),
    ).rejects.toThrow(/수정/);
    expect(
      (
        await db.query(
          "SELECT id FROM library_revisions WHERE action='identifyPdfEdition'",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await pg.close();
  }
});

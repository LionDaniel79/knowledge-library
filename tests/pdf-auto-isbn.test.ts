import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { extractPdfIdentity } from "../src/local/curation/pdf-identity";
import {
  applyAutomaticBibliography,
  decideAutomaticBibliography,
} from "../src/server/auto-bibliography";
it("saves proven native PDF ISBN with independently reversible provenance", async () => {
  const f = await testDatabase();
  try {
    const owner = "pdf-auto",
      id = (
        await createLibraryStore(f.db).mutate(owner, {
          requestId: randomUUID(),
          type: "addBook",
          payload: { title: "마음의 이해", formats: ["pdf"] },
        })
      ).id!,
      doc = randomUUID();
    await f.db.query(
      "UPDATE library_books SET source_data=$3 WHERE owner_id=$1 AND id=$2",
      [owner, id, JSON.stringify({ app: "Local PDF", recordId: doc })],
    );
    await f.db.query(
      "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope) VALUES($1,$2,$3,'E:/books','E:/books/book.pdf','book.pdf',100,'1','full')",
      [doc, owner, id],
    );
    const evidence = extractPdfIdentity(
      {
        id: doc,
        title: "마음의 이해",
        author: "",
        signature: "sig",
        sha256: "",
        pageCount: 1,
        processingScope: "full",
        status: "ready",
      },
      [{ pageNumber: 1, text: "ISBN 9780306406157", method: "text" }],
    );
    const record: any = {
      provider: "도서관 정보나루",
      url: "https://www.data4library.kr",
      isbn: "9780306406157",
      title: "마음의 이해",
      facts: {
        title: "마음의 이해",
        isbn: "9780306406157",
        author: "홍길동",
        publisher: "출판사",
        coverUrl: "",
      },
    };
    await applyAutomaticBibliography(
      f.db,
      owner,
      id,
      1,
      record,
      undefined,
      evidence,
    );
    expect(
      (await f.db.query("SELECT isbn FROM library_books WHERE id=$1", [id]))
        .rows[0].isbn,
    ).toBe(record.isbn);
    await decideAutomaticBibliography(f.db, owner, {
      bookId: id,
      expectedVersion: 2,
      action: "undo",
      fields: ["isbn"],
    });
    const b = (
      await f.db.query(
        "SELECT isbn,author,enrichment FROM library_books WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(b.isbn).toBe("");
    expect(b.author).toBe("홍길동");
    expect(b.enrichment.auto_referenceIsbn).toBe(record.isbn);
  } finally {
    await f.pg.close();
  }
});

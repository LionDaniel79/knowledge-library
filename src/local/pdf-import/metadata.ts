import { createHash } from "node:crypto";
import { compactTitle } from "../../lib/bibliography";
import { withSyncWrite } from "../../server/sync/write";
import { lookupLibraryTitle } from "../../server/catalog-provider";
import { mirrorCover } from "../../server/cover-mirrors";
import { LibraryError, type Database } from "../../server/library-store";
import {
  extractPdfIdentity,
  resolvePdfIdentity,
  identitySearchQueries,
  type PdfIdentity,
  type IdentityPage,
} from "../curation/pdf-identity";
import {
  collectBookReference,
  lookupCollectedBook,
  type CollectedBook,
} from "../curation/catalog";
import { parseYes24Records, readYes24Response } from "../curation/yes24-batch";
import {
  reserveCatalogRequest,
  CatalogQuotaError,
} from "../curation/api-quota";
import { PdfImportJobs, type ImportItem } from "./jobs";
import { enqueueCatalogSupplement } from "../../server/catalog-supplement-queue";

export { extractPdfIdentity, resolvePdfIdentity };
export type { PdfIdentity, IdentityPage };
export async function importMetadataCandidates(
  jobs: PdfImportJobs,
  evidence: PdfIdentity,
): Promise<CollectedBook[]> {
  const records: CollectedBook[] = [];
  const isbn =
    evidence.candidates.length === 1 ? evidence.candidates[0].isbn : "";
  const query =
    isbn || identitySearchQueries(evidence.title, evidence.author)[0]?.title;
  if (!query) return [];
  for (const provider of ["yes24", "library", "google"] as const) {
    const key =
      process.env[
        provider === "yes24"
          ? "YES24_API_KEY"
          : provider === "library"
            ? "DATA4LIBRARY_KEY"
            : "GOOGLE_BOOKS_API_KEY"
      ];
    if (!key) continue;
    const cacheKey = createHash("sha256")
      .update(JSON.stringify([provider, query, !!isbn]))
      .digest("hex");
    const cached = jobs.cache(cacheKey);
    if (cached) {
      records.push(...cached);
      if (cached.length) break;
      continue;
    }
    let found: CollectedBook[];
    try {
      if (provider === "yes24") {
        reserveCatalogRequest("yes24", key);
        const url = new URL("https://apis.yes24.com/v1/goods/itemList");
        url.search = new URLSearchParams({
          query,
          page: "1",
          pageSize: "10",
          category: "BOOK",
          detail: "Y",
        }).toString();
        const json = await readYes24Response(
          await fetch(url, {
            headers: { "X-Api-Key": key },
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          }),
        );
        found = json ? parseYes24Records(json, isbn) : [];
      } else if (isbn) {
        const r = await lookupCollectedBook(isbn, provider, key);
        found = r ? [r] : [];
      } else if (provider === "library") {
        const results = await lookupLibraryTitle(
          query,
          key,
          evidence.author.length <= 200 ? evidence.author : "",
        );
        found = results.books.map((r) => ({
          provider: "도서관 정보나루",
          title: r.title,
          isbn: r.isbn,
          url: r.url,
          facts: {
            title: r.title,
            isbn: r.isbn,
            author: r.author,
            publisher: r.publisher,
            coverUrl: r.coverUrl,
          },
          description: r.description,
          descriptionFormat: r.descriptionFormat,
        }));
      } else continue;
      jobs.saveCache(cacheKey, found);
    } catch (e) {
      if (e instanceof CatalogQuotaError) throw e;
      throw Error(
        "서지 제공자에 연결하지 못했습니다. 기본 등록은 보존됩니다. 나중에 오류 재시도를 눌러 주세요.",
      );
    }
    records.push(...found);
    if (found.length) break;
  }
  return records.slice(0, 10);
}

/** Saved provider records only; optimistic version check protects subsequent human edits. */
export async function applyImportMetadata(
  db: Database,
  owner: string,
  item: ImportItem,
  record: CollectedBook,
) {
  if (!item.bookId || !item.bookVersion)
    throw new LibraryError(409, "등록된 도서 정보를 다시 확인하세요.");
  // Download outside the transaction. A failed image must not roll back basic registration.
  if (record.facts.coverUrl)
    await mirrorCover(db, owner, record.facts.coverUrl);
  // Stable operation ID spans the online commit / local checkpoint boundary.
  // A different edition, file version, or starting book version gets a new ID.
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "pdf-bulk-metadata/v1",
        owner,
        item.document.id,
        item.hash,
        item.bookId,
        item.bookVersion,
        record,
      ]),
    )
    .digest("hex");
  const operation = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return withSyncWrite(db, owner, async (tx) => {
    const book = (
      await tx.query(
        "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, item.bookId],
      )
    ).rows[0];
    const committed = (
      await tx.query(
        "SELECT id FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND id=$3 AND action='identifyPdfEdition'",
        [owner, item.bookId, operation],
      )
    ).rows.length;
    // Returning current version only acknowledges our earlier commit; no field
    // writes occur here, including when the reader has since edited the book.
    if (book && committed) return Number(book.version);
    if (!book || Number(book.version) !== item.bookVersion)
      throw new LibraryError(
        409,
        "책 정보가 수정되었습니다. 도서 수정 화면에서 확인하세요.",
      );
    if (
      (
        await tx.query(
          "SELECT id FROM library_book_exclusions WHERE owner_id=$1 AND id=$2 AND state='excluded'",
          [owner, item.bookId],
        )
      ).rows.length
    )
      throw new LibraryError(409, "제외된 자료입니다.");
    if (
      (
        await tx.query(
          "SELECT id FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action='editBook' LIMIT 1",
          [owner, item.bookId],
        )
      ).rows.length
    )
      throw new LibraryError(
        409,
        "직접 수정한 책 정보는 자동으로 바꾸지 않습니다.",
      );
    if (book.isbn && book.isbn !== record.isbn)
      throw new LibraryError(409, "기존 ISBN과 다른 판본입니다.");
    if (
      book.publisher &&
      compactTitle(book.publisher) !== compactTitle(record.facts.publisher)
    )
      throw new LibraryError(409, "기존 출판사와 다른 판본입니다.");
    const next = (
      await tx.query(
        "UPDATE library_books SET title=$3,author=$4,publisher=$5,isbn=$6,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [
          owner,
          item.bookId,
          record.facts.title.slice(0, 300),
          record.facts.author.slice(0, 300),
          record.facts.publisher.slice(0, 300),
          record.isbn,
        ],
      )
    ).rows[0];
    await enqueueCatalogSupplement(tx, owner, next);
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'identifyPdfEdition',$4,$5)",
      [
        operation,
        owner,
        item.bookId,
        JSON.stringify(book),
        JSON.stringify(next),
      ],
    );
    await collectBookReference(
      { query: tx.query, transaction: (fn) => fn(tx) },
      owner,
      { kind: "book", id: item.bookId!, version: String(next.version) },
      record,
      true,
    );
    return Number(next.version);
  });
}

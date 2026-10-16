import type { Executor } from "./library-store";
import type { Book } from "../lib/domain";
import { isbn13 } from "../lib/bibliography";
import { secureImage } from "./catalog-provider";
import { attachStoredCovers } from "./cover-mirrors";
export const bookSelect =
  'id,title,author,publisher,isbn,formats,total_pages AS "totalPages",shelf,tags,category,classification,bookshelves,cover_url AS "coverUrl",enrichment,version,created_at AS "createdAt",source_data AS "sourceData"';
export const compactBookSelect = bookSelect
  .replace(
    'source_data AS "sourceData"',
    `CASE WHEN source_data IS NULL THEN NULL ELSE jsonb_build_object('app',source_data->'app','libraryId',source_data->'libraryId','recordId',source_data->'recordId','cover',source_data->'cover','raw','{}'::jsonb) END AS "sourceData"`,
  )
  .replace(
    "enrichment,",
    "jsonb_build_object('catalogSelection',enrichment->'catalogSelection') AS enrichment,",
  );
export async function attachCatalogCoverSources(
  tx: Executor,
  owner: string,
  books: Book[],
) {
  if (!books.length) return;
  const covers = await tx.query(
    `SELECT c.source_id, c.value->>'coverUrl' AS url, c.value->>'isbn' AS isbn,
              r.facts->>'isbn' AS reference_isbn
       FROM library_curation_items c
       JOIN library_books b ON b.owner_id=c.owner_id AND b.id::text=c.source_id
       JOIN library_reference_sources r ON r.owner_id=c.owner_id
         AND r.id::text=c.evidence->>'referenceId'
         AND r.source_kind=c.source_kind AND r.source_id=c.source_id
         AND r.source_version=c.source_version
       WHERE c.owner_id=$1 AND c.source_id=ANY($2::text[]) AND c.source_kind='book' AND c.kind='bibliography'
         AND c.origin='provider' AND c.state='active' AND r.edition_match='isbn'
         AND c.source_version=b.version::text AND coalesce(c.value->>'coverUrl','')<>''
         AND (coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS (
           SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id
             AND d.book_id=b.id AND d.processing_scope='full'))
       ORDER BY c.created_at DESC, c.id DESC`,
    [owner, books.map((b) => b.id)],
  );
  const byId = new Map(books.map((b) => [b.id, b]));
  for (const candidate of covers.rows) {
    const book = byId.get(candidate.source_id);
    if (!book || book.catalogCoverUrl) continue;
    const isbn = isbn13(book.isbn),
      url = secureImage(candidate.url);
    if (
      url &&
      isbn &&
      isbn === isbn13(candidate.isbn) &&
      isbn === isbn13(candidate.reference_isbn)
    )
      book.catalogCoverUrl = url;
  }
}
export async function attachCatalogCovers(
  tx: Executor,
  owner: string,
  books: Book[],
) {
  await attachCatalogCoverSources(tx, owner, books);
  await attachStoredCovers(tx, owner, books);
}

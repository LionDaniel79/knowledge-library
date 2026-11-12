import type { Executor } from "./library-store";
import { attachCatalogCovers } from "./book-records";
export async function catalogReviewSummary(db: Executor, owner: string) {
  const books: any[] = (
    await db.query(
      `SELECT id,title,author,publisher,isbn,formats,cover_url AS "coverUrl",source_data AS "sourceData",enrichment,category,classification FROM library_active_books WHERE owner_id=$1`,
      [owner],
    )
  ).rows;
  const reviews = (
    await db.query(
      "SELECT book_id,count(*)::int n FROM library_catalog_reviews WHERE owner_id=$1 AND status IN ('pending','deferred') GROUP BY book_id",
      [owner],
    )
  ).rows;
  const counts = new Map(reviews.map((r) => [r.book_id, r.n]));
  for (let i = 0; i < books.length; i += 200)
    await attachCatalogCovers(db, owner, books.slice(i, i + 200));
  const formats = ["paper", "logos", "ebook", "pdf"].map((format) => {
    const selected = books.filter((b) => b.formats.includes(format));
    return {
      format,
      total: selected.length,
      covers: selected.filter(
        (b) =>
          b.storedCoverUrl ||
          b.storedImportedCoverUrl ||
          b.catalogCoverUrl ||
          b.sourceData?.cover,
      ).length,
      classified: selected.filter((b) => b.category).length,
      verified: selected.filter((b) => b.category && b.classification?.verified)
        .length,
      reviewBooks: selected.filter((b) => counts.has(b.id)).length,
      candidates: selected.reduce((n, b) => n + (counts.get(b.id) ?? 0), 0),
      incomplete: selected.filter((b) =>
        b.sourceData?.app === "Logos"
          ? b.enrichment?.logosCompletion?.state !== "certain"
          : b.enrichment?.catalogSupplement?.state !== "complete",
      ).length,
    };
  });
  return { formats };
}


import { z } from "zod";
import type { Executor } from "./library-store";
import { LibraryError } from "./library-store";
import { ratingSummary, ratingGroup } from "../lib/reading-ratings";
import { compactBookSelect, attachCatalogCovers } from "./book-records";
import type { ReadingCycle } from "../lib/domain";
export const ratingQuery = z.object({
  year: z
    .string()
    .regex(/^all$|^(19|20|21|22)\d{2}$/)
    .default("all"),
  group: z
    .enum(["all", "0", "2", "4", "6", "8", "10", "unrated"])
    .default("all"),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export async function readRatingPage(
  db: Executor,
  owner: string,
  raw: unknown,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = ratingQuery.parse(raw);
  const cycles = (
    await db.query(
      `SELECT DISTINCT ON(book_id) id,book_id AS "bookId",status,started_on::text AS "startedOn",completed_on::text AS "completedOn",current_page AS "currentPage",version,created_at AS "createdAt",CASE WHEN source_data ? 'readingRating' THEN (source_data#>>'{readingRating,steps}')::int WHEN source_data#>>'{raw,ZRATING}' ~ '^(10|[1-9])$' THEN (source_data#>>'{raw,ZRATING}')::int ELSE NULL END AS "ratingSteps" FROM library_active_cycles WHERE owner_id=$1 AND status='completed' AND ($2='all' OR left(completed_on::text,4)=$2) ORDER BY book_id,completed_on DESC NULLS LAST,created_at DESC,id DESC`,
      [owner, p.year],
    )
  ).rows as ReadingCycle[];
  cycles.sort(
    (a, b) =>
      String(b.completedOn ?? "").localeCompare(String(a.completedOn ?? "")) ||
      b.id.localeCompare(a.id),
  );
  const matched = cycles.filter(
      (c) => p.group === "all" || ratingGroup(c.ratingSteps) === p.group,
    ),
    items = matched.slice(p.offset, p.offset + p.limit);
  const books = (
    await db.query(
      `SELECT ${compactBookSelect} FROM library_active_books WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
      [owner, items.map((c) => c.bookId)],
    )
  ).rows;
  await attachCatalogCovers(db, owner, books as any);
  return {
    summary: ratingSummary(cycles),
    items,
    books,
    total: matched.length,
  };
}

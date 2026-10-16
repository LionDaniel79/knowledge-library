import { z } from "zod";
import { monthCells, type Note, type ReadingCycle } from "../lib/domain";
import { LibraryError, type Executor } from "./library-store";
import {
  compactBookSelect as bookSelect,
  attachCatalogCovers,
} from "./book-records";
export const fullNoteSelect =
  'n.id,n.book_id AS "bookId",n.title,n.content,n.kind,n.page,n.tags,n.version,n.created_at AS "createdAt",n.updated_at AS "updatedAt",n.source_data AS "sourceData"';
export const previewNoteSelect = fullNoteSelect
  .replace("n.content", "left(n.content,240) AS content")
  .replace(
    'n.source_data AS "sourceData"',
    `CASE WHEN n.source_data IS NULL THEN NULL ELSE jsonb_build_object('app',n.source_data->'app','libraryId',n.source_data->'libraryId','recordId',n.source_data->'recordId','raw',CASE WHEN n.source_data->>'app'='PDF' THEN jsonb_build_object('signature',n.source_data->'raw'->'signature','pdfPage',n.source_data->'raw'->'pdfPage') ELSE '{}'::jsonb END) END AS "sourceData",true AS "summary"`,
  );
const querySchema = z.object({
  q: z.string().trim().max(200).default(""),
  tag: z.string().max(80).default("all"),
  kind: z
    .enum([
      "all",
      "thought",
      "note",
      "highlight",
      "review",
      "claim",
      "evidence",
      "counterargument",
      "reflection",
    ])
    .default("all"),
  book: z
    .union([z.enum(["all", "unlinked"]), z.string().uuid()])
    .default("all"),
  from: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
    .default(""),
  to: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
    .default(""),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export async function readNotePage(db: Executor, owner: string, raw: unknown) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = querySchema.parse(raw),
    args = [owner, p.q, p.tag, p.kind, p.book, p.from, p.to];
  const where = `n.owner_id=$1 AND ($2='' OR strpos(lower(n.title||' '||n.content||' '||array_to_string(n.tags,' ')||' '||coalesce(b.title,'')),lower($2))>0) AND ($3='all' OR ($3='untagged' AND cardinality(n.tags)=0) OR $3=ANY(n.tags)) AND ($4='all' OR n.kind=$4) AND ($5='all' OR ($5='unlinked' AND n.book_id IS NULL) OR n.book_id::text=$5) AND ($6='' OR (n.created_at AT TIME ZONE 'Asia/Seoul')::date::text >=$6) AND ($7='' OR (n.created_at AT TIME ZONE 'Asia/Seoul')::date::text <=$7)`;
  const join =
    " FROM library_active_notes n LEFT JOIN library_books b ON b.owner_id=n.owner_id AND b.id=n.book_id WHERE ";
  const total = Number(
    (await db.query("SELECT count(*)::int AS n" + join + where, args)).rows[0]
      .n,
  );
  const items = (
    await db.query(
      `SELECT ${previewNoteSelect}${join}${where} ORDER BY n.updated_at DESC,n.id LIMIT 24 OFFSET $8`,
      [...args, p.offset],
    )
  ).rows as Note[];
  return {
    items,
    total,
    nextOffset:
      p.offset + items.length < total ? p.offset + items.length : null,
  };
}
export async function readNoteDetail(
  db: Executor,
  owner: string,
  id: string,
  trash = false,
) {
  z.string().uuid().parse(id);
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const n = (
    await db.query(
      `SELECT ${fullNoteSelect} FROM ${trash ? "library_notes" : "library_active_notes"} n WHERE n.owner_id=$1 AND n.id=$2${trash ? " AND EXISTS(SELECT 1 FROM library_note_trash t WHERE t.owner_id=n.owner_id AND t.id=n.id AND t.restored_at IS NULL)" : ""}`,
      [owner, id],
    )
  ).rows[0];
  if (!n) throw new LibraryError(404, "기록을 찾을 수 없습니다.");
  return n as Note;
}
export async function readReadingSummary(db: Executor, owner: string) {
  const rows = (
    await db.query(
      `WITH ordered AS(SELECT *,row_number() OVER(PARTITION BY book_id ORDER BY completed_on,id) AS occurrence FROM library_cycles WHERE owner_id=$1 AND status='completed' AND completed_on IS NOT NULL) SELECT to_char(completed_on,'YYYY-MM') AS month,count(*)::int AS "monthCount",count(DISTINCT book_id)::int AS "uniqueBooks",count(*) FILTER(WHERE occurrence>1)::int AS rereads FROM ordered GROUP BY 1 ORDER BY 1`,
      [owner],
    )
  ).rows;
  const totals = (
    await db.query(
      `SELECT count(*) FILTER(WHERE status='completed')::int AS "totalCompleted",count(*) FILTER(WHERE status='completed' AND completed_on IS NULL)::int AS "undatedCount",array_agg(DISTINCT book_id) FILTER(WHERE status='completed') AS "completedIds" FROM library_cycles WHERE owner_id=$1`,
      [owner],
    )
  ).rows[0];
  return {
    ...totals,
    completedIds: totals.completedIds ?? [],
    months: Object.fromEntries(
      rows.map((r) => [
        r.month,
        {
          monthCount: r.monthCount,
          uniqueBooks: r.uniqueBooks,
          rereads: r.rereads,
        },
      ]),
    ),
  };
}
const cycleSelect =
  'id,book_id AS "bookId",status,started_on::text AS "startedOn",completed_on::text AS "completedOn",current_page AS "currentPage",version,created_at AS "createdAt"';
export async function readCyclePage(db: Executor, owner: string, raw: unknown) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = z
    .object({
      id: z.string().uuid().optional(),
      book: z.string().uuid().optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    })
    .parse(raw);
  const args = [owner, p.book ?? null, p.date ?? null, p.id ?? null],
    where =
      "owner_id=$1 AND ($2::uuid IS NULL OR book_id=$2::uuid) AND ($3::date IS NULL OR completed_on=$3::date) AND ($4::uuid IS NULL OR id=$4::uuid)";
  const total = Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM library_cycles WHERE ${where}`,
          args,
        )
      ).rows[0].n,
    ),
    items = (
      await db.query(
        `SELECT ${cycleSelect} FROM library_cycles WHERE ${where} ORDER BY completed_on DESC NULLS FIRST,id LIMIT 24 OFFSET $5`,
        [...args, p.offset],
      )
    ).rows as ReadingCycle[];
  const books = (
    await db.query(
      `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
      [owner, items.map((i) => i.bookId)],
    )
  ).rows;
  await attachCatalogCovers(db, owner, books as any);
  return {
    items,
    total,
    books,
    nextOffset:
      p.offset + items.length < total ? p.offset + items.length : null,
  };
}
export async function readReadingCalendar(
  db: Executor,
  owner: string,
  raw: string,
) {
  const month = z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .parse(raw),
    days = monthCells(month);
  const rows = (
    await db.query(
      `WITH ranked AS(SELECT *,row_number() OVER(PARTITION BY completed_on ORDER BY created_at,id) AS rank,count(*) OVER(PARTITION BY completed_on)::int AS total FROM library_cycles WHERE owner_id=$1 AND status='completed' AND completed_on BETWEEN $2 AND $3) SELECT ${cycleSelect},total FROM ranked WHERE rank=1 ORDER BY completed_on`,
      [owner, days[0], days.at(-1)],
    )
  ).rows;
  const books = (
    await db.query(
      `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
      [owner, rows.map((r) => r.bookId)],
    )
  ).rows;
  await attachCatalogCovers(db, owner, books as any);
  return { days: rows, books };
}

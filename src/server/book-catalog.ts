import { createHash } from "node:crypto";
import { z } from "zod";
import type { Book, BookPage, Format } from "../lib/domain";
import { categories } from "../lib/catalog";
import { LibraryError, type Executor } from "./library-store";
import {
  attachCatalogCovers,
  bookSelect,
  compactBookSelect,
} from "./book-records";
const queryInput = z.object({
  q: z.string().trim().max(200).default(""),
  sort: z.enum(["newest", "oldest", "title", "author"]).default("newest"),
  category: z
    .enum([
      "all",
      "unclassified",
      "review",
      "000",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
    ])
    .default("all"),
  shelf: z.string().max(80).default("all"),
  filter: z
    .enum(["all", "reading", "completed", "paper", "pdf", "ebook", "unknown"])
    .default("all"),
  topic: z
    .union([z.enum(["all", "unclassified"]), z.string().uuid()])
    .default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  cursor: z.string().max(4000).optional(),
});
function ownerRequired(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
const serialize = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));
export async function readBookPage(
  tx: Executor,
  owner: string,
  input: unknown,
): Promise<BookPage> {
  ownerRequired(owner);
  const { cursor, offset, ...q } = queryInput.parse(input);
  if (cursor && offset)
    throw new LibraryError(400, "페이지 조회 방법을 하나만 선택해 주세요.");
  const values: unknown[] = [owner],
    where = ["b.owner_id=$1"];
  const param = (v: unknown) => {
    values.push(v);
    return "$" + values.length;
  };
  if (q.q) {
    const text = param("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
    const compactText = param(q.q.replace(/\s+/g, "").toLowerCase());
    const categoryIds = categories
      .filter(([, name]) =>
        name.toLocaleLowerCase().includes(q.q.toLocaleLowerCase()),
      )
      .map(([id]) => id);
    where.push(
      `(concat_ws(' ',b.title,b.author,b.publisher,b.isbn,b.shelf,array_to_string(b.tags,' '),array_to_string(b.bookshelves,' ')) ILIKE ${text} ESCAPE '\\'
       OR position(${compactText} in regexp_replace(lower(b.title),'[[:space:]　 ]+','','g'))>0
       OR position(${compactText} in regexp_replace(lower(b.author),'[[:space:]　 ]+','','g'))>0
       OR b.category=ANY(${param(categoryIds)}::text[]))`,
    );
  }
  if (q.category === "unclassified") where.push("b.category=''");
  else if (q.category === "review")
    where.push(
      "b.category<>'' AND coalesce(b.classification->>'verified','false')<>'true'",
    );
  else if (q.category !== "all") where.push(`b.category=${param(q.category)}`);
  if (q.shelf !== "all") where.push(`${param(q.shelf)}=ANY(b.bookshelves)`);
  if (q.filter === "reading" || q.filter === "completed")
    where.push(
      `EXISTS(SELECT 1 FROM library_cycles c WHERE c.owner_id=b.owner_id AND c.book_id=b.id AND c.status=${param(q.filter)})`,
    );
  else if (q.filter !== "all") where.push(`${param(q.filter)}=ANY(b.formats)`);
  if (q.topic !== "all") {
    const assigned = `SELECT 1 FROM library_topic_memberships m WHERE m.owner_id=b.owner_id AND m.source_kind='book' AND m.source_id=b.id::text AND m.status<>'rejected'`;
    where.push(
      q.topic === "unclassified"
        ? `NOT EXISTS(${assigned})`
        : `EXISTS(${assigned} AND m.topic_id=${param(q.topic)}::uuid)`,
    );
  }
  const total = Number(
    (
      await tx.query(
        `SELECT count(*)::int AS total FROM library_books b WHERE ${where.join(" AND ")}`,
        values,
      )
    ).rows[0].total,
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["catalog-spacing/v2", owner, q]))
    .digest("hex");
  const fields =
    q.sort === "title"
      ? ['b.title COLLATE "C"', "b.id"]
      : q.sort === "author"
        ? ['b.author COLLATE "C"', 'b.title COLLATE "C"', "b.id"]
        : ["b.created_at", "b.id"];
  const direction = q.sort === "newest" ? "DESC" : "ASC";
  if (cursor) {
    let c: { scope: string; keys: string[] };
    try {
      c = z
        .object({
          scope: z.literal(fingerprint),
          keys: z.array(z.string().max(1000)).length(fields.length),
        })
        .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      z.string().uuid().parse(c.keys.at(-1));
      if (q.sort === "newest" || q.sort === "oldest") {
        if (
          !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(
            c.keys[0],
          ) ||
          !Number.isFinite(Date.parse(c.keys[0]))
        )
          throw Error();
      }
    } catch {
      throw new LibraryError(
        400,
        "목록 조건이 바뀌었거나 페이지 정보가 잘못되었습니다. 처음부터 조회하세요.",
      );
    }
    const keys = c.keys.map(
      (key, i) =>
        param(key) +
        (i === fields.length - 1
          ? "::uuid"
          : (q.sort === "newest" || q.sort === "oldest") && i === 0
            ? "::timestamptz"
            : '::text COLLATE "C"'),
    );
    where.push(
      `(${fields.join(",")}) ${direction === "DESC" ? "<" : ">"} (${keys.join(",")})`,
    );
  }
  const result = await tx.query(
    `SELECT ${compactBookSelect},created_at::text AS "_created" FROM library_books b WHERE ${where.join(" AND ")} ORDER BY ${fields.map((f) => f + " " + direction).join(",")} LIMIT ${param(q.limit + 1)} OFFSET ${param(offset)}`,
    values,
  );
  const rows = result.rows.slice(0, q.limit),
    last = rows.at(-1);
  const nextCursor =
    result.rows.length > q.limit && last
      ? Buffer.from(
          JSON.stringify({
            scope: fingerprint,
            keys:
              q.sort === "title"
                ? [last.title, last.id]
                : q.sort === "author"
                  ? [last.author, last.title, last.id]
                  : [last._created, last.id],
          }),
        ).toString("base64url")
      : null;
  const books = rows.map(({ _created, ...row }) => row) as Book[];
  await attachCatalogCovers(tx, owner, books);
  return { items: serialize<Book[]>(books), total, nextCursor };
}
export async function readBookDetail(
  tx: Executor,
  owner: string,
  id: string,
): Promise<Book> {
  ownerRequired(owner);
  z.string().uuid().parse(id);
  const rows = (
    await tx.query(
      `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2`,
      [owner, id],
    )
  ).rows as Book[];
  if (!rows.length) throw new LibraryError(404, "책을 찾을 수 없습니다.");
  await attachCatalogCovers(tx, owner, rows);
  return serialize<Book>(rows[0]);
}
export async function readBooksByIds(
  tx: Executor,
  owner: string,
  ids: string[],
): Promise<Book[]> {
  ownerRequired(owner);
  z.array(z.string().uuid()).max(100).parse(ids);
  if (!ids.length) return [];
  const rows = (
    await tx.query(
      `SELECT ${compactBookSelect} FROM library_books WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY title,id`,
      [owner, ids],
    )
  ).rows as Book[];
  await attachCatalogCovers(tx, owner, rows);
  return serialize<Book[]>(rows);
}
export async function readCatalogCounts(tx: Executor, owner: string) {
  const rows = (
    await tx.query(
      "SELECT category,formats,count(*)::int AS n FROM library_books WHERE owner_id=$1 GROUP BY category,formats",
      [owner],
    )
  ).rows;
  const formatCounts: Record<Format, number> = {
      paper: 0,
      pdf: 0,
      ebook: 0,
      unknown: 0,
    },
    categoryCounts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    total += row.n;
    categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + row.n;
    for (const format of row.formats as Format[]) formatCounts[format] += row.n;
  }
  return { total, formatCounts, categoryCounts };
}

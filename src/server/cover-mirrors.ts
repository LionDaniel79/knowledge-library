import { syncQuery } from "./sync/write";
import { LibraryError, type Database, type Executor } from "./library-store";
import type { Book } from "../lib/domain";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCoverStore } from "./book-covers";
import { downloadCover } from "./cover-download";
const assetUrl = (id: string) => ({ id, url: "/api/book-covers/" + id });
function validate(owner: string, source: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  z.string().min(1).max(2000).parse(source);
}
async function saved(db: Executor, owner: string, source: string) {
  const row = (
    await db.query(
      "SELECT asset_id FROM library_cover_mirrors WHERE owner_id=$1 AND source=$2",
      [owner, source],
    )
  ).rows[0];
  return row ? assetUrl(String(row.asset_id)) : null;
}
export async function storeCoverMirror(
  db: Database,
  owner: string,
  source: string,
  input: Buffer,
) {
  validate(owner, source);
  const existing = await saved(db, owner, source);
  if (existing) return existing;
  const asset = await createCoverStore(db).upload(owner, input);
  await syncQuery(
    db,
    owner,
    "INSERT INTO library_cover_mirrors(id,owner_id,source,asset_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,source) DO NOTHING",
    [randomUUID(), owner, source, asset.id],
  );
  return (await saved(db, owner, source))!;
}
export async function mirrorCover(
  db: Database,
  owner: string,
  source: string,
  download: (url: string) => Promise<Buffer> = downloadCover,
) {
  validate(owner, source);
  return (
    (await saved(db, owner, source)) ??
    storeCoverMirror(db, owner, source, await download(source))
  );
}
/** Repair a missing mirror without changing the book or downloading it twice. */
export async function readStoredBookCover(
  db: Database,
  owner: string,
  bookId: string,
  etag = "",
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  z.string().uuid().parse(bookId);
  const book = (
    await db.query(
      "SELECT cover_url FROM library_active_books WHERE owner_id=$1 AND id=$2",
      [owner, bookId],
    )
  ).rows[0];
  const managed = /^\/api\/book-covers\/([a-f0-9-]{36})$/i.exec(
    book?.cover_url ?? "",
  );
  if (managed)
    return createCoverStore(db).readConditional(owner, managed[1], etag);
  if (!book?.cover_url?.startsWith("https://"))
    throw new LibraryError(404, "저장할 표지가 없습니다.");
  // Repair legacy external URLs once; subsequent reads use the stored mirror.
  const asset = await mirrorCover(db, owner, book.cover_url);
  return createCoverStore(db).readConditional(owner, asset.id, etag);
}
export async function attachStoredCovers(
  db: Executor,
  owner: string,
  books: Book[],
) {
  const source = (book: Book) => {
    const sha = book.sourceData?.cover?.sha256;
    return sha && /^[a-f0-9]{64}$/.test(sha) ? "import:" + sha : undefined;
  };
  const keys = [
    ...new Set(
      books
        .flatMap((b) => [b.coverUrl, b.catalogCoverUrl, source(b)])
        .filter((s): s is string => !!s),
    ),
  ];
  if (!keys.length) return;
  const rows = (
    await db.query(
      "SELECT source,asset_id FROM library_cover_mirrors WHERE owner_id=$1 AND source=ANY($2::text[])",
      [owner, keys],
    )
  ).rows;
  const urls = new Map<string, string>(
    rows.map((r) => [r.source, assetUrl(r.asset_id).url]),
  );
  for (const book of books) {
    book.storedCoverUrl = book.coverUrl?.startsWith("/api/book-covers/")
      ? book.coverUrl
      : book.coverUrl
        ? urls.get(book.coverUrl)
        : undefined;
    book.storedImportedCoverUrl = urls.get(source(book) ?? "");
    if (book.catalogCoverUrl)
      book.catalogCoverUrl = urls.get(book.catalogCoverUrl);
  }
}
export async function ensureBookCover(
  db: Database,
  owner: string,
  type: "addBook" | "editBook",
  book: { id?: string; expectedVersion?: number; coverUrl: string },
  download = downloadCover,
) {
  if (!book.coverUrl.startsWith("https://")) return;
  if (type === "editBook") {
    const existing = (
      await db.query(
        "SELECT cover_url,version FROM library_books WHERE owner_id=$1 AND id=$2",
        [owner, book.id],
      )
    ).rows[0];
    if (
      !existing ||
      existing.cover_url === book.coverUrl ||
      Number(existing.version) !== book.expectedVersion
    )
      return;
  }
  await mirrorCover(db, owner, book.coverUrl, download);
}

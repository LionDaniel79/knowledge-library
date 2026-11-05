import sharp from "sharp";
import { createHash } from "node:crypto";
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
  if (!book?.cover_url?.startsWith("https://"))
    throw new LibraryError(404, "저장할 표지가 없습니다.");
  // For owner-verified Logos image URLs, proxy an optimized image without
  // occupying the legacy 5,000-row base64 asset store.
  const location = (
    await db.query(
      "SELECT storage_kind,object_key FROM library_cover_locations WHERE owner_id=$1 AND book_id=$2",
      [owner, bookId],
    )
  ).rows[0];
  if (
    location?.storage_kind === "external" &&
    location.object_key === book.cover_url
  ) {
    const raw = await downloadCover(book.cover_url);
    const bytes = await sharp(raw, {
      limitInputPixels: 24000000,
      failOn: "error",
    })
      .rotate()
      .resize({
        width: 800,
        height: 1200,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .toBuffer();
    const checksum =
      '"' + createHash("sha256").update(bytes).digest("hex") + '"';
    return {
      bytes: etag === checksum ? null : bytes,
      mime: "image/webp",
      etag: checksum,
    };
  }
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
    book.storedCoverUrl = book.coverUrl ? urls.get(book.coverUrl) : undefined;
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

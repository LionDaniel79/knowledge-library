import { z } from "zod";
import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import { downloadCover } from "./cover-download";
import { withSyncWrite } from "./sync/write";
import { prepareCover, storePreparedCover } from "./book-covers";
import { randomUUID } from "node:crypto";
import { bookSelect } from "./book-records";
import { carryCuration } from "./book-curation-history";

const input = z
  .object({
    bookId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    coverUrl: z.string().url().max(1024),
    verification: z.enum(["verified", "manual"]),
    origin: z.string().trim().max(200).default("user"),
  })
  .strict();

export async function saveVerifiedLogosCover(
  db: Database,
  owner: string,
  raw: unknown,
  download: typeof downloadCover = downloadCover,
) {
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(
      403,
      "로고스 표지의 실제 등록은 5단계에서 허용됩니다.",
    );
  const p = input.parse(raw);
  // Decode outside the transaction. Persist the actual optimized bytes atomically
  // with the version-checked book update, using the existing replica asset store.
  const image = await prepareCover(await download(p.coverUrl));
  return withSyncWrite(db, owner, async (tx) => {
    const b = (
      await tx.query(
        `SELECT ${bookSelect},source_data->>'app' AS app FROM library_books b WHERE owner_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=b.owner_id AND e.id=b.id AND e.state='excluded') FOR UPDATE`,
        [owner, p.bookId],
      )
    ).rows[0];
    if (!b || b.app !== "Logos")
      throw new LibraryError(404, "로고스 도서를 찾을 수 없습니다.");
    if (Number(b.version) !== p.expectedVersion)
      throw new LibraryError(409, "다른 기기에서 도서가 수정되었습니다.");
    const provenance = (
      await tx.query(
        "SELECT object_key FROM library_cover_locations WHERE owner_id=$1 AND book_id=$2",
        [owner, p.bookId],
      )
    ).rows[0];
    const mirror = (
      await tx.query(
        "SELECT asset_id FROM library_cover_mirrors WHERE owner_id=$1 AND source=$2",
        [owner, p.coverUrl],
      )
    ).rows[0];
    if (
      b.enrichment?.coverRemoved ||
      (b.coverUrl &&
        b.coverUrl !== p.coverUrl &&
        provenance?.object_key !== p.coverUrl &&
        b.coverUrl !== "/api/book-covers/" + mirror?.asset_id)
    )
      throw new LibraryError(409, "기존 표지를 자동 교체할 수 없습니다.");
    const asset = await storePreparedCover(tx, owner, image);
    const changed = b.coverUrl !== asset.url;
    if (changed)
      await tx.query(
        "UPDATE library_books SET cover_url=$3,version=version+1 WHERE owner_id=$1 AND id=$2",
        [owner, p.bookId, asset.url],
      );
    if (changed) {
      await carryCuration(
        tx,
        owner,
        p.bookId,
        String(b.version),
        String(Number(b.version) + 1),
      );
      await tx.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'logosCover',$4,$5)",
        [
          randomUUID(),
          owner,
          p.bookId,
          JSON.stringify(b),
          JSON.stringify({
            ...b,
            coverUrl: asset.url,
            version: Number(b.version) + 1,
          }),
        ],
      );
    }
    await tx.query(
      "INSERT INTO library_cover_mirrors(id,owner_id,source,asset_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,source) DO NOTHING",
      [randomUUID(), owner, p.coverUrl, asset.id],
    );
    await tx.query(
      "INSERT INTO library_cover_locations(owner_id,book_id,storage_kind,object_key,verification_status,origin) VALUES($1,$2,'managed_asset',$3,$4,$5) ON CONFLICT(owner_id,book_id) DO UPDATE SET storage_kind='managed_asset',object_key=excluded.object_key,verification_status=excluded.verification_status,origin=excluded.origin",
      [owner, p.bookId, asset.id, p.verification, p.origin],
    );
    return {
      bookId: p.bookId,
      coverUrl: asset.url,
      version: Number(b.version) + (changed ? 1 : 0),
    };
  });
}

import { z } from "zod";
import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import { downloadCover } from "./cover-download";
import { withSyncWrite } from "./sync/write";

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
  // Validate trusted image host and a real image before accepting a URL.
  await download(p.coverUrl);
  return withSyncWrite(db, owner, async (tx) => {
    const b = (
      await tx.query(
        "SELECT id,version,cover_url,source_data->>'app' AS app FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, p.bookId],
      )
    ).rows[0];
    if (!b || b.app !== "Logos")
      throw new LibraryError(404, "로고스 도서를 찾을 수 없습니다.");
    if (Number(b.version) !== p.expectedVersion)
      throw new LibraryError(409, "다른 기기에서 도서가 수정되었습니다.");
    if (b.cover_url && b.cover_url !== p.coverUrl)
      throw new LibraryError(409, "기존 표지를 자동 교체할 수 없습니다.");
    if (!b.cover_url)
      await tx.query(
        "UPDATE library_books SET cover_url=$3,version=version+1 WHERE owner_id=$1 AND id=$2",
        [owner, p.bookId, p.coverUrl],
      );
    await tx.query(
      "INSERT INTO library_cover_locations(owner_id,book_id,storage_kind,object_key,verification_status,origin) VALUES($1,$2,'external',$3,$4,$5) ON CONFLICT(owner_id,book_id) DO NOTHING",
      [owner, p.bookId, p.coverUrl, p.verification, p.origin],
    );
    return {
      bookId: p.bookId,
      coverUrl: p.coverUrl,
      version: Number(b.version) + (b.cover_url ? 0 : 1),
    };
  });
}

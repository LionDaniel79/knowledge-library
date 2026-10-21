import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import type { Book } from "../lib/domain";
import { attachCatalogCovers } from "./book-records";
import { createCoverStore } from "./book-covers";
import { downloadCover } from "./cover-download";
import sharp from "sharp";
export async function readMinistryBookCover(
  db: Database,
  owner: string,
  id: string,
) {
  const book = (
    await db.query(
      'SELECT id,title,isbn,version,cover_url AS "coverUrl",source_data AS "sourceData" FROM library_active_books WHERE owner_id=$1 AND id=$2',
      [owner, id],
    )
  ).rows[0] as Book | undefined;
  if (!book) throw new LibraryError(404, "책을 찾을 수 없습니다.");
  await attachCatalogCovers(db, owner, [book]);
  for (const source of [
    book.storedCoverUrl,
    book.coverUrl,
    book.storedImportedCoverUrl,
    book.catalogCoverUrl,
  ]) {
    const asset = source?.match(/^\/api\/book-covers\/([a-f0-9-]{36})$/i)?.[1];
    if (asset) {
      try {
        return await createCoverStore(db).read(owner, asset);
      } catch (error) {
        if (!(error instanceof LibraryError) || error.status !== 404)
          throw error;
      }
    }
  }
  const image = book.sourceData?.cover;
  if (
    process.env.LIBRARY_IMPORT_ASSET_DIR &&
    image &&
    /^[a-f0-9]{64}$/.test(image.sha256) &&
    ["image/jpeg", "image/png"].includes(image.mime)
  ) {
    try {
      const bytes = await readFile(
        resolve(process.env.LIBRARY_IMPORT_ASSET_DIR, image.sha256),
      );
      if (createHash("sha256").update(bytes).digest("hex") === image.sha256)
        return { bytes, mime: image.mime };
    } catch {}
  }
  if (book.coverUrl?.startsWith("https://")) {
    try {
      return {
        bytes: await sharp(await downloadCover(book.coverUrl), {
          limitInputPixels: 24000000,
        })
          .rotate()
          .resize({
            width: 400,
            height: 600,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toBuffer(),
        mime: "image/webp",
      };
    } catch {}
  }
  if (
    process.env.LIBRARY_PDF_INDEX &&
    book.sourceData?.app === "Local PDF" &&
    /^[a-f0-9-]{36}$/i.test(book.sourceData.recordId)
  ) {
    const d = (
      await db.query(
        "SELECT bytes,mtime_ns FROM library_active_documents WHERE owner_id=$1 AND id=$2",
        [owner, book.sourceData.recordId],
      )
    ).rows[0];
    if (d) {
      const key = createHash("sha256")
        .update(`${d.bytes}:${d.mtime_ns}`)
        .digest("hex")
        .slice(0, 16);
      try {
        return {
          bytes: await readFile(
            join(
              dirname(process.env.LIBRARY_PDF_INDEX),
              "pdf-covers",
              `${book.sourceData.recordId}-${key}.jpg`,
            ),
          ),
          mime: "image/jpeg",
        };
      } catch {}
    }
  }
  throw new LibraryError(404, "저장된 표지가 없습니다.");
}

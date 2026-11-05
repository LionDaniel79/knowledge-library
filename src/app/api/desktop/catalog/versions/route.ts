import { z } from "zod";
import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";

export const dynamic = "force-dynamic";

// Read-only, owner-scoped identity/version lookup for an already verified
// Windows PDF scan. No titles, local paths, hashes, OCR, or PDF bytes returned.
const requestSchema = z
  .object({
    documentIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.documentIds.map((id) => id.toLowerCase())).size ===
      v.documentIds.length,
    "Duplicate document ID",
  );

export async function POST(request: Request) {
  try {
    const who = await authorizeDesktop(database, request, "catalog:read");
    if (Number(request.headers.get("content-length")) > 12000)
      return new Response(null, { status: 413 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 12000)
      return new Response(null, { status: 413 });
    const input = requestSchema.parse(JSON.parse(raw));
    const result = await database.query(
      "SELECT d.id::text AS document_id,d.book_id::text AS book_id,b.version::int AS book_version FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=ANY($2::uuid[]) AND b.source_data->>'app'='Local PDF'",
      [who.owner, input.documentIds],
    );
    const byId = new Map(
      result.rows.map((row) => [String(row.document_id).toLowerCase(), row]),
    );
    if (byId.size !== input.documentIds.length)
      throw new LibraryError(
        409,
        "문서 ID·소유자·자료 유형이 시험 서버와 일치하지 않습니다.",
      );

    const items = input.documentIds.map((id) => {
      const found = byId.get(id.toLowerCase());
      if (!found || !Number.isSafeInteger(Number(found.book_version)))
        throw new LibraryError(409, "도서 버전을 검증할 수 없습니다.");
      return {
        legacyDocumentId: id.toLowerCase(),
        bookId: String(found.book_id).toLowerCase(),
        expectedBookVersion: Number(found.book_version),
      };
    });
    return Response.json(
      { verifiedAtUnix: Math.floor(Date.now() / 1000), items },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
